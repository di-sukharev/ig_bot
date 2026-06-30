import { z } from "zod";
import {
  getCommentReplyKeywords,
  parseCommentReplyRulesConfig,
  type CommentReplyRule,
} from "./comments/reply-rules";
import replyRulesConfig from "../config/reply-rules.json";
import type { WorkerEnv } from "./types";

const commentReplyRuleSchema = z.object({
  keywords: z.array(z.string().min(1)).min(1),
  publicReplyText: z.string().min(1).optional(),
  privateReplyText: z.string().min(1).optional(),
  always: z.boolean().optional(),
}).refine(
  (rule) => Boolean(rule.publicReplyText || rule.privateReplyText),
  "reply rule must define publicReplyText or privateReplyText",
);

const configSchema = z.object({
  appEnv: z.string().default("development"),
  publicBaseUrl: z.string().optional(),
  adminApiKey: z.string().min(1),
  metaAppSecret: z.string().min(1),
  metaWebhookVerifyToken: z.string().min(1),
  metaGraphApiVersion: z.string().min(1).default("v25.0"),
  metaGraphApiBaseUrl: z.string().url().default("https://graph.instagram.com"),
  instagramAccountId: z.string().min(1),
  instagramUsername: z.string().optional(),
  instagramAccessToken: z.string().min(1),
  instagramAccessTokenExpiresAt: z.string().optional(),
  botEnabled: z.boolean(),
  dmAutoreplyEnabled: z.boolean(),
  commentPrivateReplyEnabled: z.boolean(),
  backfillReplyEnabled: z.boolean(),
  commentPublicReplyEnabled: z.boolean(),
  commentKeywords: z.array(z.string()),
  commentReplyRules: z.array(commentReplyRuleSchema).min(1),
  backfillPrivateReplyMaxAgeDays: z.number().int().positive().max(7),
  backfillMaxPagesPerRun: z.number().int().positive(),
  maxReplyAttempts: z.number().int().positive(),
  rateLimitMessagesPerMinute: z.number().int().positive(),
  reconcilerEnabled: z.boolean(),
  reconcilerIntervalMinutes: z.number().int().positive().max(60).refine(
    (value) => 60 % value === 0,
    "RECONCILER_INTERVAL_MINUTES must evenly divide 60",
  ),
  reconcilerMediaLimit: z.number().int().positive(),
  reconcilerMaxCommentPagesPerMedia: z.number().int().positive(),
  reconcilerLookbackHours: z.number().int().positive(),
});

export type AppConfig = z.infer<typeof configSchema>;

