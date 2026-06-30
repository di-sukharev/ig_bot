import type { AppConfig } from "../env";
import type { BotRepository } from "../db/repository";
import type { MetaGraphClient } from "../meta/client";
import type { CommentRecord, ReplyJobRecord } from "../types";
import { isPrivateReplyEligible, matchKeyword } from "./matching";
import {
  basicCommentReplySkipReason,
  getConversationStatus,
  getMatchedReplyRuleForComment,
  planCommentReplyJobs,
} from "./reply-policy";
import type { CommentReplyRule } from "./reply-rules";
import { processReplyJob } from "./service";

export type ManualCommentReplyResult =
  | {
      status: "comment_not_found";
    }
  | {
      status: "reply_not_allowed";
      skippedReason: string;
    }
  | {
      status: "ok";
      commentId: string;
      results: ManualCommentReplyJobResult[];
    };

export interface ManualCommentReplyJobResult {
  id: string;
  type: ReplyJobRecord["type"];
  created: boolean;
  duplicate: boolean;
  sent: boolean;
  status: ReplyJobRecord["status"];
  lastError?: string;
}

export async function sendManualCommentReply(input: {
  commentId: string;
  force: boolean;
  config: AppConfig;
  repo: BotRepository;
  metaClient: MetaGraphClient;
  now: Date;
}): Promise<ManualCommentReplyResult> {
  const comment = await input.repo.getComment(input.commentId);
  if (!comment) {
    return { status: "comment_not_found" };
  }

  const skippedReason = await manualReplySkippedReason({
    ...input,
    comment,
  });
  if (skippedReason) {
    return {
      status: "reply_not_allowed",
      skippedReason,
    };
  }

  const jobs: Array<{ job: ReplyJobRecord; created: boolean }> = [];
  const replyRule = manualReplyRuleForComment(input.config, comment, input.force);
  for (const jobInput of planCommentReplyJobs(input.config, replyRule)) {
    const created = await input.repo.createReplyJob({
      commentId: input.commentId,
      type: jobInput.type,
      replyText: jobInput.replyText,
      publicSuccessReplyText: jobInput.publicSuccessReplyText,
      maxAttempts: input.config.maxReplyAttempts,
      now: input.now.toISOString(),
    });
    jobs.push({ job: created.job, created: created.inserted });
  }

  const replyConfig = input.force ? { ...input.config, botEnabled: true } : input.config;
  const results: ManualCommentReplyJobResult[] = [];
  for (const entry of jobs) {
    const sent = await processReplyJob({
      repo: input.repo,
      metaClient: input.metaClient,
      config: replyConfig,
      jobId: entry.job.id,
      now: input.now,
    });
    const current = await input.repo.getReplyJob(entry.job.id);
    results.push({
      id: entry.job.id,
      type: entry.job.type,
      created: entry.created,
      duplicate: !entry.created,
      sent,
      status: current?.status ?? entry.job.status,
      lastError: current?.lastError,
    });
  }

  return {
    status: "ok",
    commentId: input.commentId,
    results,
  };
}

async function manualReplySkippedReason(input: {
  comment: CommentRecord;
  config: AppConfig;
  metaClient: MetaGraphClient;
  now: Date;
  force: boolean;
}): Promise<string | undefined> {
  const match = matchKeyword(input.comment.text, input.config.commentKeywords);
  const basicSkipReason = basicCommentReplySkipReason({
    comment: input.comment,
    config: input.config,
    keywordMatched: match.matched,
    force: input.force,
  });
  if (basicSkipReason) {
    return basicSkipReason;
  }

  const replyRule = manualReplyRuleForComment(input.config, input.comment, input.force);
  if (planCommentReplyJobs(input.config, replyRule).length === 0) {
    return "sending_disabled";
  }

  if (
    !isPrivateReplyEligible(
      input.comment.createdAt,
      input.now,
      input.config.backfillPrivateReplyMaxAgeDays,
    )
  ) {
    return "outside_private_reply_window";
  }

  if (!input.force && !input.config.botEnabled) {
    return "sending_disabled";
  }

  if (getMatchedReplyRuleForComment(input.config, input.comment)?.always !== true) {
    const conversationStatus = await getConversationStatus(
      input.metaClient,
      input.comment.commenterId,
    );
    if (conversationStatus !== "clear") {
      return conversationStatus === "exists"
        ? "existing_conversation"
        : "conversation_lookup_failed";
    }
  }

  return undefined;
}

function manualReplyRuleForComment(
  config: AppConfig,
  comment: CommentRecord,
  force: boolean,
): CommentReplyRule | undefined {
  return (
    getMatchedReplyRuleForComment(config, comment) ??
    (force ? config.commentReplyRules[0] : undefined)
  );
}
