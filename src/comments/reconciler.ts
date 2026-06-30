import type { AppConfig } from "../env";
import type { BotRepository } from "../db/repository";
import type { MetaComment, MetaGraphClient } from "../meta/client";
import type {
  ReconcilerCheckpointState,
  ReconcilerMediaCheckpoint,
  ReconcilerRunSummary,
} from "../types";
import { normalizeFetchedComment } from "./normalize";
import { processComment } from "./service";

export async function reconcileFreshComments(input: {
  config: AppConfig;
  repo: BotRepository;
  metaClient: MetaGraphClient;
  now: Date;
}): Promise<ReconcilerRunSummary> {
  const startedAt = input.now.toISOString();
  const summary: ReconcilerRunSummary = {
    startedAt,
    finishedAt: startedAt,
    mediaScanned: 0,
    commentsScanned: 0,
    commentsRecovered: 0,
    replyJobsCreated: 0,
    errors: 0,
  };
  const lookbackAfter = new Date(
    input.now.getTime() - input.config.reconcilerLookbackHours * 60 * 60 * 1000,
  );
  const checkpointState = await input.repo.getReconcilerCheckpointState();
  const nextCheckpointState: ReconcilerCheckpointState = { version: 1, media: {} };
  let shouldSaveCheckpointState = false;

  try {
    let mediaCursor: string | undefined;
    while (summary.mediaScanned < input.config.reconcilerMediaLimit) {
      const mediaPage = await input.metaClient.getMedia(mediaCursor);
      const mediaIds = (mediaPage.data ?? [])
        .map((media) => media.id)
        .filter(Boolean)
        .slice(0, input.config.reconcilerMediaLimit - summary.mediaScanned);

      if (mediaIds.length === 0) {
        break;
      }

      for (const mediaId of mediaIds) {
        summary.mediaScanned += 1;
        shouldSaveCheckpointState = true;
        const existingCheckpoint = checkpointState.media[mediaId];
        if (existingCheckpoint) {
          nextCheckpointState.media[mediaId] = existingCheckpoint;
        }

        const mediaResult = await reconcileMediaComments({
          ...input,
          mediaId,
          lookbackAfter,
          summary,
          checkpoint: existingCheckpoint,
        });
        if (mediaResult.success) {
          nextCheckpointState.media[mediaId] = mediaResult.checkpoint;
        }
      }

      const nextCursor = mediaPage.paging?.cursors?.after;
      if (!nextCursor || nextCursor === mediaCursor) {
        break;
      }
      mediaCursor = nextCursor;
    }
  } catch {
    summary.errors += 1;
  }

  summary.finishedAt = new Date().toISOString();
  if (shouldSaveCheckpointState) {
    try {
      await input.repo.saveReconcilerCheckpointState(nextCheckpointState);
    } catch {
      summary.errors += 1;
    }
  }
  await input.repo.recordReconcilerRun(summary);
  return summary;
}

