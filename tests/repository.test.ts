import { describe, expect, test } from "bun:test";
import { SqliteD1 } from "./helpers/sqlite-d1";
import { DrizzleRepository } from "../src/db/repository";
import type { CommentRecord, DirectMessageRecord } from "../src/types";

describe("DrizzleRepository", () => {
  test("keeps webhook insert idempotent by event key", async () => {
    const { repo } = await createRepository();
    const first = await repo.insertWebhookEvent({
      id: "event_1",
      eventKey: "instagram:comment:1",
      source: "instagram",
      rawPayload: "{}",
      receivedAt: "2026-05-05T12:00:00.000Z",
    });
    const duplicate = await repo.insertWebhookEvent({
      id: "event_2",
      eventKey: "instagram:comment:1",
      source: "instagram",
      rawPayload: "{\"changed\":true}",
      receivedAt: "2026-05-05T12:01:00.000Z",
    });

    expect(first).toEqual({ id: "event_1", inserted: true });
    expect(duplicate).toEqual({ id: "event_1", inserted: false });
  });

  test("keeps old insert-or-ignore behavior for webhook primary key conflicts", async () => {
    const { db, repo } = await createRepository();
    await repo.insertWebhookEvent({
      id: "event_1",
      eventKey: "instagram:comment:1",
      source: "instagram",
      rawPayload: "{}",
      receivedAt: "2026-05-05T12:00:00.000Z",
    });

    const primaryKeyConflict = await repo.insertWebhookEvent({
      id: "event_1",
      eventKey: "instagram:comment:2",
      source: "instagram",
      rawPayload: JSON.stringify({
        value: { id: "comment_2", from: { id: "user_2", username: "Other" } },
      }),
      receivedAt: "2026-05-05T12:01:00.000Z",
    });

    expect(primaryKeyConflict).toEqual({ id: "event_1", inserted: false });
    await expect(repo.getWebhookEvent("event_1")).resolves.toMatchObject({
      eventKey: "instagram:comment:1",
      rawPayload: "{}",
    });
    expect(db.first<{ count: number }>(
      "SELECT COUNT(*) as count FROM webhook_event_subjects WHERE normalized_value IN ('comment_2', 'user_2', 'other')",
    )).toEqual({ count: 0 });
  });

  test("claims stale webhook events for retry without touching fresh or exhausted events", async () => {
    const { db, repo } = await createRepository();
    await repo.insertWebhookEvent({
      id: "event_received_old",
      eventKey: "event:received-old",
      source: "instagram",
      rawPayload: "{}",
      receivedAt: "2026-05-05T12:00:00.000Z",
    });
    await repo.insertWebhookEvent({
      id: "event_processing_old",
      eventKey: "event:processing-old",
      source: "instagram",
      rawPayload: "{}",
      receivedAt: "2026-05-05T12:01:00.000Z",
    });
    await repo.markWebhookProcessing("event_processing_old", "2026-05-05T12:02:00.000Z");
    await repo.insertWebhookEvent({
      id: "event_failed_old",
      eventKey: "event:failed-old",
      source: "instagram",
      rawPayload: "{}",
      receivedAt: "2026-05-05T12:02:00.000Z",
    });
    await repo.markWebhookProcessing("event_failed_old", "2026-05-05T12:03:00.000Z");
    await repo.markWebhookFailed("event_failed_old", "temporary failure");
    await repo.insertWebhookEvent({
      id: "event_received_fresh",
      eventKey: "event:received-fresh",
      source: "instagram",
      rawPayload: "{}",
      receivedAt: "2026-05-05T12:15:00.000Z",
    });
    await repo.insertWebhookEvent({
      id: "event_failed_exhausted",
      eventKey: "event:failed-exhausted",
      source: "instagram",
      rawPayload: "{}",
      receivedAt: "2026-05-05T11:59:00.000Z",
    });
    await repo.markWebhookProcessing("event_failed_exhausted", "2026-05-05T12:00:00.000Z");
    await repo.markWebhookFailed("event_failed_exhausted", "still failing");
    db.run("UPDATE webhook_events SET attempts = 3 WHERE id = 'event_failed_exhausted'");

    const claimed = await repo.claimStaleWebhookEventsForRetry({
      now: "2026-05-05T12:20:00.000Z",
      staleReceivedBefore: "2026-05-05T12:10:00.000Z",
      staleProcessingBefore: "2026-05-05T12:10:00.000Z",
      maxAttempts: 3,
      limit: 10,
    });

    expect(claimed).toEqual([
      "event_received_old",
      "event_processing_old",
      "event_failed_old",
    ]);
    const rows = await db
      .prepare(
        "SELECT id, status, processing_started_at, last_error FROM webhook_events ORDER BY received_at",
      )
      .bind()
      .all();
    expect(rows.results).toMatchObject([
      {
        id: "event_failed_exhausted",
        status: "failed",
        last_error: "still failing",
      },
      {
        id: "event_received_old",
        status: "processing",
        processing_started_at: "2026-05-05T12:20:00.000Z",
        last_error: null,
      },
      {
        id: "event_processing_old",
        status: "processing",
        processing_started_at: "2026-05-05T12:20:00.000Z",
        last_error: null,
      },
      {
        id: "event_failed_old",
        status: "processing",
        processing_started_at: "2026-05-05T12:20:00.000Z",
        last_error: null,
      },
      {
        id: "event_received_fresh",
        status: "received",
        processing_started_at: null,
        last_error: null,
      },
    ]);
  });

  test("updates comments while preserving existing matched keyword when update has none", async () => {
    const { repo } = await createRepository();

    await expect(repo.upsertComment(comment("comment_1"), "2026-05-05T12:00:00.000Z"))
      .resolves.toEqual({ inserted: true });
    await expect(repo.upsertComment(
      comment("comment_1", {
        source: "backfill",
        matchedKeyword: undefined,
        privateReplyEligible: false,
        raw: { edited: true },
        text: undefined,
        username: undefined,
      }),
      "2026-05-05T12:01:00.000Z",
    )).resolves.toEqual({ inserted: false });

    await expect(repo.getComment("comment_1")).resolves.toEqual({
      id: "comment_1",
      mediaId: "media_1",
      commenterId: "user_1",
      username: undefined,
      text: undefined,
      createdAt: "2026-05-05T12:00:00.000Z",
      source: "webhook",
      lastSeenSource: "backfill",
      commentKind: "feed",
      matchedKeyword: "хочу",
      privateReplyEligible: false,
      raw: { edited: true },
    });
  });

  test("reports and anonymizes stored data for a commenter", async () => {
    const { db, repo } = await createRepository();
    await repo.insertWebhookEvent({
      id: "event_1",
      eventKey: "comment:comment_1",
      source: "instagram",
      rawPayload: JSON.stringify({ value: { id: "comment_1", from: { id: "user_1", username: "User" } } }),
      receivedAt: "2026-05-05T12:00:00.000Z",
    });
    await repo.upsertComment(comment("comment_1", { username: "User" }), "2026-05-05T12:00:00.000Z");
    await repo.upsertMediaCommenter({
      mediaId: "media_1",
      commenterId: "user_1",
      username: "User",
      commentId: "comment_1",
      lastCommentAt: "2026-05-05T12:00:00.000Z",
      now: "2026-05-05T12:00:00.000Z",
    });
    const { job } = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_private_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });
    await repo.markReplySent({
      id: job.id,
      recipientId: "user_1",
      messageId: "message_1",
      now: "2026-05-05T12:01:00.000Z",
    });
    await repo.markReplyNotSent({
      id: job.id,
      status: "retryable",
      error: "User specific last error",
      nextRetryAt: "2026-05-05T12:05:00.000Z",
      now: "2026-05-05T12:01:30.000Z",
    });
    await repo.recordReplyAttempt({
      replyJobId: job.id,
      attemptNumber: 1,
      status: "sent",
      responseSummary: JSON.stringify({ recipient_id: "user_1" }),
      errorMessage: "User specific detail",
      now: "2026-05-05T12:01:00.000Z",
    });

    await expect(repo.getDataSubjectReport({ username: "user" })).resolves.toMatchObject({
      commentIds: ["comment_1"],
      commenterIds: ["user_1"],
      usernames: ["user"],
      replyJobIds: [job.id],
      webhookEventIds: ["event_1"],
      counts: {
        comments: 1,
        directMessages: 0,
        mediaCommenters: 1,
        replyJobs: 1,
        commentProcessingDecisions: 0,
        replyRateLimitSlots: 0,
        replyAttempts: 1,
        webhookEvents: 1,
        webhookEventSubjects: 3,
      },
    });

    const result = await repo.anonymizeDataSubject(
      { commenterId: "user_1" },
      "2026-05-05T12:02:00.000Z",
    );

    expect(result.redacted).toEqual({
      comments: 1,
      directMessages: 0,
      mediaCommenters: 1,
      replyJobs: 1,
      commentProcessingDecisions: 0,
      replyRateLimitSlots: 0,
      replyAttempts: 1,
      webhookEvents: 1,
      webhookEventSubjects: 3,
    });
    expect(db.first<{ count: number }>(
      "SELECT COUNT(*) as count FROM comments WHERE id = ?",
      "comment_1",
    )).toEqual({ count: 0 });
    expect(db.first<{ count: number }>(
      "SELECT COUNT(*) as count FROM media_commenters WHERE commenter_id = ?",
      "user_1",
    )).toEqual({ count: 0 });
    expect(db.first<{ count: number }>(
      "SELECT COUNT(*) as count FROM reply_jobs WHERE id = ?",
      job.id,
    )).toEqual({ count: 0 });
    expect(db.first<{ count: number }>(
      "SELECT COUNT(*) as count FROM reply_attempts WHERE reply_job_id = ?",
      job.id,
    )).toEqual({ count: 0 });
    expect(db.first<{ event_key: string; raw_payload_redacted_at: string | null }>(
      "SELECT event_key, raw_payload_redacted_at FROM webhook_events WHERE id = ?",
      "event_1",
    )).toEqual({
      event_key: "redacted:event_1",
      raw_payload_redacted_at: "2026-05-05T12:02:00.000Z",
    });
    expect(db.first<{ count: number }>(
      "SELECT COUNT(*) as count FROM webhook_event_subjects WHERE normalized_value IN ('comment_1', 'user_1', 'user')",
    )).toEqual({ count: 0 });
  });

  test("reports and anonymizes stored data for a direct message sender", async () => {
    const { db, repo } = await createRepository();
    await repo.insertWebhookEvent({
      id: "event_dm",
      eventKey: "direct_message:dm_1",
      source: "instagram",
      rawPayload: JSON.stringify({
        entry: [
          {
            messaging: [
              {
                sender: { id: "user_dm" },
                recipient: { id: "ig_account" },
                message: { mid: "dm_1", text: "🦐" },
              },
            ],
          },
        ],
      }),
      receivedAt: "2026-05-05T12:00:00.000Z",
    });
    await repo.upsertDirectMessage(directMessage("dm_1"), "2026-05-05T12:00:00.000Z");
    const { job } = await repo.createReplyJob({
      directMessageId: "dm_1",
      type: "direct_message_reply",
      replyText: "dm reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });
    await repo.recordReplyAttempt({
      replyJobId: job.id,
      attemptNumber: 1,
      status: "sent",
      responseSummary: JSON.stringify({ recipient_id: "user_dm" }),
      now: "2026-05-05T12:01:00.000Z",
    });

    await expect(repo.getDataSubjectReport({ commenterId: "user_dm" })).resolves.toMatchObject({
      directMessageIds: ["dm_1"],
      commenterIds: ["user_dm"],
      replyJobIds: [job.id],
      webhookEventIds: ["event_dm"],
      counts: {
        comments: 0,
        directMessages: 1,
        mediaCommenters: 0,
        replyJobs: 1,
        replyAttempts: 1,
        webhookEvents: 1,
        webhookEventSubjects: 2,
      },
    });

    const result = await repo.anonymizeDataSubject(
      { directMessageId: "dm_1" },
      "2026-05-05T12:02:00.000Z",
    );

    expect(result.redacted.directMessages).toBe(1);
    expect(result.redacted.replyJobs).toBe(1);
    expect(result.redacted.replyAttempts).toBe(1);
    expect(db.first<{ count: number }>(
      "SELECT COUNT(*) as count FROM direct_messages WHERE id = ?",
      "dm_1",
    )).toEqual({ count: 0 });
    expect(db.first<{ count: number }>(
      "SELECT COUNT(*) as count FROM webhook_event_subjects WHERE normalized_value IN ('dm_1', 'user_dm')",
    )).toEqual({ count: 0 });
  });

  test("matches webhook events through structured subjects instead of raw substrings", async () => {
    const { repo } = await createRepository();
    await repo.insertWebhookEvent({
      id: "event_subject",
      eventKey: "comment:comment_1",
      source: "instagram",
      rawPayload: JSON.stringify({
        entry: [{
          changes: [{
            field: "comments",
            value: {
              id: "comment_1",
              from: { id: "user_1", username: "Ann" },
              text: "hello",
            },
          }],
        }],
      }),
      receivedAt: "2026-05-05T12:00:00.000Z",
    });
    await repo.insertWebhookEvent({
      id: "event_substring_only",
      eventKey: "comment:comment_2",
      source: "instagram",
      rawPayload: JSON.stringify({
        entry: [{
          changes: [{
            field: "comments",
            value: {
              id: "comment_2",
              from: { id: "user_2", username: "Bob" },
              text: "ann appears only in free text",
            },
          }],
        }],
      }),
      receivedAt: "2026-05-05T12:00:00.000Z",
    });

    await expect(repo.getDataSubjectReport({ username: "ann" })).resolves.toMatchObject({
      webhookEventIds: ["event_subject"],
      counts: {
        webhookEvents: 1,
        webhookEventSubjects: 1,
      },
    });
  });

  test("redacts expired webhook raw payloads during retention cleanup", async () => {
    const { db, repo } = await createRepository();
    await repo.insertWebhookEvent({
      id: "event_old",
      eventKey: "comment:old",
      source: "instagram",
      rawPayload: JSON.stringify({ value: { id: "old", from: { id: "old_user", username: "Old" } } }),
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    await repo.insertWebhookEvent({
      id: "event_new",
      eventKey: "comment:new",
      source: "instagram",
      rawPayload: JSON.stringify({ value: { id: "new" } }),
      receivedAt: "2026-05-01T00:00:00.000Z",
    });

    await expect(repo.redactExpiredWebhookPayloads("2026-05-06T00:00:00.000Z", 10)).resolves.toBe(1);
    expect(db.first<{ event_key: string; raw_payload: string; raw_payload_redacted_at: string | null }>(
      "SELECT event_key, raw_payload, raw_payload_redacted_at FROM webhook_events WHERE id = ?",
      "event_old",
    )).toEqual({
      event_key: "retention-redacted:event_old",
      raw_payload: JSON.stringify({ redacted: true, reason: "retention_expired", redactedAt: "2026-05-06T00:00:00.000Z" }),
      raw_payload_redacted_at: "2026-05-06T00:00:00.000Z",
    });
    expect(db.first<{ raw_payload_redacted_at: string | null }>(
      "SELECT raw_payload_redacted_at FROM webhook_events WHERE id = ?",
      "event_new",
    )).toEqual({ raw_payload_redacted_at: null });
    expect(db.first<{ count: number }>(
      "SELECT COUNT(*) as count FROM webhook_event_subjects WHERE event_id = ?",
      "event_old",
    )).toEqual({ count: 0 });
  });

  test("chunks high-cardinality subject redaction", async () => {
    const { db, repo } = await createRepository();
    const commentIds = Array.from({ length: 85 }, (_, index) => `bulk_comment_${index}`);
    for (const id of commentIds) {
      await repo.upsertComment(
        comment(id, { commenterId: "bulk_user", username: "BulkUser" }),
        "2026-05-05T12:00:00.000Z",
      );
    }

    await expect(repo.getDataSubjectReport({ commenterId: "bulk_user" })).resolves.toMatchObject({
      counts: { comments: 85 },
    });
    await expect(repo.anonymizeDataSubject(
      { commenterId: "bulk_user" },
      "2026-05-05T12:10:00.000Z",
    )).resolves.toMatchObject({
      redacted: { comments: 85 },
    });
    expect(db.first<{ count: number }>(
      "SELECT COUNT(*) as count FROM comments WHERE commenter_id = ?",
      "bulk_user",
    )).toEqual({ count: 0 });
  });

  test("keeps reply jobs idempotent by type and comment", async () => {
    const { repo } = await createRepository();
    await repo.upsertComment(comment("comment_1"), "2026-05-05T12:00:00.000Z");

    const first = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_private_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });
    const duplicate = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_private_reply",
      maxAttempts: 5,
      now: "2026-05-05T12:01:00.000Z",
    });

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    expect(duplicate.job.maxAttempts).toBe(3);
  });

  test("persists fixed reply text and processing decisions", async () => {
    const { db, repo } = await createRepository();
    await repo.upsertComment(comment("comment_1"), "2026-05-05T12:00:00.000Z");
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_private_reply",
      replyText: "fixed text",
      publicSuccessReplyText: "fixed public success",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    await repo.recordCommentProcessingDecision({
      commentId: "comment_1",
      source: "reconciler",
      matchedKeyword: "хочу",
      action: "jobs_created",
      createdJobTypes: ["comment_private_reply"],
      createdAt: "2026-05-05T12:00:00.000Z",
    });

    await expect(repo.getReplyJob(created.job.id)).resolves.toMatchObject({
      replyText: "fixed text",
      publicSuccessReplyText: "fixed public success",
    });
    expect(db.first<{ source: string; action: string; created_job_types_json: string }>(
      "SELECT source, action, created_job_types_json FROM comment_processing_decisions WHERE comment_id = ?",
      "comment_1",
    )).toEqual({
      source: "reconciler",
      action: "jobs_created",
      created_job_types_json: JSON.stringify(["comment_private_reply"]),
    });
  });

  test("persists reconciler status and reply error summaries", async () => {
    const { repo } = await createRepository();
    await repo.upsertComment(comment("comment_1"), "2026-05-05T12:00:00.000Z");
    const failed = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_private_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });
    await repo.recordReplyAttempt({
      replyJobId: failed.job.id,
      attemptNumber: 1,
      status: "failed",
      httpStatus: 400,
      metaCode: 100,
      metaSubcode: 2534025,
      errorMessage: "invalid",
      now: "2026-05-05T12:01:00.000Z",
    });
    await repo.markReplyNotSent({
      id: failed.job.id,
      status: "blocked",
      error: "private_reply_invalid",
      now: "2026-05-05T12:01:00.000Z",
    });
    await repo.recordReconcilerRun({
      startedAt: "2026-05-05T12:00:00.000Z",
      finishedAt: "2026-05-05T12:01:00.000Z",
      mediaScanned: 1,
      commentsScanned: 2,
      commentsRecovered: 1,
      replyJobsCreated: 1,
      errors: 0,
    });

    await expect(repo.getLastReconcilerRun()).resolves.toMatchObject({
      mediaScanned: 1,
      replyJobsCreated: 1,
    });
    await expect(repo.getReplyDeliverySummary("2026-05-05T00:00:00.000Z"))
      .resolves.toMatchObject({
        private: { blocked: 1 },
      });
    await expect(repo.getTopReplyErrors("2026-05-05T00:00:00.000Z", 5))
      .resolves.toEqual([
        {
          type: "comment_private_reply",
          status: "blocked",
          lastError: "private_reply_invalid",
          httpStatus: 400,
          metaCode: 100,
          metaSubcode: 2534025,
          count: 1,
        },
      ]);
  });

  test("persists reconciler checkpoint state in settings", async () => {
    const { repo } = await createRepository();

    await repo.saveReconcilerCheckpointState({
      version: 1,
      media: {
        media_1: {
          newestCommentAt: "2026-05-05T11:59:00.000Z",
          newestCommentIds: ["comment_1", "comment_2"],
          lastScannedAt: "2026-05-05T12:00:00.000Z",
        },
      },
    });

    await expect(repo.getReconcilerCheckpointState()).resolves.toEqual({
      version: 1,
      media: {
        media_1: {
          newestCommentAt: "2026-05-05T11:59:00.000Z",
          newestCommentIds: ["comment_1", "comment_2"],
          lastScannedAt: "2026-05-05T12:00:00.000Z",
        },
      },
    });
  });

  test("treats missing or malformed reconciler checkpoint state as empty", async () => {
    const { db, repo } = await createRepository();

    await expect(repo.getReconcilerCheckpointState()).resolves.toEqual({
      version: 1,
      media: {},
    });

    db.run(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('reconciler:comment_checkpoints', '{bad json', '2026-05-05T12:00:00.000Z')
    `);

    await expect(repo.getReconcilerCheckpointState()).resolves.toEqual({
      version: 1,
      media: {},
    });
  });

  test("rejects reply jobs without comment id", async () => {
    const { db } = await createRepository();

    expect(() => db.run(`
      INSERT INTO reply_jobs
        (id, idempotency_key, type, comment_id, status, attempts, max_attempts, created_at, updated_at)
      VALUES
        ('invalid_job', 'comment_private_reply:missing', 'comment_private_reply',
         NULL, 'pending', 0, 3, '2026-05-05T12:00:00.000Z', '2026-05-05T12:00:00.000Z');
    `)).toThrow();
  });

  test("reserves rate-limit slots by bucket and slot", async () => {
    const { repo } = await createRepository();
    await repo.upsertComment(comment("comment_1"), "2026-05-05T12:00:00.000Z");
    const first = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_private_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });
    const second = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_public_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    await expect(repo.reserveReplyRateLimitSlot({
      bucket: "2026-05-05T12:00",
      limit: 1,
      replyJobId: first.job.id,
      now: "2026-05-05T12:00:00.000Z",
    })).resolves.toBe(true);
    await expect(repo.reserveReplyRateLimitSlot({
      bucket: "2026-05-05T12:00",
      limit: 1,
      replyJobId: second.job.id,
      now: "2026-05-05T12:00:01.000Z",
    })).resolves.toBe(false);
  });

  test("claims pending jobs once and allows stale sending recovery", async () => {
    const { repo } = await createRepository();
    await repo.upsertComment(comment("comment_1"), "2026-05-05T12:00:00.000Z");
    const { job } = await repo.createReplyJob({
      commentId: "comment_1",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    await expect(repo.claimReplyJobForSending({
      id: job.id,
      now: "2026-05-05T12:01:00.000Z",
      staleSendingBefore: "2026-05-05T11:51:00.000Z",
    })).resolves.toBe(true);
    await expect(repo.claimReplyJobForSending({
      id: job.id,
      now: "2026-05-05T12:02:00.000Z",
      staleSendingBefore: "2026-05-05T11:52:00.000Z",
    })).resolves.toBe(false);
    await expect(repo.claimReplyJobForSending({
      id: job.id,
      now: "2026-05-05T12:12:00.000Z",
      staleSendingBefore: "2026-05-05T12:02:00.000Z",
    })).resolves.toBe(true);
  });

  test("marks reply jobs and records attempts", async () => {
    const { db, repo } = await createRepository();
    await repo.upsertComment(comment("comment_1"), "2026-05-05T12:00:00.000Z");
    const sent = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_private_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });
    const retryable = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_public_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    await repo.markReplyAttemptStarted({
      id: sent.job.id,
      attempt: 1,
      now: "2026-05-05T12:01:00.000Z",
    });
    await repo.markReplySent({
      id: sent.job.id,
      recipientId: "recipient_1",
      messageId: "message_1",
      now: "2026-05-05T12:02:00.000Z",
    });
    await repo.markReplyNotSent({
      id: retryable.job.id,
      status: "retryable",
      error: "rate_limit",
      nextRetryAt: "2026-05-05T12:10:00.000Z",
      now: "2026-05-05T12:02:00.000Z",
    });
    await repo.recordReplyAttempt({
      replyJobId: retryable.job.id,
      attemptNumber: 1,
      status: "retryable",
      httpStatus: 429,
      metaCode: 4,
      fbtraceId: "trace_1",
      responseSummary: "Too many requests",
      errorMessage: "rate_limit",
      now: "2026-05-05T12:02:00.000Z",
    });

    await expect(repo.getReplyJob(sent.job.id)).resolves.toMatchObject({
      status: "sent",
      attempts: 1,
      metaRecipientId: "recipient_1",
      metaMessageId: "message_1",
      sentAt: "2026-05-05T12:02:00.000Z",
      sendingStartedAt: undefined,
    });
    await expect(repo.getReplyJob(retryable.job.id)).resolves.toMatchObject({
      status: "retryable",
      lastError: "rate_limit",
      nextRetryAt: "2026-05-05T12:10:00.000Z",
    });
    expect(db.first<{ count: number }>(
      "SELECT COUNT(*) as count FROM reply_attempts WHERE reply_job_id = ? AND http_status = 429",
      retryable.job.id,
    )).toEqual({ count: 1 });
  });

  test("summarizes backlog and blocks due jobs by disabled types", async () => {
    const { repo } = await createRepository();
    await repo.upsertComment(comment("comment_1"), "2026-05-05T12:00:00.000Z");
    const privateJob = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_private_reply",
      maxAttempts: 3,
      now: "2026-05-05T11:59:00.000Z",
    });
    const publicJob = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_public_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });
    await repo.claimReplyJobForSending({
      id: publicJob.job.id,
      now: "2026-05-05T12:00:00.000Z",
      staleSendingBefore: "2026-05-05T11:50:00.000Z",
    });

    await expect(repo.getReplyJobBacklog(
      "2026-05-05T12:02:00.000Z",
      "2026-05-05T12:01:00.000Z",
    )).resolves.toMatchObject({
      counts: {
        pending: 1,
        sending: 1,
        sent: 0,
        retryable: 0,
        failed: 0,
        blocked: 0,
      },
      due: 2,
      oldestDueCreatedAt: "2026-05-05T11:59:00.000Z",
    });

    await expect(repo.blockReplyJobsForTypes({
      types: ["comment_private_reply"],
      error: "reply_type_disabled",
      now: "2026-05-05T12:03:00.000Z",
      staleSendingBefore: "2026-05-05T12:01:00.000Z",
    })).resolves.toBe(1);
    await expect(repo.getReplyJob(privateJob.job.id)).resolves.toMatchObject({
      status: "blocked",
      lastError: "reply_type_disabled",
    });
  });

  test("blocks historical terminal Meta failures without touching retryable failures", async () => {
    const { repo } = await createRepository();
    await repo.upsertComment(comment("public_comment"), "2026-05-05T12:00:00.000Z");
    await repo.upsertComment(comment("private_comment"), "2026-05-05T12:00:00.000Z");
    await repo.upsertComment(comment("temporary_comment"), "2026-05-05T12:00:00.000Z");
    const publicJob = await repo.createReplyJob({
      commentId: "public_comment",
      type: "comment_public_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });
    const privateJob = await repo.createReplyJob({
      commentId: "private_comment",
      type: "comment_private_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });
    const temporaryJob = await repo.createReplyJob({
      commentId: "temporary_comment",
      type: "comment_public_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });
    await repo.markReplyNotSent({
      id: publicJob.job.id,
      status: "failed",
      error: "Meta object was unavailable",
      nextRetryAt: "2026-05-05T12:10:00.000Z",
      now: "2026-05-05T12:01:00.000Z",
    });
    await repo.recordReplyAttempt({
      replyJobId: publicJob.job.id,
      attemptNumber: 1,
      status: "failed",
      httpStatus: 400,
      metaCode: 100,
      metaSubcode: 33,
      errorMessage: "Meta object was unavailable",
      now: "2026-05-05T12:01:00.000Z",
    });
    await repo.markReplyNotSent({
      id: privateJob.job.id,
      status: "failed",
      error: "The requested user cannot be found.",
      nextRetryAt: "2026-05-05T12:10:00.000Z",
      now: "2026-05-05T12:01:00.000Z",
    });
    await repo.markReplyNotSent({
      id: temporaryJob.job.id,
      status: "failed",
      error: "temporary outage",
      nextRetryAt: "2026-05-05T12:10:00.000Z",
      now: "2026-05-05T12:01:00.000Z",
    });

    await expect(repo.blockTerminalFailedReplyJobs("2026-05-05T12:20:00.000Z")).resolves.toBe(2);
    await expect(repo.getReplyJob(publicJob.job.id)).resolves.toMatchObject({
      status: "blocked",
      lastError: "meta_object_unavailable",
      nextRetryAt: undefined,
      updatedAt: "2026-05-05T12:20:00.000Z",
    });
    await expect(repo.getReplyJob(privateJob.job.id)).resolves.toMatchObject({
      status: "blocked",
      lastError: "meta_recipient_unavailable",
      nextRetryAt: undefined,
      updatedAt: "2026-05-05T12:20:00.000Z",
    });
    await expect(repo.getReplyJob(temporaryJob.job.id)).resolves.toMatchObject({
      status: "failed",
      lastError: "temporary outage",
      nextRetryAt: "2026-05-05T12:10:00.000Z",
      updatedAt: "2026-05-05T12:01:00.000Z",
    });
  });

  test("updates backfill cursor and summary fields", async () => {
    const { db, repo } = await createRepository();
    const runId = await repo.createBackfillRun(
      "media_1",
      true,
      "2026-05-05T12:00:00.000Z",
    );

    await repo.updateBackfillCursor(runId, "cursor_2");
    await repo.updateBackfillRun({
      runId,
      mediaId: "media_1",
      sendEnabled: true,
      total: 10,
      matched: 4,
      eligiblePrivateReply: 3,
      staleSavedOnly: 1,
      duplicates: 2,
      errors: 1,
      pages: 5,
      completed: true,
    }, "finished");

    const row = db.first<{
      after_cursor: string | null;
      total_count: number;
      matched_count: number;
      page_count: number;
      completed: number;
      status: string;
    }>("SELECT after_cursor, total_count, matched_count, page_count, completed, status FROM media_backfill_runs WHERE id = ?", runId);

    expect(row).toEqual({
      after_cursor: "cursor_2",
      total_count: 10,
      matched_count: 4,
      page_count: 5,
      completed: 1,
      status: "finished",
    });
  });

  test("filters due reply jobs by enabled type before stale sending branch", async () => {
    const { db, repo } = await createRepository();
    db.exec(`
      INSERT INTO comments
        (id, media_id, comment_kind, commenter_id, username, username_normalized, text, created_at, source,
         last_seen_source, matched_keyword, private_reply_eligible, raw_json, inserted_at, updated_at)
      VALUES
        ('private_comment', 'media_1', 'feed', 'user_1', 'user', 'user', 'хочу',
         '2026-05-05T11:00:00.000Z', 'webhook', 'webhook', 'хочу', 1, '{}',
         '2026-05-05T11:00:00.000Z', '2026-05-05T11:00:00.000Z'),
        ('public_comment', 'media_1', 'feed', 'user_2', 'user2', 'user2', 'хочу',
         '2026-05-05T11:59:00.000Z', 'webhook', 'webhook', 'хочу', 1, '{}',
         '2026-05-05T11:59:00.000Z', '2026-05-05T11:59:00.000Z');

      INSERT INTO reply_jobs
        (id, idempotency_key, type, comment_id, status, attempts, max_attempts,
         created_at, updated_at, sending_started_at)
      VALUES
        ('private_job', 'comment_private_reply:private_comment', 'comment_private_reply',
         'private_comment', 'sending', 0, 3,
         '2026-05-05T11:00:00.000Z', '2026-05-05T11:00:00.000Z',
         '2026-05-05T11:40:00.000Z'),
        ('public_job', 'comment_public_reply:public_comment', 'comment_public_reply',
         'public_comment', 'pending', 0, 3,
         '2026-05-05T11:59:00.000Z', '2026-05-05T11:59:00.000Z',
         NULL);
    `);

    const dueJobs = await repo.listDueReplyJobs(
      "2026-05-05T12:01:00.000Z",
      10,
      "2026-05-05T11:51:00.000Z",
      ["comment_public_reply"],
    );

    expect(dueJobs.map((job) => job.id)).toEqual(["public_job"]);
  });
});

async function createRepository(): Promise<{ db: SqliteD1; repo: DrizzleRepository }> {
  const db = new SqliteD1();
  for (const migrationPath of Array.from(new Bun.Glob("migrations/*.sql").scanSync(".")).sort()) {
    db.exec(await Bun.file(migrationPath).text());
  }

  return {
    db,
    repo: new DrizzleRepository(db as unknown as D1Database),
  };
}

function comment(id: string, overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    id,
    mediaId: "media_1",
    commentKind: "feed" as const,
    commenterId: "user_1",
    username: "user",
    text: "хочу",
    createdAt: "2026-05-05T12:00:00.000Z",
    source: "webhook" as const,
    matchedKeyword: "хочу",
    privateReplyEligible: true,
    raw: {},
    ...overrides,
  };
}

function directMessage(
  id: string,
  overrides: Partial<DirectMessageRecord> = {},
): DirectMessageRecord {
  return {
    id,
    senderId: "user_dm",
    recipientId: "ig_account",
    text: "🦐",
    createdAt: "2026-05-05T12:00:00.000Z",
    source: "webhook" as const,
    matchedKeyword: "🦐",
    raw: {},
    ...overrides,
  };
}
