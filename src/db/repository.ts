import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type {
  BackfillSummary,
  CommentProcessingDecisionInput,
  CommentRecord,
  DirectMessageRecord,
  ReconcilerCheckpointState,
  ReconcilerRunSummary,
  ReplyDeliveryWindowSummary,
  ReplyErrorSummary,
  ReplyJobBacklogSummary,
  ReplyJobRecord,
  ReplyJobStatus,
  ReplyJobType,
} from "../types";
import {
  extractWebhookEventSubjects,
  type WebhookEventSubject,
} from "../webhook/subjects";
import { createDb, type DbClient } from "./client";
import {
  accountStatuses,
  comments,
  commentProcessingDecisions,
  directMessages,
  instagramAccounts,
  mediaBackfillRuns,
  mediaCommenters,
  replyAttempts,
  replyJobs,
  replyAttemptStatuses,
  replyJobStatuses,
  replyRateLimitSlots,
  settings,
  webhookEventSubjects,
  webhookEvents,
} from "./schema";

type AccountStatus = typeof accountStatuses[number];
type ReplyAttemptStatus = typeof replyAttemptStatuses[number];

const WEBHOOK_RAW_PAYLOAD_RETENTION_DAYS = 90;
const SQL_BINDING_CHUNK_SIZE = 80;
const DATA_SUBJECT_REDACTION_BATCH_SIZE = 40;
const RECONCILER_CHECKPOINTS_KEY = "reconciler:comment_checkpoints";

export interface InsertWebhookEventInput {
  id: string;
  eventKey: string;
  source: string;
  rawPayload: string;
  headersJson?: string;
  receivedAt: string;
  rawPayloadRetentionUntil?: string;
}

export interface WebhookEventRecord {
  id: string;
  eventKey: string;
  rawPayload: string;
  status: string;
  attempts: number;
}

export interface DataSubjectSelector {
  commentId?: string;
  directMessageId?: string;
  commenterId?: string;
  username?: string;
}

export interface DataSubjectReport {
  selector: DataSubjectSelector;
  commentIds: string[];
  directMessageIds: string[];
  commenterIds: string[];
  usernames: string[];
  replyJobIds: string[];
  webhookEventIds: string[];
  counts: {
    comments: number;
    directMessages: number;
    mediaCommenters: number;
    replyJobs: number;
    commentProcessingDecisions: number;
    replyRateLimitSlots: number;
    replyAttempts: number;
    webhookEvents: number;
    webhookEventSubjects: number;
  };
}

export interface DataSubjectRedactionResult {
  report: DataSubjectReport;
  redacted: {
    comments: number;
    directMessages: number;
    mediaCommenters: number;
    replyJobs: number;
    commentProcessingDecisions: number;
    replyRateLimitSlots: number;
    replyAttempts: number;
    webhookEvents: number;
    webhookEventSubjects: number;
  };
}

export interface CreateReplyJobResult {
  job: ReplyJobRecord;
  inserted: boolean;
}

export type WebhookEventStatusCounts = Record<string, number>;

export interface BotRepository {
  insertWebhookEvent(input: InsertWebhookEventInput): Promise<{ id: string; inserted: boolean }>;
  getWebhookEvent(id: string): Promise<WebhookEventRecord | undefined>;
  markWebhookProcessing(id: string, now: string): Promise<void>;
  markWebhookProcessed(id: string, now: string): Promise<void>;
  markWebhookFailed(id: string, error: string): Promise<void>;
  claimStaleWebhookEventsForRetry(input: {
    now: string;
    staleReceivedBefore: string;
    staleProcessingBefore: string;
    maxAttempts: number;
    limit: number;
  }): Promise<string[]>;
  upsertAccountStatus(accountId: string, status: AccountStatus, now: string): Promise<void>;
  getAccountStatus(accountId: string): Promise<string>;
  upsertComment(comment: CommentRecord, now: string): Promise<{ inserted: boolean }>;
  getComment(id: string): Promise<CommentRecord | undefined>;
  upsertDirectMessage(message: DirectMessageRecord, now: string): Promise<{ inserted: boolean }>;
  getDirectMessage(id: string): Promise<DirectMessageRecord | undefined>;
  createReplyJob(input: {
    commentId?: string;
    directMessageId?: string;
    type?: ReplyJobType;
    replyText?: string;
    publicSuccessReplyText?: string;
    maxAttempts: number;
    now: string;
  }): Promise<CreateReplyJobResult>;
  getReplyJob(id: string): Promise<ReplyJobRecord | undefined>;
  reserveReplyRateLimitSlot(input: {
    bucket: string;
    limit: number;
    replyJobId: string;
    now: string;
  }): Promise<boolean>;
  cleanupReplyRateLimitSlots(before: string): Promise<void>;
  redactExpiredWebhookPayloads(now: string, limit: number): Promise<number>;
  claimReplyJobForSending(input: {
    id: string;
    now: string;
    staleSendingBefore: string;
  }): Promise<boolean>;
  markReplyAttemptStarted(input: { id: string; attempt: number; now: string }): Promise<void>;
  markReplySent(input: {
    id: string;
    recipientId?: string;
    messageId?: string;
    now: string;
  }): Promise<void>;
  markReplyNotSent(input: {
    id: string;
    status: "retryable" | "failed" | "blocked";
    error: string;
    nextRetryAt?: string;
    now: string;
  }): Promise<void>;
  recordReplyAttempt(input: {
    replyJobId: string;
    attemptNumber: number;
    status: ReplyAttemptStatus;
    httpStatus?: number;
    metaCode?: number;
    metaSubcode?: number;
    fbtraceId?: string;
    responseSummary?: string;
    errorMessage?: string;
    now: string;
  }): Promise<void>;
  listDueReplyJobs(
    now: string,
    limit: number,
    staleSendingBefore: string,
    types?: ReplyJobType[],
  ): Promise<ReplyJobRecord[]>;
  blockReplyJobsForTypes(input: {
    types: ReplyJobType[];
    error: string;
    now: string;
    staleSendingBefore: string;
  }): Promise<number>;
  blockTerminalFailedReplyJobs(now: string): Promise<number>;
  getReplyJobBacklog(
    now: string,
    staleSendingBefore: string,
  ): Promise<Omit<ReplyJobBacklogSummary, "oldestDueAgeSeconds">>;
  getWebhookEventStatusCounts(): Promise<WebhookEventStatusCounts>;
  getReplyDeliverySummary(since: string): Promise<ReplyDeliveryWindowSummary>;
  getTopReplyErrors(since: string, limit: number): Promise<ReplyErrorSummary[]>;
  recordCommentProcessingDecision(input: CommentProcessingDecisionInput): Promise<void>;
  recordReconcilerRun(summary: ReconcilerRunSummary): Promise<void>;
  getLastReconcilerRun(): Promise<ReconcilerRunSummary | undefined>;
  getReconcilerCheckpointState(): Promise<ReconcilerCheckpointState>;
  saveReconcilerCheckpointState(state: ReconcilerCheckpointState): Promise<void>;
  createBackfillRun(mediaId: string, sendEnabled: boolean, now: string): Promise<string>;
  updateBackfillRun(
    summary: BackfillSummary,
    status: "finished" | "failed",
    error?: string,
  ): Promise<void>;
  updateBackfillCursor(runId: string, cursor: string | undefined): Promise<void>;
  upsertMediaCommenter(input: {
    mediaId: string;
    commenterId: string;
    username?: string;
    commentId: string;
    lastCommentAt?: string;
    now: string;
  }): Promise<void>;
  getDataSubjectReport(selector: DataSubjectSelector): Promise<DataSubjectReport>;
  anonymizeDataSubject(
    selector: DataSubjectSelector,
    now: string,
  ): Promise<DataSubjectRedactionResult>;
}

