import type { NormalizedComment } from "../types";

type UnknownRecord = Record<string, unknown>;

export function normalizeFetchedComment(
  mediaId: string,
  value: unknown,
): NormalizedComment | undefined {
  if (!isRecord(value) || typeof value.id !== "string") {
    return undefined;
  }

  const from = isRecord(value.from) ? value.from : undefined;
  return {
    id: value.id,
    mediaId,
    commentKind: "feed",
    commenterId: readString(from?.id),
    username: readString(from?.username),
    text: readString(value.text),
    createdAt: readString(value.timestamp),
    source: "backfill",
    raw: value,
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
