import type { AppConfig } from "../env";
import type { CommentRecord, NormalizedComment, ReplyJobType } from "../types";
import { matchCommentKeyword } from "./matching";
import { findCommentReplyRule, type CommentReplyRule } from "./reply-rules";

export type ConversationStatus = "clear" | "exists" | "unknown";
export type BasicCommentReplySkipReason =
  | "own_comment"
  | "missing_commenter_id"
  | "live_comment_unsupported"
  | "no_keyword";
export type CommentReplyJobPlan = Array<{
  type: ReplyJobType;
  replyText?: string;
  publicSuccessReplyText?: string;
}>;

const REPLY_JOB_TYPE_FLAGS: Array<{
  type: ReplyJobType;
  isEnabled: (config: AppConfig) => boolean;
}> = [
  { type: "comment_public_reply", isEnabled: (config) => config.commentPublicReplyEnabled },
  { type: "comment_private_reply", isEnabled: (config) => config.commentPrivateReplyEnabled },
  { type: "direct_message_reply", isEnabled: (config) => config.dmAutoreplyEnabled },
];

type CommentIdentity = Pick<NormalizedComment, "commenterId" | "username" | "commentKind">;
type ReplyRuleComment = Pick<CommentRecord, "matchedKeyword" | "text">;
type ConversationClient = {
  hasConversationWithUser(userId: string): Promise<boolean>;
};

export function isOwnComment(comment: CommentIdentity, config: AppConfig): boolean {
  if (comment.commenterId === config.instagramAccountId) {
    return true;
  }

  return Boolean(
    config.instagramUsername &&
      comment.username &&
      comment.username.toLocaleLowerCase("en-US") ===
        config.instagramUsername.toLocaleLowerCase("en-US"),
  );
}

export function basicCommentReplySkipReason(input: {
  comment: CommentIdentity;
  config: AppConfig;
  keywordMatched: boolean;
  force?: boolean;
}): BasicCommentReplySkipReason | undefined {
  if (isOwnComment(input.comment, input.config)) {
    return "own_comment";
  }

  if (!input.comment.commenterId) {
    return "missing_commenter_id";
  }

  if (input.comment.commentKind === "live") {
    return "live_comment_unsupported";
  }

  if (!input.force && !input.keywordMatched) {
    return "no_keyword";
  }

  return undefined;
}

export function planCommentReplyJobs(
  config: AppConfig,
  rule: CommentReplyRule | undefined,
): CommentReplyJobPlan {
  if (config.commentPrivateReplyEnabled && rule?.privateReplyText) {
    return [
      {
        type: "comment_private_reply",
        replyText: rule.privateReplyText,
        publicSuccessReplyText: config.commentPublicReplyEnabled
          ? rule.publicReplyText
          : undefined,
      },
    ];
  }

  if (config.commentPublicReplyEnabled && rule?.publicReplyText) {
    return [
      {
        type: "comment_public_reply",
        replyText: rule.publicReplyText,
      },
    ];
  }

  return [];
}

export function enabledReplyJobTypes(config: AppConfig): ReplyJobType[] {
  return REPLY_JOB_TYPE_FLAGS
    .filter((flag) => flag.isEnabled(config))
    .map((flag) => flag.type);
}

export function disabledReplyJobTypes(config: AppConfig): ReplyJobType[] {
  return REPLY_JOB_TYPE_FLAGS
    .filter((flag) => !flag.isEnabled(config))
    .map((flag) => flag.type);
}

export function isReplyJobTypeEnabled(config: AppConfig, type: ReplyJobType): boolean {
  return REPLY_JOB_TYPE_FLAGS.some(
    (flag) => flag.type === type && flag.isEnabled(config),
  );
}

export function getMatchedReplyRuleForComment(
  config: AppConfig,
  comment: ReplyRuleComment,
): CommentReplyRule | undefined {
  const matchedKeyword =
    comment.matchedKeyword ??
    matchCommentKeyword(comment.text, config.commentKeywords).keyword;
  return findCommentReplyRule(config.commentReplyRules, matchedKeyword);
}

export function getReplyRuleForComment(
  config: AppConfig,
  comment: ReplyRuleComment,
): CommentReplyRule | undefined {
  return getMatchedReplyRuleForComment(config, comment) ?? config.commentReplyRules[0];
}

export function shouldBypassExistingConversation(
  config: AppConfig,
  comment: ReplyRuleComment,
): boolean {
  return getMatchedReplyRuleForComment(config, comment)?.always === true;
}

export async function getConversationStatus(
  metaClient: ConversationClient,
  commenterId: string | undefined,
): Promise<ConversationStatus> {
  if (!commenterId) {
    return "unknown";
  }

  try {
    return (await metaClient.hasConversationWithUser(commenterId)) ? "exists" : "clear";
  } catch {
    return "unknown";
  }
}
