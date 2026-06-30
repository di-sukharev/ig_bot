import type { AppConfig } from "../env";
import type { BotRepository } from "../db/repository";
import type { DirectMessageRecord, NormalizedDirectMessage } from "../types";
import { matchKeyword } from "../comments/matching";
import { findCommentReplyRule } from "../comments/reply-rules";

export interface ProcessDirectMessageResult {
  inserted: boolean;
  matched: boolean;
  replyJobCreated: boolean;
  skippedReason?: string;
}

export async function processDirectMessage(input: {
  directMessage: NormalizedDirectMessage;
  config: AppConfig;
  repo: BotRepository;
  now: Date;
  allowReplies: boolean;
}): Promise<ProcessDirectMessageResult> {
  const match = matchKeyword(input.directMessage.text, input.config.commentKeywords);
  const record: DirectMessageRecord = {
    ...input.directMessage,
    matchedKeyword: match.keyword,
  };
  const inserted = await input.repo.upsertDirectMessage(record, input.now.toISOString());

  if (!match.matched) {
    return {
      inserted: inserted.inserted,
      matched: false,
      replyJobCreated: false,
      skippedReason: "no_keyword",
    };
  }

  const rule = findCommentReplyRule(input.config.commentReplyRules, match.keyword);

  if (!rule?.privateReplyText) {
    return {
      inserted: inserted.inserted,
      matched: true,
      replyJobCreated: false,
      skippedReason: "private_reply_text_not_configured",
    };
  }

  if (
    !input.allowReplies ||
    !input.config.botEnabled ||
    !input.config.dmAutoreplyEnabled
  ) {
    return {
      inserted: inserted.inserted,
      matched: true,
      replyJobCreated: false,
      skippedReason: "sending_disabled",
    };
  }

  const created = await input.repo.createReplyJob({
    directMessageId: input.directMessage.id,
    type: "direct_message_reply",
    replyText: rule.privateReplyText,
    maxAttempts: input.config.maxReplyAttempts,
    now: input.now.toISOString(),
  });

  return {
    inserted: inserted.inserted,
    matched: true,
    replyJobCreated: created.inserted,
    skippedReason: created.inserted ? undefined : "duplicate_reply_job",
  };
}
