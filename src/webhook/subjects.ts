type UnknownRecord = Record<string, unknown>;

export type WebhookEventSubjectType = "comment" | "commenter" | "username" | "direct_message";

export interface WebhookEventSubject {
  subjectType: WebhookEventSubjectType;
  subjectValue: string;
  normalizedValue: string;
  createdAt: string;
}

export function extractWebhookEventSubjects(
  rawPayload: string,
  createdAt: string,
): WebhookEventSubject[] {
  let payload: unknown;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    return [];
  }

  const values = extractWebhookCommentValues(payload);
  const directMessageValues = extractWebhookDirectMessageValues(payload);
  const subjects = new Map<string, WebhookEventSubject>();

  for (const value of values) {
    addWebhookSubject(
      subjects,
      "comment",
      readString(value.id) ?? readString(value.comment_id),
      createdAt,
    );
    const from = isRecord(value.from) ? value.from : undefined;
    addWebhookSubject(subjects, "commenter", readString(from?.id), createdAt);
    addWebhookSubject(subjects, "username", readString(from?.username), createdAt);
  }

  for (const value of directMessageValues) {
    const message = isRecord(value.message) ? value.message : undefined;
    const sender = isRecord(value.sender) ? value.sender : undefined;
    addWebhookSubject(subjects, "direct_message", readString(message?.mid), createdAt);
    addWebhookSubject(subjects, "commenter", readString(sender?.id), createdAt);
  }

  return [...subjects.values()];
}

function extractWebhookCommentValues(payload: unknown): UnknownRecord[] {
  if (!isRecord(payload)) {
    return [];
  }

  if (isRecord(payload.value)) {
    return [payload.value];
  }

  if (!Array.isArray(payload.entry)) {
    return [];
  }

  const values: UnknownRecord[] = [];
  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) {
      continue;
    }

    for (const change of entry.changes) {
      if (!isRecord(change) || !isRecord(change.value)) {
        continue;
      }

      const field = readString(change.field);
      if (field === "comments" || field === "live_comments") {
        values.push(change.value);
      }
    }
  }

  return values;
}

function extractWebhookDirectMessageValues(payload: unknown): UnknownRecord[] {
  if (!isRecord(payload)) {
    return [];
  }

  if (!Array.isArray(payload.entry)) {
    return [];
  }

  const values: UnknownRecord[] = [];
  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.messaging)) {
      continue;
    }

    for (const messagingEvent of entry.messaging) {
      if (isRecord(messagingEvent)) {
        values.push(messagingEvent);
      }
    }
  }

  return values;
}

function addWebhookSubject(
  subjects: Map<string, WebhookEventSubject>,
  subjectType: WebhookEventSubjectType,
  subjectValue: string | undefined,
  createdAt: string,
): void {
  if (!subjectValue) {
    return;
  }

  const normalizedValue = normalizeSubjectValue(subjectValue);
  subjects.set(`${subjectType}:${normalizedValue}`, {
    subjectType,
    subjectValue,
    normalizedValue,
    createdAt,
  });
}

function normalizeSubjectValue(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
