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
  COMMIT_SHA?: string;
  DEPLOYED_AT?: string;
  GITHUB_TOKEN?: string;
  GITHUB_WORKFLOW?: string;
  GITHUB_REF?: string;

  /** Optional read-only analytics token; enables KV/D1 numbers in the usage snapshot. */
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  D1_ID?: string;

  /** AES-GCM key (base64, 32 bytes) used to encrypt domestic proxy passwords. */
  PROXY_KEY?: string;

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
