import { describe, expect, test } from "bun:test";
import {
  buildReleaseCommandPlan,
  parseD1DatabaseName,
  prepareReleaseContext,
  shouldRunDeployCommands,
} from "../scripts/release";
import { parseWranglerConfigArg } from "../scripts/wrangler";
import {
  PRODUCTION_REPLY_RULES_CONFIG,
  PRODUCTION_WRANGLER_CONFIG,
  PUBLIC_REPLY_RULES_CONFIG,
  PUBLIC_WRANGLER_CONFIG,
  resolveReplyRulesConfigPath,
} from "../scripts/wrangler-config";

describe("release helper", () => {
  test("builds preflight and manual deploy commands", () => {
    expect(buildReleaseCommandPlan("example_d1_database")).toEqual({
      preflight: [
        ["bun", "run", "typecheck"],
        ["bun", "run", "test"],
        ["bun", "run", "smoke:d1"],
      ],
      deploy: [
        ["bun", "run", "wrangler", "d1", "migrations", "apply", "example_d1_database", "--remote"],
        ["bun", "run", "deploy"],
        ["bun", "run", "bot:status"],
      ],
    });
  });

  test("requires exact DEPLOY confirmation from an interactive terminal", () => {
    expect(shouldRunDeployCommands({ isTty: true, confirmation: "DEPLOY" })).toBe(true);
    expect(shouldRunDeployCommands({ isTty: true, confirmation: "deploy" })).toBe(false);
    expect(shouldRunDeployCommands({ isTty: false, confirmation: "DEPLOY" })).toBe(false);
  });

  test("parses D1 database name from wrangler config", () => {
    expect(parseD1DatabaseName(`
      name = "instagram-bot"

      [[d1_databases]]
      binding = "DB"
      database_name = "example_d1_database"
      database_id = "example"
    `)).toBe("example_d1_database");
  });

  test("keeps public deploy rules tied to public wrangler config", async () => {
    await expect(resolveReplyRulesConfigPath({
      wranglerConfigPath: PUBLIC_WRANGLER_CONFIG,
      fileExists: async (path) => path === PRODUCTION_REPLY_RULES_CONFIG,
    })).resolves.toBe(PUBLIC_REPLY_RULES_CONFIG);
  });

  test("requires production reply rules with production wrangler config", async () => {
    await expect(resolveReplyRulesConfigPath({
      wranglerConfigPath: PRODUCTION_WRANGLER_CONFIG,
      fileExists: async () => false,
    })).rejects.toThrow(PRODUCTION_REPLY_RULES_CONFIG);

    await expect(resolveReplyRulesConfigPath({
      wranglerConfigPath: PRODUCTION_WRANGLER_CONFIG,
      fileExists: async (path) => path === PRODUCTION_REPLY_RULES_CONFIG,
    })).resolves.toBe(PRODUCTION_REPLY_RULES_CONFIG);
  });

  test("keeps explicit deploy config out of the temporary deploy command", () => {
    expect(parseWranglerConfigArg(["deploy", "--dry-run", "--config", PRODUCTION_WRANGLER_CONFIG]))
      .toEqual({
        explicitConfigPath: PRODUCTION_WRANGLER_CONFIG,
        argsWithoutConfig: ["deploy", "--dry-run"],
      });

    expect(parseWranglerConfigArg(["deploy", `--config=${PUBLIC_WRANGLER_CONFIG}`]))
      .toEqual({
        explicitConfigPath: PUBLIC_WRANGLER_CONFIG,
        argsWithoutConfig: ["deploy"],
      });
  });

  test("recognizes dot-relative production wrangler config paths", async () => {
    await expect(resolveReplyRulesConfigPath({
      wranglerConfigPath: `./${PRODUCTION_WRANGLER_CONFIG}`,
      fileExists: async (path) => path === PRODUCTION_REPLY_RULES_CONFIG,
    })).resolves.toBe(PRODUCTION_REPLY_RULES_CONFIG);
  });

  test("validates release reply rules before exposing deploy commands", async () => {
    const calls: string[] = [];

    await expect(prepareReleaseContext({
      readWranglerConfig: async () => {
        calls.push("read-wrangler");
        return {
          path: PRODUCTION_WRANGLER_CONFIG,
          text: `
            [[d1_databases]]
            database_name = "example_d1_database"
          `,
        };
      },
      validateReplyRulesConfig: async (wranglerConfigPath) => {
        calls.push(`validate:${wranglerConfigPath}`);
        throw new Error("invalid production reply rules");
      },
    })).rejects.toThrow("invalid production reply rules");

    expect(calls).toEqual([
      "read-wrangler",
      `validate:${PRODUCTION_WRANGLER_CONFIG}`,
    ]);
  });
});
