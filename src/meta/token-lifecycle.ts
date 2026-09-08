import type { AppConfig } from "../env";
import { TokenRepository, type TokenState } from "../db/token-repository";
import { MetaApiError, MetaGraphClient, type FetchLike } from "./client";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (time: number) => new Date(time).toISOString();

async function sourceHash(config: AppConfig): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(config.instagramAccessToken));
  return encode(new Uint8Array(hash));
}

function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function decode(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }

async function tokenKey(config: AppConfig): Promise<CryptoKey> {
  if (!config.instagramTokenEncryptionKey) throw new Error("Instagram token encryption key is missing");
  return crypto.subtle.importKey("raw", decode(config.instagramTokenEncryptionKey), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function additionalData(config: AppConfig, hash: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`instagram-token:v1:${config.instagramAccountId}:${hash}`);
}

async function encrypt(config: AppConfig, token: string, hash: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData(config, hash) },
    await tokenKey(config), new TextEncoder().encode(token));
  return `${encode(iv)}.${encode(new Uint8Array(bytes))}`;
}

async function decrypt(config: AppConfig, state: TokenState): Promise<string> {
  try {
    const [iv, ciphertext] = state.encryptedToken.split(".");
    if (!iv || !ciphertext) throw new Error();
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv), additionalData: additionalData(config, state.sourceHash) },
      await tokenKey(config), decode(ciphertext));
    return new TextDecoder().decode(bytes);
  } catch { throw new Error("Cannot decrypt Instagram token; check INSTAGRAM_TOKEN_ENCRYPTION_KEY"); }
}

export async function resolveTokenConfig(config: AppConfig, repo: TokenRepository): Promise<AppConfig> {
  if (!config.instagramTokenEncryptionKey) return config;
  const state = await repo.read(config.instagramAccountId);
  if (!state || !isKnownSource(state, await sourceHash(config))) return config;
  return { ...config, instagramAccessToken: await decrypt(config, state), instagramAccessTokenExpiresAt: state.expiresAt };
}

function isKnownSource(state: TokenState, hash: string): boolean {
  return state.sourceHash === hash || Boolean(state.retiredSourceHashes?.includes(hash));
}

export async function tokenStatus(config: AppConfig, repo: TokenRepository, now = new Date()) {
  const state = config.instagramTokenEncryptionKey ? await repo.read(config.instagramAccountId) : null;
  const current = state && isKnownSource(state, await sourceHash(config)) ? state : null;
  return {
    enabled: config.instagramTokenAutoRefreshEnabled,
    notificationsConfigured: Boolean(config.telegramBotToken && config.telegramChatId),
    initializedAt: current?.initializedAt, refreshedAt: current?.refreshedAt,
    expiresAt: current ? current.expiresAt : config.instagramAccessTokenExpiresAt,
    nextRefreshAt: current?.nextRefreshAt, failures: current?.failures ?? 0,
    requiresReauth: current?.requiresReauth ?? false,
    needsAttention: current ? needsAttention(current, now) : false,
    lastError: current?.lastError, lastAttemptAt: current?.lastAttemptAt,
    notificationError: current?.notificationError,
  };
}

export async function maintainToken(config: AppConfig, repo: TokenRepository, now = new Date(),
  fetchFn: FetchLike = (input, init) => fetch(input, init)): Promise<void> {
  if (!config.instagramTokenAutoRefreshEnabled) return;
  await refreshTokenIfDue(config, repo, now, fetchFn);
  await notifyTokenProblem(config, repo, now, fetchFn);
}

