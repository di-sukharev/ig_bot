import type { AppConfig } from "../env";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MetaComment {
  id: string;
  text?: string;
  timestamp?: string;
  from?: {
    id?: string;
    username?: string;
  };
}

export interface MetaCommentsPage {
  data: MetaComment[];
  paging?: {
    cursors?: {
      after?: string;
      before?: string;
    };
    next?: string;
  };
}

export interface MetaMedia {
  id: string;
  timestamp?: string;
  media_type?: string;
}

export interface MetaMediaPage {
  data?: MetaMedia[];
  paging?: {
    cursors?: {
      after?: string;
      before?: string;
    };
    next?: string;
  };
}

export interface PrivateReplyResponse {
  recipient_id?: string;
  message_id?: string;
}

export interface PublicReplyResponse {
  id?: string;
}

export class MetaApiError extends Error {
  readonly httpStatus: number;
  readonly metaCode?: number;
  readonly metaSubcode?: number;
  readonly fbtraceId?: string;
  readonly requestId?: string;
  readonly responseSummary: string;
  readonly retryable: boolean;

  constructor(input: {
    message: string;
    httpStatus: number;
    metaCode?: number;
    metaSubcode?: number;
    fbtraceId?: string;
    requestId?: string;
    responseSummary: string;
    retryable: boolean;
  }) {
    super(input.message);
    this.name = "MetaApiError";
    this.httpStatus = input.httpStatus;
    this.metaCode = input.metaCode;
    this.metaSubcode = input.metaSubcode;
    this.fbtraceId = input.fbtraceId;
    this.requestId = input.requestId;
    this.responseSummary = input.responseSummary;
    this.retryable = input.retryable;
  }
}

export class MetaGraphClient {
  private readonly config: AppConfig;
  private readonly fetchFn: FetchLike;

  constructor(config: AppConfig, fetchFn: FetchLike = (input, init) => fetch(input, init)) {
    this.config = config;
    this.fetchFn = fetchFn;
  }

  async sendPrivateReply(commentId: string, text: string): Promise<PrivateReplyResponse> {
    const response = await this.request<PrivateReplyResponse>(
      `/${this.config.instagramAccountId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { comment_id: commentId },
          message: { text },
        }),
      },
    );

    return response;
  }

  async sendDirectMessage(recipientId: string, text: string): Promise<PrivateReplyResponse> {
    return this.request<PrivateReplyResponse>(
      `/${this.config.instagramAccountId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text },
        }),
      },
    );
  }

  async getComments(mediaId: string, after?: string): Promise<MetaCommentsPage> {
    const searchParams = new URLSearchParams({
      fields: "id,text,timestamp,from",
      limit: "100",
    });

    if (after) {
      searchParams.set("after", after);
    }

    return this.request<MetaCommentsPage>(`/${mediaId}/comments?${searchParams.toString()}`);
  }

  async getMedia(after?: string): Promise<MetaMediaPage> {
    const searchParams = new URLSearchParams({
      fields: "id,timestamp,media_type",
      limit: "100",
    });

    if (after) {
      searchParams.set("after", after);
    }

    return this.request<MetaMediaPage>(
      `/${this.config.instagramAccountId}/media?${searchParams.toString()}`,
    );
  }

  async sendPublicReply(commentId: string, text: string): Promise<PublicReplyResponse> {
    return this.request<PublicReplyResponse>(`/${commentId}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
  }

  async hasConversationWithUser(userId: string): Promise<boolean> {
    const searchParams = new URLSearchParams({ user_id: userId });
    const response = await this.request<{ data?: unknown[] }>(
      `/${this.config.instagramAccountId}/conversations?${searchParams.toString()}`,
    );

    return Array.isArray(response.data) && response.data.length > 0;
  }

  async tokenHealth(): Promise<{ id: string; username?: string }> {
    return this.request<{ id: string; username?: string }>(
      `/${this.config.instagramAccountId}?fields=id,username`,
    );
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(
      `${this.config.metaGraphApiBaseUrl}/${this.config.metaGraphApiVersion}${path}`,
    );

    const headers = new Headers(init.headers as ConstructorParameters<typeof Headers>[0]);
    headers.set("Authorization", `Bearer ${this.config.instagramAccessToken}`);

    const response = await this.fetchFn(url.toString(), {
      ...init,
      headers,
    });
    const text = await response.text();

    if (!response.ok) {
      throw buildMetaApiError(response, text);
    }

    if (!text) {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }
}

function buildMetaApiError(response: Response, bodyText: string): MetaApiError {
  const parsed = parseBody(bodyText);
  const parsedRecord = isRecord(parsed) ? parsed : {};
  const error = isRecord(parsedRecord.error) ? parsedRecord.error : undefined;
  const message = readString(error?.message) ?? `Meta API request failed with ${response.status}`;
  const code = readNumber(error?.code);
  const subcode = readNumber(error?.error_subcode);
  const fbtraceId =
    readString(error?.fbtrace_id) ?? response.headers.get("x-fb-trace-id") ?? undefined;
  const requestId = response.headers.get("x-fb-request-id") ?? undefined;

  return new MetaApiError({
    message,
    httpStatus: response.status,
    metaCode: code,
    metaSubcode: subcode,
    fbtraceId,
    requestId,
    responseSummary: summarizeBody(bodyText),
    retryable: isRetryable(response.status, code),
  });
}

function isRetryable(status: number, code: number | undefined): boolean {
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return true;
  }

  return code !== undefined && [1, 2, 4, 17, 32, 613].includes(code);
}

function summarizeBody(value: string): string {
  return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
}

function parseBody(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
