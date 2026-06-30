import { requireAdminApiKey } from "./cli";

const commentId = readArg("--comment");
if (!commentId) {
  throw new Error("Usage: bun run scripts/send-comment-reply.ts --comment <commentId> [--url <baseUrl>]");
}

const baseUrl = (readArg("--url") ?? process.env.ADMIN_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const adminApiKey = process.env.ADMIN_API_KEY ?? "";
requireAdminApiKey(adminApiKey);

const response = await fetch(new URL(`/admin/reply/comment/${encodeURIComponent(commentId)}`, baseUrl), {
  method: "POST",
  headers: {
    Authorization: `Bearer ${adminApiKey}`,
  },
});

const body = await response.text();
if (!response.ok) {
  throw new Error(`Reply request failed with ${response.status}: ${body}`);
}

console.log(JSON.stringify(JSON.parse(body), null, 2));

function readArg(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}
