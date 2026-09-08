import { $ } from "bun";
import { parseD1DatabaseName } from "./release";
import { readWranglerConfig } from "./wrangler-config";

const wranglerConfig = await readWranglerConfig({ preferProduction: false });
const d1DatabaseName = parseD1DatabaseName(wranglerConfig.text);
const commentId = `smoke_comment_${crypto.randomUUID()}`;
const directMessageId = `smoke_dm_${crypto.randomUUID()}`;
const jobId = `smoke_job_${crypto.randomUUID()}`;
const directJobId = `smoke_dm_job_${crypto.randomUUID()}`;
const eventId = `smoke_event_${crypto.randomUUID()}`;
const now = new Date().toISOString();
const cleanDb = `/tmp/instagram-bot-clean-${crypto.randomUUID()}.sqlite`;

for (const migrationPath of Array.from(
  new Bun.Glob("migrations/*.sql").scanSync("."),
).sort()) {
  await $`sqlite3 ${cleanDb} ".read ${migrationPath}"`.quiet();
}

const cleanSchema = await $`sqlite3 ${cleanDb} "PRAGMA table_info(instagram_accounts); PRAGMA table_info(comments); PRAGMA table_info(direct_messages); PRAGMA table_info(webhook_events); PRAGMA table_info(reply_jobs); SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"`.text();
assertIncludes(cleanSchema, "token_state");
assertIncludes(cleanSchema, "comment_kind");
assertIncludes(cleanSchema, "direct_messages");
assertIncludes(cleanSchema, "direct_message_id");
assertIncludes(cleanSchema, "last_seen_source");
assertIncludes(cleanSchema, "username_normalized");
assertIncludes(cleanSchema, "raw_payload_retention_until");
assertIncludes(cleanSchema, "webhook_event_subjects");
assertIncludes(cleanSchema, "reply_rate_limit_slots");
assertIncludes(cleanSchema, "reply_text");
assertIncludes(cleanSchema, "public_success_reply_text");
assertIncludes(cleanSchema, "comment_processing_decisions");

await $`bunx wrangler d1 execute ${d1DatabaseName} --local --config ${wranglerConfig.path} --command ${resetLocalD1Sql()}`.quiet();
await $`bunx wrangler d1 migrations apply ${d1DatabaseName} --local --config ${wranglerConfig.path}`.quiet();

const schema = await $`bunx wrangler d1 execute ${d1DatabaseName} --local --config ${wranglerConfig.path} --command ${`
  SELECT name FROM sqlite_master
  WHERE type = 'table'
    AND name IN ('webhook_events', 'webhook_event_subjects', 'comments', 'direct_messages', 'reply_jobs', 'comment_processing_decisions', 'reply_attempts', 'reply_rate_limit_slots');
  PRAGMA table_info(comments);
  PRAGMA table_info(instagram_accounts);
  PRAGMA table_info(direct_messages);
  PRAGMA table_info(webhook_events);
  PRAGMA table_info(reply_jobs);
`}`.text();

assertIncludes(schema, "webhook_events");
assertIncludes(schema, "token_state");
assertIncludes(schema, "webhook_event_subjects");
assertIncludes(schema, "comments");
assertIncludes(schema, "direct_messages");
assertIncludes(schema, "reply_jobs");
assertIncludes(schema, "comment_processing_decisions");
assertIncludes(schema, "reply_attempts");
assertIncludes(schema, "reply_rate_limit_slots");
assertIncludes(schema, "comment_kind");
assertIncludes(schema, "direct_message_id");
assertIncludes(schema, "last_seen_source");
assertIncludes(schema, "username_normalized");
assertIncludes(schema, "raw_payload_retention_until");
assertIncludes(schema, "reply_text");
assertIncludes(schema, "public_success_reply_text");

