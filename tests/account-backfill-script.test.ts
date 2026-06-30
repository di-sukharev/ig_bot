import { describe, expect, test } from "bun:test";
import { runAccountBackfill } from "../scripts/backfill-account";

describe("account backfill script helper", () => {
  test("follows per-media comment cursors until each media is complete", async () => {
    const mediaBackfillCalls: Array<{
      mediaId: string;
      afterCursor?: string;
      maxPages?: number;
    }> = [];

    const result = await runAccountBackfill({
      options: {
        send: true,
        maxMediaPages: 1,
        maxCommentPages: 5,
        afterCursor: undefined,
      },
      getMediaPage: async () => ({
        data: [{ id: "media_1" }],
      }),
      runMediaBackfill: async (_options, mediaId, afterCursor, maxPages) => {
        mediaBackfillCalls.push({ mediaId, afterCursor, maxPages });
        if (!afterCursor) {
          return {
            ok: true,
            summary: summary({ total: 100, pages: 3, completed: false, nextCursor: "comments_2" }),
          };
        }

        return {
          ok: true,
          summary: summary({ total: 20, pages: 2, completed: true }),
        };
      },
    });

    expect(mediaBackfillCalls).toEqual([
      { mediaId: "media_1", afterCursor: undefined, maxPages: 5 },
      { mediaId: "media_1", afterCursor: "comments_2", maxPages: 2 },
    ]);
    expect(result.completed).toBe(true);
    expect(result.incompleteMedia).toEqual([]);
    expect(result.totals.total).toBe(120);
    expect(result.media).toEqual([
      expect.objectContaining({
        mediaId: "media_1",
        pagesProcessed: 5,
        completed: true,
      }),
    ]);
  });

  test("reports incomplete media when per-media comment page budget is exhausted", async () => {
    const result = await runAccountBackfill({
      options: {
        send: false,
        maxMediaPages: 1,
        maxCommentPages: 1,
        afterCursor: undefined,
      },
      getMediaPage: async () => ({
        data: [{ id: "media_1" }],
      }),
      runMediaBackfill: async () => ({
        ok: true,
        summary: summary({ total: 100, pages: 1, completed: false, nextCursor: "comments_2" }),
      }),
    });

    expect(result.completed).toBe(false);
    expect(result.incompleteMedia).toEqual([
      {
        mediaId: "media_1",
        nextCursor: "comments_2",
        pagesProcessed: 1,
      },
    ]);
  });
});

function summary(overrides: {
  total?: number;
  matched?: number;
  eligiblePrivateReply?: number;
  staleSavedOnly?: number;
  duplicates?: number;
  errors?: number;
  pages?: number;
  completed?: boolean;
  nextCursor?: string;
}) {
  return {
    total: overrides.total ?? 0,
    matched: overrides.matched ?? 0,
    eligiblePrivateReply: overrides.eligiblePrivateReply ?? 0,
    staleSavedOnly: overrides.staleSavedOnly ?? 0,
    duplicates: overrides.duplicates ?? 0,
    errors: overrides.errors ?? 0,
    pages: overrides.pages ?? 1,
    completed: overrides.completed ?? true,
    nextCursor: overrides.nextCursor,
  };
}