export function getConfig(env: WorkerEnv): AppConfig {
  const commentReplyRules = resolveCommentReplyRules(env);
  const commentKeywords = getCommentReplyKeywords(commentReplyRules);
  const commentPrivateReplyEnabled = parseBoolean(env.COMMENT_PRIVATE_REPLY_ENABLED, false);
  const backfillReplyEnabled = parseBoolean(env.BACKFILL_REPLY_ENABLED, false);
  const commentPublicReplyEnabled = parseBoolean(env.COMMENT_PUBLIC_REPLY_ENABLED, false);
  const raw = {
    appEnv: env.APP_ENV ?? "development",
    publicBaseUrl: emptyToUndefined(env.PUBLIC_BASE_URL),
    adminApiKey: env.ADMIN_API_KEY ?? "",
    metaAppSecret: env.META_APP_SECRET ?? "",
    metaWebhookVerifyToken: env.META_WEBHOOK_VERIFY_TOKEN ?? "",
    metaGraphApiVersion: env.META_GRAPH_API_VERSION ?? "v25.0",
    metaGraphApiBaseUrl: env.META_GRAPH_API_BASE_URL ?? "https://graph.instagram.com",
    instagramAccountId: env.INSTAGRAM_ACCOUNT_ID ?? "",
    instagramUsername: emptyToUndefined(env.INSTAGRAM_USERNAME),
    instagramAccessToken: env.INSTAGRAM_ACCESS_TOKEN ?? "",
    instagramAccessTokenExpiresAt: emptyToUndefined(env.INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT),
    botEnabled: parseBoolean(env.BOT_ENABLED, true),
    dmAutoreplyEnabled: parseBoolean(env.DM_AUTOREPLY_ENABLED, false),
    commentPrivateReplyEnabled,
    backfillReplyEnabled,
    commentPublicReplyEnabled,
    commentKeywords,
    commentReplyRules,
    backfillPrivateReplyMaxAgeDays: Math.min(
      parseInteger(env.BACKFILL_PRIVATE_REPLY_MAX_AGE_DAYS, 7),
      7,
    ),
    backfillMaxPagesPerRun: parseInteger(env.BACKFILL_MAX_PAGES_PER_RUN, 25),
    maxReplyAttempts: parseInteger(env.MAX_REPLY_ATTEMPTS, 3),
    rateLimitMessagesPerMinute: parseInteger(env.RATE_LIMIT_MESSAGES_PER_MINUTE, 30),
    reconcilerEnabled: parseBoolean(env.RECONCILER_ENABLED, true),
    reconcilerIntervalMinutes: parseInteger(env.RECONCILER_INTERVAL_MINUTES, 10),
    reconcilerMediaLimit: parseInteger(env.RECONCILER_MEDIA_LIMIT, 10),
    reconcilerMaxCommentPagesPerMedia: parseInteger(
      env.RECONCILER_MAX_COMMENT_PAGES_PER_MEDIA,
      3,
    ),
    reconcilerLookbackHours: parseInteger(env.RECONCILER_LOOKBACK_HOURS, 24),
  };

  return configSchema.parse(raw);
}

export function getPublicConfig(config: AppConfig) {
  return {
    appEnv: config.appEnv,
    publicBaseUrl: config.publicBaseUrl,
    metaGraphApiVersion: config.metaGraphApiVersion,
    metaGraphApiBaseUrl: config.metaGraphApiBaseUrl,
    instagramAccountId: config.instagramAccountId,
    instagramUsername: config.instagramUsername,
    botEnabled: config.botEnabled,
    dmAutoreplyEnabled: config.dmAutoreplyEnabled,
    commentPrivateReplyEnabled: config.commentPrivateReplyEnabled,
    backfillReplyEnabled: config.backfillReplyEnabled,
    commentPublicReplyEnabled: config.commentPublicReplyEnabled,
    commentKeywords: config.commentKeywords,
    commentReplyRules: config.commentReplyRules.map((rule) => ({
      keywords: rule.keywords,
      publicReplyText: rule.publicReplyText,
      hasPrivateReplyText: Boolean(rule.privateReplyText),
      always: rule.always === true,
    })),
    backfillPrivateReplyMaxAgeDays: config.backfillPrivateReplyMaxAgeDays,
    backfillMaxPagesPerRun: config.backfillMaxPagesPerRun,
    maxReplyAttempts: config.maxReplyAttempts,
    rateLimitMessagesPerMinute: config.rateLimitMessagesPerMinute,
    reconcilerEnabled: config.reconcilerEnabled,
    reconcilerIntervalMinutes: config.reconcilerIntervalMinutes,
    reconcilerMediaLimit: config.reconcilerMediaLimit,
    reconcilerMaxCommentPagesPerMedia: config.reconcilerMaxCommentPagesPerMedia,
    reconcilerLookbackHours: config.reconcilerLookbackHours,
    hasAdminApiKey: config.adminApiKey.length > 0,
    hasMetaAppSecret: config.metaAppSecret.length > 0,
    hasInstagramAccessToken: config.instagramAccessToken.length > 0,
  };
}

function parseBoolean(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Expected boolean string, got "${value}"`);
}

function parseInteger(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected integer, got "${value}"`);
  }

  return parsed;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value;
}

function resolveCommentReplyRules(env: WorkerEnv): CommentReplyRule[] {
  void env;
  return parseCommentReplyRulesConfig(replyRulesConfig, "config/reply-rules.json");
}