type CommentRow = typeof comments.$inferSelect;
type DirectMessageRow = typeof directMessages.$inferSelect;
type ReplyJobRow = typeof replyJobs.$inferSelect;
type DataSubjectCommentRow = Pick<
  typeof comments.$inferSelect,
  "id" | "commenterId" | "usernameNormalized"
>;
type DataSubjectMediaCommenterRow = Pick<
  typeof mediaCommenters.$inferSelect,
  "mediaId" | "commenterId" | "usernameNormalized" | "firstCommentId"
>;
type WebhookEventSubjectRow = Pick<
  typeof webhookEventSubjects.$inferSelect,
  "eventId" | "subjectType" | "normalizedValue"
>;
type DataSubjectDirectMessageRow = Pick<
  typeof directMessages.$inferSelect,
  "id" | "senderId"
>;

export class DrizzleRepository implements BotRepository {
  private readonly rawDb: D1Database;
  private readonly db: DbClient;

  constructor(db: D1Database) {
    this.rawDb = db;
    this.db = createDb(db);
  }

  async insertWebhookEvent(input: InsertWebhookEventInput): Promise<{ id: string; inserted: boolean }> {
    const subjects = extractWebhookEventSubjects(input.rawPayload, input.receivedAt);
    const statements = [
      this.rawDb.prepare(`
        INSERT OR IGNORE INTO webhook_events
          (id, event_key, source, raw_payload, headers_json, status, attempts, received_at,
           raw_payload_retention_until)
        VALUES (?, ?, ?, ?, ?, 'received', 0, ?, ?)
      `).bind(
        input.id,
        input.eventKey,
        input.source,
        input.rawPayload,
        input.headersJson ?? null,
        input.receivedAt,
        input.rawPayloadRetentionUntil ??
          addDaysIso(input.receivedAt, WEBHOOK_RAW_PAYLOAD_RETENTION_DAYS),
      ),
    ];

    const subjectStatement = webhookEventSubjectInsertStatement(input.id, subjects);
    if (subjectStatement) {
      statements.push(this.rawDb.prepare(subjectStatement.sql).bind(...subjectStatement.bindings));
    }

    const results = await this.rawDb.batch(statements);
    if (readD1Changes(results[0]) > 0) {
      return { id: input.id, inserted: true };
    }

    const existing = await this.db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(eq(webhookEvents.eventKey, input.eventKey))
      .get();

    return { id: existing?.id ?? input.id, inserted: false };
  }

