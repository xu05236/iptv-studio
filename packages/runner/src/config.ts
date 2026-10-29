/** Runner configuration from environment variables (GitHub Actions secrets). */

export interface RunnerConfig {
  apiBaseUrl: string;
  adminToken: string;
  publicBaseUrl: string;
  telegram?: { botToken: string; chatId: string };
  probeBudget: number;
  concurrency: number;
  dryRun: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

export function loadConfig(): RunnerConfig {
  const apiBaseUrl = required('API_BASE_URL').replace(/\/+$/, '');
  const configuredPublicBase = process.env.PUBLIC_BASE_URL?.trim();
  return {
    apiBaseUrl,
    adminToken: required('ADMIN_TOKEN'),
    publicBaseUrl: (configuredPublicBase || apiBaseUrl).replace(/\/+$/, ''),
    telegram: process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
      ? { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID }
      : undefined,
    probeBudget: Number(process.env.PROBE_BUDGET ?? '0') || 0,
    concurrency: Number(process.env.PROBE_CONCURRENCY ?? '0') || 48,
    dryRun: process.argv.includes('--dry-run'),
  };
}
