import { describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createApp } from "../src/app";
import { hmacSha256Hex } from "../src/webhook/signature";
import type { WebhookQueueMessage, WorkerEnv } from "../src/types";
import { defaultWorkerEnv } from "./helpers/config";

describe("public policy routes", () => {
  test("serves privacy policy and data deletion instructions", async () => {
    const app = createApp();
    const db = new FakeD1Database();

    const privacy = await app.fetch(new Request("http://worker.test/privacy"), env(db));
    const deletion = await app.fetch(new Request("http://worker.test/data-deletion"), env(db));

    expect(privacy.status).toBe(200);
    expect(privacy.headers.get("content-type")).toContain("text/html");
    expect(await privacy.text()).toContain("Privacy Policy");
    expect(deletion.status).toBe(200);
    expect(await deletion.text()).toContain("Data Deletion");
  });
});

describe("webhook route", () => {
  test("stores signed webhook payload and enqueues processing", async () => {
    const app = createApp();
    const db = new FakeD1Database();
    const queue = new FakeQueue();
    const body = JSON.stringify(commentWebhookPayload());

    const response = await app.fetch(
      new Request("http://worker.test/webhooks/instagram", {
        method: "POST",
        headers: {
          "X-Hub-Signature-256": `sha256=${await hmacSha256Hex(body, "secret")}`,
        },
        body,
      }),
      env(db, queue),
    );

    expect(response.status).toBe(200);
    expect(db.events).toHaveLength(1);
    const eventId = db.events[0]?.id;
    expect(eventId).toBeDefined();
    expect(queue.messages).toEqual([
      {
        type: "webhook_event",
        webhookEventId: eventId!,
      },
    ]);
  });

  test("fails loudly when Queue binding is missing", async () => {
    const app = createApp();
    const db = new FakeD1Database();
    const body = JSON.stringify(commentWebhookPayload());

    const response = await app.fetch(
      new Request("http://worker.test/webhooks/instagram", {
        method: "POST",
        headers: {
          "X-Hub-Signature-256": `sha256=${await hmacSha256Hex(body, "secret")}`,
        },
        body,
      }),
      env(db),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "webhook_queue_missing",
    });
    expect(db.events).toHaveLength(0);
  });

  test("re-enqueues existing event after a previous enqueue failure", async () => {
    const app = createApp();
    const db = new FakeD1Database();
    const failingQueue = new FakeQueue({ failOnce: true });
    const body = JSON.stringify(commentWebhookPayload());
    const signature = `sha256=${await hmacSha256Hex(body, "secret")}`;
    const originalConsoleError = console.error;
    console.error = () => {};

    let first: Response;
    try {
      first = await app.fetch(
        new Request("http://worker.test/webhooks/instagram", {
          method: "POST",
          headers: { "X-Hub-Signature-256": signature },
          body,
        }),
        env(db, failingQueue),
      );
    } finally {
      console.error = originalConsoleError;
    }
    expect(first.status).toBe(500);
    expect(db.events).toHaveLength(1);

    const retryQueue = new FakeQueue();
    const second = await app.fetch(
      new Request("http://worker.test/webhooks/instagram", {
        method: "POST",
        headers: { "X-Hub-Signature-256": signature },
        body,
      }),
      env(db, retryQueue),
    );

    expect(second.status).toBe(200);
    expect(db.events).toHaveLength(1);
    const eventId = db.events[0]?.id;
    expect(eventId).toBeDefined();
    expect(retryQueue.messages).toEqual([
      {
        type: "webhook_event",
        webhookEventId: eventId!,
      },
    ]);
  });
});

describe("admin authorization", () => {
  test("rejects admin routes without auth", async () => {
    const app = createApp();
    const db = new FakeD1Database();
    const requests = [
      new Request("http://worker.test/admin/status"),
      new Request("http://worker.test/admin/data-subject?username=user"),
      new Request("http://worker.test/admin/data-subject/redact?commenterId=user_1", {
        method: "POST",
      }),
      new Request("http://worker.test/admin/backfill/media/media_1", {
        method: "POST",
      }),
      new Request("http://worker.test/admin/reply/comment/comment_1", {
        method: "POST",
      }),
    ];

    for (const request of requests) {
      const response = await app.fetch(request, env(db));

      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Unauthorized");
    }
  });
});

