import { Hono } from "hono";
import { getConfig, getPublicConfig } from "./env";
import { runBackfill } from "./comments/backfill";
import { sendManualCommentReply } from "./comments/manual-reply";
import { DrizzleRepository, type DataSubjectSelector } from "./db/repository";
import { MetaGraphClient } from "./meta/client";
import type { WorkerEnv } from "./types";
import { buildWebhookEventKey } from "./webhook/normalize";
import { verifyInstagramSignature } from "./webhook/signature";

type HonoBindings = {
  Bindings: WorkerEnv;
};

export function createApp() {
  const app = new Hono<HonoBindings>();

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "instagram-bot",
    }),
  );

  app.get("/privacy", (c) =>
    c.html(renderPolicyPage({
      title: "Privacy Policy",
      body: [
        "This Instagram automation service is used by the Instagram account owner to process comments and inbound direct messages on their own professional Instagram account.",
        "The service stores Instagram comment IDs, direct message IDs, media IDs, sender/commenter IDs, usernames when provided by Meta, message/comment text, timestamps, webhook payloads, reply job status, and API error metadata needed to prevent duplicate replies, diagnose failures, and comply with Meta Platform rules.",
        "The service does not sell personal data, does not use platform data for advertising profiles, and does not send cold direct messages. Automatic replies are only attempted for comments or inbound direct messages that match configured keywords, with per-keyword rules controlling whether an existing conversation should block comment-based private replies.",
        "Stored data is used only to operate the bot, prevent duplicate replies, troubleshoot delivery, and comply with platform requirements. Raw webhook payloads are retained for a limited operational window and then redacted automatically. Access is limited to the app operator.",
        "To request access, deletion, or anonymization of data associated with your Instagram interaction, contact the owner of the Instagram account where you left the comment or sent the direct message.",
      ],
    })),
  );

  app.get("/data-deletion", (c) =>
    c.html(renderPolicyPage({
      title: "Data Deletion Instructions",
      body: [
        "To disconnect this app from Instagram, remove the app from your Instagram or Meta connected apps settings where applicable.",
        "To request deletion or anonymization of stored comment, direct-message, or reply-processing data, contact the owner of the Instagram account where you interacted and include your Instagram username, the approximate date of the interaction, and the media URL if available.",
        "After a valid request is received, the app operator can use internal admin tooling to find and delete or anonymize matching comment, direct-message, commenter/sender, webhook subject, reply-job, and reply-attempt records unless retention is required for security, abuse prevention, platform compliance, or legal reasons.",
      ],
    })),
  );

  app.get("/webhooks/instagram", (c) => {
    const config = getConfig(c.env);
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");

    if (mode === "subscribe" && token === config.metaWebhookVerifyToken && challenge) {
      return c.text(challenge);
    }

    return c.text("Forbidden", 403);
  });

  app.post("/webhooks/instagram", async (c) => {
    const config = getConfig(c.env);
    const rawBody = await c.req.text();
    const validSignature = await verifyInstagramSignature(
      rawBody,
      c.req.header("X-Hub-Signature-256") ?? null,
      config.metaAppSecret,
    );

    if (!validSignature) {
      return c.text("Invalid signature", 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.text("Invalid JSON", 400);
    }

    if (!c.env.WEBHOOK_QUEUE) {
      return c.json(
        {
          ok: false,
          error: "webhook_queue_missing",
        },
        500,
      );
    }

    const repo = new DrizzleRepository(c.env.DB);
    const eventKey = await buildWebhookEventKey(rawBody, payload);
    const result = await repo.insertWebhookEvent({
      id: crypto.randomUUID(),
      eventKey,
      source: "instagram",
      rawPayload: rawBody,
      headersJson: JSON.stringify(readSafeWebhookHeaders(c.req.raw.headers)),
      receivedAt: new Date().toISOString(),
    });

    await c.env.WEBHOOK_QUEUE.send({
      type: "webhook_event",
      webhookEventId: result.id,
    });

    return c.json({
      ok: true,
      duplicate: !result.inserted,
    });
  });

  app.use("/admin/*", async (c, next) => {
    const config = getConfig(c.env);
    if (!isAuthorized(c.req.raw, config.adminApiKey)) {
      return c.text("Unauthorized", 401);
    }

    await next();
  });

  app.get("/admin/status", async (c) => {
    const config = getConfig(c.env);
    const repo = new DrizzleRepository(c.env.DB);
    const now = new Date();
    const accountStatus = await repo.getAccountStatus(config.instagramAccountId);
    const replyJobs = await repo.getReplyJobBacklog(
      now.toISOString(),
      new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
    );
    const deliverySince1h = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const deliverySince24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    return c.json({
      ok: true,
      accountStatus,
      config: getPublicConfig(config),
      webhookEvents: await repo.getWebhookEventStatusCounts(),
      replyJobs: {
        ...replyJobs,
        oldestDueAgeSeconds: replyJobs.oldestDueCreatedAt
          ? Math.max(0, Math.floor((now.getTime() - Date.parse(replyJobs.oldestDueCreatedAt)) / 1000))
          : undefined,
      },
      replyDelivery: {
        lastHour: await repo.getReplyDeliverySummary(deliverySince1h),
        last24Hours: await repo.getReplyDeliverySummary(deliverySince24h),
      },
      topReplyErrors: await repo.getTopReplyErrors(deliverySince24h, 10),
      reconciler: {
        lastRun: await repo.getLastReconcilerRun(),
      },
    });
  });

  app.get("/admin/data-subject", async (c) => {
    const selector = readDataSubjectSelector(c.req);
    if (!selector) {
      return c.json({ ok: false, error: "missing_data_subject_selector" }, 400);
    }

    const repo = new DrizzleRepository(c.env.DB);
    const report = await repo.getDataSubjectReport(selector);
    return c.json({ ok: true, report });
  });

  app.post("/admin/data-subject/redact", async (c) => {
    const selector = readDataSubjectSelector(c.req);
    if (!selector) {
      return c.json({ ok: false, error: "missing_data_subject_selector" }, 400);
    }

    const repo = new DrizzleRepository(c.env.DB);
    const result = await repo.anonymizeDataSubject(selector, new Date().toISOString());
    return c.json({ ok: true, ...result });
  });

  app.post("/admin/backfill/media/:mediaId", async (c) => {
    const config = getConfig(c.env);
    const mediaId = c.req.param("mediaId");
    const send = c.req.query("send") === "1" || c.req.query("send") === "true";
    const afterCursor = c.req.query("after");
    const maxPages = parsePositiveInteger(c.req.query("maxPages"));
    const summary = await runBackfill({
      mediaId,
      send,
      afterCursor,
      maxPages,
      config,
      repo: new DrizzleRepository(c.env.DB),
      metaClient: new MetaGraphClient(config),
      now: new Date(),
    });

    return c.json({ ok: true, summary });
  });

  app.post("/admin/reply/comment/:commentId", async (c) => {
    const config = getConfig(c.env);
    const now = new Date();
    const repo = new DrizzleRepository(c.env.DB);
    const commentId = c.req.param("commentId");
    const force = isForce(c.req.query("force"));
    const metaClient = new MetaGraphClient(config);
    const result = await sendManualCommentReply({
      commentId,
      config,
      repo,
      metaClient,
      now,
      force,
    });

    if (result.status === "comment_not_found") {
      return c.json({ ok: false, error: "comment_not_found" }, 404);
    }

    if (result.status === "reply_not_allowed") {
      return c.json(
        {
          ok: false,
          error: "reply_not_allowed",
          skippedReason: result.skippedReason,
        },
        409,
      );
    }

    return c.json({ ok: true, commentId: result.commentId, results: result.results });
  });

  return app;
}

