import { resolve } from "node:path";
import { parseCommentReplyRulesConfig } from "../src/comments/reply-rules";

export const PUBLIC_WRANGLER_CONFIG = "wrangler.toml";
export const PRODUCTION_WRANGLER_CONFIG = "wrangler.production.toml";
export const PUBLIC_REPLY_RULES_CONFIG = "config/reply-rules.json";
export const PRODUCTION_REPLY_RULES_CONFIG = "config/reply-rules.production.json";

type FileExists = (path: string) => Promise<boolean>;
type ReadText = (path: string) => Promise<string>;

export async function resolveWranglerConfigPath(input: {
  preferProduction?: boolean;
} = {}): Promise<string> {
  if (input.preferProduction && await Bun.file(PRODUCTION_WRANGLER_CONFIG).exists()) {
    return PRODUCTION_WRANGLER_CONFIG;
  }

  return PUBLIC_WRANGLER_CONFIG;
}

export async function readWranglerConfig(input: {
  preferProduction?: boolean;
} = {}): Promise<{ path: string; text: string }> {
  const path = await resolveWranglerConfigPath(input);
  return { path, text: await Bun.file(path).text() };
}

export async function resolveReplyRulesConfigPath(input: {
  wranglerConfigPath: string;
  fileExists?: FileExists;
}): Promise<string> {
  const fileExists = input.fileExists ?? ((path) => Bun.file(path).exists());
  if (!isProductionWranglerConfig(input.wranglerConfigPath)) {
    return PUBLIC_REPLY_RULES_CONFIG;
  }

  if (!(await fileExists(PRODUCTION_REPLY_RULES_CONFIG))) {
    throw new Error(
      `${PRODUCTION_REPLY_RULES_CONFIG} is required when using ${PRODUCTION_WRANGLER_CONFIG}`,
    );
  }

  return PRODUCTION_REPLY_RULES_CONFIG;
}

export async function resolveAndValidateReplyRulesConfigPath(input: {
  wranglerConfigPath: string;
  fileExists?: FileExists;
  readText?: ReadText;
}): Promise<string> {
  const path = await resolveReplyRulesConfigPath(input);
  await validateReplyRulesConfigFile(path, { readText: input.readText });
  return path;
}

export async function validateReplyRulesConfigFile(
  path: string,
  input: { readText?: ReadText } = {},
): Promise<void> {
  const raw = await (input.readText ?? ((filePath) => Bun.file(filePath).text()))(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} must be valid JSON`);
  }

  parseCommentReplyRulesConfig(parsed, path);
}

function isProductionWranglerConfig(path: string): boolean {
  return path === PRODUCTION_WRANGLER_CONFIG || resolve(path) === resolve(PRODUCTION_WRANGLER_CONFIG);
}