describe("admin status", () => {
  test("returns reply job backlog counts and oldest due age", async () => {
    const app = createApp();
    const db = new FakeD1Database();
    db.replyJobs = [
      {
        status: "pending",
        createdAt: new Date(Date.now() - 120_000).toISOString(),
      },
      {
        status: "retryable",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        status: "sent",
        createdAt: new Date(Date.now() - 30_000).toISOString(),
      },
    ];

    const response = await app.fetch(
      new Request("http://worker.test/admin/status", {
        headers: { Authorization: "Bearer admin" },
      }),
      env(db),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      replyJobs: {
        oldestDueCreatedAt?: string;
        oldestDueAgeSeconds?: number;
      };
    };
    expect(body).toMatchObject({
      ok: true,
      accountStatus: "active",
      replyJobs: {
        counts: {
          pending: 1,
          retryable: 1,
          sending: 0,
          sent: 1,
          failed: 0,
          blocked: 0,
        },
        due: 1,
      },
    });
    expect(body.replyJobs.oldestDueCreatedAt).toBe(db.replyJobs[0]?.createdAt);
    expect(body.replyJobs.oldestDueAgeSeconds).toBeGreaterThan(0);
  });
});

describe("admin manual replies", () => {
  test("rejects manual replies that do not pass keyword gates", async () => {
    const app = createApp();
    const db = await createSqliteD1();
    insertComment(db, { id: "comment_no_keyword", text: "hello" });

    const response = await app.fetch(
      new Request("http://worker.test/admin/reply/comment/comment_no_keyword", {
        method: "POST",
        headers: { Authorization: "Bearer admin" },
      }),
      env(db),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "reply_not_allowed",
      skippedReason: "no_keyword",
    });
    expect(db.first<{ count: number }>("SELECT COUNT(*) as count FROM reply_jobs")).toEqual({
      count: 0,
    });
  });

  test("rejects manual replies for multi-word comments containing a keyword", async () => {
    const app = createApp();
    const db = await createSqliteD1();
    insertComment(db, {
      id: "comment_keyword_in_sentence",
      text: "это мой 🔥 комментарий",
    });

    const response = await app.fetch(
      new Request(
        "http://worker.test/admin/reply/comment/comment_keyword_in_sentence",
        {
          method: "POST",
          headers: { Authorization: "Bearer admin" },
        },
      ),
      env(db),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "reply_not_allowed",
      skippedReason: "no_keyword",
    });
    expect(db.first<{ count: number }>("SELECT COUNT(*) as count FROM reply_jobs")).toEqual({
      count: 0,
    });
  });

  test("sends a guarded manual reply for an eligible stored comment", async () => {
    const app = createApp();
    const db = await createSqliteD1();
    insertComment(db, { id: "comment_keyword", text: "🔥" });

    await withMetaFetch(async (requests) => {
      const response = await app.fetch(
        new Request("http://worker.test/admin/reply/comment/comment_keyword", {
          method: "POST",
          headers: { Authorization: "Bearer admin" },
        }),
        env(db),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        commentId: "comment_keyword",
        results: [
          {
            type: "comment_private_reply",
            created: true,
            duplicate: false,
            sent: true,
            status: "sent",
          },
        ],
      });
      expect(requests.filter((url) => url.includes("/conversations"))).toHaveLength(2);
      expect(requests.some((url) => url.endsWith("/ig_account/messages"))).toBe(true);
    });
  });

  test("manual private+public replies retry transient private invalid before public fallback", async () => {
    const app = createApp();
    const db = await createSqliteD1();
    insertComment(db, { id: "comment_manual_private_fail", text: "🔥" });

    await withMetaFetch(async (requests) => {
      const response = await app.fetch(
        new Request("http://worker.test/admin/reply/comment/comment_manual_private_fail", {
          method: "POST",
          headers: { Authorization: "Bearer admin" },
        }),
        env(db, undefined, { COMMENT_PUBLIC_REPLY_ENABLED: "true" }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        commentId: "comment_manual_private_fail",
        results: [
          {
            type: "comment_private_reply",
            created: true,
            duplicate: false,
            sent: false,
            status: "retryable",
            lastError: "private_reply_invalid",
          },
        ],
      });
      const privateRequestIndex = requests.findIndex((url) => url.endsWith("/ig_account/messages"));
      const publicRequestIndex = requests.findIndex((url) => url.endsWith("/replies"));
      expect(privateRequestIndex).toBeGreaterThan(-1);
      expect(publicRequestIndex).toBe(-1);
      expect(db.first<{ count: number }>(
        "SELECT COUNT(*) as count FROM reply_jobs WHERE type = 'comment_public_reply' AND status = 'sent'",
      )).toEqual({ count: 0 });
    }, { privateReplyFails: true });
  });

  test("does not create a manual reply job when conversation lookup fails", async () => {
    const app = createApp();
    const db = await createSqliteD1();
    insertComment(db, { id: "comment_lookup_failure", text: "🔥" });

    await withMetaFetch(async (requests) => {
      const response = await app.fetch(
        new Request("http://worker.test/admin/reply/comment/comment_lookup_failure", {
          method: "POST",
          headers: { Authorization: "Bearer admin" },
        }),
        env(db),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: "reply_not_allowed",
        skippedReason: "conversation_lookup_failed",
      });
      expect(requests.filter((url) => url.includes("/conversations"))).toHaveLength(1);
      expect(requests.some((url) => url.endsWith("/ig_account/messages"))).toBe(false);
      expect(db.first<{ count: number }>("SELECT COUNT(*) as count FROM reply_jobs")).toEqual({
        count: 0,
      });
    }, { conversationLookupFails: true });
  });

  test("manual replies can nudge an existing pending reply job", async () => {
    const app = createApp();
    const db = await createSqliteD1();
    insertComment(db, { id: "comment_existing_job", text: "🔥" });
    insertReplyJob(db, {
      id: "job_existing",
      commentId: "comment_existing_job",
      type: "comment_private_reply",
    });

    await withMetaFetch(async (requests) => {
      const response = await app.fetch(
        new Request("http://worker.test/admin/reply/comment/comment_existing_job", {
          method: "POST",
          headers: { Authorization: "Bearer admin" },
        }),
        env(db),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        commentId: "comment_existing_job",
        results: [
          {
            id: "job_existing",
            type: "comment_private_reply",
            created: false,
            duplicate: true,
            sent: true,
            status: "sent",
          },
        ],
      });
      expect(requests.filter((url) => url.includes("/conversations"))).toHaveLength(2);
      expect(requests.some((url) => url.endsWith("/ig_account/messages"))).toBe(true);
      expect(db.first<{ count: number }>("SELECT COUNT(*) as count FROM reply_jobs")).toEqual({
        count: 1,
      });
    });
  });

  test("force bypasses keyword and bot-enabled gates only", async () => {
    const app = createApp();
    const db = await createSqliteD1();
    insertComment(db, { id: "comment_force", text: "hello" });
    insertComment(db, {
      id: "comment_own",
      text: "hello",
      commenterId: "ig_account",
      username: "owner_account",
    });

    await withMetaFetch(async () => {
      const forced = await app.fetch(
        new Request("http://worker.test/admin/reply/comment/comment_force?force=1", {
          method: "POST",
          headers: { Authorization: "Bearer admin" },
        }),
        env(db, undefined, { BOT_ENABLED: "false", INSTAGRAM_USERNAME: "owner_account" }),
      );

      expect(forced.status).toBe(200);
      await expect(forced.json()).resolves.toMatchObject({
        ok: true,
        results: [{ sent: true, status: "sent" }],
      });

      const own = await app.fetch(
        new Request("http://worker.test/admin/reply/comment/comment_own?force=1", {
          method: "POST",
          headers: { Authorization: "Bearer admin" },
        }),
        env(db, undefined, { INSTAGRAM_USERNAME: "owner_account" }),
      );

      expect(own.status).toBe(409);
      await expect(own.json()).resolves.toMatchObject({
        ok: false,
        error: "reply_not_allowed",
        skippedReason: "own_comment",
      });
    });
  });
});