async function refreshTokenIfDue(config: AppConfig, repo: TokenRepository, now: Date, fetchFn: FetchLike): Promise<void> {
  let state = await repo.read(config.instagramAccountId);
  const hash = await sourceHash(config);
  if (!state || state.sourceHash !== hash) {
    if (state?.retiredSourceHashes?.includes(hash)) return;
    const sourceExpiresAt = config.instagramAccessTokenExpiresAt
      ? iso(Date.parse(config.instagramAccessTokenExpiresAt)) : null;
    // Unchanged metadata still belongs to the old bootstrap. Legacy state has no
    // source expiry marker, so its configured expiry cannot be attributed safely.
    const expiresAt = !state || (state.sourceExpiresAt !== undefined && state.sourceExpiresAt !== sourceExpiresAt)
      ? sourceExpiresAt ?? undefined : undefined;
    const initial: TokenState = {
      version: 1, sourceHash: hash,
      sourceExpiresAt,
      retiredSourceHashes: state ? [...(state.retiredSourceHashes ?? []), state.sourceHash] : [],
      encryptedToken: await encrypt(config, config.instagramAccessToken, hash),
      initializedAt: now.toISOString(), expiresAt,
      nextRefreshAt: iso(now.getTime() + 25 * HOUR), failures: 0, requiresReauth: false,
    };
    if (!await repo.save(config.instagramAccountId, state, initial, now.toISOString())) return;
    state = initial;
  }
  if (state.lease && state.lease.until > now.toISOString()) return;
  if (state.requiresReauth) return;
  if (state.expiresAt && Date.parse(state.expiresAt) <= now.getTime()) {
    await repo.save(config.instagramAccountId, state, {
      ...state, requiresReauth: true, nextRefreshAt: undefined, lease: undefined,
      lastError: "Instagram token expired; reconnect the account", notifyAfter: undefined,
    }, now.toISOString());
    return;
  }
  if (!state.nextRefreshAt || state.nextRefreshAt > now.toISOString()) return;
  const effectiveConfig = { ...config, instagramAccessToken: await decrypt(config, state) };
  const claimed: TokenState = {
    ...state, lease: { id: crypto.randomUUID(), until: iso(now.getTime() + 5 * 60_000) },
    lastAttemptAt: now.toISOString(),
  };
  if (!await repo.save(config.instagramAccountId, state, claimed, now.toISOString())) return;
  let result: { accessToken: string; expiresIn: number };
  try {
    result = await new MetaGraphClient(effectiveConfig, fetchFn).refreshAccessToken();
  } catch (error) {
    const requiresReauth = error instanceof MetaApiError
      && (error.metaCode === 190 || error.httpStatus === 401 || error.httpStatus === 403);
    const failures = claimed.failures + 1;
    const lastError = error instanceof MetaApiError
      ? `Token refresh failed: HTTP ${error.httpStatus}, Meta ${error.metaCode ?? "unknown"}`
      : "Token refresh network or response error";
    const delay = Math.min(6 * HOUR, 5 * 60_000 * 2 ** Math.min(failures - 1, 7));
    await repo.save(config.instagramAccountId, claimed, {
      ...claimed, lease: undefined, failures, requiresReauth, lastError,
      nextRefreshAt: requiresReauth ? undefined : iso(now.getTime() + delay),
    }, now.toISOString());
    return;
  }
  const lifetime = result.expiresIn * 1000;
  await repo.save(config.instagramAccountId, claimed, {
    ...claimed, encryptedToken: await encrypt(config, result.accessToken, hash),
    refreshedAt: now.toISOString(), expiresAt: iso(now.getTime() + lifetime),
    nextRefreshAt: iso(now.getTime() + Math.min(30 * DAY, Math.max(25 * HOUR, lifetime - 7 * DAY))),
    lease: undefined, failures: 0, requiresReauth: false, lastError: undefined,
    notifyAfter: undefined, notificationError: undefined,
  }, now.toISOString());
}

export async function reportTokenInvalid(config: AppConfig, repo: TokenRepository, failedToken: string,
  now = new Date(), fetchFn: FetchLike = (input, init) => fetch(input, init)): Promise<void> {
  if (!config.instagramTokenAutoRefreshEnabled) return;
  const state = await repo.read(config.instagramAccountId);
  if (!state || state.sourceHash !== await sourceHash(config) || state.requiresReauth
    || (state.lease && state.lease.until > now.toISOString()) || await decrypt(config, state) !== failedToken) return;
  await repo.save(config.instagramAccountId, state, {
    ...state, requiresReauth: true, nextRefreshAt: undefined,
    lastError: "Instagram rejected the token; reconnect the account", notifyAfter: undefined,
  }, now.toISOString());
  await notifyTokenProblem(config, repo, now, fetchFn);
}

function needsAttention(state: TokenState, now: Date): boolean {
  return state.requiresReauth || state.failures >= 3
    || Boolean(state.expiresAt && Date.parse(state.expiresAt) <= now.getTime() + 7 * DAY);
}

async function notifyTokenProblem(config: AppConfig, repo: TokenRepository, now: Date, fetchFn: FetchLike): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  const state = await repo.read(config.instagramAccountId);
  if (!state || state.sourceHash !== await sourceHash(config) || !needsAttention(state, now)
    || (state.lease && state.lease.until > now.toISOString())
    || (state.notifyAfter && state.notifyAfter > now.toISOString())) return;
  const claimed = { ...state, notifyAfter: iso(now.getTime() + HOUR) };
  if (!await repo.save(config.instagramAccountId, state, claimed, now.toISOString())) return;
  let delivered = false;
  try {
    const text = [
      `Instagram-бот ${config.instagramUsername ?? config.instagramAccountId}: требуется внимание.`,
      state.requiresReauth ? "Токен недействителен: нужен повторный вход и замена INSTAGRAM_ACCESS_TOKEN."
        : "Не удалось продлить токен или до истечения осталось меньше 7 дней. Автоматические попытки продолжатся.",
      state.expiresAt ? `Срок действия: ${state.expiresAt}` : "Точный срок действия пока неизвестен.",
      state.lastError,
    ].filter(Boolean).join("\n");
    const response = await fetchFn(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: config.telegramChatId, text }), signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json() as { ok?: boolean };
    delivered = response.ok && body?.ok === true;
  } catch { /* Telegram errors can contain the bot credential in the URL. */ }
  await repo.save(config.instagramAccountId, claimed, {
    ...claimed, notifyAfter: iso(now.getTime() + (delivered ? DAY : HOUR)),
    notificationError: delivered ? undefined : "Telegram notification failed",
  }, now.toISOString());
}