  async getWebhookEvent(id: string): Promise<WebhookEventRecord | undefined> {
    const row = await this.db
      .select({
        id: webhookEvents.id,
        eventKey: webhookEvents.eventKey,
        rawPayload: webhookEvents.rawPayload,
        status: webhookEvents.status,
        attempts: webhookEvents.attempts,
      })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, id))
      .get();

    return row ?? undefined;
  }

  async markWebhookProcessing(id: string, now: string): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({
        status: "processing",
        attempts: sql`${webhookEvents.attempts} + 1`,
        processingStartedAt: now,
        lastError: null,
      })
      .where(eq(webhookEvents.id, id))
      .run();
  }

  async markWebhookProcessed(id: string, now: string): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({ status: "processed", processedAt: now })
      .where(eq(webhookEvents.id, id))
      .run();
  }

  async markWebhookFailed(id: string, error: string): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({ status: "failed", lastError: error })
      .where(eq(webhookEvents.id, id))
      .run();
  }

  async claimStaleWebhookEventsForRetry(input: {
    now: string;
    staleReceivedBefore: string;
    staleProcessingBefore: string;
    maxAttempts: number;
    limit: number;
  }): Promise<string[]> {
    if (input.limit <= 0) {
      return [];
    }

    const rows = await this.db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(
        and(
          lt(webhookEvents.attempts, input.maxAttempts),
          or(
            and(
              eq(webhookEvents.status, "received"),
              lte(webhookEvents.receivedAt, input.staleReceivedBefore),
            ),
            and(
              eq(webhookEvents.status, "processing"),
              or(
                isNull(webhookEvents.processingStartedAt),
                lte(webhookEvents.processingStartedAt, input.staleProcessingBefore),
              ),
            ),
            and(
              eq(webhookEvents.status, "failed"),
              or(
                isNull(webhookEvents.processingStartedAt),
                lte(webhookEvents.processingStartedAt, input.staleProcessingBefore),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(webhookEvents.receivedAt))
      .limit(input.limit)
      .all();

    const ids = rows.map((row) => row.id);
    if (ids.length === 0) {
      return [];
    }

    await this.db
      .update(webhookEvents)
      .set({
        status: "processing",
        processingStartedAt: input.now,
        lastError: null,
      })
      .where(inArray(webhookEvents.id, ids))
      .run();

    return ids;
  }

  async upsertAccountStatus(accountId: string, status: AccountStatus, now: string): Promise<void> {
    await this.db
      .insert(instagramAccounts)
      .values({ id: accountId, status, updatedAt: now })
      .onConflictDoUpdate({
        target: instagramAccounts.id,
        set: { status, updatedAt: now },
      })
      .run();
  }

  async getAccountStatus(accountId: string): Promise<string> {
    const row = await this.db
      .select({ status: instagramAccounts.status })
      .from(instagramAccounts)
      .where(eq(instagramAccounts.id, accountId))
      .get();

    return row?.status ?? "active";
  }

  async upsertComment(comment: CommentRecord, now: string): Promise<{ inserted: boolean }> {
    const result = await this.db
      .insert(comments)
      .values(commentInsertValues(comment, now))
      .onConflictDoNothing()
      .run();

    if ((result.meta.changes ?? 0) > 0) {
      return { inserted: true };
    }

    await this.db
      .update(comments)
      .set({
        mediaId: comment.mediaId,
        commentKind: comment.commentKind,
        commenterId: comment.commenterId ?? null,
        username: comment.username ?? null,
        usernameNormalized: comment.username ? normalizeSubjectValue(comment.username) : null,
        text: comment.text ?? null,
        createdAt: comment.createdAt ?? null,
        lastSeenSource: comment.source,
        matchedKeyword: sql`COALESCE(${comment.matchedKeyword ?? null}, ${comments.matchedKeyword})`,
        privateReplyEligible: comment.privateReplyEligible ? 1 : 0,
        rawJson: JSON.stringify(comment.raw),
        updatedAt: now,
      })
      .where(eq(comments.id, comment.id))
      .run();

    return { inserted: false };
  }

  async getComment(id: string): Promise<CommentRecord | undefined> {
    const row = await this.db
      .select()
      .from(comments)
      .where(eq(comments.id, id))
      .get();

    return row ? mapComment(row) : undefined;
  }

  async upsertDirectMessage(
    message: DirectMessageRecord,
    now: string,
  ): Promise<{ inserted: boolean }> {
    const result = await this.db
      .insert(directMessages)
      .values(directMessageInsertValues(message, now))
      .onConflictDoNothing()
      .run();

    if ((result.meta.changes ?? 0) > 0) {
      return { inserted: true };
    }

    await this.db
      .update(directMessages)
      .set({
        senderId: message.senderId,
        recipientId: message.recipientId ?? null,
        text: message.text ?? null,
        createdAt: message.createdAt ?? null,
        matchedKeyword: sql`COALESCE(${message.matchedKeyword ?? null}, ${directMessages.matchedKeyword})`,
        rawJson: JSON.stringify(message.raw),
        updatedAt: now,
      })
      .where(eq(directMessages.id, message.id))
      .run();

    return { inserted: false };
  }

  async getDirectMessage(id: string): Promise<DirectMessageRecord | undefined> {
    const row = await this.db
      .select()
      .from(directMessages)
      .where(eq(directMessages.id, id))
      .get();

    return row ? mapDirectMessage(row) : undefined;
  }

  async createReplyJob(input: {
    commentId?: string;
    directMessageId?: string;
    type?: ReplyJobType;
    replyText?: string;
    publicSuccessReplyText?: string;
    maxAttempts: number;
    now: string;
  }): Promise<CreateReplyJobResult> {
    const type = input.type ?? "comment_private_reply";
    const targetId =
      type === "direct_message_reply" ? input.directMessageId : input.commentId;
    if (!targetId) {
      throw new Error(`Missing reply job target for ${type}`);
    }

    const idempotencyKey = `${type}:${targetId}`;
    const id = crypto.randomUUID();
    const result = await this.db
      .insert(replyJobs)
      .values({
        id,
        idempotencyKey,
        type,
        commentId: type === "direct_message_reply" ? null : input.commentId ?? null,
        directMessageId:
          type === "direct_message_reply" ? input.directMessageId ?? null : null,
        replyText: input.replyText ?? null,
        publicSuccessReplyText: input.publicSuccessReplyText ?? null,
        status: "pending",
        attempts: 0,
        maxAttempts: input.maxAttempts,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing()
      .run();

    const row = await this.db
      .select()
      .from(replyJobs)
      .where(eq(replyJobs.idempotencyKey, idempotencyKey))
      .get();

    const job = row ? mapReplyJob(row) : undefined;
    if (!job) {
      throw new Error("Failed to create or read reply job");
    }

    return { job, inserted: (result.meta.changes ?? 0) > 0 };
  }

  async getReplyJob(id: string): Promise<ReplyJobRecord | undefined> {
    const row = await this.db
      .select()
      .from(replyJobs)
      .where(eq(replyJobs.id, id))
      .get();

    return row ? mapReplyJob(row) : undefined;
  }

  async reserveReplyRateLimitSlot(input: {
    bucket: string;
    limit: number;
    replyJobId: string;
    now: string;
  }): Promise<boolean> {
    for (let slot = 0; slot < input.limit; slot += 1) {
      const result = await this.db
        .insert(replyRateLimitSlots)
        .values({
          bucket: input.bucket,
          slot,
          replyJobId: input.replyJobId,
          createdAt: input.now,
        })
        .onConflictDoNothing()
        .run();

      if ((result.meta.changes ?? 0) === 1) {
        return true;
      }
    }

    return false;
  }

  async cleanupReplyRateLimitSlots(before: string): Promise<void> {
    await this.db
      .delete(replyRateLimitSlots)
      .where(lt(replyRateLimitSlots.createdAt, before))
      .run();
  }

  async redactExpiredWebhookPayloads(now: string, limit: number): Promise<number> {
    if (limit <= 0) {
      return 0;
    }

    const rows = await this.db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(
        and(
          isNull(webhookEvents.rawPayloadRedactedAt),
          lte(webhookEvents.rawPayloadRetentionUntil, now),
        ),
      )
      .limit(limit)
      .all();

    const ids = rows.map((row) => row.id);
    if (ids.length === 0) {
      return 0;
    }

    const results = await this.rawDb.batch([
      this.rawDb.prepare(`
        UPDATE webhook_events
        SET raw_payload = ?,
            raw_payload_redacted_at = ?,
            event_key = 'retention-redacted:' || id
        WHERE id IN (${sqlPlaceholders(ids.length)})
      `).bind(
        JSON.stringify({
          redacted: true,
          reason: "retention_expired",
          redactedAt: now,
        }),
        now,
        ...ids,
      ),
      this.rawDb.prepare(`
        DELETE FROM webhook_event_subjects
        WHERE event_id IN (${sqlPlaceholders(ids.length)})
      `).bind(...ids),
    ]);

    return readD1Changes(results[0]);
  }

  async claimReplyJobForSending(input: {
    id: string;
    now: string;
    staleSendingBefore: string;
  }): Promise<boolean> {
    const result = await this.db
      .update(replyJobs)
      .set({
        status: "sending",
        updatedAt: input.now,
        sendingStartedAt: input.now,
        nextRetryAt: null,
        lastError: null,
      })
      .where(
        and(
          eq(replyJobs.id, input.id),
          or(
            and(
              inArray(replyJobs.status, ["pending", "retryable"]),
              or(isNull(replyJobs.nextRetryAt), lte(replyJobs.nextRetryAt, input.now)),
            ),
            and(
              eq(replyJobs.status, "sending"),
              isNotNull(replyJobs.sendingStartedAt),
              lte(replyJobs.sendingStartedAt, input.staleSendingBefore),
            ),
          ),
        ),
      )
      .run();

    return (result.meta.changes ?? 0) === 1;
  }

  async markReplyAttemptStarted(input: {
    id: string;
    attempt: number;
    now: string;
  }): Promise<void> {
    await this.db
      .update(replyJobs)
      .set({ attempts: input.attempt, updatedAt: input.now })
      .where(eq(replyJobs.id, input.id))
      .run();
  }

  async markReplySent(input: {
    id: string;
    recipientId?: string;
    messageId?: string;
    now: string;
  }): Promise<void> {
    await this.db
      .update(replyJobs)
      .set({
        status: "sent",
        metaRecipientId: input.recipientId ?? null,
        metaMessageId: input.messageId ?? null,
        sentAt: input.now,
        sendingStartedAt: null,
        nextRetryAt: null,
        updatedAt: input.now,
      })
      .where(eq(replyJobs.id, input.id))
      .run();
  }

  async markReplyNotSent(input: {
    id: string;
    status: "retryable" | "failed" | "blocked";
    error: string;
    nextRetryAt?: string;
    now: string;
  }): Promise<void> {
    await this.db
      .update(replyJobs)
      .set({
        status: input.status,
        lastError: input.error,
        nextRetryAt: input.nextRetryAt ?? null,
        sendingStartedAt: null,
        updatedAt: input.now,
      })
      .where(eq(replyJobs.id, input.id))
      .run();
  }

  async recordReplyAttempt(input: {
    replyJobId: string;
    attemptNumber: number;
    status: ReplyAttemptStatus;
    httpStatus?: number;
    metaCode?: number;
    metaSubcode?: number;
    fbtraceId?: string;
    responseSummary?: string;
    errorMessage?: string;
    now: string;
  }): Promise<void> {
    await this.db
      .insert(replyAttempts)
      .values({
        id: crypto.randomUUID(),
        replyJobId: input.replyJobId,
        attemptNumber: input.attemptNumber,
        status: input.status,
        httpStatus: input.httpStatus ?? null,
        metaCode: input.metaCode ?? null,
        metaSubcode: input.metaSubcode ?? null,
        fbtraceId: input.fbtraceId ?? null,
        responseSummary: input.responseSummary ?? null,
        errorMessage: input.errorMessage ?? null,
        createdAt: input.now,
      })
      .run();
  }

  async listDueReplyJobs(
    now: string,
    limit: number,
    staleSendingBefore: string,
    types?: ReplyJobType[],
  ): Promise<ReplyJobRecord[]> {
    if (types && types.length === 0) {
      return [];
    }

    const typeCondition = types ? inArray(replyJobs.type, types) : undefined;
    const where = typeCondition
      ? and(typeCondition, processableDueReplyJobCondition(now, staleSendingBefore))
      : processableDueReplyJobCondition(now, staleSendingBefore);
    const rows = await this.db
      .select()
      .from(replyJobs)
      .where(where)
      .orderBy(asc(replyJobs.createdAt))
      .limit(limit)
      .all();

    return rows.map(mapReplyJob);
  }

  async blockReplyJobsForTypes(input: {
    types: ReplyJobType[];
    error: string;
    now: string;
    staleSendingBefore: string;
  }): Promise<number> {
    if (input.types.length === 0) {
      return 0;
    }

    const result = await this.db
      .update(replyJobs)
      .set({
        status: "blocked",
        lastError: input.error,
        nextRetryAt: null,
        sendingStartedAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          inArray(replyJobs.type, input.types),
          or(
            inArray(replyJobs.status, ["pending", "retryable"]),
            and(
              eq(replyJobs.status, "sending"),
              isNotNull(replyJobs.sendingStartedAt),
              lte(replyJobs.sendingStartedAt, input.staleSendingBefore),
            ),
          ),
        ),
      )
      .run();

    return result.meta.changes ?? 0;
  }

  async blockTerminalFailedReplyJobs(now: string): Promise<number> {
    const unavailablePublic = await this.rawDb.prepare(`
      UPDATE reply_jobs
      SET
        status = 'blocked',
        last_error = 'meta_object_unavailable',
        next_retry_at = NULL,
        sending_started_at = NULL,
        updated_at = ?
      WHERE status = 'failed'
        AND type = 'comment_public_reply'
        AND (
          last_error LIKE 'Unsupported post request. Object with ID%'
          OR EXISTS (
            SELECT 1
            FROM reply_attempts
            WHERE reply_attempts.reply_job_id = reply_jobs.id
              AND reply_attempts.meta_code = 100
              AND reply_attempts.meta_subcode = 33
          )
        )
    `).bind(now).run();
    const unavailablePrivate = await this.rawDb.prepare(`
      UPDATE reply_jobs
      SET
        status = 'blocked',
        last_error = 'meta_recipient_unavailable',
        next_retry_at = NULL,
        sending_started_at = NULL,
        updated_at = ?
      WHERE status = 'failed'
        AND type = 'comment_private_reply'
        AND (
          last_error LIKE '%requested user cannot be found%'
          OR EXISTS (
            SELECT 1
            FROM reply_attempts
            WHERE reply_attempts.reply_job_id = reply_jobs.id
              AND reply_attempts.meta_code = 100
              AND reply_attempts.meta_subcode = 2534014
          )
        )
    `).bind(now).run();
    const invalidPrivateReply = await this.rawDb.prepare(`
      UPDATE reply_jobs
      SET
        status = 'blocked',
        last_error = 'private_reply_invalid',
        next_retry_at = NULL,
        sending_started_at = NULL,
        updated_at = ?
      WHERE status = 'failed'
        AND type = 'comment_private_reply'
        AND EXISTS (
          SELECT 1
          FROM reply_attempts
          WHERE reply_attempts.reply_job_id = reply_jobs.id
            AND reply_attempts.meta_code = 100
            AND reply_attempts.meta_subcode = 2534025
        )
    `).bind(now).run();

    return (
      readD1Changes(unavailablePublic) +
      readD1Changes(unavailablePrivate) +
      readD1Changes(invalidPrivateReply)
    );
  }

  async getReplyJobBacklog(
    now: string,
    staleSendingBefore: string,
  ): Promise<Omit<ReplyJobBacklogSummary, "oldestDueAgeSeconds">> {
    const counts = Object.fromEntries(
      replyJobStatuses.map((status) => [status, 0]),
    ) as ReplyJobBacklogSummary["counts"];
    const countRows = await this.db
      .select({
        status: replyJobs.status,
        count: sql<number>`COUNT(*)`,
      })
      .from(replyJobs)
      .groupBy(replyJobs.status)
      .all();

    for (const row of countRows) {
      if (row.status in counts) {
        counts[row.status as ReplyJobStatus] = row.count;
      }
    }

    const dueRow = await this.db
      .select({
        due: sql<number>`COUNT(*)`,
        oldestDueCreatedAt: sql<string | null>`MIN(${replyJobs.createdAt})`,
      })
      .from(replyJobs)
      .where(processableDueReplyJobCondition(now, staleSendingBefore))
      .get();

    return {
      counts,
      due: dueRow?.due ?? 0,
      oldestDueCreatedAt: dueRow?.oldestDueCreatedAt ?? undefined,
    };
  }

  async getWebhookEventStatusCounts(): Promise<WebhookEventStatusCounts> {
    const rows = await this.db
      .select({
        status: webhookEvents.status,
        count: sql<number>`COUNT(*)`,
      })
      .from(webhookEvents)
      .groupBy(webhookEvents.status)
      .all();

    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  async getReplyDeliverySummary(since: string): Promise<ReplyDeliveryWindowSummary> {
    const summary = emptyReplyDeliveryWindowSummary();
    const rows = await this.db
      .select({
        type: replyJobs.type,
        status: replyJobs.status,
        count: sql<number>`COUNT(*)`,
      })
      .from(replyJobs)
      .where(
        and(
          inArray(replyJobs.status, ["sent", "failed", "blocked"]),
          gte(replyJobs.updatedAt, since),
        ),
      )
      .groupBy(replyJobs.type, replyJobs.status)
      .all();

    for (const row of rows) {
      const target =
        row.type === "direct_message_reply"
          ? summary.dm
          : row.type === "comment_private_reply"
            ? summary.private
            : summary.public;
      if (row.status === "sent" || row.status === "failed" || row.status === "blocked") {
        target[row.status] = row.count;
      }
    }

    return summary;
  }

  async getTopReplyErrors(since: string, limit: number): Promise<ReplyErrorSummary[]> {
    if (limit <= 0) {
      return [];
    }

    const rows = await this.rawDb.prepare(`
      SELECT
        r.type AS type,
        r.status AS status,
        r.last_error AS lastError,
        (
          SELECT a.http_status
          FROM reply_attempts a
          WHERE a.reply_job_id = r.id
          ORDER BY a.created_at DESC
          LIMIT 1
        ) AS httpStatus,
        (
          SELECT a.meta_code
          FROM reply_attempts a
          WHERE a.reply_job_id = r.id
          ORDER BY a.created_at DESC
          LIMIT 1
        ) AS metaCode,
        (
          SELECT a.meta_subcode
          FROM reply_attempts a
          WHERE a.reply_job_id = r.id
          ORDER BY a.created_at DESC
          LIMIT 1
        ) AS metaSubcode,
        COUNT(*) AS count
      FROM reply_jobs r
      WHERE r.updated_at >= ?
        AND r.status IN ('failed', 'blocked', 'retryable')
      GROUP BY r.type, r.status, r.last_error, httpStatus, metaCode, metaSubcode
      ORDER BY count DESC
      LIMIT ?
    `).bind(since, limit).all<{
      type: ReplyJobType;
      status: ReplyJobStatus;
      lastError: string | null;
      httpStatus: number | null;
      metaCode: number | null;
      metaSubcode: number | null;
      count: number;
    }>();

    return (rows.results ?? []).map((row) => ({
      type: row.type,
      status: row.status,
      lastError: row.lastError ?? undefined,
      httpStatus: row.httpStatus ?? undefined,
      metaCode: row.metaCode ?? undefined,
      metaSubcode: row.metaSubcode ?? undefined,
      count: row.count,
    }));
  }

  async recordCommentProcessingDecision(input: CommentProcessingDecisionInput): Promise<void> {
    await this.db
      .insert(commentProcessingDecisions)
      .values({
        id: crypto.randomUUID(),
        commentId: input.commentId,
        source: input.source,
        matchedKeyword: input.matchedKeyword ?? null,
        action: input.action,
        skippedReason: input.skippedReason ?? null,
        createdJobTypesJson: JSON.stringify(input.createdJobTypes),
        createdAt: input.createdAt,
      })
      .run();
  }

  async recordReconcilerRun(summary: ReconcilerRunSummary): Promise<void> {
    await this.db
      .insert(settings)
      .values({
        key: "reconciler:last_run",
        value: JSON.stringify(summary),
        updatedAt: summary.finishedAt,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value: JSON.stringify(summary),
          updatedAt: summary.finishedAt,
        },
      })
      .run();
  }

  async getLastReconcilerRun(): Promise<ReconcilerRunSummary | undefined> {
    const row = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, "reconciler:last_run"))
      .get();

    if (!row) {
      return undefined;
    }

    return JSON.parse(row.value) as ReconcilerRunSummary;
  }

  async getReconcilerCheckpointState(): Promise<ReconcilerCheckpointState> {
    const row = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, RECONCILER_CHECKPOINTS_KEY))
      .get();

    if (!row) {
      return emptyReconcilerCheckpointState();
    }

    try {
      return normalizeReconcilerCheckpointState(JSON.parse(row.value));
    } catch {
      return emptyReconcilerCheckpointState();
    }
  }

  async saveReconcilerCheckpointState(state: ReconcilerCheckpointState): Promise<void> {
    await this.db
      .insert(settings)
      .values({
        key: RECONCILER_CHECKPOINTS_KEY,
        value: JSON.stringify(normalizeReconcilerCheckpointState(state)),
        updatedAt: latestReconcilerCheckpointUpdatedAt(state) ?? new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value: JSON.stringify(normalizeReconcilerCheckpointState(state)),
          updatedAt: latestReconcilerCheckpointUpdatedAt(state) ?? new Date().toISOString(),
        },
      })
      .run();
  }

  async createBackfillRun(mediaId: string, sendEnabled: boolean, now: string): Promise<string> {
    const id = crypto.randomUUID();
    await this.db
      .insert(mediaBackfillRuns)
      .values({
        id,
        mediaId,
        status: "running",
        sendEnabled: sendEnabled ? 1 : 0,
        startedAt: now,
      })
      .run();
    return id;
  }

  async updateBackfillRun(
    summary: BackfillSummary,
    status: "finished" | "failed",
    error?: string,
  ): Promise<void> {
    await this.db
      .update(mediaBackfillRuns)
      .set({
        status,
        totalCount: summary.total,
        matchedCount: summary.matched,
        eligiblePrivateReplyCount: summary.eligiblePrivateReply,
        staleSavedOnlyCount: summary.staleSavedOnly,
        duplicateCount: summary.duplicates,
        errorCount: summary.errors,
        pageCount: summary.pages,
        completed: summary.completed ? 1 : 0,
        finishedAt: new Date().toISOString(),
        lastError: error ?? null,
      })
      .where(eq(mediaBackfillRuns.id, summary.runId))
      .run();
  }

  async updateBackfillCursor(runId: string, cursor: string | undefined): Promise<void> {
    await this.db
      .update(mediaBackfillRuns)
      .set({ afterCursor: cursor ?? null })
      .where(eq(mediaBackfillRuns.id, runId))
      .run();
  }

  async upsertMediaCommenter(input: {
    mediaId: string;
    commenterId: string;
    username?: string;
    commentId: string;
    lastCommentAt?: string;
    now: string;
  }): Promise<void> {
    await this.db
      .insert(mediaCommenters)
      .values({
        mediaId: input.mediaId,
        commenterId: input.commenterId,
        username: input.username ?? null,
        usernameNormalized: input.username ? normalizeSubjectValue(input.username) : null,
        firstCommentId: input.commentId,
        lastCommentAt: input.lastCommentAt ?? null,
        insertedAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [mediaCommenters.mediaId, mediaCommenters.commenterId],
        set: {
          username: sql`COALESCE(${sql.raw("excluded.username")}, ${mediaCommenters.username})`,
          usernameNormalized: sql`COALESCE(${sql.raw("excluded.username_normalized")}, ${mediaCommenters.usernameNormalized})`,
          lastCommentAt: sql`CASE
            WHEN ${sql.raw("excluded.last_comment_at")} IS NULL THEN ${mediaCommenters.lastCommentAt}
            WHEN ${mediaCommenters.lastCommentAt} IS NULL THEN ${sql.raw("excluded.last_comment_at")}
            WHEN ${sql.raw("excluded.last_comment_at")} > ${mediaCommenters.lastCommentAt}
              THEN ${sql.raw("excluded.last_comment_at")}
            ELSE ${mediaCommenters.lastCommentAt}
          END`,
          updatedAt: sql.raw("excluded.updated_at"),
        },
      })
      .run();
  }

  async getDataSubjectReport(selector: DataSubjectSelector): Promise<DataSubjectReport> {
    const normalized = normalizeDataSubjectSelector(selector);
    assertDataSubjectSelector(normalized);

    const commentIds = new Set(normalized.commentId ? [normalized.commentId] : []);
    const directMessageIds = new Set(
      normalized.directMessageId ? [normalized.directMessageId] : [],
    );
    const commenterIds = new Set(normalized.commenterId ? [normalized.commenterId] : []);
    const usernames = new Set(normalized.username ? [normalizeSubjectValue(normalized.username)] : []);
    const commentRows = new Map<string, DataSubjectCommentRow>();
    const directMessageRows = new Map<string, DataSubjectDirectMessageRow>();
    const commenterRows = new Map<string, DataSubjectMediaCommenterRow>();
    let changed = true;

    while (changed) {
      changed = false;

      for (const row of await this.findDataSubjectComments(commentIds, commenterIds, usernames)) {
        commentRows.set(row.id, row);
        changed = addToSet(commentIds, row.id) || changed;
        if (row.commenterId !== null) {
          changed = addToSet(commenterIds, row.commenterId) || changed;
        }
        if (row.usernameNormalized !== null) {
          changed = addToSet(usernames, row.usernameNormalized) || changed;
        }
      }

      for (const row of await this.findDataSubjectDirectMessages(directMessageIds, commenterIds)) {
        directMessageRows.set(row.id, row);
        changed = addToSet(directMessageIds, row.id) || changed;
        changed = addToSet(commenterIds, row.senderId) || changed;
      }

      for (const row of await this.findDataSubjectMediaCommenters(
        commentIds,
        commenterIds,
        usernames,
      )) {
        commenterRows.set(`${row.mediaId}:${row.commenterId}`, row);
        changed = addToSet(commentIds, row.firstCommentId) || changed;
        changed = addToSet(commenterIds, row.commenterId) || changed;
        if (row.usernameNormalized !== null) {
          changed = addToSet(usernames, row.usernameNormalized) || changed;
        }
      }
    }

    const existingCommentIds = [...commentRows.keys()];
    const existingDirectMessageIds = [...directMessageRows.keys()];
    const replyJobRows = [
      ...(await this.findReplyJobsForComments(existingCommentIds)),
      ...(await this.findReplyJobsForDirectMessages(existingDirectMessageIds)),
    ];
    const replyJobIds = replyJobRows.map((row) => row.id);
    const commentProcessingDecisionCount =
      await this.countCommentProcessingDecisionsForComments(existingCommentIds);
    const replyAttemptCount = await this.countReplyAttemptsForJobs(replyJobIds);
    const replyRateLimitSlotCount = await this.countRateLimitSlotsForJobs(replyJobIds);
    const webhookSubjectRows = await this.findWebhookEventSubjects(
      commentIds,
      directMessageIds,
      commenterIds,
      usernames,
    );
    const webhookEventIds = webhookSubjectRows.map((row) => row.eventId);

    return {
      selector: normalized,
      commentIds: uniqueSorted([...commentIds]),
      directMessageIds: uniqueSorted([...directMessageIds]),
      commenterIds: uniqueSorted([...commenterIds]),
      usernames: uniqueSorted([...usernames]),
      replyJobIds: uniqueSorted(replyJobIds),
      webhookEventIds: uniqueSorted(webhookEventIds),
      counts: {
        comments: existingCommentIds.length,
        directMessages: existingDirectMessageIds.length,
        mediaCommenters: commenterRows.size,
        replyJobs: replyJobIds.length,
        commentProcessingDecisions: commentProcessingDecisionCount,
        replyRateLimitSlots: replyRateLimitSlotCount,
        replyAttempts: replyAttemptCount,
        webhookEvents: uniqueSorted(webhookEventIds).length,
        webhookEventSubjects: webhookSubjectRows.length,
      },
    };
  }

  private async findDataSubjectComments(
    commentIds: Set<string>,
    commenterIds: Set<string>,
    usernames: Set<string>,
  ): Promise<DataSubjectCommentRow[]> {
    const rows = new Map<string, DataSubjectCommentRow>();
    await this.collectDataSubjectComments(rows, comments.id, [...commentIds]);
    await this.collectDataSubjectComments(rows, comments.commenterId, [...commenterIds]);
    await this.collectDataSubjectComments(rows, comments.usernameNormalized, [...usernames]);
    return [...rows.values()];
  }

  private async collectDataSubjectComments(
    rows: Map<string, DataSubjectCommentRow>,
    column: typeof comments.id | typeof comments.commenterId | typeof comments.usernameNormalized,
    values: string[],
  ): Promise<void> {
    for (const chunk of chunkValues(values)) {
      for (const row of await this.db
        .select({
          id: comments.id,
          commenterId: comments.commenterId,
          usernameNormalized: comments.usernameNormalized,
        })
        .from(comments)
        .where(inArray(column, chunk))
        .all()) {
        rows.set(row.id, row);
      }
    }
  }

  private async findDataSubjectDirectMessages(
    directMessageIds: Set<string>,
    senderIds: Set<string>,
  ): Promise<DataSubjectDirectMessageRow[]> {
    const rows = new Map<string, DataSubjectDirectMessageRow>();
    await this.collectDataSubjectDirectMessages(rows, directMessages.id, [...directMessageIds]);
    await this.collectDataSubjectDirectMessages(rows, directMessages.senderId, [...senderIds]);
    return [...rows.values()];
  }

  private async collectDataSubjectDirectMessages(
    rows: Map<string, DataSubjectDirectMessageRow>,
    column: typeof directMessages.id | typeof directMessages.senderId,
    values: string[],
  ): Promise<void> {
    for (const chunk of chunkValues(values)) {
      for (const row of await this.db
        .select({
          id: directMessages.id,
          senderId: directMessages.senderId,
        })
        .from(directMessages)
        .where(inArray(column, chunk))
        .all()) {
        rows.set(row.id, row);
      }
    }
  }

  private async findDataSubjectMediaCommenters(
    commentIds: Set<string>,
    commenterIds: Set<string>,
    usernames: Set<string>,
  ): Promise<DataSubjectMediaCommenterRow[]> {
    const rows = new Map<string, DataSubjectMediaCommenterRow>();
    await this.collectDataSubjectMediaCommenters(rows, mediaCommenters.firstCommentId, [...commentIds]);
    await this.collectDataSubjectMediaCommenters(rows, mediaCommenters.commenterId, [...commenterIds]);
    await this.collectDataSubjectMediaCommenters(
      rows,
      mediaCommenters.usernameNormalized,
      [...usernames],
    );
    return [...rows.values()];
  }

  private async collectDataSubjectMediaCommenters(
    rows: Map<string, DataSubjectMediaCommenterRow>,
    column:
      | typeof mediaCommenters.firstCommentId
      | typeof mediaCommenters.commenterId
      | typeof mediaCommenters.usernameNormalized,
    values: string[],
  ): Promise<void> {
    for (const chunk of chunkValues(values)) {
      for (const row of await this.db
        .select({
          mediaId: mediaCommenters.mediaId,
          commenterId: mediaCommenters.commenterId,
          usernameNormalized: mediaCommenters.usernameNormalized,
          firstCommentId: mediaCommenters.firstCommentId,
        })
        .from(mediaCommenters)
        .where(inArray(column, chunk))
        .all()) {
        rows.set(`${row.mediaId}:${row.commenterId}`, row);
      }
    }
  }

  private async findReplyJobsForComments(commentIds: string[]): Promise<Array<{ id: string }>> {
    const rows: Array<{ id: string }> = [];
    for (const chunk of chunkValues(commentIds)) {
      rows.push(...await this.db
        .select({ id: replyJobs.id })
        .from(replyJobs)
        .where(inArray(replyJobs.commentId, chunk))
        .all());
    }

    return rows;
  }

  private async findReplyJobsForDirectMessages(
    directMessageIds: string[],
  ): Promise<Array<{ id: string }>> {
    const rows: Array<{ id: string }> = [];
    for (const chunk of chunkValues(directMessageIds)) {
      rows.push(...await this.db
        .select({ id: replyJobs.id })
        .from(replyJobs)
        .where(inArray(replyJobs.directMessageId, chunk))
        .all());
    }

    return rows;
  }

  private async countReplyAttemptsForJobs(replyJobIds: string[]): Promise<number> {
    let count = 0;
    for (const chunk of chunkValues(replyJobIds)) {
      count += (await this.db
        .select({ count: sql<number>`COUNT(*)` })
        .from(replyAttempts)
        .where(inArray(replyAttempts.replyJobId, chunk))
        .get())?.count ?? 0;
    }

    return count;
  }

  private async countCommentProcessingDecisionsForComments(commentIds: string[]): Promise<number> {
    let count = 0;
    for (const chunk of chunkValues(commentIds)) {
      count += (await this.db
        .select({ count: sql<number>`COUNT(*)` })
        .from(commentProcessingDecisions)
        .where(inArray(commentProcessingDecisions.commentId, chunk))
        .get())?.count ?? 0;
    }

    return count;
  }

  private async countRateLimitSlotsForJobs(replyJobIds: string[]): Promise<number> {
    let count = 0;
    for (const chunk of chunkValues(replyJobIds)) {
      count += (await this.db
        .select({ count: sql<number>`COUNT(*)` })
        .from(replyRateLimitSlots)
        .where(inArray(replyRateLimitSlots.replyJobId, chunk))
        .get())?.count ?? 0;
    }

    return count;
  }

  private async findWebhookEventSubjects(
    commentIds: Set<string>,
    directMessageIds: Set<string>,
    commenterIds: Set<string>,
    usernames: Set<string>,
  ): Promise<WebhookEventSubjectRow[]> {
    const rows: WebhookEventSubjectRow[] = [];
    for (const input of [
      { type: "comment" as const, values: normalizeSubjectValues([...commentIds]) },
      { type: "direct_message" as const, values: normalizeSubjectValues([...directMessageIds]) },
      { type: "commenter" as const, values: normalizeSubjectValues([...commenterIds]) },
      { type: "username" as const, values: [...usernames] },
    ]) {
      for (const chunk of chunkValues(input.values)) {
        rows.push(...await this.db
          .select({
            eventId: webhookEventSubjects.eventId,
            subjectType: webhookEventSubjects.subjectType,
            normalizedValue: webhookEventSubjects.normalizedValue,
          })
          .from(webhookEventSubjects)
          .where(and(
            eq(webhookEventSubjects.subjectType, input.type),
            inArray(webhookEventSubjects.normalizedValue, chunk),
          ))
          .all());
      }
    }

    return rows;
  }

  async anonymizeDataSubject(
    selector: DataSubjectSelector,
    now: string,
  ): Promise<DataSubjectRedactionResult> {
    const report = await this.getDataSubjectReport(selector);
    const redactedPayload = JSON.stringify({ redacted: true, redactedAt: now });
    const redacted = {
      comments: 0,
      directMessages: 0,
      mediaCommenters: 0,
      replyJobs: 0,
      commentProcessingDecisions: 0,
      replyRateLimitSlots: 0,
      replyAttempts: 0,
      webhookEvents: 0,
      webhookEventSubjects: 0,
    };
    const operations: Array<{
      target: keyof typeof redacted;
      statement: ReturnType<D1Database["prepare"]>;
    }> = [];

    for (const mediaCommenterStatement of dataSubjectMediaCommenterDeleteStatements(report)) {
      operations.push({
        target: "mediaCommenters",
        statement: this.rawDb
          .prepare(mediaCommenterStatement.sql)
          .bind(...mediaCommenterStatement.bindings),
      });
    }

    for (const replyJobIds of chunkValues(report.replyJobIds)) {
      operations.push({
        target: "replyRateLimitSlots",
        statement: this.rawDb.prepare(`
          DELETE FROM reply_rate_limit_slots
          WHERE reply_job_id IN (${sqlPlaceholders(replyJobIds.length)})
        `).bind(...replyJobIds),
      });
      operations.push({
        target: "replyAttempts",
        statement: this.rawDb.prepare(`
          DELETE FROM reply_attempts
          WHERE reply_job_id IN (${sqlPlaceholders(replyJobIds.length)})
        `).bind(...replyJobIds),
      });
      operations.push({
        target: "replyJobs",
        statement: this.rawDb.prepare(`
          DELETE FROM reply_jobs
          WHERE id IN (${sqlPlaceholders(replyJobIds.length)})
        `).bind(...replyJobIds),
      });
    }

    for (const commentIds of chunkValues(report.commentIds)) {
      operations.push({
        target: "commentProcessingDecisions",
        statement: this.rawDb.prepare(`
          DELETE FROM comment_processing_decisions
          WHERE comment_id IN (${sqlPlaceholders(commentIds.length)})
        `).bind(...commentIds),
      });
      operations.push({
        target: "comments",
        statement: this.rawDb.prepare(`
          DELETE FROM comments
          WHERE id IN (${sqlPlaceholders(commentIds.length)})
        `).bind(...commentIds),
      });
    }

    for (const directMessageIds of chunkValues(report.directMessageIds)) {
      operations.push({
        target: "directMessages",
        statement: this.rawDb.prepare(`
          DELETE FROM direct_messages
          WHERE id IN (${sqlPlaceholders(directMessageIds.length)})
        `).bind(...directMessageIds),
      });
    }

    for (const webhookEventIds of chunkValues(report.webhookEventIds)) {
      operations.push({
        target: "webhookEvents",
        statement: this.rawDb.prepare(`
          UPDATE webhook_events
          SET raw_payload = ?,
              raw_payload_redacted_at = ?,
              event_key = 'redacted:' || id
          WHERE id IN (${sqlPlaceholders(webhookEventIds.length)})
        `).bind(redactedPayload, now, ...webhookEventIds),
      });
      operations.push({
        target: "webhookEventSubjects",
        statement: this.rawDb.prepare(`
          DELETE FROM webhook_event_subjects
          WHERE event_id IN (${sqlPlaceholders(webhookEventIds.length)})
        `).bind(...webhookEventIds),
      });
    }

    for (const operationChunk of chunkValues(operations, DATA_SUBJECT_REDACTION_BATCH_SIZE)) {
      const results = await this.rawDb.batch(operationChunk.map((operation) => operation.statement));
      results.forEach((result, index) => {
        redacted[operationChunk[index]!.target] += readD1Changes(result);
      });
    }

    return { report, redacted };
  }
}

