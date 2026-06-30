import { describe, expect, test } from "bun:test";
import { getConfig } from "../src/env";
import { parseCommentReplyRulesConfig } from "../src/comments/reply-rules";
import { defaultWorkerEnv } from "./helpers/config";

describe("env config", () => {
  test("parses runtime flags and file-defined reply rules", () => {
    const config = getConfig(defaultWorkerEnv({
      BOT_ENABLED: "false",
      DM_AUTOREPLY_ENABLED: "false",
      BACKFILL_REPLY_ENABLED: "true",
      COMMENT_PUBLIC_REPLY_ENABLED: "true",
    }));

    expect(config.botEnabled).toBe(false);
    expect(config.dmAutoreplyEnabled).toBe(false);
    expect(config.commentPrivateReplyEnabled).toBe(false);
    expect(config.commentKeywords).toContain("demo");
    expect(config.backfillReplyEnabled).toBe(true);
    expect(config.commentPublicReplyEnabled).toBe(true);
    expect(config.commentReplyRules[0]?.publicReplyText).toBe("public reply");
    expect(config.commentReplyRules[0]?.privateReplyText).toBe("dm reply");
  });

  test("supports comma-separated keywords inside file-defined rules", () => {
    const rules = parseCommentReplyRulesConfig(
      [
        {
          keywords: "alpha,beta",
          publicReplyText: "public",
          privateReplyText: "private",
        },
      ],
      "test reply rules",
    );

    expect(rules).toEqual([
      {
        keywords: ["alpha", "beta"],
        publicReplyText: "public",
        privateReplyText: "private",
        always: false,
      },
    ]);
  });

  test("falls back to public/private aliases when explicit reply text fields are blank", () => {
    const rules = parseCommentReplyRulesConfig(
      [
        {
          keywords: ["demo"],
          public: "public",
          private: "private",
          publicReplyText: " ",
          privateReplyText: " ",
        },
      ],
      "test reply rules",
    );

    expect(rules).toEqual([
      {
        keywords: ["demo"],
        publicReplyText: "public",
        privateReplyText: "private",
        always: false,
      },
    ]);
  });

  test("rejects invalid file-defined reply rules", () => {
    expect(() => parseCommentReplyRulesConfig([], "test reply rules")).toThrow(
      /test reply rules/,
    );
  });

  test("ignores legacy env reply text and keyword overrides", () => {
    const config = getConfig({
      ...defaultWorkerEnv(),
      COMMENT_KEYWORDS: "хочу",
      COMMENT_PRIVATE_REPLY_TEXT: "legacy private",
      COMMENT_PUBLIC_REPLY_TEXT: "legacy public",
    } as Parameters<typeof getConfig>[0]);

    expect(config.commentKeywords).not.toEqual(["хочу"]);
    expect(config.commentReplyRules.some((rule) => rule.privateReplyText === "legacy private")).toBe(
      false,
    );
    expect(config.commentReplyRules.some((rule) => rule.publicReplyText === "legacy public")).toBe(
      false,
    );
    expect(config.commentReplyRules.some((rule) => rule.privateReplyText?.length)).toBe(
      true,
    );
  });

  test("caps private reply max age at Meta's hard 7-day window", () => {
    const config = getConfig(defaultWorkerEnv({ BACKFILL_PRIVATE_REPLY_MAX_AGE_DAYS: "30" }));

    expect(config.backfillPrivateReplyMaxAgeDays).toBe(7);
  });

  test("rejects reconciler intervals that cannot run evenly on minute cron", () => {
    expect(() => getConfig(defaultWorkerEnv({ RECONCILER_INTERVAL_MINUTES: "7" }))).toThrow();
    expect(() => getConfig(defaultWorkerEnv({ RECONCILER_INTERVAL_MINUTES: "90" }))).toThrow();
  });

  test("rejects missing secrets", () => {
    expect(() => getConfig(defaultWorkerEnv({ ADMIN_API_KEY: "" }))).toThrow();
  });
});
