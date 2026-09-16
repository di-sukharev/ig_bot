import type { AppConfig } from "../env";
import type { BotRepository } from "../db/repository";
import { MetaApiError, MetaGraphClient } from "../meta/client";
import type {
  CommentProcessingAction,
  CommentProcessingSource,
  CommentRecord,
  DirectMessageRecord,
  NormalizedComment,
  ReplyJobRecord,
  ReplyJobType,
} from "../types";
import { isPrivateReplyEligible, matchCommentKeyword } from "./matching";
import {
  basicCommentReplySkipReason,
  getConversationStatus,
  getMatchedReplyRuleForComment,
  getReplyRuleForComment,
  isReplyJobTypeEnabled,
  planCommentReplyJobs,
  shouldBypassExistingConversation,
} from "./reply-policy";
import {
  findCommentReplyRule,
  getPublicCommentReplyText,
  type CommentReplyRule,
} from "./reply-rules";
import { decideRetry } from "./retry";

const REPLY_JOB_LEASE_MS = 10 * 60 * 1000;
const TOKEN_INVALID_RETRY_MS = 10 * 60 * 1000;
const SENDING_PAUSED_RETRY_MS = 5 * 60 * 1000;
const ALREADY_REPLIED_META_CODES = new Set([10, 100, 190, 200]);
export const COMMENT_PRIVATE_REPLY_FALLBACK_TEXT =
  "не получилось 🤷‍♀️, ошибка в инсте какая-то. попробуйте ещё раз?)";

export interface ProcessCommentResult {
  inserted: boolean;
  matched: boolean;
  replyJobCreated: boolean;
  sent: boolean;
  skippedReason?: string;
}

export async function processComment(input: {
  comment: NormalizedComment;
  config: AppConfig;
  repo: BotRepository;
  metaClient: MetaGraphClient;
  now: Date;
  allowReplies: boolean;
  sendImmediately?: boolean;
  processingSource?: CommentProcessingSource;
}): Promise<ProcessCommentResult> {
  const match = matchCommentKeyword(input.comment.text, input.config.commentKeywords);
  const eligible = isPrivateReplyEligible(
    input.comment.createdAt,
    input.now,
    input.config.backfillPrivateReplyMaxAgeDays,
  );
  const record: CommentRecord = {
    ...input.comment,
    matchedKeyword: match.keyword,
    privateReplyEligible: eligible,
  };
  const matchedRule = getMatchedReplyRuleForComment(input.config, record);
  const processingSource = input.processingSource ?? input.comment.source;

  const inserted = await input.repo.upsertComment(
    record,
    input.now.toISOString(),
  );

  const finish = async (
    result: ProcessCommentResult,
    action: CommentProcessingAction,
    createdJobTypes: ReplyJobType[] = [],
  ): Promise<ProcessCommentResult> => {
    await input.repo.recordCommentProcessingDecision({
      commentId: input.comment.id,
      source: processingSource,
      matchedKeyword: match.keyword,
      action,
      skippedReason: result.skippedReason,
      createdJobTypes,
      createdAt: input.now.toISOString(),
    });
    return result;
  };

  const basicSkipReason = basicCommentReplySkipReason({
    comment: input.comment,
    config: input.config,
    keywordMatched: match.matched,
  });
  if (basicSkipReason) {
    return finish(
      {
        inserted: inserted.inserted,
        matched: match.matched,
        replyJobCreated: false,
        sent: false,
        skippedReason: basicSkipReason,
      },
      "skipped",
    );
  }

  if (!eligible) {
    return finish(
      {
        inserted: inserted.inserted,
        matched: true,
        replyJobCreated: false,
        sent: false,
        skippedReason: "outside_private_reply_window",
      },
      "skipped",
    );
  }

  const replyJobInputs = matchedRule
    ? planCommentReplyJobs(input.config, matchedRule)
    : [];
  if (
    !input.allowReplies ||
    !input.config.botEnabled ||
    replyJobInputs.length === 0
  ) {
    return finish(
      {
        inserted: inserted.inserted,
        matched: true,
        replyJobCreated: false,
        sent: false,
        skippedReason: "sending_disabled",
      },
      "skipped",
    );
  }

  const conversationStatus = matchedRule?.always
    ? "clear"
    : await getConversationStatus(input.metaClient, input.comment.commenterId);
  if (conversationStatus === "exists") {
    return finish(
      {
        inserted: inserted.inserted,
        matched: true,
        replyJobCreated: false,
        sent: false,
        skippedReason: "existing_conversation",
      },
      "skipped",
    );
  }

  const created = await createReplyJobs({
    repo: input.repo,
    commentId: input.comment.id,
    jobs: replyJobInputs,
    maxAttempts: input.config.maxReplyAttempts,
    now: input.now.toISOString(),
  });

  if (created.insertedJobs.length === 0) {
    return finish(
      {
        inserted: inserted.inserted,
        matched: true,
        replyJobCreated: false,
        sent: false,
        skippedReason: "duplicate_reply_job",
      },
      "duplicate",
    );
  }

  if (conversationStatus === "unknown") {
    await markJobsRetryable({
      repo: input.repo,
      jobs: created.insertedJobs,
      error: "conversation_lookup_failed",
      nextRetryAt: new Date(
        input.now.getTime() + TOKEN_INVALID_RETRY_MS,
      ).toISOString(),
      now: input.now.toISOString(),
    });
    return finish(
      {
        inserted: inserted.inserted,
        matched: true,
        replyJobCreated: true,
        sent: false,
        skippedReason: "conversation_lookup_failed",
      },
      "jobs_created",
      created.insertedJobs.map((job) => job.type),
    );
  }

  if (input.sendImmediately === false) {
    return finish(
      {
        inserted: inserted.inserted,
        matched: true,
        replyJobCreated: true,
        sent: false,
        skippedReason: "reply_job_queued",
      },
      "jobs_created",
      created.insertedJobs.map((job) => job.type),
    );
  }

  let sent = false;
  for (const job of created.insertedJobs) {
    sent =
      (await processReplyJob({
        repo: input.repo,
        metaClient: input.metaClient,
        config: input.config,
        jobId: job.id,
        now: input.now,
      })) || sent;
  }

  return finish(
    {
      inserted: inserted.inserted,
      matched: true,
      replyJobCreated: true,
      sent,
    },
    "jobs_created",
    created.insertedJobs.map((job) => job.type),
  );
}

