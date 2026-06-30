import type { NormalizedComment, NormalizedDirectMessage } from "../types";
import { sha256Hex } from "./signature";

type UnknownRecord = Record<string, unknown>;

export interface WebhookNormalizationResult {
  comments: NormalizedComment[];
  directMessages: NormalizedDirectMessage[];
  unsupportedCount: number;
}

export function normalizeInstagramWebhook(
  payload: unknown,
  connectedAccountId: string,
): WebhookNormalizationResult {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) {
    return { comments: [], directMessages: [], unsupportedCount: 1 };
  }

  const comments: NormalizedComment[] = [];
  const directMessages: NormalizedDirectMessage[] = [];
  let unsupportedCount = 0;

  for (const entry of payload.entry) {
    if (!isRecord(entry)) {
      unsupportedCount += 1;
      continue;
    }

    if (!entryBelongsToConnectedAccount(entry, connectedAccountId)) {
      const changeCount = Array.isArray(entry.changes) ? entry.changes.length : 0;
      const messagingCount = Array.isArray(entry.messaging) ? entry.messaging.length : 0;
      unsupportedCount += changeCount + messagingCount || 1;
      continue;
    }

    const entryTime = timestampToIso(entry.time);
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const change of changes) {
      if (!isRecord(change)) {
        unsupportedCount += 1;
        continue;
      }

      const field = typeof change.field === "string" ? change.field : "";
      if (field !== "comments" && field !== "live_comments") {
        unsupportedCount += 1;
        continue;
      }

      const value = change.value;
      if (!isRecord(value)) {
        unsupportedCount += 1;
        continue;
      }

      const normalized = normalizeCommentValue(value, entryTime, field);
      if (normalized) {
        comments.push(normalized);
      } else {
        unsupportedCount += 1;
      }
    }

    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const messagingEvent of messaging) {
      if (!isRecord(messagingEvent)) {
        unsupportedCount += 1;
        continue;
      }

      const normalized = normalizeDirectMessageValue(
        messagingEvent,
        entryTime,
        connectedAccountId,
      );
      if (normalized) {
        directMessages.push(normalized);
      } else {
        unsupportedCount += 1;
      }
    }
  }

  return { comments, directMessages, unsupportedCount };
}

export async function buildWebhookEventKey(rawBody: string, payload: unknown): Promise<string> {
  const commentId = findFirstCommentId(payload);
  const payloadHash = await sha256Hex(rawBody);
  if (commentId) {
    return `comment:${commentId}:${payloadHash}`;
  }

  const directMessageId = findFirstDirectMessageId(payload);
  if (directMessageId) {
    return `direct_message:${directMessageId}:${payloadHash}`;
  }

  return `payload:${payloadHash}`;
}

function normalizeCommentValue(
  value: UnknownRecord,
  entryTime: string | undefined,
  field: string,
): NormalizedComment | undefined {
  const id = readString(value.id) ?? readString(value.comment_id);
  const media = isRecord(value.media) ? value.media : undefined;
  const mediaId = readString(media?.id) ?? readString(value.media_id);
  const from = isRecord(value.from) ? value.from : undefined;
  const commenterId = readString(from?.id);

  if (!id || !mediaId) {
    return undefined;
  }

  return {
    id,
    mediaId,
    commentKind: field === "live_comments" ? "live" : "feed",
    commenterId,
    username: readString(from?.username),
    text: readString(value.text),
    createdAt: readString(value.timestamp) ?? entryTime,
    source: "webhook",
    raw: value,
  };
}

function normalizeDirectMessageValue(
  value: UnknownRecord,
  entryTime: string | undefined,
  connectedAccountId: string,
): NormalizedDirectMessage | undefined {
  const sender = isRecord(value.sender) ? value.sender : undefined;
  const recipient = isRecord(value.recipient) ? value.recipient : undefined;
  const message = isRecord(value.message) ? value.message : undefined;
  const id = readString(message?.mid);
  const senderId = readString(sender?.id);
  const recipientId = readString(recipient?.id);
  const text = readString(message?.text);

  if (
    !id ||
    !senderId ||
    !text ||
    message?.is_echo === true ||
    senderId === connectedAccountId ||
    (recipientId && recipientId !== connectedAccountId)
  ) {
    return undefined;
  }

  return {
    id,
    senderId,
    recipientId,
    text,
    createdAt: timestampMsToIso(value.timestamp) ?? entryTime,
    source: "webhook",
    raw: value,
  };
}

function entryBelongsToConnectedAccount(
  entry: UnknownRecord,
  connectedAccountId: string,
): boolean {
  const entryId = readString(entry.id);
  return !entryId || entryId === connectedAccountId;
}

function findFirstCommentId(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) {
    return undefined;
  }

  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) {
      continue;
    }

    for (const change of entry.changes) {
      if (!isRecord(change) || !isRecord(change.value)) {
        continue;
      }

      const id = readString(change.value.id) ?? readString(change.value.comment_id);
      if (id) {
        return id;
      }
    }
  }

  return undefined;
}

function findFirstDirectMessageId(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) {
    return undefined;
  }

  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.messaging)) {
      continue;
    }

    for (const messagingEvent of entry.messaging) {
      if (!isRecord(messagingEvent) || !isRecord(messagingEvent.message)) {
        continue;
      }

      const id = readString(messagingEvent.message.mid);
      if (id) {
        return id;
      }
    }
  }

  return undefined;
}

function timestampToIso(value: unknown): string | undefined {
  if (typeof value !== "number") {
    return undefined;
  }

  return new Date(value * 1000).toISOString();
}

function timestampMsToIso(value: unknown): string | undefined {
  if (typeof value !== "number") {
    return undefined;
  }

  return new Date(value).toISOString();
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