async function reconcileMediaComments(input: {
  config: AppConfig;
  repo: BotRepository;
  metaClient: MetaGraphClient;
  now: Date;
  mediaId: string;
  lookbackAfter: Date;
  summary: ReconcilerRunSummary;
  checkpoint?: ReconcilerMediaCheckpoint;
}): Promise<{ success: boolean; checkpoint: ReconcilerMediaCheckpoint }> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const nextCheckpoint = createNextCheckpoint(input.checkpoint, input.now);
  for (let pageIndex = 0; pageIndex < input.config.reconcilerMaxCommentPagesPerMedia; pageIndex += 1) {
    let page: Awaited<ReturnType<MetaGraphClient["getComments"]>>;
    try {
      page = await input.metaClient.getComments(input.mediaId, cursor);
    } catch {
      input.summary.errors += 1;
      return { success: false, checkpoint: input.checkpoint ?? nextCheckpoint };
    }

    let pageHasNewCheckpointComments = input.checkpoint === undefined;
    let pageHasUnorderedComments = false;

    for (const item of page.data) {
      input.summary.commentsScanned += 1;
      const comment = normalizeFetchedComment(input.mediaId, item);
      if (!comment) {
        continue;
      }

      updateCheckpointFromComment(nextCheckpoint, item, input.now);
      const isNewForCheckpoint = isNewerThanCheckpoint(comment.id, comment.createdAt, input.checkpoint);
      if (isTimestampMissingOrInvalid(comment.createdAt)) {
        pageHasUnorderedComments = true;
      }
      if (isNewForCheckpoint) {
        pageHasNewCheckpointComments = true;
      }

      if (
        input.checkpoint &&
        !isNewForCheckpoint &&
        !isTimestampMissingOrInvalid(comment.createdAt)
      ) {
        continue;
      }

      if (!isWithinLookback(comment.createdAt, input.lookbackAfter)) {
        continue;
      }

      const result = await processComment({
        comment,
        config: input.config,
        repo: input.repo,
        metaClient: input.metaClient,
        now: input.now,
        allowReplies: true,
        sendImmediately: false,
        processingSource: "reconciler",
      });

      if (result.inserted || result.replyJobCreated) {
        input.summary.commentsRecovered += 1;
      }
      if (result.replyJobCreated) {
        input.summary.replyJobsCreated += 1;
      }

      if (comment.commenterId) {
        await input.repo.upsertMediaCommenter({
          mediaId: input.mediaId,
          commenterId: comment.commenterId,
          username: comment.username,
          commentId: comment.id,
          lastCommentAt: comment.createdAt,
          now: input.now.toISOString(),
        });
      }
    }

    if (input.checkpoint && !pageHasNewCheckpointComments && !pageHasUnorderedComments) {
      return { success: true, checkpoint: nextCheckpoint };
    }

    const nextCursor = page.paging?.cursors?.after;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      return { success: true, checkpoint: nextCheckpoint };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return { success: true, checkpoint: nextCheckpoint };
}

function isWithinLookback(createdAt: string | undefined, lookbackAfter: Date): boolean {
  if (!createdAt) {
    return true;
  }

  const parsed = Date.parse(createdAt);
  return !Number.isFinite(parsed) || parsed >= lookbackAfter.getTime();
}

function createNextCheckpoint(
  checkpoint: ReconcilerMediaCheckpoint | undefined,
  now: Date,
): ReconcilerMediaCheckpoint {
  return {
    ...(checkpoint?.newestCommentAt ? { newestCommentAt: checkpoint.newestCommentAt } : {}),
    newestCommentIds: [...new Set(checkpoint?.newestCommentIds ?? [])],
    lastScannedAt: now.toISOString(),
  };
}

function updateCheckpointFromComment(
  checkpoint: ReconcilerMediaCheckpoint,
  item: MetaComment,
  now: Date,
): void {
  const parsed = parseTimestamp(item.timestamp);
  if (parsed === undefined) {
    checkpoint.lastScannedAt = now.toISOString();
    return;
  }

  const current = parseTimestamp(checkpoint.newestCommentAt);
  if (current === undefined || parsed > current) {
    checkpoint.newestCommentAt = item.timestamp;
    checkpoint.newestCommentIds = [item.id];
  } else if (parsed === current && !checkpoint.newestCommentIds.includes(item.id)) {
    checkpoint.newestCommentIds.push(item.id);
  }

  checkpoint.lastScannedAt = now.toISOString();
}

function isNewerThanCheckpoint(
  commentId: string,
  createdAt: string | undefined,
  checkpoint: ReconcilerMediaCheckpoint | undefined,
): boolean {
  if (!checkpoint?.newestCommentAt) {
    return true;
  }

  const createdAtMs = parseTimestamp(createdAt);
  const checkpointMs = parseTimestamp(checkpoint.newestCommentAt);
  if (createdAtMs === undefined || checkpointMs === undefined) {
    return true;
  }

  return createdAtMs > checkpointMs ||
    (createdAtMs === checkpointMs && !checkpoint.newestCommentIds.includes(commentId));
}

function isTimestampMissingOrInvalid(createdAt: string | undefined): boolean {
  return parseTimestamp(createdAt) === undefined;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