export async function processReplyJob(input: {
  repo: BotRepository;
  metaClient: MetaGraphClient;
  config: AppConfig;
  jobId: string;
  now: Date;
}): Promise<boolean> {
  const job = await input.repo.getReplyJob(input.jobId);
  if (
    !job ||
    job.status === "sent" ||
    job.status === "failed" ||
    job.status === "blocked"
  ) {
    return false;
  }

  const directMessage =
    job.type === "direct_message_reply"
      ? await input.repo.getDirectMessage(job.directMessageId ?? "")
      : undefined;
  const comment =
    job.type === "direct_message_reply"
      ? undefined
      : await input.repo.getComment(job.commentId ?? "");

  if (job.type === "direct_message_reply") {
    if (!directMessage) {
      await input.repo.markReplyNotSent({
        id: job.id,
        status: "blocked",
        error: "direct_message_not_found",
        now: input.now.toISOString(),
      });
      return false;
    }
  } else {
    if (!comment) {
      await input.repo.markReplyNotSent({
        id: job.id,
        status: "blocked",
        error: "comment_not_found",
        now: input.now.toISOString(),
      });
      return false;
    }

    if (
      !isPrivateReplyEligible(
        comment.createdAt,
        input.now,
        input.config.backfillPrivateReplyMaxAgeDays,
      )
    ) {
      await input.repo.markReplyNotSent({
        id: job.id,
        status: "blocked",
        error: "outside_private_reply_window",
        now: input.now.toISOString(),
      });
      return false;
    }
  }

  const sendPause = getReplySendPause(job.type, input.config, input.now);
  if (sendPause) {
    await input.repo.markReplyNotSent({
      id: job.id,
      status: sendPause.status,
      error: sendPause.error,
      nextRetryAt: sendPause.nextRetryAt,
      now: input.now.toISOString(),
    });
    return false;
  }

  const replyText =
    job.type === "direct_message_reply"
      ? job.replyText ?? getReplyTextForDirectMessage(input.config, directMessage)
      : job.replyText ?? getReplyTextForJob(input.config, job.type, comment);
  if (!replyText) {
    await input.repo.markReplyNotSent({
      id: job.id,
      status: "blocked",
      error: "reply_text_not_configured",
      now: input.now.toISOString(),
    });
    return false;
  }

  const accountStatus = await input.repo.getAccountStatus(
    input.config.instagramAccountId,
  );
  if (accountStatus === "token_invalid") {
    await input.repo.markReplyNotSent({
      id: job.id,
      status: "retryable",
      error: "token_invalid",
      nextRetryAt: new Date(
        input.now.getTime() + TOKEN_INVALID_RETRY_MS,
      ).toISOString(),
      now: input.now.toISOString(),
    });
    return false;
  }

  if (
    job.type === "comment_private_reply" &&
    comment &&
    !shouldBypassExistingConversation(input.config, comment)
  ) {
    const conversationStatus = await getConversationStatus(
      input.metaClient,
      comment.commenterId,
    );
    if (conversationStatus !== "clear") {
      await input.repo.markReplyNotSent({
        id: job.id,
        status: conversationStatus === "unknown" ? "retryable" : "blocked",
        error:
          conversationStatus === "unknown"
            ? "conversation_lookup_failed"
            : "existing_conversation",
        nextRetryAt:
          conversationStatus === "unknown"
            ? new Date(
                input.now.getTime() + TOKEN_INVALID_RETRY_MS,
              ).toISOString()
            : undefined,
        now: input.now.toISOString(),
      });
      return false;
    }
  }

  const attempt = job.attempts + 1;
  const staleSendingBefore = new Date(
    input.now.getTime() - REPLY_JOB_LEASE_MS,
  ).toISOString();
  const claimed = await input.repo.claimReplyJobForSending({
    id: job.id,
    now: input.now.toISOString(),
    staleSendingBefore,
  });
  if (!claimed) {
    return false;
  }

  const rateLimitSlotReserved = await input.repo.reserveReplyRateLimitSlot({
    bucket: toMinuteBucket(input.now),
    limit: input.config.rateLimitMessagesPerMinute,
    replyJobId: job.id,
    now: input.now.toISOString(),
  });
  if (!rateLimitSlotReserved) {
    await input.repo.markReplyNotSent({
      id: job.id,
      status: "retryable",
      error: "rate_limited_locally",
      nextRetryAt: new Date(input.now.getTime() + 60 * 1000).toISOString(),
      now: input.now.toISOString(),
    });
    return false;
  }

  await input.repo.markReplyAttemptStarted({
    id: job.id,
    attempt,
    now: input.now.toISOString(),
  });

  try {
    const response = await sendReplyForJob(
      input.metaClient,
      job,
      directMessage,
      replyText,
    );
    await input.repo.recordReplyAttempt({
      replyJobId: job.id,
      attemptNumber: attempt,
      status: "sent",
      responseSummary: JSON.stringify(response.raw),
      now: input.now.toISOString(),
    });
    await input.repo.markReplySent({
      id: job.id,
      recipientId: response.recipientId,
      messageId: response.messageId,
      now: input.now.toISOString(),
    });
    if (comment) {
      await createAndProcessPublicSuccessJob({
        repo: input.repo,
        metaClient: input.metaClient,
        config: input.config,
        comment,
        sourceJob: job,
        now: input.now,
      });
    }
    return true;
  } catch (error) {
    const normalized = normalizeSendError(error);
    if (normalized.authError) {
      await input.repo.upsertAccountStatus(
        input.config.instagramAccountId,
        "token_invalid",
        input.now.toISOString(),
      );
    }
    if (normalized.alreadyReplied) {
      await input.repo.recordReplyAttempt({
        replyJobId: job.id,
        attemptNumber: attempt,
        status: "sent",
        httpStatus: normalized.httpStatus,
        metaCode: normalized.metaCode,
        metaSubcode: normalized.metaSubcode,
        fbtraceId: normalized.fbtraceId,
        responseSummary: normalized.responseSummary,
        errorMessage: normalized.message,
        now: input.now.toISOString(),
      });
      await input.repo.markReplySent({
        id: job.id,
        now: input.now.toISOString(),
      });
      if (comment) {
        await createAndProcessPublicSuccessJob({
          repo: input.repo,
          metaClient: input.metaClient,
          config: input.config,
          comment,
          sourceJob: job,
          now: input.now,
        });
      }
      return true;
    }

    await input.repo.recordReplyAttempt({
      replyJobId: job.id,
      attemptNumber: attempt,
      status: "failed",
      httpStatus: normalized.httpStatus,
      metaCode: normalized.metaCode,
      metaSubcode: normalized.metaSubcode,
      fbtraceId: normalized.fbtraceId,
      responseSummary: normalized.responseSummary,
      errorMessage: normalized.message,
      now: input.now.toISOString(),
    });

    let retry: {
      status: "retryable" | "failed" | "blocked";
      error?: string;
      nextRetryAt?: string;
    };
    if (normalized.authError) {
      retry = {
        status: "retryable",
        nextRetryAt: new Date(
          input.now.getTime() + TOKEN_INVALID_RETRY_MS,
        ).toISOString(),
      };
    } else {
      const privateReplyInvalid = isPrivateReplyInvalidError(
        job.type,
        normalized,
      );
      const terminalBlockError = terminalMetaBlockError(job.type, normalized);
      if (terminalBlockError) {
        retry = {
          status:
            privateReplyInvalid && attempt < job.maxAttempts
              ? "retryable"
              : "blocked",
          error: terminalBlockError,
          nextRetryAt:
            privateReplyInvalid && attempt < job.maxAttempts
              ? decideRetry({
                  retryable: true,
                  attempt,
                  maxAttempts: job.maxAttempts,
                  now: input.now,
                }).nextRetryAt
              : undefined,
        };
      } else {
        retry = decideRetry({
          retryable: normalized.retryable,
          attempt,
          maxAttempts: job.maxAttempts,
          now: input.now,
        });
      }
    }
    await input.repo.markReplyNotSent({
      id: job.id,
      status: retry.status,
      error: "error" in retry && retry.error ? retry.error : normalized.message,
      nextRetryAt: retry.nextRetryAt,
      now: input.now.toISOString(),
    });
    if (
      job.type === "comment_private_reply" &&
      comment &&
      retry.status === "blocked" &&
      (retry.error === "private_reply_invalid" ||
        retry.error === "meta_recipient_unavailable")
    ) {
      await createAndProcessPublicFallbackJob({
        repo: input.repo,
        metaClient: input.metaClient,
        config: input.config,
        comment,
        now: input.now,
      });
    }
    return false;
  }
}

