import { requireAdminApiKey } from "./cli";
import {
  runAccountBackfill,
  type AccountBackfillOptions,
  type BackfillResponse,
  type MediaPage,
} from "./backfill-account";

interface AccountBackfillCliOptions extends AccountBackfillOptions {
  baseUrl: string;
  adminApiKey: string;
}

const options = parseOptions();
requireAdminApiKey(options.adminApiKey);

const result = await runAccountBackfill({
  options,
  getMediaPage: (_runnerOptions, afterCursor) => getMediaPage(options, afterCursor),
  runMediaBackfill: (_runnerOptions, mediaId, afterCursor, maxPages) =>
    runMediaBackfill(options, mediaId, afterCursor, maxPages),
});

console.log(JSON.stringify(result, null, 2));

function parseOptions(args: string[] = Bun.argv.slice(2)): AccountBackfillCliOptions {
  let send = false;
  let maxMediaPages = 1;
  let maxCommentPages: number | undefined;
  let afterCursor: string | undefined;
  let baseUrl = process.env.ADMIN_BASE_URL || process.env.PUBLIC_BASE_URL || "http://127.0.0.1:8787";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--send") {
      send = true;
      continue;
    }

    if (arg === "--url") {
      baseUrl = args[index + 1] ?? baseUrl;
      index += 1;
      continue;
    }

    if (arg === "--after") {
      afterCursor = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--max-media-pages") {
      maxMediaPages = parsePositiveInteger(args[index + 1]) ?? maxMediaPages;
      index += 1;
      continue;
    }

    if (arg === "--max-comment-pages") {
      maxCommentPages = parsePositiveInteger(args[index + 1]);
      index += 1;
    }
  }

  return {
    send,
    baseUrl: baseUrl.replace(/\/$/, ""),
    adminApiKey: process.env.ADMIN_API_KEY ?? "",
    maxMediaPages,
    maxCommentPages,
    afterCursor,
  };
}

async function getMediaPage(
  options: AccountBackfillCliOptions,
  afterCursor: string | undefined,
): Promise<MediaPage> {
  const url = new URL("/admin/media", options.baseUrl);
  if (afterCursor) {
    url.searchParams.set("after", afterCursor);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${options.adminApiKey}`,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Media list request failed with ${response.status}: ${body}`);
  }

  return JSON.parse(body) as MediaPage;
}

async function runMediaBackfill(
  options: AccountBackfillCliOptions,
  mediaId: string,
  afterCursor: string | undefined,
  maxPages: number | undefined,
): Promise<BackfillResponse> {
  const url = new URL(`/admin/backfill/media/${encodeURIComponent(mediaId)}`, options.baseUrl);
  if (options.send) {
    url.searchParams.set("send", "1");
  }
  if (afterCursor) {
    url.searchParams.set("after", afterCursor);
  }
  if (maxPages) {
    url.searchParams.set("maxPages", String(maxPages));
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.adminApiKey}`,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Backfill request for media ${mediaId} failed with ${response.status}: ${body}`);
  }

  return JSON.parse(body) as BackfillResponse;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
