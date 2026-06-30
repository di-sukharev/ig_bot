import { describe, expect, test } from "bun:test";
import {
  drainDueReplyJobs,
  queueWebhookComments,
  queueWebhookDirectMessages,
  runFreshCommentReconciler,
  runScheduledMaintenanceWithDependencies,
  runTokenHealthCheck,
  shouldRunReconciler,
  shouldRunTokenHealth,
} from "../src/worker";
import type { AppConfig } from "../src/env";
import type { BotRepository } from "../src/db/repository";
import { MetaApiError, type MetaGraphClient } from "../src/meta/client";
import { defaultAppConfig } from "./helpers/config";
import type {
  CommentRecord,
  DirectMessageRecord,
  NormalizedDirectMessage,
  NormalizedComment,
  ReplyJobRecord,
  ReconcilerCheckpointState,
  WebhookQueueMessage,
  WorkerEnv,
} from "../src/types";

describe("scheduled reply sender", () => {
  test("webhook comment processing queues jobs without sending", async () => {
    const repo = new FakeDrainRepo();
    const meta = new FakeDrainMeta();

    await queueWebhookComments({
      comments: [comment()],
      config: config(),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:01:00.000Z"),
    });

    expect(repo.jobs.get("comment_private_reply:comment_1")?.status).toBe("pending");
    expect(meta.sentCommentIds).toEqual([]);
  });

  test("webhook direct message processing queues one matching private-text reply", async () => {
    const repo = new FakeDrainRepo();
    const meta = new FakeDrainMeta();
    const dmConfig = config({ DM_AUTOREPLY_ENABLED: "true" });

    await queueWebhookDirectMessages({
      directMessages: [directMessage({ text: "🦐" })],
      config: dmConfig,
      repo: repo as unknown as BotRepository,
      now: new Date("2026-05-05T12:01:00.000Z"),
    });

    const job = repo.jobs.get("direct_message_reply:dm_1");
    expect(repo.directMessages.get("dm_1")?.matchedKeyword).toBe("🦐");
    expect(job?.status).toBe("pending");
    expect(job?.directMessageId).toBe("dm_1");
    expect(job?.replyText).toBe(
      dmConfig.commentReplyRules.find((rule) => rule.keywords.includes("🦐"))
        ?.privateReplyText,
    );
    expect(meta.directMessages).toEqual([]);
  });

  test("webhook direct message processing is idempotent by message id", async () => {
    const repo = new FakeDrainRepo();
    const dmConfig = config({ DM_AUTOREPLY_ENABLED: "true" });

    await queueWebhookDirectMessages({
      directMessages: [directMessage({ text: "🦐" }), directMessage({ text: "🦐" })],
      config: dmConfig,
      repo: repo as unknown as BotRepository,
      now: new Date("2026-05-05T12:01:00.000Z"),
    });

    expect([...repo.jobs.keys()].filter((key) => key === "direct_message_reply:dm_1")).toHaveLength(
      1,
    );
  });

  test("webhook direct message processing skips no-keyword and private-text-missing messages", async () => {
    const repo = new FakeDrainRepo();
    const noPrivateConfig: AppConfig = {
      ...config({ DM_AUTOREPLY_ENABLED: "true" }),
      commentKeywords: ["only-public"],
      commentReplyRules: [{ keywords: ["only-public"], publicReplyText: "public only" }],
    };

    await queueWebhookDirectMessages({
      directMessages: [
        directMessage({ id: "dm_no_keyword", text: "hello" }),
        directMessage({ id: "dm_no_private", text: "only-public" }),
      ],
      config: noPrivateConfig,
      repo: repo as unknown as BotRepository,
      now: new Date("2026-05-05T12:01:00.000Z"),
    });

    expect(repo.directMessages.get("dm_no_keyword")).toEqual(expect.objectContaining({
      id: "dm_no_keyword",
      matchedKeyword: undefined,
    }));
    expect(repo.directMessages.get("dm_no_private")).toEqual(expect.objectContaining({
      id: "dm_no_private",
      matchedKeyword: "only-public",
    }));
    expect(repo.jobs.size).toBe(0);
  });

  test("webhook direct message processing respects DM_AUTOREPLY_ENABLED", async () => {
    const repo = new FakeDrainRepo();

    await queueWebhookDirectMessages({
      directMessages: [directMessage({ text: "🦐" })],
      config: config({ DM_AUTOREPLY_ENABLED: "false" }),
      repo: repo as unknown as BotRepository,
      now: new Date("2026-05-05T12:01:00.000Z"),
    });

    expect(repo.directMessages.get("dm_1")?.matchedKeyword).toBe("🦐");
    expect(repo.jobs.size).toBe(0);
  });

  test("drains due reply jobs up to the configured limit", async () => {
    const repo = new FakeDrainRepo();
    const meta = new FakeDrainMeta();
    repo.addJob("comment_1");
    repo.addJob("comment_2");
    repo.addJob("comment_3");

    const result = await drainDueReplyJobs({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config({ RATE_LIMIT_MESSAGES_PER_MINUTE: "2" }),
      now: new Date("2026-05-05T12:01:00.000Z"),
    });

    expect(result.attempted).toBe(2);
    expect(result.sent).toBe(2);
    expect(meta.sentCommentIds).toEqual(["comment_1", "comment_2"]);
    expect(repo.jobs.get("comment_private_reply:comment_1")?.status).toBe("sent");
    expect(repo.jobs.get("comment_private_reply:comment_2")?.status).toBe("sent");
    expect(repo.jobs.get("comment_private_reply:comment_3")?.status).toBe("pending");
  });

  test("drain skips disabled private backlog and sends due public jobs", async () => {
    const repo = new FakeDrainRepo();
    const meta = new FakeDrainMeta();
    repo.addJob("private_1", "comment_private_reply");
    repo.addJob("private_2", "comment_private_reply");
    repo.addJob("public_1", "comment_public_reply");
    const drainConfig = config({
      COMMENT_PRIVATE_REPLY_ENABLED: "false",
      COMMENT_PUBLIC_REPLY_ENABLED: "true",
      RATE_LIMIT_MESSAGES_PER_MINUTE: "1",
    });

    const result = await drainDueReplyJobs({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: drainConfig,
      now: new Date("2026-05-05T12:01:00.000Z"),
    });

    expect(result.attempted).toBe(1);
    expect(result.sent).toBe(1);
    expect(meta.publicReplies).toEqual([
      {
        commentId: "public_1",
        text: drainConfig.commentReplyRules.find((rule) =>
          rule.keywords.includes("🔥"),
        )?.publicReplyText,
      },
    ]);
    expect(repo.jobs.get("comment_public_reply:public_1")?.status).toBe("sent");
    expect(repo.jobs.get("comment_private_reply:private_1")?.status).toBe("pending");
  });

  test("drain sends due direct message reply jobs when DM autoreply is enabled", async () => {
    const repo = new FakeDrainRepo();
    const meta = new FakeDrainMeta();
    repo.addDirectJob("dm_1");

    const result = await drainDueReplyJobs({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config({
        DM_AUTOREPLY_ENABLED: "true",
        RATE_LIMIT_MESSAGES_PER_MINUTE: "1",
      }),
      now: new Date("2026-05-05T12:01:00.000Z"),
    });

    expect(result).toEqual({ attempted: 1, sent: 1 });
    expect(meta.directMessages).toEqual([
      {
        recipientId: "user_dm",
        text: "dm reply",
      },
    ]);
    expect(repo.jobs.get("direct_message_reply:dm_1")?.status).toBe("sent");
    expect(repo.jobs.get("direct_message_reply:dm_1")?.metaRecipientId).toBe("user_dm");
  });

  test("scheduled maintenance blocks disabled direct message reply backlog", async () => {
    const repo = new FakeDrainRepo();
    const meta = new FakeDrainMeta();
    repo.addDirectJob("dm_1");

    await runScheduledMaintenanceWithDependencies({
      config: config({ DM_AUTOREPLY_ENABLED: "false" }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:20:00.000Z"),
    });

    const job = repo.jobs.get("direct_message_reply:dm_1");
    expect(job?.status).toBe("blocked");
    expect(job?.lastError).toBe("reply_type_disabled");
  });

  test("runs token health only on 10-minute UTC buckets", () => {
    expect(shouldRunTokenHealth(new Date("2026-05-05T12:00:00.000Z"))).toBe(true);
    expect(shouldRunTokenHealth(new Date("2026-05-05T12:10:59.000Z"))).toBe(true);
    expect(shouldRunTokenHealth(new Date("2026-05-05T12:01:00.000Z"))).toBe(false);
  });

  test("runs reconciler only on configured UTC buckets", () => {
    const reconcileConfig = config({ RECONCILER_INTERVAL_MINUTES: "10" });

    expect(shouldRunReconciler(new Date("2026-05-05T12:00:00.000Z"), reconcileConfig)).toBe(true);
    expect(shouldRunReconciler(new Date("2026-05-05T12:10:59.000Z"), reconcileConfig)).toBe(true);
    expect(shouldRunReconciler(new Date("2026-05-05T12:01:00.000Z"), reconcileConfig)).toBe(false);
    expect(shouldRunReconciler(new Date("2026-05-05T12:10:00.000Z"), config({
      RECONCILER_ENABLED: "false",
    }))).toBe(false);
  });

  test("token health auth failure marks token invalid and tells caller to skip drain", async () => {
    const repo = new FakeDrainRepo();
    const meta = new FakeDrainMeta();
    meta.tokenHealthError = new MetaApiError({
      message: "Invalid token",
      httpStatus: 401,
      responseSummary: "{}",
      retryable: false,
    });

    const canDrain = await runTokenHealthCheck({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config(),
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(canDrain).toBe(false);
    expect(repo.accountStatus).toBe("token_invalid");
  });

  test("scheduled maintenance redacts expired webhook payloads", async () => {
    const repo = new FakeDrainRepo();
    const meta = new FakeDrainMeta();

    await runScheduledMaintenanceWithDependencies({
      config: config(),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:01:00.000Z"),
    });

    expect(repo.retentionCleanup).toEqual({
      now: "2026-05-05T12:01:00.000Z",
      limit: 100,
    });
  });

  test("scheduled maintenance requeues stale webhook events", async () => {
    const repo = new FakeDrainRepo();
    const meta = new FakeDrainMeta();
    const queue = new FakeWebhookQueue();
    repo.staleWebhookEventIds = ["event_received", "event_processing"];

    await runScheduledMaintenanceWithDependencies({
      config: config(),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      webhookQueue: queue as unknown as Queue<WebhookQueueMessage>,
      now: new Date("2026-05-05T12:20:00.000Z"),
    });

    expect(repo.webhookRetryClaim).toEqual({
      now: "2026-05-05T12:20:00.000Z",
      staleReceivedBefore: "2026-05-05T12:10:00.000Z",
      staleProcessingBefore: "2026-05-05T12:10:00.000Z",
      maxAttempts: 3,
      limit: 20,
    });
    expect(queue.messages).toEqual([
      { type: "webhook_event", webhookEventId: "event_received" },
      { type: "webhook_event", webhookEventId: "event_processing" },
    ]);
  });

  test("scheduled maintenance blocks terminal failed reply jobs", async () => {
    const repo = new FakeDrainRepo();
    const meta = new FakeDrainMeta();

    await runScheduledMaintenanceWithDependencies({
      config: config(),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:20:00.000Z"),
    });

    expect(repo.terminalFailedBlockedAt).toBe("2026-05-05T12:20:00.000Z");
  });

  test("fresh comment reconciler creates missing jobs from recent media comments", async () => {
    const repo = new FakeDrainRepo();
    const meta = new FakeDrainMeta();
    meta.mediaPages = [{ data: [{ id: "media_1" }] }];
    meta.commentPages.set("media_1", [
      {
        data: [
          {
            id: "comment_recovered",
            text: "🔥",
            timestamp: "2026-05-05T11:58:00.000Z",
            from: { id: "user_recovered", username: "recovered" },
          },
        ],
      },
    ]);

    const summary = await runFreshCommentReconciler({
      config: config({
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
      }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(summary).toMatchObject({
      mediaScanned: 1,
      commentsScanned: 1,
      commentsRecovered: 1,
      replyJobsCreated: 1,
    });
    expect(repo.comments.get("comment_recovered")?.source).toBe("backfill");
    expect(repo.jobs.get("comment_private_reply:comment_recovered")?.status).toBe("pending");
    expect(repo.decisions).toContainEqual(expect.objectContaining({
      commentId: "comment_recovered",
      source: "reconciler",
      action: "jobs_created",
    }));
    expect(repo.lastReconcilerRun).toMatchObject({
      mediaScanned: 1,
      commentsRecovered: 1,
      replyJobsCreated: 1,
    });
  });

  test("fresh comment reconciler stops after first old page when checkpoint is current", async () => {
    const repo = new FakeDrainRepo();
    repo.reconcilerCheckpointState = {
      version: 1,
      media: {
        media_1: {
          newestCommentAt: "2026-05-05T11:59:00.000Z",
          newestCommentIds: ["comment_old"],
          lastScannedAt: "2026-05-05T11:50:00.000Z",
        },
      },
    };
    const meta = new FakeDrainMeta();
    meta.mediaPages = [{ data: [{ id: "media_1" }] }];
    meta.commentPages.set("media_1", [
      {
        data: [
          {
            id: "comment_old",
            text: "🔥",
            timestamp: "2026-05-05T11:59:00.000Z",
            from: { id: "user_old", username: "old" },
          },
        ],
        paging: { cursors: { after: "page_2" } },
      },
      {
        data: [
          {
            id: "comment_should_not_scan",
            text: "🔥",
            timestamp: "2026-05-05T11:58:00.000Z",
            from: { id: "user_older", username: "older" },
          },
        ],
      },
    ]);

    const summary = await runFreshCommentReconciler({
      config: config({
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
        RECONCILER_MAX_COMMENT_PAGES_PER_MEDIA: "3",
      }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(summary.commentsScanned).toBe(1);
    expect(meta.commentCalls).toEqual([{ mediaId: "media_1", after: undefined }]);
    expect(repo.jobs.has("comment_private_reply:comment_should_not_scan")).toBe(false);
  });

  test("fresh comment reconciler treats unseen same-timestamp ids as new", async () => {
    const repo = new FakeDrainRepo();
    repo.reconcilerCheckpointState = {
      version: 1,
      media: {
        media_1: {
          newestCommentAt: "2026-05-05T11:59:00.000Z",
          newestCommentIds: ["comment_old"],
          lastScannedAt: "2026-05-05T11:50:00.000Z",
        },
      },
    };
    const meta = new FakeDrainMeta();
    meta.mediaPages = [{ data: [{ id: "media_1" }] }];
    meta.commentPages.set("media_1", [
      {
        data: [
          {
            id: "comment_same_time",
            text: "🔥",
            timestamp: "2026-05-05T11:59:00.000Z",
            from: { id: "user_same", username: "same" },
          },
        ],
      },
    ]);

    const summary = await runFreshCommentReconciler({
      config: config({ COMMENT_PUBLIC_REPLY_ENABLED: "true" }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(summary.replyJobsCreated).toBe(1);
    expect(repo.jobs.get("comment_private_reply:comment_same_time")?.status).toBe("pending");
  });

  test("fresh comment reconciler keeps scanning after comments with missing timestamps", async () => {
    const repo = new FakeDrainRepo();
    repo.reconcilerCheckpointState = {
      version: 1,
      media: {
        media_1: {
          newestCommentAt: "2026-05-05T11:59:00.000Z",
          newestCommentIds: ["comment_old"],
          lastScannedAt: "2026-05-05T11:50:00.000Z",
        },
      },
    };
    const meta = new FakeDrainMeta();
    meta.mediaPages = [{ data: [{ id: "media_1" }] }];
    meta.commentPages.set("media_1", [
      {
        data: [
          {
            id: "comment_unknown_time",
            text: "🔥",
            from: { id: "user_unknown", username: "unknown" },
          },
        ],
        paging: { cursors: { after: "page_2" } },
      },
      {
        data: [
          {
            id: "comment_newer",
            text: "🔥",
            timestamp: "2026-05-05T12:00:00.000Z",
            from: { id: "user_newer", username: "newer" },
          },
        ],
      },
    ]);

    const summary = await runFreshCommentReconciler({
      config: config({
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
        RECONCILER_MAX_COMMENT_PAGES_PER_MEDIA: "3",
      }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:01:00.000Z"),
    });

    expect(summary.commentsScanned).toBe(2);
    expect(meta.commentCalls).toEqual([
      { mediaId: "media_1", after: undefined },
      { mediaId: "media_1", after: "page_2" },
    ]);
    expect(repo.jobs.get("comment_private_reply:comment_newer")?.status).toBe("pending");
  });

  test("fresh comment reconciler does not checkpoint failed media scans", async () => {
    const repo = new FakeDrainRepo();
    repo.reconcilerCheckpointState = {
      version: 1,
      media: {
        media_1: {
          newestCommentAt: "2026-05-05T11:59:00.000Z",
          newestCommentIds: ["comment_old"],
          lastScannedAt: "2026-05-05T11:50:00.000Z",
        },
      },
    };
    const meta = new FakeDrainMeta();
    meta.mediaPages = [{ data: [{ id: "media_1" }] }];
    meta.commentErrors.set("media_1", new Error("Meta comments failed"));

    const summary = await runFreshCommentReconciler({
      config: config({ COMMENT_PUBLIC_REPLY_ENABLED: "true" }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(summary.errors).toBe(1);
    expect(repo.reconcilerCheckpointState.media.media_1).toEqual({
      newestCommentAt: "2026-05-05T11:59:00.000Z",
      newestCommentIds: ["comment_old"],
      lastScannedAt: "2026-05-05T11:50:00.000Z",
    });
  });
});

class FakeDrainRepo {
  comments = new Map<string, CommentRecord>();
  directMessages = new Map<string, DirectMessageRecord>();
  jobs = new Map<string, ReplyJobRecord>();
  accountStatus = "active";
  retentionCleanup?: { now: string; limit: number };
  terminalFailedBlockedAt?: string;
  staleWebhookEventIds: string[] = [];
  decisions: unknown[] = [];
  mediaCommenters: unknown[] = [];
  lastReconcilerRun?: unknown;
  reconcilerCheckpointState: ReconcilerCheckpointState = { version: 1, media: {} };
  webhookRetryClaim?: {
    now: string;
    staleReceivedBefore: string;
    staleProcessingBefore: string;
    maxAttempts: number;
    limit: number;
  };

  addJob(commentId: string, type: ReplyJobRecord["type"] = "comment_private_reply") {
    const now = "2026-05-05T12:00:00.000Z";
    const idempotencyKey = `${type}:${commentId}`;
    const job: ReplyJobRecord = {
      id: `job_${this.jobs.size + 1}`,
      idempotencyKey,
      type,
      commentId,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(idempotencyKey, job);
    this.comments.set(commentId, {
      id: commentId,
      mediaId: "media_1",
      commentKind: "feed",
      commenterId: `user_${this.jobs.size}`,
      username: "user",
      text: "🔥",
      createdAt: "2026-05-05T11:59:00.000Z",
      source: "webhook",
      raw: {},
      matchedKeyword: "🔥",
      privateReplyEligible: true,
    });
  }

  addDirectJob(directMessageId: string) {
    const now = "2026-05-05T12:00:00.000Z";
    const idempotencyKey = `direct_message_reply:${directMessageId}`;
    const job: ReplyJobRecord = {
      id: `job_${this.jobs.size + 1}`,
      idempotencyKey,
      type: "direct_message_reply",
      directMessageId,
      replyText: "dm reply",
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(idempotencyKey, job);
    this.directMessages.set(directMessageId, {
      id: directMessageId,
      senderId: "user_dm",
      recipientId: "ig_account",
      text: "🦐",
      createdAt: "2026-05-05T11:59:00.000Z",
      source: "webhook",
      raw: {},
      matchedKeyword: "🦐",
    });
  }

  async upsertComment(comment: CommentRecord) {
    const inserted = !this.comments.has(comment.id);
    this.comments.set(comment.id, comment);
    return { inserted };
  }

  async upsertDirectMessage(message: DirectMessageRecord) {
    const inserted = !this.directMessages.has(message.id);
    this.directMessages.set(message.id, message);
    return { inserted };
  }

  async createReplyJob(input: {
    commentId?: string;
    directMessageId?: string;
    type?: ReplyJobRecord["type"];
    replyText?: string;
    publicSuccessReplyText?: string;
    maxAttempts: number;
    now: string;
  }) {
    const type = input.type ?? "comment_private_reply";
    const targetId =
      type === "direct_message_reply" ? input.directMessageId : input.commentId;
    const idempotencyKey = `${type}:${targetId}`;
    const existing = this.jobs.get(idempotencyKey);
    if (existing) {
      return { job: existing, inserted: false };
    }

    const job: ReplyJobRecord = {
      id: `job_${this.jobs.size + 1}`,
      idempotencyKey,
      type,
      commentId: input.commentId,
      directMessageId: input.directMessageId,
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

  async listDueReplyJobs(
    _now: string,
    limit: number,
    _staleSendingBefore: string,
    types?: ReplyJobRecord["type"][],
  ) {
    return [...this.jobs.values()]
      .filter((job) => job.status === "pending")
      .filter((job) => !types || types.includes(job.type))
      .slice(0, limit);
  }

  async getReplyJob(id: string) {
    return [...this.jobs.values()].find((job) => job.id === id);
  }

  async getComment(id: string) {
    return this.comments.get(id);
  }

  async getDirectMessage(id: string) {
    return this.directMessages.get(id);
  }

  async getAccountStatus() {
    return this.accountStatus;
  }

  async upsertAccountStatus(_accountId: string, status: string) {
    this.accountStatus = status;
  }

  async claimReplyJobForSending(input: { id: string }) {
    const job = [...this.jobs.values()].find((item) => item.id === input.id);
    if (!job) {
      return false;
    }

    job.status = "sending";
    return true;
  }

  async markReplyAttemptStarted(input: { id: string; attempt: number }) {
    const job = [...this.jobs.values()].find((item) => item.id === input.id);
    if (job) {
      job.attempts = input.attempt;
    }
  }

  async reserveReplyRateLimitSlot() {
    return true;
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

  async recordCommentProcessingDecision(input: unknown) {
    this.decisions.push(input);
  }

  async recordReconcilerRun(input: unknown) {
    this.lastReconcilerRun = input;
  }

  async upsertMediaCommenter(input: unknown) {
    this.mediaCommenters.push(input);
  }

  async getReconcilerCheckpointState() {
    return this.reconcilerCheckpointState;
  }

  async saveReconcilerCheckpointState(input: ReconcilerCheckpointState) {
    this.reconcilerCheckpointState = input;
  }

  async cleanupReplyRateLimitSlots() {}

  async blockReplyJobsForTypes(input: {
    types: ReplyJobRecord["type"][];
    error: string;
    now: string;
  }) {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (input.types.includes(job.type) && ["pending", "retryable", "sending"].includes(job.status)) {
        job.status = "blocked";
        job.lastError = input.error;
        job.updatedAt = input.now;
        count += 1;
      }
    }
    return count;
  }

  async blockTerminalFailedReplyJobs(now: string) {
    this.terminalFailedBlockedAt = now;
    return 0;
  }

  async redactExpiredWebhookPayloads(now: string, limit: number) {
    this.retentionCleanup = { now, limit };
    return 0;
  }

  async claimStaleWebhookEventsForRetry(input: {
    now: string;
    staleReceivedBefore: string;
    staleProcessingBefore: string;
    maxAttempts: number;
    limit: number;
  }) {
    this.webhookRetryClaim = input;
    return this.staleWebhookEventIds.slice(0, input.limit);
  }
}

class FakeWebhookQueue {
  messages: WebhookQueueMessage[] = [];

  async send(message: WebhookQueueMessage) {
    this.messages.push(message);
  }
}

class FakeDrainMeta {
  sentCommentIds: string[] = [];
  directMessages: Array<{ recipientId: string; text?: string }> = [];
  tokenHealthError?: Error;
  mediaPages: Array<{
    data?: Array<{ id?: string; timestamp?: string; media_type?: string }>;
    paging?: { cursors?: { after?: string } };
  }> = [];
  commentPages = new Map<string, Array<{
    data: Array<{
      id: string;
      text?: string;
      timestamp?: string;
      from?: { id?: string; username?: string };
    }>;
    paging?: { cursors?: { after?: string } };
  }>>();
  commentErrors = new Map<string, Error>();
  commentCalls: Array<{ mediaId: string; after?: string }> = [];

  async hasConversationWithUser() {
    return false;
  }

  async tokenHealth() {
    if (this.tokenHealthError) {
      throw this.tokenHealthError;
    }

    return { id: "ig_account" };
  }

  async sendPrivateReply(commentId: string) {
    this.sentCommentIds.push(commentId);
    return { recipient_id: "user_1", message_id: `message_${commentId}` };
  }

  async sendDirectMessage(recipientId: string, text?: string) {
    this.directMessages.push({ recipientId, text });
    return { recipient_id: recipientId, message_id: `message_${recipientId}` };
  }

  publicReplies: Array<{ commentId: string; text?: string }> = [];

  async sendPublicReply(commentId: string, text?: string) {
    this.publicReplies.push({ commentId, text });
    return { id: `public_${commentId}` };
  }

  async getMedia(_after?: string) {
    return this.mediaPages.shift() ?? { data: [] };
  }

  async getComments(mediaId: string, after?: string) {
    this.commentCalls.push({ mediaId, after });
    const error = this.commentErrors.get(mediaId);
    if (error) {
      throw error;
    }

    return this.commentPages.get(mediaId)?.shift() ?? { data: [] };
  }
}

function config(overrides: Partial<WorkerEnv> = {}): AppConfig {
  return defaultAppConfig({
    COMMENT_PRIVATE_REPLY_ENABLED: "true",
    ...overrides,
  });
}

function comment(overrides: Partial<NormalizedComment> = {}): NormalizedComment {
  return {
    id: "comment_1",
    mediaId: "media_1",
    commentKind: "feed",
    commenterId: "user_1",
    username: "user",
    text: "🔥",
    createdAt: "2026-05-05T11:59:00.000Z",
    source: "webhook",
    raw: {},
    ...overrides,
  };
}

function directMessage(overrides: Partial<NormalizedDirectMessage> = {}): NormalizedDirectMessage {
  return {
    id: "dm_1",
    senderId: "user_dm",
    recipientId: "ig_account",
    text: "🦐",
    createdAt: "2026-05-05T11:59:00.000Z",
    source: "webhook",
    raw: {},
    ...overrides,
  };
}