describe("admin data subject redaction", () => {
  test("returns a dry-run report without mutating stored data", async () => {
    const app = createApp();
    const db = await createSqliteD1();
    insertComment(db, { id: "comment_subject", username: "User" });
    db.exec(`
      INSERT INTO webhook_events
        (id, event_key, source, raw_payload, status, attempts, received_at, raw_payload_retention_until)
      VALUES
        ('event_subject', 'comment:comment_subject', 'instagram',
         '{"value":{"id":"comment_subject","from":{"id":"user_1","username":"User"}}}',
         'received', 0, '2026-05-05T12:00:00.000Z', '2026-08-03T12:00:00.000Z');

      INSERT INTO webhook_event_subjects
        (event_id, subject_type, subject_value, normalized_value, created_at)
      VALUES
        ('event_subject', 'comment', 'comment_subject', 'comment_subject', '2026-05-05T12:00:00.000Z'),
        ('event_subject', 'commenter', 'user_1', 'user_1', '2026-05-05T12:00:00.000Z'),
        ('event_subject', 'username', 'User', 'user', '2026-05-05T12:00:00.000Z');
    `);

    const response = await app.fetch(
      new Request("http://worker.test/admin/data-subject?username=user", {
        headers: { Authorization: "Bearer admin" },
      }),
      env(db),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      report: {
        commentIds: ["comment_subject"],
        commenterIds: ["user_1"],
        usernames: ["user"],
        counts: {
          comments: 1,
          webhookEvents: 1,
        },
      },
    });
    expect(db.first<{ username: string | null }>(
      "SELECT username FROM comments WHERE id = ?",
      "comment_subject",
    )).toEqual({ username: "User" });
  });

  test("anonymizes matching subject data through the apply endpoint", async () => {
    const app = createApp();
    const db = await createSqliteD1();
    insertComment(db, { id: "comment_subject", username: "User" });

    const response = await app.fetch(
      new Request("http://worker.test/admin/data-subject/redact?commenterId=user_1", {
        method: "POST",
        headers: { Authorization: "Bearer admin" },
      }),
      env(db),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      report: {
        commentIds: ["comment_subject"],
        commenterIds: ["user_1"],
      },
      redacted: {
        comments: 1,
      },
    });
    expect(db.first<{ count: number }>(
      "SELECT COUNT(*) as count FROM comments WHERE id = ?",
      "comment_subject",
    )).toEqual({ count: 0 });
  });
});

