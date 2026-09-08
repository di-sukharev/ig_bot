export interface WorkerEnv {
  DB: D1Database;
  WEBHOOK_QUEUE?: Queue<WebhookQueueMessage>;
  APP_ENV?: string;
  LOG_LEVEL?: string;
  PUBLIC_BASE_URL?: string;
  ADMIN_API_KEY?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_WEBHOOK_VERIFY_TOKEN?: string;
  META_GRAPH_API_VERSION?: string;
  META_GRAPH_API_BASE_URL?: string;
  INSTAGRAM_ACCOUNT_ID?: string;
  INSTAGRAM_USERNAME?: string;
  INSTAGRAM_ACCESS_TOKEN?: string;
  INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT?: string;
  INSTAGRAM_TOKEN_AUTO_REFRESH_ENABLED?: string;
  INSTAGRAM_TOKEN_ENCRYPTION_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  BOT_ENABLED?: string;
  DM_AUTOREPLY_ENABLED?: string;
  COMMENT_PRIVATE_REPLY_ENABLED?: string;
  BACKFILL_REPLY_ENABLED?: string;
  COMMENT_PUBLIC_REPLY_ENABLED?: string;
  BACKFILL_PRIVATE_REPLY_MAX_AGE_DAYS?: string;
  BACKFILL_MAX_PAGES_PER_RUN?: string;
  MAX_REPLY_ATTEMPTS?: string;
  RATE_LIMIT_MESSAGES_PER_MINUTE?: string;
  RECONCILER_ENABLED?: string;
  RECONCILER_INTERVAL_MINUTES?: string;
  RECONCILER_MEDIA_LIMIT?: string;
  RECONCILER_MAX_COMMENT_PAGES_PER_MEDIA?: string;
  RECONCILER_LOOKBACK_HOURS?: string;
}

export interface WebhookQueueMessage {
  type: "webhook_event";
  webhookEventId: string;
}

export interface NormalizedComment {
  id: string;
  mediaId: string;
  commentKind: "feed" | "live";
  commenterId?: string;
  username?: string;
  text?: string;
  createdAt?: string;
  source: "webhook" | "backfill";
  raw: unknown;
}

export interface NormalizedDirectMessage {
  id: string;
  senderId: string;
  recipientId?: string;
  text?: string;
  createdAt?: string;
  source: "webhook";
  raw: unknown;
}

export interface CommentRecord extends NormalizedComment {
  lastSeenSource?: NormalizedComment["source"];
  matchedKeyword?: string;
  privateReplyEligible: boolean;
}

export interface DirectMessageRecord extends NormalizedDirectMessage {
  matchedKeyword?: string;
}

export interface ReplyJobRecord {
  id: string;
  idempotencyKey: string;
  type: ReplyJobType;
  commentId?: string;
  directMessageId?: string;
  replyText?: string;
  publicSuccessReplyText?: string;
  status: ReplyJobStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt?: string;
  lastError?: string;
  metaMessageId?: string;
  metaRecipientId?: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  sendingStartedAt?: string;
}

export type ReplyJobType =
  | "comment_public_reply"
  | "comment_private_reply"
  | "direct_message_reply";

export type ReplyJobStatus =
  | "pending"
  | "sending"
  | "sent"
  | "retryable"
  | "failed"
  | "blocked";

export type ReplyJobStatusCounts = Record<ReplyJobStatus, number>;

export interface ReplyJobBacklogSummary {
  counts: ReplyJobStatusCounts;
  due: number;
  oldestDueCreatedAt?: string;
  oldestDueAgeSeconds?: number;
}

export type CommentProcessingSource = "webhook" | "backfill" | "reconciler";
export type CommentProcessingAction = "jobs_created" | "duplicate" | "skipped";

export interface CommentProcessingDecisionInput {
  commentId: string;
  source: CommentProcessingSource;
  matchedKeyword?: string;
  action: CommentProcessingAction;
  skippedReason?: string;
  createdJobTypes: ReplyJobType[];
  createdAt: string;
}

export interface ReplyDeliveryWindowSummary {
  private: Pick<ReplyJobStatusCounts, "sent" | "failed" | "blocked">;
  public: Pick<ReplyJobStatusCounts, "sent" | "failed" | "blocked">;
  dm: Pick<ReplyJobStatusCounts, "sent" | "failed" | "blocked">;
}

export interface ReplyErrorSummary {
  type: ReplyJobType;
  status: ReplyJobStatus;
  lastError?: string;
  httpStatus?: number;
  metaCode?: number;
  metaSubcode?: number;
  count: number;
}

export interface ReconcilerRunSummary {
  startedAt: string;
  finishedAt: string;
  mediaScanned: number;
  commentsScanned: number;
  commentsRecovered: number;
  replyJobsCreated: number;
  errors: number;
}

export interface ReconcilerMediaCheckpoint {
  newestCommentAt?: string;
  newestCommentIds: string[];
  lastScannedAt: string;
}

export interface ReconcilerCheckpointState {
  version: 1;
  media: Record<string, ReconcilerMediaCheckpoint>;
}

export interface BackfillSummary {
  runId: string;
  mediaId: string;
  sendEnabled: boolean;
  total: number;
  matched: number;
  eligiblePrivateReply: number;
  staleSavedOnly: number;
  duplicates: number;
  errors: number;
  pages: number;
  completed: boolean;
  nextCursor?: string;
}
