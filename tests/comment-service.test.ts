import { describe, expect, spyOn, test } from "bun:test";
import type { AppConfig } from "../src/env";
import type { BotRepository } from "../src/db/repository";
import { MetaApiError, type MetaGraphClient } from "../src/meta/client";
import { processComment, processReplyJob } from "../src/comments/service";
import { getMatchedReplyRuleForComment } from "../src/comments/reply-policy";
import {
  buildCommentReplyRules,
  getCommentReplyKeywords,
  type CommentReplyRuleDefinition,
} from "../src/comments/reply-rules";
import type {
  CommentRecord,
  NormalizedComment,
  ReplyJobRecord,
  WorkerEnv,
} from "../src/types";
import { defaultAppConfig } from "./helpers/config";

describe("comment processing", () => {
  test("sends one private reply for an eligible keyword comment", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const result = await processComment({
      comment: comment({ text: "хочу" }),
      config: config(),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
    });

    expect(result.replyJobCreated).toBe(true);
    expect(result.sent).toBe(true);
    expect(meta.sentCommentIds).toEqual(["comment_1"]);
    expect(repo.jobs.get("comment_private_reply:comment_1")?.status).toBe(
      "sent",
    );
  });

  test("does not match a keyword separated from another word by emoji", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const result = await processComment({
      comment: comment({ text: "я🔥хочу" }),
      config: config(),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
    });

    expect(result).toEqual({
      inserted: true,
      matched: false,
      replyJobCreated: false,
      sent: false,
      skippedReason: "no_keyword",
    });
    expect(repo.comments.get("comment_1")?.matchedKeyword).toBeUndefined();
    expect(repo.jobs.size).toBe(0);
    expect(meta.conversationChecks).toEqual([]);
  });

  test("sends public and private replies only when no conversation exists", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const result = await processComment({
      comment: comment({ text: "хочу" }),
      config: config({
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
      }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
    });

    expect(result.replyJobCreated).toBe(true);
    expect(meta.conversationChecks).toEqual(["user_1", "user_1"]);
    expect(meta.publicReplies).toEqual([
      { commentId: "comment_1", text: "public reply" },
    ]);
    expect(meta.privateReplies).toEqual([
      { commentId: "comment_1", text: "reply" },
    ]);
    expect(repo.jobs.get("comment_public_reply:comment_1")?.status).toBe(
      "sent",
    );
    expect(repo.jobs.get("comment_private_reply:comment_1")?.status).toBe(
      "sent",
    );
  });

  test("uses the reply text for the matched keyword rule", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const rules = configWithRules(
      [
        ["спасибо", { public: "пожалуйста", private: "личное пожалуйста" }],
        [
          "🐿️,🦫",
          { public: "эмодзи принял", private: "личный ответ на эмодзи" },
        ],
      ],
      {
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
        COMMENT_PRIVATE_REPLY_ENABLED: "true",
      },
    );

    await processComment({
      comment: comment({ text: "спасибо" }),
      config: rules,
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
    });

    expect(meta.publicReplies).toEqual([
      { commentId: "comment_1", text: "пожалуйста" },
    ]);
    expect(meta.privateReplies).toEqual([
      { commentId: "comment_1", text: "личное пожалуйста" },
    ]);
    expect(repo.comments.get("comment_1")?.matchedKeyword).toBe("спасибо");
  });

  test("does not create any reply jobs when a conversation already exists", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    meta.existingConversation = true;

    const result = await processComment({
      comment: comment({ text: "хочу" }),
      config: config({
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
      }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
    });

    expect(result.skippedReason).toBe("existing_conversation");
    expect(repo.jobs.size).toBe(0);
    expect(meta.publicReplies).toEqual([]);
    expect(meta.privateReplies).toEqual([]);
  });

  test("always rules send replies even when a conversation already exists", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    meta.existingConversation = true;
    const rules = configWithRules(
      [
        [
          "🐝",
          { public: "отправил 🐛", private: "личное сообщение", always: true },
        ],
      ],
      {
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
        COMMENT_PRIVATE_REPLY_ENABLED: "true",
      },
    );

    const result = await processComment({
      comment: comment({ text: "🐝" }),
      config: rules,
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
    });

    expect(result.replyJobCreated).toBe(true);
    expect(result.sent).toBe(true);
    expect(meta.conversationChecks).toEqual([]);
    expect(meta.publicReplies).toEqual([
      { commentId: "comment_1", text: "отправил 🐛" },
    ]);
    expect(meta.privateReplies).toEqual([
      { commentId: "comment_1", text: "личное сообщение" },
    ]);
    expect(repo.jobs.get("comment_public_reply:comment_1")?.status).toBe(
      "sent",
    );
    expect(repo.jobs.get("comment_private_reply:comment_1")?.status).toBe(
      "sent",
    );
  });

  test("does not send twice for the same comment", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const base = {
      comment: comment({ text: "хочу" }),
      config: config(),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
    };

    await processComment(base);
    const result = await processComment(base);

    expect(result.skippedReason).toBe("duplicate_reply_job");
    expect(meta.sentCommentIds).toEqual(["comment_1"]);
  });

  test("queues reply jobs without sending immediately", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const result = await processComment({
      comment: comment({ text: "хочу" }),
      config: config({
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
      }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
      sendImmediately: false,
    });

    expect(result.replyJobCreated).toBe(true);
    expect(result.sent).toBe(false);
    expect(repo.jobs.get("comment_private_reply:comment_1")?.status).toBe(
      "pending",
    );
    expect(
      repo.jobs.get("comment_private_reply:comment_1")?.publicSuccessReplyText,
    ).toBe("public reply");
    expect(repo.jobs.has("comment_public_reply:comment_1")).toBe(false);
    expect(meta.privateReplies).toEqual([]);
    expect(meta.publicReplies).toEqual([]);
  });

  test("uses snapshotted public success text after delayed private success", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const originalConfig = configWithRules(
      [["хочу", { public: "old public", private: "old private" }]],
      {
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
        COMMENT_PRIVATE_REPLY_ENABLED: "true",
      },
    );

    await processComment({
      comment: comment({ text: "хочу" }),
      config: originalConfig,
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
      sendImmediately: false,
    });

    const changedConfig = configWithRules(
      [["хочу", { public: "new public", private: "new private" }]],
      {
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
        COMMENT_PRIVATE_REPLY_ENABLED: "true",
      },
    );
    const privateJob = repo.jobs.get("comment_private_reply:comment_1");

    await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: changedConfig,
      jobId: privateJob!.id,
      now: new Date("2026-05-05T12:05:00.000Z"),
    });

    expect(meta.privateReplies).toEqual([
      { commentId: "comment_1", text: "old private" },
    ]);
    expect(meta.publicReplies).toEqual([
      { commentId: "comment_1", text: "old public" },
    ]);
  });

  test("snapshots a random public reply per comment through duplicates and send retries", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const rules = configWithRules([["хочу", { private: "reply" }]], {
      COMMENT_PUBLIC_REPLY_ENABLED: "true",
    });
    const base = {
      config: rules,
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
      sendImmediately: false,
    };
    const random = spyOn(Math, "random");
    try {
      random.mockReturnValue(0);
      await processComment({ ...base, comment: comment() });
      const privateJob = repo.jobs.get("comment_private_reply:comment_1")!;
      const selectedText = privateJob.publicSuccessReplyText;
      expect(selectedText).toMatch(/\p{Extended_Pictographic}/u);

      random.mockReturnValue(0.99);
      await processComment({ ...base, comment: comment({ id: "comment_2" }) });
      expect(repo.jobs.get("comment_private_reply:comment_2")?.publicSuccessReplyText)
        .not.toBe(selectedText);
      await processComment({ ...base, comment: comment() });
      expect(privateJob.publicSuccessReplyText).toBe(selectedText);
      expect(meta.publicReplies).toEqual([]);

      meta.privateError = new Error("temporary private reply failure");
      await processReplyJob({ ...base, jobId: privateJob.id });
      expect(privateJob.status).toBe("retryable");
      expect(meta.publicReplies).toEqual([]);

      meta.privateError = undefined;
      meta.publicError = new Error("temporary public reply failure");
      const changedConfig = configWithRules([
        ["хочу", { public: "new override", private: "new private" }],
      ], { COMMENT_PUBLIC_REPLY_ENABLED: "true" });
      await processReplyJob({ ...base, config: changedConfig, jobId: privateJob.id });
      const publicJob = repo.jobs.get("comment_public_reply:comment_1")!;
      expect(publicJob.status).toBe("retryable");
      expect(publicJob.replyText).toBe(selectedText);

      meta.publicError = undefined;
      await processReplyJob({ ...base, config: changedConfig, jobId: publicJob.id });
      expect(meta.privateReplies).toEqual([{ commentId: "comment_1", text: "reply" }]);
      expect(meta.publicReplies).toEqual([{ commentId: "comment_1", text: selectedText }]);
    } finally {
      random.mockRestore();
    }
  });

  test.each(["comment_private_reply", "comment_public_reply"] as const)(
    "uses a universal reply for a legacy %s job without a public snapshot",
    async (type) => {
      const repo = new FakeRepo();
      const meta = new FakeMetaClient();
      const rules = configWithRules([["хочу", { private: "reply" }]], {
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
      });
      const now = new Date("2026-05-05T12:00:00.000Z");
      const { job } = await repo.createReplyJob({
        commentId: "comment_1",
        type,
        maxAttempts: 3,
        now: now.toISOString(),
      });

      expect(await processReplyJob({
        config: rules,
        repo: repo as unknown as BotRepository,
        metaClient: meta as unknown as MetaGraphClient,
        jobId: job.id,
        now,
      })).toBe(true);
      expect(meta.publicReplies).toHaveLength(1);
      expect(meta.publicReplies[0]?.text).toMatch(/\p{Extended_Pictographic}/u);
    },
  );

  test("queues only public jobs when private comment replies are disabled", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const result = await processComment({
      comment: comment({ text: "хочу" }),
      config: config({
        COMMENT_PRIVATE_REPLY_ENABLED: "false",
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
      }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
      sendImmediately: false,
    });

    expect(result.replyJobCreated).toBe(true);
    expect(repo.jobs.has("comment_private_reply:comment_1")).toBe(false);
    expect(repo.jobs.get("comment_public_reply:comment_1")?.status).toBe(
      "pending",
    );
    expect(meta.privateReplies).toEqual([]);
    expect(meta.publicReplies).toEqual([]);
  });

  test("saves stale keyword comments without private reply", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const result = await processComment({
      comment: comment({
        text: "спасибо",
        createdAt: "2026-04-01T12:00:00.000Z",
      }),
      config: config(),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
    });

    expect(result.matched).toBe(true);
    expect(result.replyJobCreated).toBe(false);
    expect(result.skippedReason).toBe("outside_private_reply_window");
    expect(meta.sentCommentIds).toEqual([]);
  });

  test("saves live comments but does not create private reply jobs in MVP", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const result = await processComment({
      comment: comment({ text: "хочу", commentKind: "live" }),
      config: config(),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
    });

    expect(result.matched).toBe(true);
    expect(result.replyJobCreated).toBe(false);
    expect(result.skippedReason).toBe("live_comment_unsupported");
    expect(repo.comments.get("comment_1")?.commentKind).toBe("live");
    expect(meta.sentCommentIds).toEqual([]);
  });

  test("does not create private reply jobs when commenter id is unknown", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const result = await processComment({
      comment: comment({ text: "хочу", commenterId: undefined }),
      config: config(),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
    });

    expect(result.matched).toBe(true);
    expect(result.replyJobCreated).toBe(false);
    expect(result.skippedReason).toBe("missing_commenter_id");
    expect(meta.sentCommentIds).toEqual([]);
  });

  test("skips comments from the connected Instagram username", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const result = await processComment({
      comment: comment({
        text: "🐿️",
        commenterId: "instagram_scoped_user_id",
        username: "owner_account",
      }),
      config: config({ INSTAGRAM_USERNAME: "owner_account" }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
    });

    expect(result.skippedReason).toBe("own_comment");
    expect(repo.jobs.size).toBe(0);
    expect(meta.sentCommentIds).toEqual([]);
  });

  test("blocks sending when BOT_ENABLED=false", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const result = await processComment({
      comment: comment({ text: "хочу" }),
      config: config({ BOT_ENABLED: "false" }),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
    });

    expect(result.skippedReason).toBe("sending_disabled");
    expect(meta.sentCommentIds).toEqual([]);
  });

  test("does not send when atomic job claim fails", async () => {
    const repo = new FakeRepo();
    repo.claimSucceeds = false;
    const meta = new FakeMetaClient();
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    const sent = await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config(),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(sent).toBe(false);
    expect(meta.sentCommentIds).toEqual([]);
  });

  test("send-time auth errors mark token invalid and keep job retryable", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    meta.privateError = new MetaApiError({
      message: "Invalid OAuth access token",
      httpStatus: 401,
      responseSummary: "{}",
      retryable: false,
    });
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    const sent = await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config(),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(sent).toBe(false);
    expect(repo.accountStatus).toBe("token_invalid");
    expect(repo.jobs.get("comment_private_reply:comment_1")?.status).toBe(
      "retryable",
    );
  });

  test("token_invalid pauses jobs before Meta conversation lookup", async () => {
    const repo = new FakeRepo();
    repo.accountStatus = "token_invalid";
    const meta = new FakeMetaClient();
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    const sent = await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config(),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const job = repo.jobs.get("comment_private_reply:comment_1");
    expect(sent).toBe(false);
    expect(job?.status).toBe("retryable");
    expect(job?.lastError).toBe("token_invalid");
    expect(meta.conversationChecks).toEqual([]);
  });

  test("already-replied Meta errors are treated as delivered", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    meta.privateError = new MetaApiError({
      message: "This comment already has a private reply",
      httpStatus: 400,
      metaCode: 100,
      responseSummary: JSON.stringify({
        error: {
          message: "Only one private reply is allowed; already replied.",
        },
      }),
      retryable: false,
    });
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    const sent = await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config(),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const job = repo.jobs.get("comment_private_reply:comment_1");
    expect(sent).toBe(true);
    expect(job?.status).toBe("sent");
    expect(job?.nextRetryAt).toBeUndefined();
  });

  test("retries invalid private replies before sending public fallback", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    meta.privateError = new MetaApiError({
      message: "Der Kommentar ist für private Antworten ungültig",
      httpStatus: 400,
      metaCode: 100,
      metaSubcode: 2534025,
      responseSummary: JSON.stringify({
        error: {
          message: "The comment is invalid for a private reply",
          code: 100,
          error_subcode: 2534025,
        },
      }),
      retryable: false,
    });
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_private_reply",
      replyText: "reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    const firstAttemptSent = await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config({
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
      }),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const retryableJob = repo.jobs.get("comment_private_reply:comment_1");
    expect(firstAttemptSent).toBe(false);
    expect(retryableJob?.status).toBe("retryable");
    expect(retryableJob?.lastError).toBe("private_reply_invalid");
    expect(retryableJob?.nextRetryAt).toBe("2026-05-05T12:01:00.000Z");
    expect(repo.jobs.has("comment_public_reply:comment_1")).toBe(false);
    expect(meta.publicReplies).toEqual([]);

    meta.privateError = undefined;
    const retrySent = await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config({
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
      }),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:01:00.000Z"),
    });

    const privateJob = repo.jobs.get("comment_private_reply:comment_1");
    const successJob = repo.jobs.get("comment_public_reply:comment_1");
    expect(retrySent).toBe(true);
    expect(privateJob?.status).toBe("sent");
    expect(successJob?.status).toBe("sent");
    expect(successJob?.replyText).toBe("public reply");
    expect(meta.publicReplies).toEqual([
      { commentId: "comment_1", text: "public reply" },
    ]);
  });

  test("blocks exhausted invalid private replies by subcode and sends public fallback", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    meta.privateError = new MetaApiError({
      message: "Der Kommentar ist für private Antworten ungültig",
      httpStatus: 400,
      metaCode: 100,
      metaSubcode: 2534025,
      responseSummary: JSON.stringify({
        error: {
          message: "The comment is invalid for a private reply",
          code: 100,
          error_subcode: 2534025,
        },
      }),
      retryable: false,
    });
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_private_reply",
      replyText: "reply",
      maxAttempts: 1,
      now: "2026-05-05T12:00:00.000Z",
    });

    const sent = await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config({
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
      }),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const privateJob = repo.jobs.get("comment_private_reply:comment_1");
    const fallbackJob = repo.jobs.get("comment_public_reply:comment_1");
    expect(sent).toBe(false);
    expect(privateJob?.status).toBe("blocked");
    expect(privateJob?.lastError).toBe("private_reply_invalid");
    expect(fallbackJob?.status).toBe("sent");
    expect(fallbackJob?.replyText).toBe(
      "не получилось 🤷‍♀️, ошибка в инсте какая-то. попробуйте ещё раз?)",
    );
    expect(meta.publicReplies).toEqual([
      {
        commentId: "comment_1",
        text: "не получилось 🤷‍♀️, ошибка в инсте какая-то. попробуйте ещё раз?)",
      },
    ]);
  });

  test("blocks unavailable public comment errors instead of counting them as failed jobs", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    meta.error = new MetaApiError({
      message:
        "Unsupported post request. Object with ID 'comment_1' does not exist, cannot be loaded due to missing permissions, or does not support this operation",
      httpStatus: 400,
      metaCode: 100,
      metaSubcode: 33,
      responseSummary: JSON.stringify({
        error: {
          message:
            "Unsupported post request. Object with ID 'comment_1' does not exist, cannot be loaded due to missing permissions, or does not support this operation",
          code: 100,
          error_subcode: 33,
        },
      }),
      retryable: false,
    });
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_public_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    const sent = await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config({
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
      }),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const job = repo.jobs.get("comment_public_reply:comment_1");
    expect(sent).toBe(false);
    expect(job?.status).toBe("blocked");
    expect(job?.lastError).toBe("meta_object_unavailable");
    expect(repo.attempts).toMatchObject([
      { status: "failed", metaSubcode: 33 },
    ]);
  });

  test("blocks unavailable private recipient errors instead of counting them as failed jobs", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    meta.error = new MetaApiError({
      message: "The requested user cannot be found.",
      httpStatus: 400,
      metaCode: 100,
      metaSubcode: 2534014,
      responseSummary: JSON.stringify({
        error: {
          message: "The requested user cannot be found.",
          code: 100,
          error_subcode: 2534014,
        },
      }),
      retryable: false,
    });
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    const sent = await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config(),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const job = repo.jobs.get("comment_private_reply:comment_1");
    expect(sent).toBe(false);
    expect(job?.status).toBe("blocked");
    expect(job?.lastError).toBe("meta_recipient_unavailable");
    expect(repo.attempts).toMatchObject([
      { status: "failed", metaSubcode: 2534014 },
    ]);
  });

  test("classifies 403 recipient-unavailable Meta errors without invalidating the token", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    meta.privateError = new MetaApiError({
      message: "The recipient is unavailable for private reply",
      httpStatus: 403,
      metaCode: 200,
      metaSubcode: 2534066,
      responseSummary: JSON.stringify({
        error: {
          message: "The recipient is unavailable for private reply",
          code: 200,
          error_subcode: 2534066,
        },
      }),
      retryable: false,
    });
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_private_reply",
      replyText: "reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    const sent = await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config({
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
      }),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const privateJob = repo.jobs.get("comment_private_reply:comment_1");
    const fallbackJob = repo.jobs.get("comment_public_reply:comment_1");
    expect(sent).toBe(false);
    expect(repo.accountStatus).toBe("active");
    expect(privateJob?.status).toBe("blocked");
    expect(privateJob?.lastError).toBe("meta_recipient_unavailable");
    expect(fallbackJob?.status).toBe("sent");
    expect(repo.attempts[0]).toMatchObject({
      status: "failed",
      metaSubcode: 2534066,
    });
  });

  test("does not send retry jobs after private reply window expires", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    repo.comments.set(
      "comment_1",
      commentRecord({
        createdAt: "2026-04-01T12:00:00.000Z",
        privateReplyEligible: false,
      }),
    );
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    const sent = await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config(),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const job = repo.jobs.get("comment_private_reply:comment_1");
    expect(sent).toBe(false);
    expect(job?.status).toBe("blocked");
    expect(job?.lastError).toBe("outside_private_reply_window");
    expect(meta.sentCommentIds).toEqual([]);
  });

  test("global sending pause keeps existing jobs retryable", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config({ BOT_ENABLED: "false" }),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const job = repo.jobs.get("comment_private_reply:comment_1");
    expect(job?.status).toBe("retryable");
    expect(job?.lastError).toBe("sending_paused");
    expect(meta.sentCommentIds).toEqual([]);
  });

  test("blocks existing jobs for a disabled reply type", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_private_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config({ COMMENT_PRIVATE_REPLY_ENABLED: "false" }),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const job = repo.jobs.get("comment_private_reply:comment_1");
    expect(job?.status).toBe("blocked");
    expect(job?.lastError).toBe("reply_type_disabled");
    expect(job?.nextRetryAt).toBeUndefined();
    expect(meta.privateReplies).toEqual([]);
  });

  test("retries ambiguous public reply failures because duplicate public replies are acceptable", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    meta.error = new Error("network timeout");
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_public_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config({
        COMMENT_PRIVATE_REPLY_ENABLED: "false",
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
      }),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const job = repo.jobs.get("comment_public_reply:comment_1");
    expect(job?.status).toBe("retryable");
    expect(job?.lastError).toBe("network timeout");
    expect(job?.nextRetryAt).toBe("2026-05-05T12:01:00.000Z");
    expect(job?.attempts).toBe(1);
  });

  test("reclaims stale public sending jobs for retry", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_public_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });
    created.job.status = "sending";
    created.job.sendingStartedAt = "2026-05-05T11:40:00.000Z";

    const sent = await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config({
        COMMENT_PRIVATE_REPLY_ENABLED: "false",
        COMMENT_PUBLIC_REPLY_ENABLED: "true",
      }),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const job = repo.jobs.get("comment_public_reply:comment_1");
    expect(sent).toBe(true);
    expect(job?.status).toBe("sent");
    expect(meta.publicReplies).toEqual([
      { commentId: "comment_1", text: "public reply" },
    ]);
  });

  test("still allows stale private sending jobs to be reclaimed", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_private_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });
    created.job.status = "sending";
    created.job.sendingStartedAt = "2026-05-05T11:40:00.000Z";

    const sent = await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config(),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(sent).toBe(true);
    expect(repo.jobs.get("comment_private_reply:comment_1")?.status).toBe(
      "sent",
    );
    expect(meta.privateReplies).toEqual([
      { commentId: "comment_1", text: "reply" },
    ]);
  });

  test("does not send when atomic rate limit slot cannot be reserved", async () => {
    const repo = new FakeRepo();
    repo.rateLimitAllows = false;
    const meta = new FakeMetaClient();
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config(),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const job = repo.jobs.get("comment_private_reply:comment_1");
    expect(job?.status).toBe("retryable");
    expect(job?.lastError).toBe("rate_limited_locally");
    expect(job?.attempts).toBe(0);
    expect(meta.sentCommentIds).toEqual([]);
  });

  test("blocks an existing job when a conversation appears before send time", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    meta.existingConversation = true;
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_private_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    const sent = await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config(),
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const job = repo.jobs.get("comment_private_reply:comment_1");
    expect(sent).toBe(false);
    expect(job?.status).toBe("blocked");
    expect(job?.lastError).toBe("existing_conversation");
    expect(meta.privateReplies).toEqual([]);
  });

  test("always rules send queued jobs even when a conversation appears before send time", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    meta.existingConversation = true;
    const rules = configWithRules([
      [
        "🐝",
        { public: "отправил 🐛", private: "личное сообщение", always: true },
      ],
    ]);
    repo.comments.set(
      "comment_1",
      commentRecord({
        text: "🐝",
        matchedKeyword: "🐝",
      }),
    );
    const created = await repo.createReplyJob({
      commentId: "comment_1",
      type: "comment_private_reply",
      maxAttempts: 3,
      now: "2026-05-05T12:00:00.000Z",
    });

    const sent = await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: rules,
      jobId: created.job.id,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const job = repo.jobs.get("comment_private_reply:comment_1");
    expect(sent).toBe(true);
    expect(job?.status).toBe("sent");
    expect(meta.conversationChecks).toEqual([]);
    expect(meta.privateReplies).toEqual([
      { commentId: "comment_1", text: "личное сообщение" },
    ]);
  });

  test("keeps jobs retryable when conversation lookup fails during intake", async () => {
    const repo = new FakeRepo();
    const meta = new FakeMetaClient();
    meta.conversationError = new Error("conversation timeout");

    const result = await processComment({
      comment: comment({ text: "хочу" }),
      config: config(),
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      now: new Date("2026-05-05T12:00:00.000Z"),
      allowReplies: true,
      sendImmediately: false,
    });

    const job = repo.jobs.get("comment_private_reply:comment_1");
    expect(result.replyJobCreated).toBe(true);
    expect(result.sent).toBe(false);
    expect(result.skippedReason).toBe("conversation_lookup_failed");
    expect(job?.status).toBe("retryable");
    expect(job?.lastError).toBe("conversation_lookup_failed");
    expect(job?.nextRetryAt).toBe("2026-05-05T12:10:00.000Z");
    expect(meta.privateReplies).toEqual([]);

    meta.conversationError = undefined;
    await processReplyJob({
      repo: repo as unknown as BotRepository,
      metaClient: meta as unknown as MetaGraphClient,
      config: config(),
      jobId: job!.id,
      now: new Date("2026-05-05T12:10:00.000Z"),
    });

    expect(repo.jobs.get("comment_private_reply:comment_1")?.status).toBe(
      "sent",
    );
    expect(meta.privateReplies).toEqual([
      { commentId: "comment_1", text: "reply" },
    ]);
  });
});