class FakeD1Database {
  events: Array<{ id: string; eventKey: string; rawPayload: string }> = [];
  replyJobs: Array<{
    status: string;
    createdAt: string;
    nextRetryAt?: string;
    sendingStartedAt?: string;
  }> = [];

  prepare(sql: string) {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements: FakeD1Statement[]) {
    const results = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }
}

class FakeD1Statement {
  private args: unknown[] = [];

  constructor(
    private readonly db: FakeD1Database,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async run() {
    const normalizedSql = this.sql.toLowerCase();
    if (
      normalizedSql.includes('insert into "webhook_events"') ||
      normalizedSql.includes("insert or ignore into webhook_events")
    ) {
      const eventKey = String(this.args[1]);
      const existing = this.db.events.find((event) => event.eventKey === eventKey);
      if (existing) {
        return { meta: { changes: 0 } };
      }

      this.db.events.push({
        id: String(this.args[0]),
        eventKey,
        rawPayload: String(this.args[3]),
      });
      return { meta: { changes: 1 } };
    }

    if (normalizedSql.includes("insert or ignore into webhook_event_subjects")) {
      return { meta: { changes: 0 } };
    }

    return { meta: { changes: 0 } };
  }

  async raw() {
    if (this.sql.includes('select "id" from "webhook_events"')) {
      const existing = this.db.events.find((event) => event.eventKey === this.args[0]);
      return existing ? [[existing.id]] : [];
    }

    if (this.sql.includes('select "status" from "instagram_accounts"')) {
      return [["active"]];
    }

    if (this.sql.includes("COUNT(*)") && this.sql.includes("MIN(")) {
      const now = new Date().toISOString();
      const staleSendingBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const dueJobs = this.dueJobs(now, staleSendingBefore);
      const oldestDueCreatedAt = dueJobs
        .map((job) => job.createdAt)
        .sort()[0];

      return [[dueJobs.length, oldestDueCreatedAt ?? null]];
    }

    if (this.sql.includes("group by")) {
      const counts = new Map<string, number>();
      for (const job of this.db.replyJobs) {
        counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
      }

      return [...counts.entries()].map(([status, count]) => [status, count]);
    }

    return [];
  }

  async first() {
    if (this.sql.includes("SELECT id FROM webhook_events WHERE event_key = ?")) {
      return this.db.events.find((event) => event.eventKey === this.args[0]) ?? null;
    }

    if (this.sql.includes("SELECT status FROM instagram_accounts WHERE id = ?")) {
      return { status: "active" };
    }

    if (this.sql.includes("COUNT(*) as due") && this.sql.includes("oldestDueCreatedAt")) {
      const now = String(this.args[0]);
      const staleSendingBefore = String(this.args[1]);
      const dueJobs = this.db.replyJobs.filter(
        (job) =>
          ((job.status === "pending" || job.status === "retryable") &&
            (!job.nextRetryAt || job.nextRetryAt <= now)) ||
          (job.status === "sending" &&
            job.sendingStartedAt !== undefined &&
            job.sendingStartedAt <= staleSendingBefore),
      );

      const oldestDueCreatedAt = dueJobs
        .map((job) => job.createdAt)
        .sort()[0];

      return { due: dueJobs.length, oldestDueCreatedAt: oldestDueCreatedAt ?? null };
    }

    return null;
  }

  async all() {
    if (this.sql.includes("GROUP BY status")) {
      const counts = new Map<string, number>();
      for (const job of this.db.replyJobs) {
        counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
      }

      return {
        results: [...counts.entries()].map(([status, count]) => ({ status, count })),
      };
    }

    return { results: [] };
  }

  private dueJobs(now: string, staleSendingBefore: string) {
    return this.db.replyJobs.filter(
      (job) =>
        ((job.status === "pending" || job.status === "retryable") &&
          (!job.nextRetryAt || job.nextRetryAt <= now)) ||
        (job.status === "sending" &&
          job.sendingStartedAt !== undefined &&
          job.sendingStartedAt <= staleSendingBefore),
    );
  }
}

class FakeQueue {
  messages: WebhookQueueMessage[] = [];

