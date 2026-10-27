export interface Env {
  DB: D1Database;
  /** artifacts + rate-limit counters (no R2 required) */
  KV: KVNamespace;
  ASSETS: Fetcher;

  ENVIRONMENT?: string;
  /** service token; also the only credential accepted at /api/admin/login */
  ADMIN_TOKEN?: string;
  SESSION_SECRET?: string;
  PUBLIC_BASE_URL?: string;

  GITHUB_REPO?: string;
  GITHUB_TOKEN?: string;
  GITHUB_WORKFLOW?: string;
  GITHUB_REF?: string;

  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export interface Variables {
  actor: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: Variables;
};