function toMinuteBucket(value: Date): string {
  return new Date(Math.floor(value.getTime() / 60_000) * 60_000).toISOString();
}

async function createReplyJobs(input: {
  repo: BotRepository;
  commentId: string;
  jobs: Array<{
    type: ReplyJobType;
    replyText?: string;
    publicSuccessReplyText?: string;
  }>;
  maxAttempts: number;
  now: string;
}): Promise<{ jobs: ReplyJobRecord[]; insertedJobs: ReplyJobRecord[] }> {
  const jobs: ReplyJobRecord[] = [];
  const insertedJobs: ReplyJobRecord[] = [];
  for (const jobInput of input.jobs) {
    const replyJob = await input.repo.createReplyJob({
      commentId: input.commentId,
      type: jobInput.type,
      replyText: jobInput.replyText,
      publicSuccessReplyText: jobInput.publicSuccessReplyText,
      maxAttempts: input.maxAttempts,
      now: input.now,
    });
    jobs.push(replyJob.job);
    if (replyJob.inserted) {
      insertedJobs.push(replyJob.job);
    }
  }

  return { jobs, insertedJobs };
}

async function createAndProcessPublicSuccessJob(input: {
  repo: BotRepository;
  metaClient: MetaGraphClient;
  config: AppConfig;
  comment: CommentRecord;
  sourceJob: ReplyJobRecord;
  now: Date;
}): Promise<void> {
  if (
    input.sourceJob.type !== "comment_private_reply" ||
    !input.config.commentPublicReplyEnabled
  ) {
    return;
  }

  const replyText =
    input.sourceJob.publicSuccessReplyText ??
    getPublicCommentReplyText(getMatchedReplyRuleForComment(input.config, input.comment));
  if (!replyText) {
    return;
  }

  await createAndProcessPublicJob({
    repo: input.repo,
    metaClient: input.metaClient,
    config: input.config,
    commentId: input.comment.id,
    replyText,
    now: input.now,
  });
}

