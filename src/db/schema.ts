import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const webhookEventStatuses = ["received", "processing", "processed", "failed"] as const;
export const accountStatuses = ["active", "token_invalid"] as const;
export const commentKinds = ["feed", "live"] as const;
export const commentSources = ["webhook", "backfill"] as const;
export const directMessageSources = ["webhook"] as const;
export const replyJobTypes = [
  "comment_public_reply",
  "comment_private_reply",
  "direct_message_reply",
] as const;
export const commentProcessingSources = ["webhook", "backfill", "reconciler"] as const;
export const commentProcessingActions = ["jobs_created", "duplicate", "skipped"] as const;
export const webhookEventSubjectTypes = [
  "comment",
  "commenter",
  "username",
  "direct_message",
] as const;
export const replyJobStatuses = [
  "pending",
  "sending",
  "sent",
  "retryable",
  "failed",
  "blocked",
] as const;
export const replyAttemptStatuses = ["sent", "failed", "retryable", "blocked"] as const;
export const mediaBackfillRunStatuses = ["running", "finished", "failed"] as const;

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    eventKey: text("event_key").notNull().unique(),
    source: text("source").notNull(),
    rawPayload: text("raw_payload").notNull(),
    headersJson: text("headers_json"),
    status: text("status", { enum: webhookEventStatuses }).notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    receivedAt: text("received_at").notNull(),
    processingStartedAt: text("processing_started_at"),
    processedAt: text("processed_at"),
    lastError: text("last_error"),
    rawPayloadRetentionUntil: text("raw_payload_retention_until").notNull(),
    rawPayloadRedactedAt: text("raw_payload_redacted_at"),
  },
  (table) => [
    index("webhook_events_status_received_idx").on(table.status, table.receivedAt),
    index("webhook_events_retention_idx").on(
      table.rawPayloadRedactedAt,
      table.rawPayloadRetentionUntil,
    ),
    check("webhook_events_source_check", sql`${table.source} = 'instagram'`),
    check(
      "webhook_events_status_check",
      sql`${table.status} IN ('received', 'processing', 'processed', 'failed')`,
    ),
    check("webhook_events_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

export const webhookEventSubjects = sqliteTable(
  "webhook_event_subjects",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => webhookEvents.id),
    subjectType: text("subject_type", { enum: webhookEventSubjectTypes }).notNull(),
    subjectValue: text("subject_value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.subjectType, table.normalizedValue] }),
    index("webhook_event_subjects_lookup_idx").on(table.subjectType, table.normalizedValue),
    check(
      "webhook_event_subjects_type_check",
      sql`${table.subjectType} IN ('comment', 'commenter', 'username', 'direct_message')`,
    ),
  ],
);

export const instagramAccounts = sqliteTable(
  "instagram_accounts",
  {
    id: text("id").primaryKey(),
    status: text("status", { enum: accountStatuses }).notNull().default("active"),
    tokenExpiresAt: text("token_expires_at"),
    tokenState: text("token_state"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("instagram_accounts_status_check", sql`${table.status} IN ('active', 'token_invalid')`),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    mediaId: text("media_id").notNull(),
    commentKind: text("comment_kind", { enum: commentKinds }).notNull().default("feed"),
    commenterId: text("commenter_id"),
    username: text("username"),
    usernameNormalized: text("username_normalized"),
    text: text("text"),
    createdAt: text("created_at"),
    source: text("source", { enum: commentSources }).notNull(),
    lastSeenSource: text("last_seen_source", { enum: commentSources }).notNull(),
    matchedKeyword: text("matched_keyword"),
    privateReplyEligible: integer("private_reply_eligible").notNull().default(0),
    rawJson: text("raw_json"),
    insertedAt: text("inserted_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("comments_kind_source_idx").on(table.commentKind, table.source),
    index("comments_media_idx").on(table.mediaId),
    index("comments_commenter_idx").on(table.commenterId),
    index("comments_username_idx").on(table.username),
    index("comments_username_normalized_idx").on(table.usernameNormalized),
    check("comments_kind_check", sql`${table.commentKind} IN ('feed', 'live')`),
    check("comments_source_check", sql`${table.source} IN ('webhook', 'backfill')`),
    check("comments_last_seen_source_check", sql`${table.lastSeenSource} IN ('webhook', 'backfill')`),
    check("comments_private_reply_eligible_check", sql`${table.privateReplyEligible} IN (0, 1)`),
  ],
);

export const directMessages = sqliteTable(
  "direct_messages",
  {
    id: text("id").primaryKey(),
    senderId: text("sender_id").notNull(),
    recipientId: text("recipient_id"),
    text: text("text"),
    createdAt: text("created_at"),
    source: text("source", { enum: directMessageSources }).notNull(),
    matchedKeyword: text("matched_keyword"),
    rawJson: text("raw_json"),
    insertedAt: text("inserted_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("direct_messages_sender_idx").on(table.senderId),
    index("direct_messages_created_idx").on(table.createdAt),
    check("direct_messages_source_check", sql`${table.source} = 'webhook'`),
  ],
);

export const replyJobs = sqliteTable(
  "reply_jobs",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    type: text("type", { enum: replyJobTypes }).notNull(),
    commentId: text("comment_id").references(() => comments.id),
    directMessageId: text("direct_message_id").references(() => directMessages.id),
    replyText: text("reply_text"),
    publicSuccessReplyText: text("public_success_reply_text"),
    status: text("status", { enum: replyJobStatuses }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    nextRetryAt: text("next_retry_at"),
    lastError: text("last_error"),
    metaMessageId: text("meta_message_id"),
    metaRecipientId: text("meta_recipient_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    sentAt: text("sent_at"),
    sendingStartedAt: text("sending_started_at"),
  },
  (table) => [
    index("reply_jobs_status_next_retry_idx").on(table.status, table.nextRetryAt),
    index("reply_jobs_sending_started_idx").on(table.status, table.sendingStartedAt),
    index("reply_jobs_comment_idx").on(table.commentId),
    index("reply_jobs_direct_message_idx").on(table.directMessageId),
    check(
      "reply_jobs_type_check",
      sql`${table.type} IN ('comment_public_reply', 'comment_private_reply', 'direct_message_reply')`,
    ),
    check(
      "reply_jobs_target_check",
      sql`(
        ${table.type} IN ('comment_public_reply', 'comment_private_reply')
        AND ${table.commentId} IS NOT NULL
        AND ${table.directMessageId} IS NULL
      ) OR (
        ${table.type} = 'direct_message_reply'
        AND ${table.commentId} IS NULL
        AND ${table.directMessageId} IS NOT NULL
      )`,
    ),
    check(
      "reply_jobs_status_check",
      sql`${table.status} IN ('pending', 'sending', 'sent', 'retryable', 'failed', 'blocked')`,
    ),
    check("reply_jobs_attempts_check", sql`${table.attempts} >= 0`),
    check("reply_jobs_max_attempts_check", sql`${table.maxAttempts} > 0`),
  ],
);

export const commentProcessingDecisions = sqliteTable(
  "comment_processing_decisions",
  {
    id: text("id").primaryKey(),
    commentId: text("comment_id")
      .notNull()
      .references(() => comments.id),
    source: text("source", { enum: commentProcessingSources }).notNull(),
    matchedKeyword: text("matched_keyword"),
    action: text("action", { enum: commentProcessingActions }).notNull(),
    skippedReason: text("skipped_reason"),
    createdJobTypesJson: text("created_job_types_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("comment_processing_decisions_comment_idx").on(table.commentId, table.createdAt),
    index("comment_processing_decisions_source_idx").on(table.source, table.createdAt),
    check(
      "comment_processing_decisions_source_check",
      sql`${table.source} IN ('webhook', 'backfill', 'reconciler')`,
    ),
    check(
      "comment_processing_decisions_action_check",
      sql`${table.action} IN ('jobs_created', 'duplicate', 'skipped')`,
    ),
  ],
);

export const replyAttempts = sqliteTable(
  "reply_attempts",
  {
    id: text("id").primaryKey(),
    replyJobId: text("reply_job_id")
      .notNull()
      .references(() => replyJobs.id),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status", { enum: replyAttemptStatuses }).notNull(),
    httpStatus: integer("http_status"),
    metaCode: integer("meta_code"),
    metaSubcode: integer("meta_subcode"),
    fbtraceId: text("fbtrace_id"),
    responseSummary: text("response_summary"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("reply_attempts_job_idx").on(table.replyJobId),
    check("reply_attempts_attempt_number_check", sql`${table.attemptNumber} > 0`),
    check(
      "reply_attempts_status_check",
      sql`${table.status} IN ('sent', 'failed', 'retryable', 'blocked')`,
    ),
  ],
);

export const mediaBackfillRuns = sqliteTable(
  "media_backfill_runs",
  {
    id: text("id").primaryKey(),
    mediaId: text("media_id").notNull(),
    status: text("status", { enum: mediaBackfillRunStatuses }).notNull(),
    sendEnabled: integer("send_enabled").notNull().default(0),
    afterCursor: text("after_cursor"),
    totalCount: integer("total_count").notNull().default(0),
    matchedCount: integer("matched_count").notNull().default(0),
    eligiblePrivateReplyCount: integer("eligible_private_reply_count").notNull().default(0),
    staleSavedOnlyCount: integer("stale_saved_only_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    pageCount: integer("page_count").notNull().default(0),
    completed: integer("completed").notNull().default(0),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    lastError: text("last_error"),
  },
  (table) => [
    index("media_backfill_runs_media_idx").on(table.mediaId, table.startedAt),
    check(
      "media_backfill_runs_status_check",
      sql`${table.status} IN ('running', 'finished', 'failed')`,
    ),
    check("media_backfill_runs_send_enabled_check", sql`${table.sendEnabled} IN (0, 1)`),
    check("media_backfill_runs_total_count_check", sql`${table.totalCount} >= 0`),
    check("media_backfill_runs_matched_count_check", sql`${table.matchedCount} >= 0`),
    check(
      "media_backfill_runs_eligible_private_reply_count_check",
      sql`${table.eligiblePrivateReplyCount} >= 0`,
    ),
    check("media_backfill_runs_stale_saved_only_count_check", sql`${table.staleSavedOnlyCount} >= 0`),
    check("media_backfill_runs_duplicate_count_check", sql`${table.duplicateCount} >= 0`),
    check("media_backfill_runs_error_count_check", sql`${table.errorCount} >= 0`),
    check("media_backfill_runs_page_count_check", sql`${table.pageCount} >= 0`),
    check("media_backfill_runs_completed_check", sql`${table.completed} IN (0, 1)`),
  ],
);

export const mediaCommenters = sqliteTable(
  "media_commenters",
  {
    mediaId: text("media_id").notNull(),
    commenterId: text("commenter_id").notNull(),
    username: text("username"),
    usernameNormalized: text("username_normalized"),
    firstCommentId: text("first_comment_id")
      .notNull()
      .references(() => comments.id),
    lastCommentAt: text("last_comment_at"),
    insertedAt: text("inserted_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.mediaId, table.commenterId] }),
    index("media_commenters_commenter_idx").on(table.commenterId),
    index("media_commenters_username_idx").on(table.username),
    index("media_commenters_username_normalized_idx").on(table.usernameNormalized),
  ],
);

export const replyRateLimitSlots = sqliteTable(
  "reply_rate_limit_slots",
  {
    bucket: text("bucket").notNull(),
    slot: integer("slot").notNull(),
    replyJobId: text("reply_job_id")
      .notNull()
      .references(() => replyJobs.id),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bucket, table.slot] }),
    index("reply_rate_limit_slots_created_idx").on(table.createdAt),
    check("reply_rate_limit_slots_slot_check", sql`${table.slot} >= 0`),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});
