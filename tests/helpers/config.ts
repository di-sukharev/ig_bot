import { getConfig, type AppConfig } from "../../src/env";
import type { WorkerEnv } from "../../src/types";

export function defaultWorkerEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    DB: {} as D1Database,
    ADMIN_API_KEY: "admin",
    META_APP_SECRET: "secret",
    META_WEBHOOK_VERIFY_TOKEN: "verify",
    META_GRAPH_API_VERSION: "v25.0",
    INSTAGRAM_ACCOUNT_ID: "ig_account",
    INSTAGRAM_ACCESS_TOKEN: "token",
    ...overrides,
  };
}

export function defaultAppConfig(overrides: Partial<WorkerEnv> = {}): AppConfig {
  return getConfig(defaultWorkerEnv(overrides));
}
