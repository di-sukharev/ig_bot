import { describe, expect, test } from "bun:test";
import {
  isPrivateReplyEligible,
  matchCommentKeyword,
  matchKeyword,
} from "../src/comments/matching";

describe("keyword matching", () => {
  test("matches case-insensitive words and phrases as normalized substrings", () => {
    expect(matchKeyword("Очень ХОЧУ программу", ["хочу"]).keyword).toBe("хочу");
    expect(matchKeyword("хочу   программу", ["хочу программу"]).matched).toBe(true);
  });

  test("does not match empty text or empty keywords", () => {
    expect(matchKeyword("", ["хочу"]).matched).toBe(false);
    expect(matchKeyword("хочу", [""]).matched).toBe(false);
  });

  test("matches emoji with or without variation selectors", () => {
    expect(matchKeyword("🐿", ["🐿️"]).matched).toBe(true);
    expect(matchKeyword("🐿️", ["🐿"]).matched).toBe(true);
  });

  test("matches one-word comments with any number of emoji", () => {
    expect(matchCommentKeyword("РЕВЬЮ!!! 🔥🙌", ["ревью"]).keyword).toBe("ревью");
    expect(matchCommentKeyword("🔥 🔥🔥", ["🔥"]).matched).toBe(true);
    expect(matchCommentKeyword("хочу ℹ️", ["хочу"]).matched).toBe(true);
    expect(matchCommentKeyword("ℹ️ ℹ️", ["ℹ️"]).matched).toBe(true);
    expect(matchCommentKeyword("хочу 1️⃣2️⃣", ["хочу"]).matched).toBe(true);
  });

  test("does not match keywords inside comments with multiple words", () => {
    expect(
      matchCommentKeyword("можно сделать ревью пожалуйста", ["ревью"]),
    ).toEqual({ matched: false });
    expect(matchCommentKeyword("хочу🔥программу", ["хочу"])).toEqual({
      matched: false,
    });
    expect(matchCommentKeyword("я1️⃣хочу", ["хочу"])).toEqual({
      matched: false,
    });
    expect(matchCommentKeyword("хочу-программу", ["хочу"])).toEqual({
      matched: false,
    });
    expect(matchCommentKeyword("хочу_программу", ["хочу"])).toEqual({
      matched: false,
    });
    expect(matchCommentKeyword("хочу’программу", ["хочу"])).toEqual({
      matched: false,
    });
  });
});

describe("private reply eligibility", () => {
  test("allows comments within the configured window", () => {
    const now = new Date("2026-05-05T12:00:00.000Z");
    expect(isPrivateReplyEligible("2026-05-01T12:00:00.000Z", now, 7)).toBe(true);
  });

  test("rejects stale comments and missing timestamps", () => {
    const now = new Date("2026-05-05T12:00:00.000Z");
    expect(isPrivateReplyEligible("2026-04-01T12:00:00.000Z", now, 7)).toBe(false);
    expect(isPrivateReplyEligible(undefined, now, 7)).toBe(false);
  });

  test("never allows windows above Meta's hard 7-day limit", () => {
    const now = new Date("2026-05-05T12:00:00.000Z");

    expect(isPrivateReplyEligible("2026-04-27T12:00:00.000Z", now, 30)).toBe(false);
  });
});
