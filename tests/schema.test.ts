import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getTableColumns } from "drizzle-orm";
import { getTableName } from "drizzle-orm/table";
import {
  comments,
  commentProcessingDecisions,
  directMessages,
  instagramAccounts,
  mediaBackfillRuns,
  mediaCommenters,
  replyAttempts,
  replyJobs,
  replyRateLimitSlots,
  settings,
  webhookEventSubjects,
  webhookEvents,
} from "../src/db/schema";

describe("Drizzle schema", () => {
  test("mirrors SQL migrations table columns", async () => {
    const db = new Database(":memory:");
    for (const migrationPath of Array.from(new Bun.Glob("migrations/*.sql").scanSync(".")).sort()) {
      db.exec(await Bun.file(migrationPath).text());
    }

    for (const table of [
      webhookEvents,
      webhookEventSubjects,
      instagramAccounts,
      comments,
      directMessages,
      commentProcessingDecisions,
      replyJobs,
      replyAttempts,
      replyRateLimitSlots,
      mediaBackfillRuns,
      mediaCommenters,
      settings,
    ]) {
      const tableName = getTableName(table);
      const migratedColumns = db
        .query<SqliteColumn, []>(`PRAGMA table_info(${tableName})`)
        .all()
        .map((column) => ({
          name: column.name,
          notNull: column.notnull === 1 || column.pk > 0,
          type: column.type.toLowerCase(),
        }))
        .sort(byName);
      const drizzleColumns = Object.values(getTableColumns(table))
        .map((column) => ({
          name: column.name,
          notNull: column.notNull,
          type: column.getSQLType().toLowerCase(),
        }))
        .sort(byName);

      expect(drizzleColumns).toEqual(migratedColumns);
    }
  });

  test("enforces domain constraints in SQL migrations", async () => {
    const db = await migratedDatabase();
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
      INSERT INTO comments
        (id, media_id, comment_kind, commenter_id, username, username_normalized, text, created_at, source,
         last_seen_source, matched_keyword, private_reply_eligible, raw_json, inserted_at, updated_at)
      VALUES
        ('comment_1', 'media_1', 'feed', 'user_1', 'user', 'user', 'хочу',
         '2026-05-05T12:00:00.000Z', 'webhook', 'webhook', 'хочу', 1, '{}',
         '2026-05-05T12:00:00.000Z', '2026-05-05T12:00:00.000Z');
    `);
    db.exec(`
      INSERT INTO direct_messages
        (id, sender_id, recipient_id, text, created_at, source, matched_keyword, raw_json, inserted_at, updated_at)
      VALUES
        ('dm_1', 'user_dm', 'ig_account', '🦐', '2026-05-05T12:00:00.000Z', 'webhook',
         '🦐', '{}', '2026-05-05T12:00:00.000Z', '2026-05-05T12:00:00.000Z');
    `);
    db.exec(`
      INSERT INTO webhook_events
        (id, event_key, source, raw_payload, received_at, raw_payload_retention_until)
      VALUES
        ('event_dm', 'direct_message:dm_1', 'instagram', '{}',
         '2026-05-05T12:00:00.000Z', '2026-08-03T12:00:00.000Z');
    `);
    db.exec(`
      INSERT INTO webhook_event_subjects
        (event_id, subject_type, subject_value, normalized_value, created_at)
      VALUES
        ('event_dm', 'direct_message', 'dm_1', 'dm_1', '2026-05-05T12:00:00.000Z');
    `);

    expectSqlToThrow(db, `
      INSERT INTO comments
        (id, media_id, comment_kind, source, last_seen_source, private_reply_eligible, inserted_at, updated_at)
      VALUES
        ('bad_comment_source', 'media_1', 'feed', 'manual', 'manual', 0,
         '2026-05-05T12:00:00.000Z', '2026-05-05T12:00:00.000Z');
    `);
    expectSqlToThrow(db, `
      INSERT INTO reply_jobs
        (id, idempotency_key, type, comment_id, status, attempts, max_attempts, created_at, updated_at)
      VALUES
        ('bad_job_type', 'bad:comment_1', 'bad_type', 'comment_1', 'pending', 0, 3,
         '2026-05-05T12:00:00.000Z', '2026-05-05T12:00:00.000Z');
    `);
    expectSqlToThrow(db, `
      INSERT INTO reply_jobs
        (id, idempotency_key, type, comment_id, status, attempts, max_attempts, created_at, updated_at)
      VALUES
        ('bad_job_comment', 'comment_private_reply:missing', 'comment_private_reply', NULL, 'pending', 0, 3,
         '2026-05-05T12:00:00.000Z', '2026-05-05T12:00:00.000Z');
    `);
    db.exec(`
      INSERT INTO reply_jobs
        (id, idempotency_key, type, direct_message_id, status, attempts, max_attempts, created_at, updated_at)
      VALUES
        ('dm_job', 'direct_message_reply:dm_1', 'direct_message_reply', 'dm_1', 'pending', 0, 3,
         '2026-05-05T12:00:00.000Z', '2026-05-05T12:00:00.000Z');
    `);
    expectSqlToThrow(db, `
      INSERT INTO reply_jobs
        (id, idempotency_key, type, comment_id, direct_message_id, status, attempts, max_attempts, created_at, updated_at)
      VALUES
        ('bad_dm_job_target', 'direct_message_reply:bad', 'direct_message_reply', 'comment_1', 'dm_1',
         'pending', 0, 3, '2026-05-05T12:00:00.000Z', '2026-05-05T12:00:00.000Z');
    `);
    expectSqlToThrow(db, `
      INSERT INTO direct_messages
        (id, sender_id, source, inserted_at, updated_at)
      VALUES
        ('bad_dm_source', 'user_dm', 'manual', '2026-05-05T12:00:00.000Z',
         '2026-05-05T12:00:00.000Z');
    `);
    expectSqlToThrow(db, `
      INSERT INTO webhook_event_subjects
        (event_id, subject_type, subject_value, normalized_value, created_at)
      VALUES
        ('event_dm', 'bad_subject', 'value', 'value', '2026-05-05T12:00:00.000Z');
    `);
    expectSqlToThrow(db, `
      INSERT INTO instagram_accounts (id, status, updated_at)
      VALUES ('ig_account', 'unknown', '2026-05-05T12:00:00.000Z');
    `);
  });

});

async function migratedDatabase(): Promise<Database> {
  const db = new Database(":memory:");
  for (const migrationPath of Array.from(new Bun.Glob("migrations/*.sql").scanSync(".")).sort()) {
    db.exec(await Bun.file(migrationPath).text());
  }
  return db;
}

interface SqliteColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name);
}

function expectSqlToThrow(db: Database, sql: string): void {
  expect(() => db.query(sql).run()).toThrow();
}
