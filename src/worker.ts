import { getConfig, type AppConfig } from "./env";
import { reconcileFreshComments } from "./comments/reconciler";
import { disabledReplyJobTypes, enabledReplyJobTypes } from "./comments/reply-policy";
import { processReplyJob, processComment } from "./comments/service";
import { processDirectMessage } from "./direct/service";
import { DrizzleRepository, type BotRepository } from "./db/repository";
import { MetaApiError, MetaGraphClient } from "./meta/client";
import type { ReconcilerRunSummary } from "./types";
import type {
  NormalizedComment,
  NormalizedDirectMessage,
  WebhookQueueMessage,
  WorkerEnv,
} from "./types";
import { normalizeInstagramWebhook } from "./webhook/normalize";

const WEBHOOK_RECOVERY_STALE_MS = 10 * 60 * 1000;
const WEBHOOK_RECOVERY_LIMIT = 20;
const WEBHOOK_RECOVERY_MAX_ATTEMPTS = 3;

export async function processWebhookQueueMessage(
  env: WorkerEnv,
  message: WebhookQueueMessage,
  now = new Date(),
): Promise<void> {
  const config = getConfig(env);
  const repo = new DrizzleRepository(env.DB);
  const metaClient = new MetaGraphClient(config);
  const event = await repo.getWebhookEvent(message.webhookEventId);

  if (!event) {
    throw new Error(`Webhook event ${message.webhookEventId} not found`);
  }

  if (event.status === "processed") {
    return;
  }

  await repo.markWebhookProcessing(event.id, now.toISOString());

  try {
    const payload = JSON.parse(event.rawPayload) as unknown;
    const normalized = normalizeInstagramWebhook(payload, config.instagramAccountId);

    await queueWebhookComments({
      comments: normalized.comments,
      config,
      repo,
      metaClient,
      now,
    });
    await queueWebhookDirectMessages({
      directMessages: normalized.directMessages,
      config,
      repo,
      now,
    });

    await repo.markWebhookProcessed(event.id, now.toISOString());
  } catch (error) {
    await repo.markWebhookFailed(
      event.id,
      error instanceof Error ? error.message : "Unknown webhook processing error",
    );
    throw error;
  }
}

export async function queueWebhookComments(input: {
  comments: NormalizedComment[];
  config: AppConfig;
  repo: BotRepository;
  metaClient: MetaGraphClient;
  now: Date;
}): Promise<void> {
  for (const comment of input.comments) {
    await processComment({
      comment,
      config: input.config,
      repo: input.repo,
      metaClient: input.metaClient,
      now: input.now,
      allowReplies: true,
      sendImmediately: false,
    });
  }
}

export async function queueWebhookDirectMessages(input: {
  directMessages: NormalizedDirectMessage[];
  config: AppConfig;
  repo: BotRepository;
  now: Date;
}): Promise<void> {
  for (const directMessage of input.directMessages) {
    await processDirectMessage({
      directMessage,
      config: input.config,
      repo: input.repo,
      now: input.now,
      allowReplies: true,
    });
  }
}

export async function runScheduledMaintenance(env: WorkerEnv, now = new Date()): Promise<void> {
  const config = getConfig(env);
  const repo = new DrizzleRepository(env.DB);
  const metaClient = new MetaGraphClient(config);
  await runScheduledMaintenanceWithDependencies({
    config,
    repo,
    metaClient,
    webhookQueue: env.WEBHOOK_QUEUE,
    now,
  });
}

