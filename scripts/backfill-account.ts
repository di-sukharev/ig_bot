export interface AccountBackfillOptions {
  send: boolean;
  maxMediaPages: number;
  maxCommentPages?: number;
  afterCursor?: string;
}

export interface MediaPage {
  data?: Array<{ id?: string }>;
  paging?: {
    cursors?: {
      after?: string;
    };
  };
}

export interface BackfillResponse {
  ok: boolean;
  summary?: BackfillSummary;
}

export interface BackfillSummary {
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

export interface AccountBackfillResult {
  ok: true;
  sendEnabled: boolean;
  completed: boolean;
  nextMediaCursor?: string;
  totals: AccountBackfillTotals;
  incompleteMedia: IncompleteMedia[];
  media: MediaBackfillResult[];
}

export interface AccountBackfillTotals {
  media: number;
  total: number;
  matched: number;
  eligiblePrivateReply: number;
  staleSavedOnly: number;
  duplicates: number;
  errors: number;
}

export interface MediaBackfillResult {
  mediaId: string;
  ok: boolean;
  summary?: BackfillSummary;
  pagesProcessed: number;
  completed: boolean;
  nextCursor?: string;
}

export interface IncompleteMedia {
  mediaId: string;
  nextCursor?: string;
  pagesProcessed: number;
}

export async function runAccountBackfill(input: {
  options: AccountBackfillOptions;
  getMediaPage: (options: AccountBackfillOptions, afterCursor: string | undefined) => Promise<MediaPage>;
  runMediaBackfill: (
    options: AccountBackfillOptions,
    mediaId: string,
    afterCursor: string | undefined,
    maxPages: number | undefined,
  ) => Promise<BackfillResponse>;
}): Promise<AccountBackfillResult> {
  const totals: AccountBackfillTotals = {
    media: 0,
    total: 0,
    matched: 0,
    eligiblePrivateReply: 0,
    staleSavedOnly: 0,
    duplicates: 0,
    errors: 0,
  };
  const media: MediaBackfillResult[] = [];
  const incompleteMedia: IncompleteMedia[] = [];
  let mediaCursor = input.options.afterCursor;
  let mediaPaginationCompleted = false;

  for (let pageIndex = 0; pageIndex < input.options.maxMediaPages; pageIndex += 1) {
    const page = await input.getMediaPage(input.options, mediaCursor);
    const mediaIds = (page.data ?? []).map((item) => item.id).filter(Boolean) as string[];

    if (mediaIds.length === 0) {
      mediaPaginationCompleted = true;
      mediaCursor = undefined;
      break;
    }

    for (const mediaId of mediaIds) {
      const result = await runSingleMediaBackfill(input, mediaId);
      media.push(result);
      totals.media += 1;
      addSummaryToTotals(totals, result.summary);
      if (!result.ok) {
        totals.errors += 1;
      }
      if (!result.completed) {
        incompleteMedia.push({
          mediaId,
          nextCursor: result.nextCursor,
          pagesProcessed: result.pagesProcessed,
        });
      }
    }

    const nextCursor = page.paging?.cursors?.after;
    if (!nextCursor || nextCursor === mediaCursor) {
      mediaPaginationCompleted = true;
      mediaCursor = undefined;
      break;
    }

    mediaCursor = nextCursor;
  }

  return {
    ok: true,
    sendEnabled: input.options.send,
    completed: mediaPaginationCompleted && incompleteMedia.length === 0,
    nextMediaCursor: mediaCursor,
    totals,
    incompleteMedia,
    media,
  };
}

async function runSingleMediaBackfill(input: {
  options: AccountBackfillOptions;
  runMediaBackfill: (
    options: AccountBackfillOptions,
    mediaId: string,
    afterCursor: string | undefined,
    maxPages: number | undefined,
  ) => Promise<BackfillResponse>;
}, mediaId: string): Promise<MediaBackfillResult> {
  let afterCursor: string | undefined;
  let pagesRemaining = input.options.maxCommentPages;
  let pagesProcessed = 0;
  let summary: BackfillSummary | undefined;
  const seenCursors = new Set<string>();

  while (pagesRemaining === undefined || pagesRemaining > 0) {
    const response = await input.runMediaBackfill(
      input.options,
      mediaId,
      afterCursor,
      pagesRemaining,
    );
    if (!response.ok || !response.summary) {
      return {
        mediaId,
        ok: false,
        summary,
        pagesProcessed,
        completed: false,
        nextCursor: afterCursor,
      };
    }

    summary = mergeSummaries(summary, response.summary);
    pagesProcessed += response.summary.pages;
    if (pagesRemaining !== undefined) {
      pagesRemaining -= response.summary.pages;
    }

    if (response.summary.completed) {
      return {
        mediaId,
        ok: true,
        summary: { ...summary, completed: true, nextCursor: undefined },
        pagesProcessed,
        completed: true,
      };
    }

    const nextCursor = response.summary.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      return {
        mediaId,
        ok: true,
        summary: { ...summary, completed: false, nextCursor },
        pagesProcessed,
        completed: false,
        nextCursor,
      };
    }

    seenCursors.add(nextCursor);
    afterCursor = nextCursor;
  }

  return {
    mediaId,
    ok: true,
    summary: summary ? { ...summary, completed: false, nextCursor: afterCursor } : undefined,
    pagesProcessed,
    completed: false,
    nextCursor: afterCursor,
  };
}

function mergeSummaries(
  current: BackfillSummary | undefined,
  next: BackfillSummary,
): BackfillSummary {
  if (!current) {
    return { ...next };
  }

  return {
    total: current.total + next.total,
    matched: current.matched + next.matched,
    eligiblePrivateReply: current.eligiblePrivateReply + next.eligiblePrivateReply,
    staleSavedOnly: current.staleSavedOnly + next.staleSavedOnly,
    duplicates: current.duplicates + next.duplicates,
    errors: current.errors + next.errors,
    pages: current.pages + next.pages,
    completed: next.completed,
    nextCursor: next.nextCursor,
  };
}

function addSummaryToTotals(
  totals: AccountBackfillTotals,
  summary: BackfillSummary | undefined,
): void {
  if (!summary) {
    return;
  }

  totals.total += summary.total;
  totals.matched += summary.matched;
  totals.eligiblePrivateReply += summary.eligiblePrivateReply;
  totals.staleSavedOnly += summary.staleSavedOnly;
  totals.duplicates += summary.duplicates;
  totals.errors += summary.errors;
}
