import { describe, expect, test } from "bun:test";
import { TokenRepository } from "../src/db/token-repository";
import { getConfig, getPublicConfig } from "../src/env";
import { maintainToken, reportTokenInvalid, resolveTokenConfig, tokenStatus } from "../src/meta/token-lifecycle";
import { defaultWorkerEnv } from "./helpers/config";
import { migratedD1 } from "./helpers/sqlite-d1";

const start = new Date("2026-09-08T19:00:00.000Z");
const key = btoa("0123456789abcdef0123456789abcdef");
const due = new Date("2026-09-09T20:00:00.000Z");
function config(token = "bootstrap-secret") {
  return getConfig(defaultWorkerEnv({
    INSTAGRAM_ACCESS_TOKEN: token,
    INSTAGRAM_TOKEN_ENCRYPTION_KEY: key,
    INSTAGRAM_TOKEN_AUTO_REFRESH_ENABLED: "true",
  }));
}

describe("Instagram token lifecycle", () => {
  test("requires a 32-byte encryption key before enabling refresh", () => {
    expect(() => getConfig(defaultWorkerEnv({ INSTAGRAM_TOKEN_AUTO_REFRESH_ENABLED: "true" }))).toThrow();
    expect(() => getConfig(defaultWorkerEnv({ INSTAGRAM_TOKEN_ENCRYPTION_KEY: "bad" }))).toThrow();
  });

  test("bootstraps encrypted storage and waits at least 24 hours before first refresh", async () => {
    const repo = new TokenRepository(await migratedD1());
    await maintainToken(config(), repo, start, async () => { throw new Error("must not fetch yet"); });
    const state = await repo.read("ig_account");
    expect(state?.initializedAt).toBe(start.toISOString());
    expect(state?.nextRefreshAt).toBe("2026-09-09T20:00:00.000Z");
    expect(state?.expiresAt).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("bootstrap-secret");
    expect((await resolveTokenConfig(config(), repo)).instagramAccessToken).toBe("bootstrap-secret");
    expect(JSON.stringify(await tokenStatus(config(), repo))).not.toContain(state!.encryptedToken);
    expect(JSON.stringify(getPublicConfig(config()))).not.toContain(key);
  });

  test("honors manual secret replacement and fails closed on the wrong encryption key", async () => {
    const repo = new TokenRepository(await migratedD1());
    await maintainToken(config(), repo, start);
    await expect(resolveTokenConfig({ ...config(), instagramTokenEncryptionKey: btoa("x".repeat(32)) }, repo))
      .rejects.toThrow("Cannot decrypt Instagram token");
    expect((await resolveTokenConfig(config("manual-token"), repo)).instagramAccessToken).toBe("manual-token");
    await maintainToken(config("manual-token"), repo, new Date(start.getTime() + 60_000));
    expect((await repo.read("ig_account"))?.initializedAt).toBe("2026-09-08T19:01:00.000Z");
    expect((await resolveTokenConfig(config("manual-token"), repo)).instagramAccessToken).toBe("manual-token");
  });

  test("does not attach the previous bootstrap expiry to a manually replaced token", async () => {
    const repo = new TokenRepository(await migratedD1());
    const original = { ...config(), instagramAccessTokenExpiresAt: "2026-11-07T19:00:00.000Z" };
    await maintainToken(original, repo, start);
    await maintainToken(original, repo, due, async () => Response.json({ access_token: "rotated", expires_in: 5184000 }));

    const replacementTime = new Date("2026-11-07T20:00:00.000Z");
    const replacement = { ...original, instagramAccessToken: "manual-token" };
    await maintainToken(replacement, repo, replacementTime);
    const state = (await repo.read("ig_account"))!;
    expect(state.requiresReauth).toBe(false);
    expect(state.expiresAt).toBeUndefined();
    expect(state.nextRefreshAt).toBe("2026-11-08T21:00:00.000Z");
    expect((await tokenStatus(replacement, repo, replacementTime)).expiresAt).toBeUndefined();

    const withNewExpiry = {
      ...replacement, instagramAccessToken: "another-manual-token",
      instagramAccessTokenExpiresAt: "2027-01-06T20:00:00.000Z",
    };
    await maintainToken(withNewExpiry, repo, replacementTime);
    expect((await repo.read("ig_account"))?.expiresAt).toBe(withNewExpiry.instagramAccessTokenExpiresAt);
  });

  test("old Cron configurations cannot restore retired bootstrap tokens", async () => {
    const repo = new TokenRepository(await migratedD1());
    await maintainToken(config(), repo, start);
    const replacementTime = new Date(start.getTime() + 60_000);
    await maintainToken(config("manual-token"), repo, replacementTime);
    const replaced = await repo.read("ig_account");

    for (const oldCronTime of [start, new Date(replacementTime.getTime() + 60_000)]) {
      await maintainToken(config(), repo, oldCronTime);
      expect(await repo.read("ig_account")).toEqual(replaced);
      expect((await resolveTokenConfig(config(), repo)).instagramAccessToken).toBe("manual-token");
    }

    await maintainToken(config("third-token"), repo, new Date(replacementTime.getTime() + 120_000));
    const latest = await repo.read("ig_account");
    await maintainToken(config(), repo, new Date(replacementTime.getTime() + 180_000));
    await maintainToken(config("manual-token"), repo, new Date(replacementTime.getTime() + 180_000));
    expect(await repo.read("ig_account")).toEqual(latest);
    expect((await resolveTokenConfig(config(), repo)).instagramAccessToken).toBe("third-token");
  });

  test("replaces persisted legacy state without inheriting unassociated expiry metadata", async () => {
    const repo = new TokenRepository(await migratedD1());
    await maintainToken(config(), repo, start);
    const state = (await repo.read("ig_account"))!;
    const legacy = { ...state };
    delete legacy.sourceExpiresAt;
    delete legacy.retiredSourceHashes;
    expect(await repo.save("ig_account", state, legacy, start.toISOString())).toBe(true);
    const replacement = { ...config("new-token"), instagramAccessTokenExpiresAt: start.toISOString() };
    await maintainToken(replacement, repo, due);
    const updated = (await repo.read("ig_account"))!;
    expect(updated.requiresReauth).toBe(false);
    expect(updated.expiresAt).toBeUndefined();
    expect(updated.nextRefreshAt).toBe("2026-09-10T21:00:00.000Z");
    expect((await resolveTokenConfig(config(), repo)).instagramAccessToken).toBe("new-token");
  });

  test("renews once across concurrent Crons and sends subsequent API calls with the stored token", async () => {
    const repo = new TokenRepository(await migratedD1());
    await maintainToken(config(), repo, start);
    const fetched = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const refresh = async () => {
      calls++;
      fetched.resolve();
      await release.promise;
      return Response.json({ access_token: "rotated-secret", expires_in: 5184000 });
    };
    const first = maintainToken(config(), repo, due, refresh);
    // A missing refresh must fail quickly, rather than hang the test waiting for fetch.
    await Promise.race([fetched.promise, first]);
    expect(calls).toBe(1);
    await maintainToken(config(), repo, due, refresh);
    expect(calls).toBe(1);
    expect((await resolveTokenConfig(config(), repo)).instagramAccessToken).toBe("bootstrap-secret");
    release.resolve();
    await first;
    const state = (await repo.read("ig_account"))!;
    expect(state.refreshedAt).toBe(due.toISOString());
    expect(state.expiresAt).toBe("2026-11-08T20:00:00.000Z");
    expect(state.nextRefreshAt).toBe("2026-10-09T20:00:00.000Z");
    expect(JSON.stringify(state)).not.toContain("rotated-secret");
    expect((await resolveTokenConfig({ ...config(), instagramTokenAutoRefreshEnabled: false }, repo)).instagramAccessToken).toBe("rotated-secret");
  });

  test("retains the working token on transient failure and backs off before retry", async () => {
    const repo = new TokenRepository(await migratedD1());
    await maintainToken(config(), repo, start);
    let calls = 0;
    const fail = async () => { calls++; throw new Error("access_token=do-not-store"); };
    await maintainToken(config(), repo, due, fail);
    const state = (await repo.read("ig_account"))!;
    expect(state.failures).toBe(1);
    expect(state.nextRefreshAt).toBe("2026-09-09T20:05:00.000Z");
    expect(JSON.stringify(state)).not.toContain("do-not-store");
    expect((await resolveTokenConfig(config(), repo)).instagramAccessToken).toBe("bootstrap-secret");
    await maintainToken(config(), repo, new Date(due.getTime() + 60_000), fail);
    expect(calls).toBe(1);
    await maintainToken(config(), repo, new Date(due.getTime() + 5 * 60_000), async () =>
      Response.json({ access_token: "recovered", expires_in: 5184000 }));
    expect((await repo.read("ig_account"))?.failures).toBe(0);
    expect((await resolveTokenConfig(config(), repo)).instagramAccessToken).toBe("recovered");
  });

  test("stops refreshing invalid or expired tokens until manually replaced", async () => {
    const repo = new TokenRepository(await migratedD1());
    await maintainToken(config(), repo, start);
    let calls = 0;
    const invalid = async () => {
      calls++;
      return Response.json({ error: { code: 190, message: "secret" } }, { status: 400 });
    };
    await maintainToken(config(), repo, due, invalid);
    expect((await repo.read("ig_account"))?.requiresReauth).toBe(true);
    expect((await repo.read("ig_account"))?.nextRefreshAt).toBeUndefined();
    await maintainToken(config(), repo, new Date(due.getTime() + 24 * 3600_000), invalid);
    expect(calls).toBe(1);
    const expired = { ...config("expired"), instagramAccessTokenExpiresAt: start.toISOString() };
    await maintainToken(expired, repo, due, invalid);
    expect(calls).toBe(1);
    expect((await repo.read("ig_account"))?.requiresReauth).toBe(true);
    await maintainToken(config("new-secret"), repo, due, invalid);
    expect((await repo.read("ig_account"))?.requiresReauth).toBe(false);
  });

  test("rejects a stale refresh result after manual replacement", async () => {
    const repo = new TokenRepository(await migratedD1());
    await maintainToken(config(), repo, start);
    let calls = 0;
    await maintainToken(config(), repo, due, async () => {
      calls++;
      await maintainToken(config("manually-replaced"), repo, due);
      return Response.json({ access_token: "stale-result", expires_in: 5184000 });
    });
    expect(calls).toBe(1);
    expect((await resolveTokenConfig(config("manually-replaced"), repo)).instagramAccessToken).toBe("manually-replaced");
  });

  test("recovers an abandoned refresh lease, but rejects the old owner's writes", async () => {
    const repo = new TokenRepository(await migratedD1());
    await maintainToken(config(), repo, start);
    const initial = (await repo.read("ig_account"))!;
    const abandoned = { ...initial, lease: { id: "dead-worker", until: due.toISOString() } };
    expect(await repo.save("ig_account", initial, abandoned, due.toISOString())).toBe(true);
    await maintainToken(config(), repo, due, async () => Response.json({ access_token: "recovered", expires_in: 5184000 }));
    expect((await resolveTokenConfig(config(), repo)).instagramAccessToken).toBe("recovered");
    expect(await repo.save("ig_account", abandoned, initial, due.toISOString())).toBe(false);
  });

  test("alerts only when Telegram is configured and deduplicates concurrent alerts", async () => {
    const repo = new TokenRepository(await migratedD1());
    await maintainToken(config(), repo, start);
    let messages = 0;
    const telegram = async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.telegram.org/bottelegram-secret/sendMessage");
      const body = JSON.parse(String(init?.body));
      expect(body.chat_id).toBe("123");
      expect(body.text).toContain("повторный вход");
      expect(body.text).not.toContain("bootstrap-secret");
      messages++;
      return Response.json({ ok: true });
    };
    await reportTokenInvalid(config(), repo, "bootstrap-secret", due, telegram);
    expect(messages).toBe(0);
    expect((await tokenStatus(config(), repo, due)).needsAttention).toBe(true);
    const enabled = { ...config(), telegramBotToken: "telegram-secret", telegramChatId: "123" };
    await Promise.all([maintainToken(enabled, repo, due, telegram), maintainToken(enabled, repo, due, telegram)]);
    expect(messages).toBe(1);
    await maintainToken(enabled, repo, new Date(due.getTime() + 60_000), telegram);
    expect(messages).toBe(1);
  });

  test("failed Telegram delivery retries later and cannot break token maintenance", async () => {
    const repo = new TokenRepository(await migratedD1());
    await maintainToken(config(), repo, start);
    await reportTokenInvalid(config(), repo, "bootstrap-secret", due);
    const enabled = { ...config(), telegramBotToken: "telegram-secret", telegramChatId: "123" };
    let calls = 0;
    const fail = async () => { calls++; throw new Error("telegram-secret"); };
    await maintainToken(enabled, repo, due, fail);
    expect(calls).toBe(1);
    expect((await repo.read("ig_account"))?.notificationError).toBe("Telegram notification failed");
    await maintainToken(enabled, repo, new Date(due.getTime() + 60_000), fail);
    expect(calls).toBe(1);
    await maintainToken(enabled, repo, new Date(due.getTime() + 3600_000), fail);
    expect(calls).toBe(2);
  });

  test("a health error from a replaced token cannot invalidate the latest token", async () => {
    const repo = new TokenRepository(await migratedD1());
    await maintainToken(config(), repo, start);
    await maintainToken(config(), repo, due, async () => Response.json({ access_token: "rotated", expires_in: 5184000 }));
    await reportTokenInvalid(config(), repo, "bootstrap-secret", due);
    expect((await repo.read("ig_account"))?.requiresReauth).toBe(false);
    await reportTokenInvalid(config(), repo, "rotated", due);
    expect((await repo.read("ig_account"))?.requiresReauth).toBe(true);
  });
});