const data = await $`bunx wrangler d1 execute ${d1DatabaseName} --local --config ${wranglerConfig.path} --command ${`
  INSERT INTO webhook_events
    (id, event_key, source, raw_payload, status, attempts, received_at, raw_payload_retention_until)
  VALUES
    ('${eventId}', 'comment:${commentId}', 'instagram',
     '{"value":{"id":"${commentId}","from":{"id":"smoke_user","username":"SmokeUser"}}}',
     'received', 0, '${now}', '${now}');

  INSERT INTO webhook_event_subjects
    (event_id, subject_type, subject_value, normalized_value, created_at)
  VALUES
    ('${eventId}', 'comment', '${commentId}', '${commentId}', '${now}'),
    ('${eventId}', 'commenter', 'smoke_user', 'smoke_user', '${now}'),
    ('${eventId}', 'username', 'SmokeUser', 'smokeuser', '${now}'),
    ('${eventId}', 'direct_message', '${directMessageId}', '${directMessageId}', '${now}'),
    ('${eventId}', 'commenter', 'smoke_dm_user', 'smoke_dm_user', '${now}');

  INSERT INTO comments
    (id, media_id, comment_kind, commenter_id, username, username_normalized, text, created_at, source,
     last_seen_source, matched_keyword, private_reply_eligible, raw_json, inserted_at, updated_at)
  VALUES
    ('${commentId}', 'smoke_media', 'feed', 'smoke_user', 'SmokeUser', 'smokeuser', 'хочу',
     '${now}', 'webhook', 'webhook', 'хочу', 1, '{}', '${now}', '${now}');

  INSERT INTO reply_jobs
    (id, idempotency_key, type, comment_id, reply_text, public_success_reply_text, status, attempts, max_attempts, created_at, updated_at)
  VALUES
    ('${jobId}', 'comment_private_reply:${commentId}', 'comment_private_reply',
     '${commentId}', 'reply text', 'public success text', 'pending', 0, 3, '${now}', '${now}');

  INSERT INTO direct_messages
    (id, sender_id, recipient_id, text, created_at, source, matched_keyword, raw_json, inserted_at, updated_at)
  VALUES
    ('${directMessageId}', 'smoke_dm_user', 'ig_account', '🦐', '${now}', 'webhook',
     '🦐', '{}', '${now}', '${now}');

  INSERT INTO reply_jobs
    (id, idempotency_key, type, direct_message_id, reply_text, status, attempts, max_attempts, created_at, updated_at)
  VALUES
    ('${directJobId}', 'direct_message_reply:${directMessageId}', 'direct_message_reply',
     '${directMessageId}', 'dm reply text', 'pending', 0, 3, '${now}', '${now}');

  INSERT INTO comment_processing_decisions
    (id, comment_id, source, matched_keyword, action, skipped_reason, created_job_types_json, created_at)
  VALUES
    ('${jobId}_decision', '${commentId}', 'webhook', 'хочу', 'jobs_created', NULL,
     '["comment_private_reply"]', '${now}');

  INSERT INTO reply_attempts
    (id, reply_job_id, attempt_number, status, created_at)
  VALUES
    ('${jobId}_attempt', '${jobId}', 1, 'retryable', '${now}');

  INSERT INTO reply_rate_limit_slots
    (bucket, slot, reply_job_id, created_at)
  VALUES
    ('${now}', 0, '${jobId}', '${now}');

  SELECT comments.id as comment_id,
         comments.comment_kind,
         reply_jobs.status
  FROM comments
  JOIN reply_jobs ON reply_jobs.comment_id = comments.id
  WHERE comments.id = '${commentId}';

  SELECT direct_messages.id as direct_message_id,
         reply_jobs.status
  FROM direct_messages
  JOIN reply_jobs ON reply_jobs.direct_message_id = direct_messages.id
  WHERE direct_messages.id = '${directMessageId}';
`}`.text();
const foreignKeyCheck = await $`bunx wrangler d1 execute ${d1DatabaseName} --local --config ${wranglerConfig.path} --command ${`
  PRAGMA foreign_key_check;
`}`.text();
const subjectCount = await $`bunx wrangler d1 execute ${d1DatabaseName} --local --config ${wranglerConfig.path} --command ${`
  SELECT COUNT(*) as subject_count
  FROM webhook_event_subjects
  WHERE event_id = '${eventId}';
`}`.text();

assertWranglerEmptyResult(foreignKeyCheck, "foreign_key_check", 0);
assertWranglerCount(subjectCount, "subject_count", 5, 0);
assertIncludes(data, commentId);
assertIncludes(data, directMessageId);
assertIncludes(data, "feed");
assertIncludes(data, "pending");

console.log(
  JSON.stringify(
    {
      ok: true,
      checked: [
        "clean_sqlite_migrations",
        "wrangler_local_migrations",
        "instagram_accounts.token_state",
        "comments.comment_kind",
        "direct_messages",
        "comments.last_seen_source",
        "comments.username_normalized",
        "webhook_events.raw_payload_retention_until",
        "webhook_event_subjects",
        "reply_jobs",
        "reply_jobs.direct_message_id",
        "reply_jobs.public_success_reply_text",
        "reply_rate_limit_slots",
        "comment_processing_decisions",
      ],
      commentId,
      directMessageId,
      eventId,
      jobId,
      directJobId,
    },
    null,
    2,
  ),
);

function resetLocalD1Sql(): string {
  return `
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS reply_rate_limit_slots;
    DROP TABLE IF EXISTS reply_attempts;
    DROP TABLE IF EXISTS comment_processing_decisions;
    DROP TABLE IF EXISTS reply_jobs;
    DROP TABLE IF EXISTS media_commenters;
    DROP TABLE IF EXISTS media_backfill_runs;
    DROP TABLE IF EXISTS direct_messages;
    DROP TABLE IF EXISTS comments;
    DROP TABLE IF EXISTS instagram_accounts;
    DROP TABLE IF EXISTS webhook_event_subjects;
    DROP TABLE IF EXISTS webhook_events;
    DROP TABLE IF EXISTS settings;
    DROP TABLE IF EXISTS d1_migrations;
  `;
}

function assertIncludes(output: string, expected: string): void {
  if (!output.includes(expected)) {
    throw new Error(`D1 smoke output did not include ${expected}`);
  }
}

function assertWranglerCount(
  output: string,
  field: string,
  expected: number,
  resultIndex: number,
): void {
  const actual = parseWranglerResults(output)[resultIndex]?.results?.[0]?.[field];
  if (actual !== expected) {
    throw new Error(`Expected ${field}=${expected}, got ${String(actual)}`);
  }
}

function assertWranglerEmptyResult(output: string, label: string, resultIndex: number): void {
  const results = parseWranglerResults(output)[resultIndex]?.results;
  if ((results?.length ?? 0) !== 0) {
    throw new Error(`Expected empty ${label}, got ${JSON.stringify(results)}`);
  }
}

function parseWranglerResults(output: string): Array<{ results?: Array<Record<string, unknown>> }> {
  const jsonStart = output.indexOf("[");
  if (jsonStart === -1) {
    throw new Error("D1 smoke output did not include JSON results");
  }

  return JSON.parse(output.slice(jsonStart)) as Array<{ results?: Array<Record<string, unknown>> }>;
}
