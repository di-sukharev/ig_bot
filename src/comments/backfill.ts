import type { AppConfig } from "../env";
import type { BotRepository } from "../db/repository";
import { MetaGraphClient } from "../meta/client";
import type { BackfillSummary } from "../types";
import { isPrivateReplyEligible } from "./matching";
import { normalizeFetchedComment } from "./normalize";
import { processComment } from "./service";

export async function runBackfill(input: {
  mediaId: string;
  send: boolean;
  afterCursor?: string;
  maxPages?: number;
  config: AppConfig;
  repo: BotRepository;
  metaClient: MetaGraphClient;
  now: Date;
}): Promise<BackfillSummary> {
  const sendEnabled =
    input.send &&
    input.config.botEnabled &&
    input.config.backfillReplyEnabled &&
    (input.config.commentPrivateReplyEnabled || input.config.commentPublicReplyEnabled);
  const runId = await input.repo.createBackfillRun(
    input.mediaId,
    sendEnabled,
    input.now.toISOString(),
  );
  const summary: BackfillSummary = {
    runId,
    mediaId: input.mediaId,
    sendEnabled,
    total: 0,
    matched: 0,
    eligiblePrivateReply: 0,
    staleSavedOnly: 0,
    duplicates: 0,
    errors: 0,
    pages: 0,
    completed: false,
  };

  try {
    let cursor = input.afterCursor;
    const seenCursors = new Set<string>(input.afterCursor ? [input.afterCursor] : []);
    const requestedMaxPages = input.maxPages ?? input.config.backfillMaxPagesPerRun;
    const maxPages = Math.min(requestedMaxPages, input.config.backfillMaxPagesPerRun);

    while (summary.pages < maxPages) {
      const page = await input.metaClient.getComments(input.mediaId, cursor);
      summary.pages += 1;
      for (const item of page.data) {
        const comment = normalizeFetchedComment(input.mediaId, item);
        if (!comment) {
          summary.errors += 1;
          continue;
        }

        summary.total += 1;
        const eligible = isPrivateReplyEligible(
          comment.createdAt,
          input.now,
          input.config.backfillPrivateReplyMaxAgeDays,
        );
        const result = await processComment({
          comment,
          config: input.config,
          repo: input.repo,
          metaClient: input.metaClient,
          now: input.now,
          allowReplies: sendEnabled,
          sendImmediately: false,
        });

        if (!result.inserted) {
          summary.duplicates += 1;
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

        if (result.matched) {
          summary.matched += 1;
          if (isBackfillPrivateReplyCandidate(comment, input.config.instagramAccountId, eligible)) {
            summary.eligiblePrivateReply += 1;
          } else if (!eligible) {
            summary.staleSavedOnly += 1;
          }
        }
      }

      const nextCursor = page.paging?.cursors?.after;
      await input.repo.updateBackfillCursor(runId, nextCursor);
      if (!nextCursor || seenCursors.has(nextCursor)) {
        summary.completed = true;
        break;
      }

      seenCursors.add(nextCursor);
      cursor = nextCursor;
      summary.nextCursor = nextCursor;
    }

    await input.repo.updateBackfillRun(summary, "finished");
    return summary;
  } catch (error) {
    summary.errors += 1;
    await input.repo.updateBackfillRun(
      summary,
      "failed",
      error instanceof Error ? error.message : "Unknown backfill error",
    );
    throw error;
  }
}

function isBackfillPrivateReplyCandidate(
  comment: { commentKind: "feed" | "live"; commenterId?: string },
  connectedAccountId: string,
  freshEnough: boolean,
): boolean {
  return (
    freshEnough &&
    comment.commentKind === "feed" &&
    Boolean(comment.commenterId) &&
    comment.commenterId !== connectedAccountId
  );
}