async function createAndProcessPublicFallbackJob(input: {
  repo: BotRepository;
  metaClient: MetaGraphClient;
  config: AppConfig;
  comment: CommentRecord;
  now: Date;
}): Promise<void> {
  if (!input.config.commentPublicReplyEnabled) {
    return;
  }

  await createAndProcessPublicJob({
    repo: input.repo,
    metaClient: input.metaClient,
    config: input.config,
    commentId: input.comment.id,
    replyText: COMMENT_PRIVATE_REPLY_FALLBACK_TEXT,
    now: input.now,
  });
}

async function createAndProcessPublicJob(input: {
  repo: BotRepository;
  metaClient: MetaGraphClient;
  config: AppConfig;
  commentId: string;
  replyText: string;
  now: Date;
}): Promise<void> {
  const created = await input.repo.createReplyJob({
    commentId: input.commentId,
    type: "comment_public_reply",
    replyText: input.replyText,
    maxAttempts: input.config.maxReplyAttempts,
    now: input.now.toISOString(),
  });
  if (!created.inserted) {
    return;
  }

  await processReplyJob({
    repo: input.repo,
    metaClient: input.metaClient,
    config: input.config,
    jobId: created.job.id,
    now: input.now,
  });
}

async function markJobsRetryable(input: {
  repo: BotRepository;
  jobs: ReplyJobRecord[];
  error: string;
  nextRetryAt: string;
  now: string;
}): Promise<void> {
  for (const job of input.jobs) {
    await input.repo.markReplyNotSent({
      id: job.id,
      status: "retryable",
      error: input.error,
      nextRetryAt: input.nextRetryAt,
      now: input.now,
    });
  }
}

