import { and, eq, isNull } from "drizzle-orm";
import { createDb } from "./client";
import { instagramAccounts } from "./schema";

export interface TokenState {
  version: 1;
  sourceHash: string;
  sourceExpiresAt?: string | null;
  retiredSourceHashes?: string[];
  encryptedToken: string;
  initializedAt: string;
  refreshedAt?: string;
  expiresAt?: string;
  nextRefreshAt?: string;
  lease?: { id: string; until: string };
  failures: number;
  requiresReauth: boolean;
  lastError?: string;
  lastAttemptAt?: string;
  notifyAfter?: string;
  notificationError?: string;
}

export class TokenRepository {
  private readonly db;

  constructor(db: D1Database) { this.db = createDb(db); }

  async read(accountId: string): Promise<TokenState | null> {
    const [row] = await this.db.select({ state: instagramAccounts.tokenState })
      .from(instagramAccounts).where(eq(instagramAccounts.id, accountId));
    if (!row?.state) return null;
    const state = JSON.parse(row.state) as TokenState;
    if (state.version !== 1) throw new Error("Unsupported Instagram token state version");
    return state;
  }

  // Compare the complete snapshot, including lease ID, to reject stale Cron writes.
  async save(accountId: string, previous: TokenState | null, next: TokenState, now: string): Promise<boolean> {
    const values = { tokenState: JSON.stringify(next), tokenExpiresAt: next.expiresAt ?? null, updatedAt: now };
    const rows = previous
      ? await this.db.update(instagramAccounts).set(values).where(and(
        eq(instagramAccounts.id, accountId), eq(instagramAccounts.tokenState, JSON.stringify(previous)),
      )).returning({ id: instagramAccounts.id })
      : await this.db.insert(instagramAccounts).values({ id: accountId, ...values })
        .onConflictDoUpdate({ target: instagramAccounts.id, set: values, setWhere: isNull(instagramAccounts.tokenState) })
        .returning({ id: instagramAccounts.id });
    return rows.length === 1;
  }
}
