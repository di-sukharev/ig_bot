import { describe, expect, test } from "bun:test";
import { isPrivateReplyEligible, matchKeyword } from "../src/comments/matching";

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