export async function runScheduledMaintenanceWithDependencies(input: {
  config: AppConfig;
  repo: BotRepository;
  metaClient: MetaGraphClient;
  webhookQueue?: Queue<WebhookQueueMessage>;
  now: Date;
}): Promise<void> {
  const { config, repo, metaClient, now } = input;
  let canDrain = true;

  if (shouldRunTokenHealth(now)) {
    canDrain = await runTokenHealthCheck({ repo, metaClient, config, now });
  }

  await repo.redactExpiredWebhookPayloads(now.toISOString(), 100);
  await repo.cleanupReplyRateLimitSlots(new Date(now.getTime() - 10 * 60 * 1000).toISOString());
  await repo.blockTerminalFailedReplyJobs(now.toISOString());
  if (input.webhookQueue) {
    await requeueStaleWebhookEvents({
      repo,
      webhookQueue: input.webhookQueue,
      now,
    });
  }
  const staleSendingBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  await repo.blockReplyJobsForTypes({
    types: disabledReplyJobTypes(config),
    error: "reply_type_disabled",
    now: now.toISOString(),
    staleSendingBefore,
  });

  if (!canDrain) {
    return;
  }

  await drainDueReplyJobs({
    repo,
    metaClient,
    config,
    now,
  });

  if (shouldRunReconciler(now, config)) {
    await runFreshCommentReconciler({
      config,
      repo,
      metaClient,
      now,
    });
  }
}

export async function runTokenHealthCheck(input: {
  repo: BotRepository;
  metaClient: MetaGraphClient;
  config: AppConfig;
  now: Date;
}): Promise<boolean> {
  try {
    await input.metaClient.tokenHealth();
    await input.repo.upsertAccountStatus(
      input.config.instagramAccountId,
      "active",
      input.now.toISOString(),
    );
    return true;
  } catch (error) {
    if (isAuthError(error)) {
      await input.repo.upsertAccountStatus(
        input.config.instagramAccountId,
        "token_invalid",
        input.now.toISOString(),
      );
      return false;
    }

    return true;
  }
}

export async function drainDueReplyJobs(input: {
  repo: BotRepository;
  metaClient: MetaGraphClient;
  config: AppConfig;
  now: Date;
}): Promise<{ attempted: number; sent: number }> {
  const staleSendingBefore = new Date(input.now.getTime() - 10 * 60 * 1000).toISOString();
  const enabledTypes = enabledReplyJobTypes(input.config);
  const dueJobs = await input.repo.listDueReplyJobs(
    input.now.toISOString(),
    input.config.rateLimitMessagesPerMinute,
    staleSendingBefore,
    enabledTypes,
  );
  let sent = 0;
  for (const job of dueJobs) {
    const didSend = await processReplyJob({
      repo: input.repo,
      metaClient: input.metaClient,
      config: input.config,
      jobId: job.id,
      now: input.now,
    });
    if (didSend) {
      sent += 1;
    }
  }

  return { attempted: dueJobs.length, sent };
}

export async function requeueStaleWebhookEvents(input: {
  repo: BotRepository;
  webhookQueue: Queue<WebhookQueueMessage>;
  now: Date;
}): Promise<number> {
  const staleBefore = new Date(input.now.getTime() - WEBHOOK_RECOVERY_STALE_MS).toISOString();
  const webhookEventIds = await input.repo.claimStaleWebhookEventsForRetry({
    now: input.now.toISOString(),
    staleReceivedBefore: staleBefore,
    staleProcessingBefore: staleBefore,
    maxAttempts: WEBHOOK_RECOVERY_MAX_ATTEMPTS,
    limit: WEBHOOK_RECOVERY_LIMIT,
  });

  for (const webhookEventId of webhookEventIds) {
    await input.webhookQueue.send({
      type: "webhook_event",
      webhookEventId,
    });
  }

  return webhookEventIds.length;
}

export function shouldRunTokenHealth(now: Date): boolean {
  return now.getUTCMinutes() % 10 === 0;
}

export function shouldRunReconciler(now: Date, config: AppConfig): boolean {
  return (
    config.reconcilerEnabled &&
    now.getUTCMinutes() % config.reconcilerIntervalMinutes === 0
  );
}

export async function runFreshCommentReconciler(input: {
  config: AppConfig;
  repo: BotRepository;
  metaClient: MetaGraphClient;
  now: Date;
}): Promise<ReconcilerRunSummary> {
  return reconcileFreshComments(input);
}

function isAuthError(error: unknown): boolean {
  return error instanceof MetaApiError && (error.httpStatus === 401 || error.httpStatus === 403);
}
