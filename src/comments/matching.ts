export interface KeywordMatch {
  matched: boolean;
  keyword?: string;
}

const COMMENT_EMOJI_PATTERN =
  /(?:[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic})/gu;
const MEANINGFUL_WORD_PATTERN =
  /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu;

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

export function matchCommentKeyword(
  text: string | undefined,
  keywords: string[],
): KeywordMatch {
  if (!hasAtMostOneMeaningfulWord(text)) {
    return { matched: false };
  }

  return matchKeyword(text, keywords);
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

function hasAtMostOneMeaningfulWord(value: string | undefined): boolean {
  const textWithoutEmoji = value?.replace(COMMENT_EMOJI_PATTERN, " ") ?? "";
  const words = textWithoutEmoji.match(MEANINGFUL_WORD_PATTERN);
  return (words?.length ?? 0) <= 1;
}