function isForce(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function renderPolicyPage(input: { title: string; body: string[] }): string {
  const paragraphs = input.body.map((text) => `<p>${escapeHtml(text)}</p>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)} - Instagram Bot</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.55; max-width: 760px; margin: 48px auto; padding: 0 20px; color: #111827; }
    h1 { font-size: 32px; line-height: 1.2; margin-bottom: 24px; }
    p { margin: 0 0 16px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(input.title)}</h1>
  ${paragraphs}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isAuthorized(request: Request, adminApiKey: string): boolean {
  const auth = request.headers.get("Authorization");
  if (auth === `Bearer ${adminApiKey}`) {
    return true;
  }

  return request.headers.get("x-admin-api-key") === adminApiKey;
}

function readSafeWebhookHeaders(headers: Headers): Record<string, string> {
  const names = ["x-hub-signature-256", "content-type", "user-agent"];
  const result: Record<string, string> = {};

  for (const name of names) {
    const value = headers.get(name);
    if (value) {
      result[name] = value;
    }
  }

  return result;
}

function readDataSubjectSelector(request: {
  query: (name: string) => string | undefined;
}): DataSubjectSelector | undefined {
  const selector = {
    commentId: cleanQueryValue(request.query("commentId")),
    directMessageId: cleanQueryValue(request.query("directMessageId")),
    commenterId: cleanQueryValue(request.query("commenterId")),
    username: cleanQueryValue(request.query("username")),
  };

  return selector.commentId || selector.directMessageId || selector.commenterId || selector.username
    ? selector
    : undefined;
}

function cleanQueryValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