function getReplySendPause(
  type: ReplyJobType,
  config: AppConfig,
  now: Date,
):
  | { status: "retryable" | "blocked"; error: string; nextRetryAt?: string }
  | undefined {
  if (!config.botEnabled) {
    return {
      status: "retryable",
      error: "sending_paused",
      nextRetryAt: new Date(
        now.getTime() + SENDING_PAUSED_RETRY_MS,
      ).toISOString(),
    };
  }

  return isReplyJobTypeEnabled(config, type)
    ? undefined
    : { status: "blocked", error: "reply_type_disabled" };
}

async function sendReplyForJob(
  metaClient: MetaGraphClient,
  job: ReplyJobRecord,
  directMessage: DirectMessageRecord | undefined,
  replyText: string,
): Promise<{ raw: unknown; recipientId?: string; messageId?: string }> {
  if (job.type === "comment_public_reply") {
    const response = await metaClient.sendPublicReply(requiredCommentId(job), replyText);
    return { raw: response, messageId: response.id };
  }

  if (job.type === "direct_message_reply") {
    const response = await metaClient.sendDirectMessage(
      requiredDirectMessage(directMessage).senderId,
      replyText,
    );
    return {
      raw: response,
      recipientId: response.recipient_id,
      messageId: response.message_id,
    };
  }

  const response = await metaClient.sendPrivateReply(requiredCommentId(job), replyText);
  return {
    raw: response,
    recipientId: response.recipient_id,
    messageId: response.message_id,
  };
}

function requiredCommentId(job: ReplyJobRecord): string {
  if (!job.commentId) {
    throw new Error("Reply job is missing comment_id");
  }

  return job.commentId;
}

function requiredDirectMessage(
  directMessage: DirectMessageRecord | undefined,
): DirectMessageRecord {
  if (!directMessage) {
    throw new Error("Reply job is missing direct message");
  }

  return directMessage;
}

