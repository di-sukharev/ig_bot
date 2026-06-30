import { parseCliOptions, requireAdminApiKey } from "./cli";

const options = parseCliOptions();
requireAdminApiKey(options.adminApiKey);

if (!options.mediaId) {
  throw new Error(
    "Usage: bun run backfill:comments -- --media <mediaId> [--send] [--after <cursor>] [--max-pages <n>] [--url <baseUrl>]",
  );
}

const url = new URL(`/admin/backfill/media/${encodeURIComponent(options.mediaId)}`, options.baseUrl);
if (options.send) {
  url.searchParams.set("send", "1");
}
if (options.afterCursor) {
  url.searchParams.set("after", options.afterCursor);
}
if (options.maxPages) {
  url.searchParams.set("maxPages", String(options.maxPages));
}

const response = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${options.adminApiKey}`,
  },
});

const body = await response.text();
if (!response.ok) {
  throw new Error(`Backfill request failed with ${response.status}: ${body}`);
}

const parsed = JSON.parse(body) as unknown;
console.log(JSON.stringify(parsed, null, 2));
