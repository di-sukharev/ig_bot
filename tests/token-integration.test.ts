import { expect, test } from "bun:test";
import { createApp } from "../src/app";
import { DrizzleRepository } from "../src/db/repository";
import { TokenRepository } from "../src/db/token-repository";
import { getConfig } from "../src/env";
import { maintainToken } from "../src/meta/token-lifecycle";
import { processWebhookQueueMessage, runScheduledMaintenance } from "../src/worker";
import { defaultWorkerEnv } from "./helpers/config";
import { migratedD1 } from "./helpers/sqlite-d1";

async function setup() {
  const env = defaultWorkerEnv({
    DB: await migratedD1(), INSTAGRAM_ACCESS_TOKEN: "bootstrap-secret",
    INSTAGRAM_TOKEN_ENCRYPTION_KEY: btoa("0123456789abcdef0123456789abcdef"),
    INSTAGRAM_TOKEN_AUTO_REFRESH_ENABLED: "true", RECONCILER_ENABLED: "false",
    BOT_ENABLED: "true", COMMENT_PRIVATE_REPLY_ENABLED: "true",
  });
  const due = new Date();
  due.setUTCMinutes(0, 0, 0);
  const repo = new TokenRepository(env.DB);
  await maintainToken(getConfig(env), repo, new Date(due.getTime() - 25 * 3600_000));
  return { env, due, repo };
}

test("Cron renews before health checks and admin status exposes lifetime without secrets", async () => {
  const { env, due } = await setup();
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url, init) => {
    requests.push(String(url));
    if (String(url).includes("refresh_access_token")) {
      return Response.json({ access_token: "rotated-secret", expires_in: 5184000 });
    }
    expect(new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).get("Authorization")).toBe("Bearer rotated-secret");
    return Response.json({ id: "ig_account" });
  }) as typeof fetch;
  try {
    await runScheduledMaintenance(env, due);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("refresh_access_token");
    const response = await createApp().fetch(new Request("https://worker.test/admin/status", {
      headers: { Authorization: "Bearer admin" },
    }), env);
    expect(response.status).toBe(200);
    const status = await response.json() as any;
    expect(status.tokenLifecycle.refreshedAt).toBe(due.toISOString());
    expect(status.tokenLifecycle.requiresReauth).toBe(false);
    expect(status.accountStatus).toBe("active");
    expect(JSON.stringify(status)).not.toMatch(/bootstrap-secret|rotated-secret|encryptedToken|sourceHash/);
  } finally { globalThis.fetch = original; }
});

test("HTTP 400 / Meta 190 during health check records that reauthentication is required", async () => {
  const { env, due, repo } = await setup();
  await maintainToken(getConfig(env), repo, due, async () => Response.json({ access_token: "rotated", expires_in: 5184000 }));
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ error: { code: 190, message: "Invalid token" } }, { status: 400 })) as unknown as typeof fetch;
  try {
    await runScheduledMaintenance(env, due);
    expect((await repo.read("ig_account"))?.requiresReauth).toBe(true);
    expect(await new DrizzleRepository(env.DB).getAccountStatus("ig_account")).toBe("token_invalid");
  } finally { globalThis.fetch = original; }
});

test("admin media listing uses the stored token, preserves cursors and omits Meta URLs", async () => {
  const { env, due, repo } = await setup();
  await maintainToken(getConfig(env), repo, due, async () => Response.json({ access_token: "rotated", expires_in: 5184000 }));
  const original = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    expect(new URL(String(url)).searchParams.get("after")).toBe("cursor");
    expect(new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).get("Authorization")).toBe("Bearer rotated");
    return Response.json({ data: [{ id: "media" }], paging: { cursors: { after: "next" }, next: "https://meta.test/?access_token=rotated" } });
  }) as typeof fetch;
  try {
    const app = createApp();
    expect((await app.fetch(new Request("https://worker.test/admin/media"), env)).status).toBe(401);
    const response = await app.fetch(new Request("https://worker.test/admin/media?after=cursor", {
      headers: { Authorization: "Bearer admin" },
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ id: "media" }], paging: { cursors: { after: "next" } } });
  } finally { globalThis.fetch = original; }
});

test("queue, manual replies and backfill use the renewed token", async () => {
  const { env, due, repo } = await setup();
  await maintainToken(getConfig(env), repo, due, async () => Response.json({ access_token: "rotated", expires_in: 5184000 }));
  const botRepo = new DrizzleRepository(env.DB);
  await botRepo.insertWebhookEvent({
    id: "event", eventKey: "event", source: "instagram", receivedAt: due.toISOString(), headersJson: "{}",
    rawPayload: JSON.stringify({ object: "instagram", entry: [{ id: "ig_account", changes: [{ field: "comments", value: {
      id: "comment", text: "demo", from: { id: "user" }, media: { id: "media" }, timestamp: due.toISOString(),
    } }] }] }),
  });
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url, init) => {
    requests.push(String(url));
    expect(new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).get("Authorization")).toBe("Bearer rotated");
    if (String(url).endsWith("/messages")) return Response.json({ message_id: "message" });
    return Response.json({ data: [] });
  }) as typeof fetch;
  try {
    await processWebhookQueueMessage(env, { type: "webhook_event", webhookEventId: "event" }, due);
    expect(requests.some(url => url.includes("/conversations"))).toBe(true);
    const app = createApp();
    const reply = await app.fetch(new Request("https://worker.test/admin/reply/comment/comment", {
      method: "POST", headers: { Authorization: "Bearer admin" },
    }), env);
    expect(reply.status).toBe(200);
    expect(requests.some(url => url.endsWith("/messages"))).toBe(true);
    const backfill = await app.fetch(new Request("https://worker.test/admin/backfill/media/media", {
      method: "POST", headers: { Authorization: "Bearer admin" },
    }), env);
    expect(backfill.status).toBe(200);
    expect(requests.some(url => url.includes("/media/comments"))).toBe(true);
  } finally { globalThis.fetch = original; }
});