export { DrizzleRepository as D1Repository };

function normalizeDataSubjectSelector(selector: DataSubjectSelector): DataSubjectSelector {
  return {
    commentId: cleanSelectorValue(selector.commentId),
    directMessageId: cleanSelectorValue(selector.directMessageId),
    commenterId: cleanSelectorValue(selector.commenterId),
    username: cleanSelectorValue(selector.username)?.replace(/^@/, ""),
  };
}

function assertDataSubjectSelector(selector: DataSubjectSelector): void {
  if (
    !selector.commentId &&
    !selector.directMessageId &&
    !selector.commenterId &&
    !selector.username
  ) {
    throw new Error("At least one data subject selector is required");
  }
}

function cleanSelectorValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function webhookEventSubjectInsertStatement(
  eventId: string,
  subjects: WebhookEventSubject[],
): { sql: string; bindings: string[] } | undefined {
  if (subjects.length === 0) {
    return undefined;
  }

  const selectClauses = subjects.map(
    () => "SELECT ?, ?, ?, ?, ? WHERE changes() = 1",
  );
  const bindings = subjects.flatMap((subject) => [
    eventId,
    subject.subjectType,
    subject.subjectValue,
    subject.normalizedValue,
    subject.createdAt,
  ]);

  return {
    sql: `
      INSERT OR IGNORE INTO webhook_event_subjects
        (event_id, subject_type, subject_value, normalized_value, created_at)
      ${selectClauses.join(" UNION ALL ")}
    `,
    bindings,
  };
}