function getReplyTextForJob(
  config: AppConfig,
  type: ReplyJobType,
  comment: CommentRecord | undefined,
): string | undefined {
  if (!comment) {
    return undefined;
  }

  const rule = getReplyRuleForComment(config, comment);
  return getReplyTextForRule(rule, type);
}

function getReplyTextForDirectMessage(
  config: AppConfig,
  directMessage: DirectMessageRecord | undefined,
): string | undefined {
  if (!directMessage) {
    return undefined;
  }

  const rule = findCommentReplyRule(config.commentReplyRules, directMessage.matchedKeyword);
  return rule?.privateReplyText;
}

function getReplyTextForRule(
  rule: CommentReplyRule | undefined,
  type: ReplyJobType,
): string | undefined {
  if (!rule) {
    return undefined;
  }

  return type === "comment_public_reply"
    ? getPublicCommentReplyText(rule)
    : rule.privateReplyText;
}

function normalizeSendError(error: unknown): {
  message: string;
  retryable: boolean;
  httpStatus?: number;
  metaCode?: number;
  metaSubcode?: number;
  fbtraceId?: string;
  responseSummary?: string;
  authError: boolean;
  alreadyReplied: boolean;
} {
  if (error instanceof MetaApiError) {
    const alreadyReplied = isAlreadyRepliedError(error);
    return {
      message: error.message,
      retryable: alreadyReplied ? false : error.retryable,
      httpStatus: error.httpStatus,
      metaCode: error.metaCode,
      metaSubcode: error.metaSubcode,
      fbtraceId: error.fbtraceId,
      responseSummary: error.responseSummary,
      authError: isSendAuthError(error),
      alreadyReplied,
    };
  }

  return {
    message: error instanceof Error ? error.message : "Unknown send error",
    retryable: true,
    authError: false,
    alreadyReplied: false,
  };
}

function isAlreadyRepliedError(error: MetaApiError): boolean {
  const text = `${error.message} ${error.responseSummary}`.toLocaleLowerCase(
    "en-US",
  );
  return (
    (text.includes("already") && text.includes("repl")) ||
    (text.includes("only one") &&
      text.includes("private") &&
      text.includes("reply")) ||
    (error.metaCode !== undefined &&
      ALREADY_REPLIED_META_CODES.has(error.metaCode) &&
      (text.includes("already") || text.includes("only one")) &&
      text.includes("private") &&
      text.includes("reply"))
  );
}

function isSendAuthError(error: MetaApiError): boolean {
  if (error.httpStatus === 401 || error.metaCode === 190) {
    return true;
  }

  if (
    error.httpStatus === 403 &&
    error.metaCode === 200 &&
    error.metaSubcode === 2534066
  ) {
    return false;
  }

  return error.httpStatus === 403 && error.metaCode === undefined;
}

function terminalMetaBlockError(
  type: ReplyJobType,
  error: {
    message: string;
    metaCode?: number;
    metaSubcode?: number;
    responseSummary?: string;
  },
): string | undefined {
  const text =
    `${error.message} ${error.responseSummary ?? ""}`.toLocaleLowerCase(
      "en-US",
    );
  if (
    type === "comment_public_reply" &&
    error.metaCode === 100 &&
    (error.metaSubcode === 33 ||
      (text.includes("does not exist") &&
        text.includes("missing permissions") &&
        text.includes("does not support this operation")))
  ) {
    return "meta_object_unavailable";
  }

  if (
    type === "comment_private_reply" &&
    error.metaCode === 100 &&
    error.metaSubcode === 2534025
  ) {
    return "private_reply_invalid";
  }

  if (
    type === "comment_private_reply" &&
    ((error.metaCode === 100 &&
      (error.metaSubcode === 2534014 ||
        text.includes("requested user cannot be found"))) ||
      (error.metaCode === 200 && error.metaSubcode === 2534066))
  ) {
    return "meta_recipient_unavailable";
  }

  return undefined;
}

function isPrivateReplyInvalidError(
  type: ReplyJobType,
  error: {
    metaCode?: number;
    metaSubcode?: number;
  },
): boolean {
  return (
    type === "comment_private_reply" &&
    error.metaCode === 100 &&
    error.metaSubcode === 2534025
  );
}
