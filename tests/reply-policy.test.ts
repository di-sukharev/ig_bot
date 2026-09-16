import { describe, expect, spyOn, test } from "bun:test";
import { planCommentReplyJobs } from "../src/comments/reply-policy";
import { parseCommentReplyRulesConfig } from "../src/comments/reply-rules";
import { defaultAppConfig } from "./helpers/config";

describe("public comment reply selection", () => {
  const config = defaultAppConfig({
    COMMENT_PUBLIC_REPLY_ENABLED: "true",
    COMMENT_PRIVATE_REPLY_ENABLED: "true",
  });

  test("randomly chooses from 20 distinct replies with different emoji for each comment", () => {
    const [rule] = parseCommentReplyRulesConfig([{ keywords: "хочу", private: "reply" }]);
    const random = spyOn(Math, "random");
    try {
      const replies = Array.from({ length: 20 }, (_, index) => {
        random.mockReturnValue(index / 20);
        const jobs = planCommentReplyJobs(config, rule);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.type).toBe("comment_private_reply");
        expect(jobs[0]?.replyText).toBe("reply");
        expect(jobs[0]?.publicSuccessReplyText).toMatch(/\p{Extended_Pictographic}/u);
        return jobs[0]!.publicSuccessReplyText!;
      });

      expect(new Set(replies).size).toBe(20);
      expect(new Set(replies.map((text) => text.match(/\p{Extended_Pictographic}/u)?.[0])).size)
        .toBe(20);
      random.mockReturnValue(1 - Number.EPSILON);
      expect(planCommentReplyJobs(config, rule)[0]?.publicSuccessReplyText).toBe(replies[19]);
    } finally {
      random.mockRestore();
    }
  });

  test.each([undefined, "", "  "])("uses a universal public reply when public is %j", (publicText) => {
    const [rule] = parseCommentReplyRulesConfig([
      { keywords: "хочу", private: "reply", public: publicText },
    ]);
    const jobs = planCommentReplyJobs({ ...config, commentPrivateReplyEnabled: false }, rule);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.type).toBe("comment_public_reply");
    expect(jobs[0]?.replyText).toMatch(/\p{Extended_Pictographic}/u);
  });

  test("keeps an explicit public override for both reply modes", () => {
    const [rule] = parseCommentReplyRulesConfig([
      { keywords: "хочу", private: "reply", public: "  свой ответ 🫡  " },
    ]);

    expect(planCommentReplyJobs(config, rule)[0]?.publicSuccessReplyText).toBe("свой ответ 🫡");
    expect(planCommentReplyJobs({ ...config, commentPrivateReplyEnabled: false }, rule))
      .toEqual([{ type: "comment_public_reply", replyText: "свой ответ 🫡" }]);
  });

  test("respects the public reply switch and requires a matching rule", () => {
    const [rule] = parseCommentReplyRulesConfig([{ keywords: "хочу", private: "reply" }]);

    expect(planCommentReplyJobs({ ...config, commentPublicReplyEnabled: false }, rule))
      .toEqual([{ type: "comment_private_reply", replyText: "reply", publicSuccessReplyText: undefined }]);
    expect(planCommentReplyJobs({
      ...config,
      commentPrivateReplyEnabled: false,
      commentPublicReplyEnabled: false,
    }, rule)).toEqual([]);
    expect(planCommentReplyJobs(config, undefined)).toEqual([]);
  });
});