describe("stored comment reply rule fallback", () => {
  test("does not recover an always rule from a multi-word comment", () => {
    const rules = configWithRules([
      ["хочу", { private: "reply", always: true }],
    ]);

    expect(
      getMatchedReplyRuleForComment(
        rules,
        commentRecord({
          text: "я хочу программу",
          matchedKeyword: undefined,
        }),
      ),
    ).toBeUndefined();
  });
});

class FakeRepo {
  comments = new Map<string, CommentRecord>();
  jobs = new Map<string, ReplyJobRecord>();
  attempts: unknown[] = [];
  decisions: unknown[] = [];
  claimSucceeds = true;
  rateLimitAllows = true;
  accountStatus = "active";

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
    if (!this.comments.has(input.commentId)) {
      this.comments.set(
        input.commentId,
        commentRecord({ id: input.commentId }),
      );
    }
    return { job, inserted: true };
  }

  async getReplyJob(id: string) {
    return [...this.jobs.values()].find((job) => job.id === id);
  }

  async getComment(id: string) {
    return this.comments.get(id);
  }

  async getAccountStatus() {
    return this.accountStatus;
  }

  async upsertAccountStatus(_accountId: string, status: string) {
    this.accountStatus = status;
  }

  async reserveReplyRateLimitSlot() {
    return this.rateLimitAllows;
  }

  async claimReplyJobForSending(input: { id: string }) {
    if (!this.claimSucceeds) {
      return false;
    }

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

  async markReplySent(input: {
    id: string;
    recipientId?: string;
    messageId?: string;
    now: string;
  }) {
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

  async recordReplyAttempt(input: unknown) {
    this.attempts.push(input);
  }

  async recordCommentProcessingDecision(input: unknown) {
    this.decisions.push(input);
  }
}

class FakeMetaClient {
  sentCommentIds: string[] = [];
  privateReplies: Array<{ commentId: string; text?: string }> = [];
  publicReplies: Array<{ commentId: string; text?: string }> = [];
  conversationChecks: string[] = [];
  existingConversation = false;
  conversationError?: Error;
  error?: Error;
  privateError?: Error;
  publicError?: Error;

  async sendPrivateReply(commentId: string, text?: string) {
    const error = this.privateError ?? this.error;
    if (error) {
      throw error;
    }

    this.sentCommentIds.push(commentId);
    this.privateReplies.push({ commentId, text });
    return { recipient_id: "user_1", message_id: "message_1" };
  }

  async sendPublicReply(commentId: string, text?: string) {
    const error = this.publicError ?? this.error;
    if (error) {
      throw error;
    }

    this.publicReplies.push({ commentId, text });
    return { id: "public_reply_1" };
  }

  async hasConversationWithUser(userId: string) {
    if (this.conversationError) {
      throw this.conversationError;
    }

    this.conversationChecks.push(userId);
    return this.existingConversation;
  }
}

function comment(
  overrides: Partial<NormalizedComment> = {},
): NormalizedComment {
  return {
    id: "comment_1",
    mediaId: "media_1",
    commentKind: "feed",
    commenterId: "user_1",
    username: "user",
    text: "хочу",
    createdAt: "2026-05-05T11:00:00.000Z",
    source: "webhook",
    raw: {},
    ...overrides,
  };
}

function commentRecord(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    id: "comment_1",
    mediaId: "media_1",
    commentKind: "feed",
    commenterId: "user_1",
    username: "user",
    text: "хочу",
    createdAt: "2026-05-05T11:00:00.000Z",
    source: "webhook",
    raw: {},
    privateReplyEligible: true,
    ...overrides,
  };
}

function config(overrides: Partial<WorkerEnv> = {}): AppConfig {
  const rules = buildCommentReplyRules([
    ["хочу,спасибо,🐿️", { public: "public reply", private: "reply" }],
  ]);
  return {
    ...defaultAppConfig({
      COMMENT_PRIVATE_REPLY_ENABLED: "true",
      ...overrides,
    }),
    commentKeywords: getCommentReplyKeywords(rules),
    commentReplyRules: rules,
  };
}

function configWithRules(
  definitions: readonly CommentReplyRuleDefinition[],
  overrides: Partial<WorkerEnv> = {},
): AppConfig {
  const rules = buildCommentReplyRules(definitions);
  return {
    ...config(overrides),
    commentKeywords: getCommentReplyKeywords(rules),
    commentReplyRules: rules,
  };
}
