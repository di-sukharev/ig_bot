import { requireAdminApiKey } from "./cli";

const selector = readSelector();
if (!selector) {
  throw new Error(
    "Usage: bun run data:redact -- (--comment <commentId> | --direct-message <messageId> | --commenter-id <id> | --username <username>) [--apply] [--url <baseUrl>]",
  );
}

const apply = Bun.argv.includes("--apply");
const baseUrl = (readArg("--url") ?? process.env.ADMIN_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const adminApiKey = process.env.ADMIN_API_KEY ?? "";
requireAdminApiKey(adminApiKey);

const path = apply ? "/admin/data-subject/redact" : "/admin/data-subject";
const url = new URL(path, baseUrl);
for (const [key, value] of Object.entries(selector)) {
  if (value) {
    url.searchParams.set(key, value);
  }
}

const response = await fetch(url, {
  method: apply ? "POST" : "GET",
  headers: {
    Authorization: `Bearer ${adminApiKey}`,
  },
});

const body = await response.text();
if (!response.ok) {
  throw new Error(`Data redaction request failed with ${response.status}: ${body}`);
}

console.log(JSON.stringify(JSON.parse(body), null, 2));

function readSelector():
  | { commentId?: string; directMessageId?: string; commenterId?: string; username?: string }
  | undefined {
  const selector = {
    commentId: readArg("--comment"),
    directMessageId: readArg("--direct-message"),
    commenterId: readArg("--commenter-id"),
    username: readArg("--username"),
  };

  return selector.commentId || selector.directMessageId || selector.commenterId || selector.username
    ? selector
    : undefined;
}

function readArg(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}
