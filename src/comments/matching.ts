export interface KeywordMatch {
  matched: boolean;
  keyword?: string;
}

export function matchKeyword(text: string | undefined, keywords: string[]): KeywordMatch {
  const normalizedText = normalizeForMatching(text);
  if (!normalizedText) {
    return { matched: false };
  }

  for (const keyword of keywords) {
    const normalizedKeyword = normalizeForMatching(keyword);
    if (normalizedKeyword && normalizedText.includes(normalizedKeyword)) {
      return { matched: true, keyword };
    }
  }

  return { matched: false };
}

export function parseKeywordList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isPrivateReplyEligible(
  createdAt: string | undefined,
  now: Date,
  maxAgeDays = 7,
): boolean {
  if (!createdAt) {
    return false;
  }

  const createdTime = Date.parse(createdAt);
  if (!Number.isFinite(createdTime)) {
    return false;
  }

  const ageMs = now.getTime() - createdTime;
  const cappedMaxAgeDays = Math.min(maxAgeDays, 7);
  return ageMs >= 0 && ageMs <= cappedMaxAgeDays * 24 * 60 * 60 * 1000;
}

export function normalizeForMatching(value: string | undefined): string {
  if (!value) {
    return "";
  }

  return value
    .toLocaleLowerCase("ru-RU")
    .replace(/[\uFE0E\uFE0F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