function normalizeSubjectValue(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function normalizeSubjectValues(values: string[]): string[] {
  return uniqueSorted(values.map((value) => normalizeSubjectValue(value)));
}

function addToSet<T>(set: Set<T>, value: T): boolean {
  if (set.has(value)) {
    return false;
  }

  set.add(value);
  return true;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function dataSubjectMediaCommenterDeleteStatements(
  report: DataSubjectReport,
): Array<{ sql: string; bindings: string[] }> {
  const statements: Array<{ sql: string; bindings: string[] }> = [];
  for (const commentIds of chunkValues(report.commentIds)) {
    statements.push({
      sql: `DELETE FROM media_commenters WHERE first_comment_id IN (${sqlPlaceholders(commentIds.length)})`,
      bindings: commentIds,
    });
  }
  for (const commenterIds of chunkValues(report.commenterIds)) {
    statements.push({
      sql: `DELETE FROM media_commenters WHERE commenter_id IN (${sqlPlaceholders(commenterIds.length)})`,
      bindings: commenterIds,
    });
  }
  for (const usernames of chunkValues(report.usernames)) {
    statements.push({
      sql: `DELETE FROM media_commenters WHERE username_normalized IN (${sqlPlaceholders(usernames.length)})`,
      bindings: usernames,
    });
  }

  return statements;
}

function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function chunkValues<T>(values: T[], size = SQL_BINDING_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

function readD1Changes(result: unknown): number {
  if (!isRecord(result) || !isRecord(result.meta) || typeof result.meta.changes !== "number") {
    return 0;
  }

  return result.meta.changes;
}

function addDaysIso(value: string, days: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyReconcilerCheckpointState(): ReconcilerCheckpointState {
  return { version: 1, media: {} };
}

function normalizeReconcilerCheckpointState(value: unknown): ReconcilerCheckpointState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.media)) {
    return emptyReconcilerCheckpointState();
  }

  const media: ReconcilerCheckpointState["media"] = {};
  for (const [mediaId, checkpoint] of Object.entries(value.media)) {
    if (!mediaId || !isRecord(checkpoint)) {
      continue;
    }

    const lastScannedAt = readString(checkpoint.lastScannedAt);
    if (!lastScannedAt) {
      continue;
    }

    const newestCommentAt = readString(checkpoint.newestCommentAt);
    const newestCommentIds = Array.isArray(checkpoint.newestCommentIds)
      ? [...new Set(checkpoint.newestCommentIds.filter((id) => typeof id === "string" && id.length > 0))]
      : [];

    media[mediaId] = {
      ...(newestCommentAt ? { newestCommentAt } : {}),
      newestCommentIds,
      lastScannedAt,
    };
  }

  return { version: 1, media };
}

function latestReconcilerCheckpointUpdatedAt(
  state: ReconcilerCheckpointState,
): string | undefined {
  return Object.values(state.media)
    .map((checkpoint) => checkpoint.lastScannedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
}

function commentInsertValues(comment: CommentRecord, now: string): typeof comments.$inferInsert {
  return {
    id: comment.id,
    mediaId: comment.mediaId,
    commentKind: comment.commentKind,
    commenterId: comment.commenterId ?? null,
    username: comment.username ?? null,
    usernameNormalized: comment.username ? normalizeSubjectValue(comment.username) : null,
    text: comment.text ?? null,
    createdAt: comment.createdAt ?? null,
    source: comment.source,
    lastSeenSource: comment.source,
    matchedKeyword: comment.matchedKeyword ?? null,
    privateReplyEligible: comment.privateReplyEligible ? 1 : 0,
    rawJson: JSON.stringify(comment.raw),
    insertedAt: now,
    updatedAt: now,
  };
}

function directMessageInsertValues(
  message: DirectMessageRecord,
  now: string,
): typeof directMessages.$inferInsert {
  return {
    id: message.id,
    senderId: message.senderId,
    recipientId: message.recipientId ?? null,
    text: message.text ?? null,
    createdAt: message.createdAt ?? null,
    source: message.source,
    matchedKeyword: message.matchedKeyword ?? null,
    rawJson: JSON.stringify(message.raw),
    insertedAt: now,
    updatedAt: now,
  };
}

function dueReplyJobCondition(now: string, staleSendingBefore: string): SQL {
  return or(
    and(
      inArray(replyJobs.status, ["pending", "retryable"]),
      or(isNull(replyJobs.nextRetryAt), lte(replyJobs.nextRetryAt, now)),
    ),
    and(
      eq(replyJobs.status, "sending"),
      isNotNull(replyJobs.sendingStartedAt),
      lte(replyJobs.sendingStartedAt, staleSendingBefore),
    ),
  )!;
}

function processableDueReplyJobCondition(now: string, staleSendingBefore: string): SQL {
  return and(
    or(isNotNull(replyJobs.commentId), isNotNull(replyJobs.directMessageId)),
    dueReplyJobCondition(now, staleSendingBefore),
  )!;
}

function emptyReplyDeliveryWindowSummary(): ReplyDeliveryWindowSummary {
  return {
    private: { sent: 0, failed: 0, blocked: 0 },
    public: { sent: 0, failed: 0, blocked: 0 },
    dm: { sent: 0, failed: 0, blocked: 0 },
  };
}

function mapComment(row: CommentRow): CommentRecord {
  return {
    id: row.id,
    mediaId: row.mediaId,
    commenterId: row.commenterId ?? undefined,
    username: row.username ?? undefined,
    text: row.text ?? undefined,
    createdAt: row.createdAt ?? undefined,
    source: row.source,
    lastSeenSource: row.lastSeenSource,
    commentKind: row.commentKind ?? "feed",
    matchedKeyword: row.matchedKeyword ?? undefined,
    privateReplyEligible: row.privateReplyEligible === 1,
    raw: row.rawJson ? JSON.parse(row.rawJson) : {},
  };
}

function mapDirectMessage(row: DirectMessageRow): DirectMessageRecord {
  return {
    id: row.id,
    senderId: row.senderId,
    recipientId: row.recipientId ?? undefined,
    text: row.text ?? undefined,
    createdAt: row.createdAt ?? undefined,
    source: row.source,
    matchedKeyword: row.matchedKeyword ?? undefined,
    raw: row.rawJson ? JSON.parse(row.rawJson) : {},
  };
}

function mapReplyJob(row: ReplyJobRow): ReplyJobRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    type: row.type,
    commentId: row.commentId ?? undefined,
    directMessageId: row.directMessageId ?? undefined,
    replyText: row.replyText ?? undefined,
    publicSuccessReplyText: row.publicSuccessReplyText ?? undefined,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    nextRetryAt: row.nextRetryAt ?? undefined,
    lastError: row.lastError ?? undefined,
    metaMessageId: row.metaMessageId ?? undefined,
    metaRecipientId: row.metaRecipientId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sentAt: row.sentAt ?? undefined,
    sendingStartedAt: row.sendingStartedAt ?? undefined,
  };
}
