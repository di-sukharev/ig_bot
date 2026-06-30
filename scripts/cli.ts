export interface CliOptions {
  mediaId?: string;
  send: boolean;
  afterCursor?: string;
  maxPages?: number;
  baseUrl: string;
  adminApiKey: string;
}

export function parseCliOptions(args: string[] = Bun.argv.slice(2)): CliOptions {
  let mediaId: string | undefined;
  let baseUrl = process.env.ADMIN_BASE_URL || process.env.PUBLIC_BASE_URL || "http://127.0.0.1:8787";
  const adminApiKey = process.env.ADMIN_API_KEY ?? "";
  let send = false;
  let afterCursor: string | undefined;
  let maxPages: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--media") {
      mediaId = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--send") {
      send = true;
      continue;
    }

    if (arg === "--url") {
      baseUrl = args[index + 1] ?? baseUrl;
      index += 1;
      continue;
    }

    if (arg === "--after") {
      afterCursor = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--max-pages") {
      const value = Number.parseInt(args[index + 1] ?? "", 10);
      maxPages = Number.isFinite(value) && value > 0 ? value : undefined;
      index += 1;
    }
  }

  return {
    mediaId,
    send,
    afterCursor,
    maxPages,
    baseUrl: baseUrl.replace(/\/$/, ""),
    adminApiKey,
  };
}

export function requireAdminApiKey(adminApiKey: string): void {
  if (!adminApiKey) {
    throw new Error("ADMIN_API_KEY is required");
  }
}