  constructor(private readonly options: { failOnce?: boolean } = {}) {}

  async send(message: WebhookQueueMessage) {
    if (this.options.failOnce) {
      this.options.failOnce = false;
      throw new Error("Queue send failed");
    }

    this.messages.push(message);
  }
}

function env(
  db: FakeD1Database | SqliteD1,
  queue?: FakeQueue,
  overrides: Partial<WorkerEnv> = {},
): WorkerEnv {
  return defaultWorkerEnv({
    DB: db as unknown as D1Database,
    WEBHOOK_QUEUE: queue as unknown as Queue<WebhookQueueMessage>,
    COMMENT_PRIVATE_REPLY_ENABLED: "true",
    ...overrides,
  });
}

function commentWebhookPayload() {
  return {
    object: "instagram",
    entry: [
      {
        id: "ig_account",
        changes: [
          {
            field: "comments",
            value: {
              id: "comment_1",
              text: "🔥",
              media: { id: "media_1" },
            },
          },
        ],
      },
    ],
  };
}

async function createSqliteD1(): Promise<SqliteD1> {
  const db = new SqliteD1();
  for (const migrationPath of Array.from(new Bun.Glob("migrations/*.sql").scanSync(".")).sort()) {
    db.exec(await Bun.file(migrationPath).text());
  }
  return db;
}

function insertComment(
  db: SqliteD1,
  overrides: {
    id?: string;
    text?: string;
    commenterId?: string;
    username?: string;
    commentKind?: "feed" | "live";
    createdAt?: string;
  } = {},
): void {
  const now = new Date().toISOString();
  const values = {
    id: overrides.id ?? "comment_1",
    mediaId: "media_1",
    commentKind: overrides.commentKind ?? "feed",
    commenterId: overrides.commenterId ?? "user_1",
    username: overrides.username ?? "user",
    usernameNormalized: (overrides.username ?? "user").toLocaleLowerCase("en-US"),
    text: overrides.text ?? "🔥",
    createdAt: overrides.createdAt ?? now,
    source: "webhook",
    matchedKeyword: null,
    privateReplyEligible: 1,
    rawJson: "{}",
    insertedAt: now,
    updatedAt: now,
  };

  db.exec(`
    INSERT INTO comments
      (id, media_id, comment_kind, commenter_id, username, username_normalized, text, created_at,
         source, last_seen_source,
       matched_keyword, private_reply_eligible, raw_json, inserted_at, updated_at)
    VALUES
      (${sqlString(values.id)}, ${sqlString(values.mediaId)}, ${sqlString(values.commentKind)},
       ${sqlString(values.commenterId)}, ${sqlString(values.username)}, ${sqlString(values.usernameNormalized)},
         ${sqlString(values.text)}, ${sqlString(values.createdAt)}, ${sqlString(values.source)},
         ${sqlString(values.source)},
       ${sqlString(values.matchedKeyword)},
       ${values.privateReplyEligible}, ${sqlString(values.rawJson)}, ${sqlString(values.insertedAt)},
       ${sqlString(values.updatedAt)});
  `);
}

function insertReplyJob(
  db: SqliteD1,
  input: {
    id: string;
    commentId: string;
    type: "comment_public_reply" | "comment_private_reply";
  },
): void {
  const now = new Date().toISOString();
  db.exec(`
    INSERT INTO reply_jobs
      (id, idempotency_key, type, comment_id, status, attempts, max_attempts, created_at, updated_at)
    VALUES
      (${sqlString(input.id)}, ${sqlString(`${input.type}:${input.commentId}`)},
       ${sqlString(input.type)}, ${sqlString(input.commentId)}, 'pending', 0, 3,
       ${sqlString(now)}, ${sqlString(now)});
  `);
}

async function withMetaFetch(
  callback: (requests: string[]) => Promise<void>,
  options: { conversationLookupFails?: boolean; privateReplyFails?: boolean } = {},
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/conversations")) {
      if (options.conversationLookupFails) {
        return new Response(JSON.stringify({ error: { message: "conversation timeout" } }), {
          status: 500,
        });
      }
      return new Response(JSON.stringify({ data: [] }));
    }
    if (url.endsWith("/messages")) {
      if (options.privateReplyFails) {
        return new Response(JSON.stringify({
          error: {
            message: "The comment is invalid for a private reply",
            code: 100,
            error_subcode: 2534025,
          },
        }), { status: 400 });
      }
      return new Response(JSON.stringify({ recipient_id: "user_1", message_id: "message_1" }));
    }
    if (url.endsWith("/replies")) {
      return new Response(JSON.stringify({ id: "public_reply_1" }));
    }
    return new Response(JSON.stringify({ error: { message: "unexpected request" } }), {
      status: 500,
    });
  }) as typeof fetch;

  try {
    await callback(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function sqlString(value: string | null): string {
  if (value === null) {
    return "NULL";
  }
  return `'${value.replace(/'/g, "''")}'`;
}

class SqliteD1 {
  private readonly db = new Database(":memory:");

  exec(sql: string) {
    this.db.exec(sql);
  }

  first<T>(sql: string, ...args: SQLQueryBindings[]): T | null {
    return this.db.query<T, SQLQueryBindings[]>(sql).get(...args);
  }

  prepare(sql: string) {
    const statement = this.db.prepare(sql);
    return {
      bind: (...args: SQLQueryBindings[]) => ({
        all: async () => ({ results: statement.all(...args) }),
        raw: async () => statement.values(...args),
        run: async () => {
          const result = statement.run(...args);
          return { meta: { changes: result.changes } };
        },
      }),
    };
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.db.exec("COMMIT;");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }
}
