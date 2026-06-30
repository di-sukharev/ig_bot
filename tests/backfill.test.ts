import { describe, expect, test } from "bun:test";
import { runBackfill } from "../src/comments/backfill";
import type { AppConfig } from "../src/env";
import type { BotRepository } from "../src/db/repository";
import type { MetaGraphClient, MetaCommentsPage } from "../src/meta/client";
import type { BackfillSummary, CommentRecord, ReplyJobRecord, WorkerEnv } from "../src/types";
import { defaultAppConfig } from "./helpers/config";

describe("backfill", () => {
  test("saves stale matched comments without private replies", async () => {
    const repo = new FakeBackfillRepo();
    const meta = new FakeBackfillMeta([
      {
        data: [
          {
            id: "old_comment",
            text: "🔥",
            timestamp: "2026-04-01T12:00:00.000Z",
            from: { id: "user_1", username: "user" },
          },
        ],
      },
    ]);

    const summary = await runBackfill({
      mediaId: "media_1",
      send: true,
      config: config({ BACKFILL_REPLY_ENABLED: "true" }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(summary.matched).toBe(1);
    expect(summary.staleSavedOnly).toBe(1);
    expect(summary.eligiblePrivateReply).toBe(0);
    expect(meta.sentCommentIds).toEqual([]);
  });

  test("queues eligible backfill replies when send is enabled", async () => {
    const repo = new FakeBackfillRepo();
    const meta = new FakeBackfillMeta([
      {
        data: [
          {
            id: "fresh_comment",
            text: "🔥",
            timestamp: "2026-05-05T11:00:00.000Z",
            from: { id: "user_1", username: "user" },
          },
        ],
      },
    ]);

    const summary = await runBackfill({
      mediaId: "media_1",
      send: true,
      config: config({ BACKFILL_REPLY_ENABLED: "true" }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(summary.eligiblePrivateReply).toBe(1);
    expect(repo.jobs.get("comment_private_reply:fresh_comment")?.status).toBe("pending");
    expect(meta.sentCommentIds).toEqual([]);
  });

  test("reports eligible comments without sending when send flag is absent", async () => {
    const repo = new FakeBackfillRepo();
    const meta = new FakeBackfillMeta([
      {
        data: [
          {
            id: "fresh_comment",
            text: "🔥",
            timestamp: "2026-05-05T11:00:00.000Z",
            from: { id: "user_1", username: "user" },
          },
        ],
      },
    ]);

    const summary = await runBackfill({
      mediaId: "media_1",
      send: false,
      config: config({ BACKFILL_REPLY_ENABLED: "true" }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(summary.eligiblePrivateReply).toBe(1);
    expect(meta.sentCommentIds).toEqual([]);
  });

  test("does not create reply jobs for fresh keyword comments without commenter id", async () => {
    const repo = new FakeBackfillRepo();
    const meta = new FakeBackfillMeta([
      {
        data: [
          {
            id: "fresh_comment_no_user",
            text: "🔥",
            timestamp: "2026-05-05T11:00:00.000Z",
          },
        ],
      },
    ]);

    const summary = await runBackfill({
      mediaId: "media_1",
      send: true,
      config: config({ BACKFILL_REPLY_ENABLED: "true" }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(summary.matched).toBe(1);
    expect(summary.eligiblePrivateReply).toBe(0);
    expect(repo.jobs.size).toBe(0);
    expect(meta.sentCommentIds).toEqual([]);
  });

  test("does not create backfill reply jobs when a conversation already exists", async () => {
    const repo = new FakeBackfillRepo();
    const meta = new FakeBackfillMeta([
      {
        data: [
          {
            id: "fresh_comment",
            text: "🔥",
            timestamp: "2026-05-05T11:00:00.000Z",
            from: { id: "user_1", username: "user" },
          },
        ],
      },
    ]);
    meta.existingConversation = true;

    const summary = await runBackfill({
      mediaId: "media_1",
      send: true,
      config: config({ BACKFILL_REPLY_ENABLED: "true" }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(summary.eligiblePrivateReply).toBe(1);
    expect(repo.jobs.size).toBe(0);
    expect(meta.sentCommentIds).toEqual([]);
  });

  test("stops after configured max pages and returns cursor for resume", async () => {
    const repo = new FakeBackfillRepo();
    const meta = new FakeBackfillMeta([
      {
        data: [
          {
            id: "comment_1",
            text: "🔥",
            timestamp: "2026-05-05T11:00:00.000Z",
            from: { id: "user_1", username: "user" },
          },
        ],
        paging: { cursors: { after: "cursor_2" } },
      },
      {
        data: [
          {
            id: "comment_2",
            text: "🔥",
            timestamp: "2026-05-05T11:00:00.000Z",
            from: { id: "user_2", username: "user2" },
          },
        ],
      },
    ]);

    const summary = await runBackfill({
      mediaId: "media_1",
      send: false,
      maxPages: 1,
      config: config(),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(summary.pages).toBe(1);
    expect(summary.completed).toBe(false);
    expect(summary.nextCursor).toBe("cursor_2");
    expect(summary.total).toBe(1);
  });

  test("caps requested max pages at the configured per-run limit", async () => {
    const repo = new FakeBackfillRepo();
    const meta = new FakeBackfillMeta([
      {
        data: [
          {
            id: "comment_1",
            text: "🔥",
            timestamp: "2026-05-05T11:00:00.000Z",
            from: { id: "user_1", username: "user" },
          },
        ],
        paging: { cursors: { after: "cursor_2" } },
      },
      {
        data: [
          {
            id: "comment_2",
            text: "🔥",
            timestamp: "2026-05-05T11:00:00.000Z",
            from: { id: "user_2", username: "user2" },
          },
        ],
      },
    ]);

    const summary = await runBackfill({
      mediaId: "media_1",
      send: false,
      maxPages: 10,
      config: config({
        BACKFILL_MAX_PAGES_PER_RUN: "1",
      }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(summary.pages).toBe(1);
    expect(summary.completed).toBe(false);
    expect(summary.nextCursor).toBe("cursor_2");
    expect(meta.fetchCount).toBe(1);
  });

  test("does not fetch an extra page when resume cursor repeats", async () => {
    const repo = new FakeBackfillRepo();
    const meta = new FakeBackfillMeta([
      {
        data: [
          {
            id: "comment_1",
            text: "🔥",
            timestamp: "2026-05-05T11:00:00.000Z",
            from: { id: "user_1", username: "user" },
          },
        ],
        paging: { cursors: { after: "cursor_1" } },
      },
      {
        data: [
          {
            id: "comment_should_not_fetch",
            text: "🔥",
            timestamp: "2026-05-05T11:00:00.000Z",
            from: { id: "user_2", username: "user2" },
          },
        ],
      },
    ]);

    const summary = await runBackfill({
      mediaId: "media_1",
      send: false,
      afterCursor: "cursor_1",
      maxPages: 25,
      config: config(),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(summary.pages).toBe(1);
    expect(summary.completed).toBe(true);
    expect(summary.total).toBe(1);
    expect(meta.fetchCount).toBe(1);
  });
});

class FakeBackfillRepo {
  comments = new Map<string, CommentRecord>();
  jobs = new Map<string, ReplyJobRecord>();
  summaries: BackfillSummary[] = [];
  commenters = new Map<string, { lastCommentAt?: string }>();

  async createBackfillRun() {
    return "run_1";
  }

  async updateBackfillRun(summary: BackfillSummary) {
    this.summaries.push(summary);
  }

  async updateBackfillCursor() {}

  async upsertMediaCommenter(input: {
    mediaId: string;
    commenterId: string;
    lastCommentAt?: string;
  }) {
    const key = `${input.mediaId}:${input.commenterId}`;
    const existing = this.commenters.get(key);
    if (!existing || !existing.lastCommentAt || (input.lastCommentAt && input.lastCommentAt > existing.lastCommentAt)) {
      this.commenters.set(key, { lastCommentAt: input.lastCommentAt });
    }
  }

  async upsertComment(comment: CommentRecord) {
    const inserted = !this.comments.has(comment.id);
    this.comments.set(comment.id, comment);
    return { inserted };
  }

  async createReplyJob(input: {
    commentId: string;
    type?: ReplyJobRecord["type"];
    replyText?: string;
    publicSuccessReplyText?: string;
    maxAttempts: number;
    now: string;
  }) {
    const type = input.type ?? "comment_private_reply";
    const idempotencyKey = `${type}:${input.commentId}`;
    const existing = this.jobs.get(idempotencyKey);
    if (existing) {
      return { job: existing, inserted: false };
    }

    const job: ReplyJobRecord = {
      id: `job_${this.jobs.size + 1}`,
      idempotencyKey,
      type,
      commentId: input.commentId,
      replyText: input.replyText,
      publicSuccessReplyText: input.publicSuccessReplyText,
      status: "pending",
      attempts: 0,
      maxAttempts: input.maxAttempts,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.jobs.set(idempotencyKey, job);
    return { job, inserted: true };
  }

  async getReplyJob(id: string) {
    return [...this.jobs.values()].find((job) => job.id === id);
  }

  async getAccountStatus() {
    return "active";
  }

  async getComment(id: string) {
    return this.comments.get(id);
  }

  async reserveReplyRateLimitSlot() {
    return true;
  }

  async claimReplyJobForSending(input: { id: string }) {
    const job = [...this.jobs.values()].find((item) => item.id === input.id);
    if (job) {
      job.status = "sending";
      return true;
    }
    return false;
  }

  async markReplyAttemptStarted(input: { id: string; attempt: number }) {
    const job = [...this.jobs.values()].find((item) => item.id === input.id);
    if (job) {
      job.attempts = input.attempt;
    }
  }

  async markReplySent(input: { id: string; recipientId?: string; messageId?: string; now: string }) {
    const job = [...this.jobs.values()].find((item) => item.id === input.id);
    if (job) {
      job.status = "sent";
      job.metaRecipientId = input.recipientId;
      job.metaMessageId = input.messageId;
      job.sentAt = input.now;
    }
  }

  async markReplyNotSent(input: {
    id: string;
    status: ReplyJobRecord["status"];
    error: string;
    nextRetryAt?: string;
  }) {
    const job = [...this.jobs.values()].find((item) => item.id === input.id);
    if (job) {
      job.status = input.status;
      job.lastError = input.error;
      job.nextRetryAt = input.nextRetryAt;
    }
  }

  async recordReplyAttempt() {}

  async recordCommentProcessingDecision() {}
}

class FakeBackfillMeta {
  sentCommentIds: string[] = [];
  existingConversation = false;
  fetchCount = 0;
  private pageIndex = 0;

  constructor(private readonly pages: MetaCommentsPage[]) {}

  async getComments() {
    this.fetchCount += 1;
    return this.pages[this.pageIndex++] ?? { data: [] };
  }

  async sendPrivateReply(commentId: string) {
    this.sentCommentIds.push(commentId);
    return { recipient_id: "user_1", message_id: "message_1" };
  }

  async sendPublicReply() {
    return { id: "public_reply_1" };
  }

  async hasConversationWithUser() {
    return this.existingConversation;
  }
}

function config(overrides: Partial<WorkerEnv> = {}): AppConfig {
  return defaultAppConfig({
    COMMENT_PRIVATE_REPLY_ENABLED: "true",
    ...overrides,
  });
}
