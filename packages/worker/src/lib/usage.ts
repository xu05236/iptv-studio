import type { Env } from '../env.js';
import { getRuntimeJson, putRuntimeJson } from './runtime-state.js';

const DAY = 86_400_000;
const KEY = 'state/usage.json';

interface DayUsage {
  date: string;
  kvWrites: number;
  d1Writes: number;
  githubMinutes: number;
}

export interface UsageSnapshot {
  collectedAt: string;
  kv: { day: string; reads: number; writes: number; lists: number; deletes: number; storageBytes: number };
  d1: { day: string; rowsRead: number; rowsWritten: number };
  github: { month: string; minutes: number; runs: number; private?: boolean };
  history: DayUsage[];
}

interface GithubRun {
  run_duration_ms?: number;
  run_started_at?: string;
  status?: string;
  created_at: string;
  updated_at: string;
}

const utcDay = (offset = 0): string => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

const monthStart = (): string => {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

/** Pure aggregation so it can be unit tested without the GitHub API. */
export function aggregateGithubRuns(
  runs: GithubRun[],
  month: string,
): { minutes: number; runs: number; byDay: Map<string, number> } {
  // A single job never runs for hours; anything longer is queue/cancel time or
  // an `updated_at` touched by log cleanup, and must not inflate the estimate.
  const MAX_RUN_MS = 60 * 60_000;
  let minutes = 0;
  let count = 0;
  const byDay = new Map<string, number>();
  for (const run of runs) {
    const day = run.created_at.slice(0, 10);
    // The created filter is best-effort; never count a previous month.
    if (day < month) continue;
    if (run.status === 'queued') {
      count += 1;
      continue;
    }
    const started = Date.parse(run.run_started_at ?? run.created_at);
    const ended = Date.parse(run.updated_at);
    const raw = run.run_duration_ms ?? Math.max(0, ended - started);
    const ms = Number.isFinite(raw) ? Math.min(Math.max(0, raw), MAX_RUN_MS) : 0;
    minutes += ms / 60_000;
    byDay.set(day, (byDay.get(day) ?? 0) + ms / 60_000);
    count += 1;
  }
  return { minutes, runs: count, byDay };
}

async function collectGithub(env: Env): Promise<{ month: string; minutes: number; runs: number; private?: boolean; byDay: Map<string, number> }> {
  const month = monthStart();
  const byDay = new Map<string, number>();
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPO;
  if (!token || !repo) return { month, minutes: 0, runs: 0, byDay };
  // Public repositories get unmetered standard runners, so the UI and the
  // quota guard need to know the visibility alongside the minutes.
  let isPrivate: boolean | undefined;
  try {
    const metaResponse = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'iptv-studio-worker',
      },
    });
    if (metaResponse.ok) {
      const meta = (await metaResponse.json()) as { private?: boolean };
      if (typeof meta.private === 'boolean') isPrivate = meta.private;
    }
  } catch {
    // Keep the private default (2,000 min budget) when visibility is unknown.
  }
  let minutes = 0;
  let runs = 0;
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs?per_page=100&page=${page}&created=${encodeURIComponent(`>=${month}`)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'iptv-studio-worker',
        },
      },
    );
    if (!response.ok) break;
    const data = (await response.json()) as { workflow_runs?: GithubRun[] };
    const pageRuns = data.workflow_runs ?? [];
    const agg = aggregateGithubRuns(pageRuns, month);
    minutes += agg.minutes;
    runs += agg.runs;
    for (const [day, value] of agg.byDay) byDay.set(day, (byDay.get(day) ?? 0) + value);
    if (pageRuns.length < 100) break;
  }
  return { month, minutes: Math.ceil(minutes), runs, private: isPrivate, byDay };
}

async function graphql(token: string, query: string): Promise<Record<string, unknown>> {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const data = (await response.json()) as { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
  if (!response.ok || data.errors?.length) throw new Error(`GraphQL HTTP ${response.status}`);
  return data.data ?? {};
}

interface CloudflareUsage {
  kv: UsageSnapshot['kv'];
  d1: UsageSnapshot['d1'];
  kvWritesByDay: Map<string, number>;
  d1WritesByDay: Map<string, number>;
}

async function collectCloudflare(env: Env, days: string[]): Promise<CloudflareUsage | null> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) return null;
  const since = days[0];
  const today = utcDay();
  const data = await graphql(
    token,
    `query {
      viewer { accounts(filter: {accountTag: "${accountId}"}) {
        kvOperationsAdaptiveGroups(limit: 500, filter: {date_geq: "${since}"}) {
          dimensions { date actionType }
          sum { requests }
        }
        kvStorageAdaptiveGroups(limit: 20, filter: {date_geq: "${since}"}) {
          dimensions { date }
          max { byteCount }
        }
        d1AnalyticsAdaptiveGroups(limit: 500, filter: {date_geq: "${since}"}) {
          dimensions { date databaseId }
          sum { rowsRead rowsWritten }
        }
      } }
    }`,
  );
  const account = ((data.viewer as { accounts?: Array<Record<string, unknown>> } | undefined)?.accounts?.[0] ?? {}) as Record<string, unknown>;
  const ops = (account.kvOperationsAdaptiveGroups as Array<{ dimensions: { date: string; actionType: string }; sum: { requests: number } }> | undefined) ?? [];
  const storage = (account.kvStorageAdaptiveGroups as Array<{ dimensions: { date: string }; max: { byteCount: number } }> | undefined) ?? [];
  const d1Rows = (account.d1AnalyticsAdaptiveGroups as Array<{ dimensions: { date: string; databaseId: string }; sum: { rowsRead: number; rowsWritten: number } }> | undefined) ?? [];

  const kvWritesByDay = new Map<string, number>();
  const kv = { day: today, reads: 0, writes: 0, lists: 0, deletes: 0, storageBytes: 0 };
  for (const item of ops) {
    const date = item.dimensions.date;
    const requests = item.sum.requests;
    if (item.dimensions.actionType === 'write') kvWritesByDay.set(date, (kvWritesByDay.get(date) ?? 0) + requests);
    if (date !== today) continue;
    if (item.dimensions.actionType === 'read') kv.reads += requests;
    if (item.dimensions.actionType === 'write') kv.writes += requests;
    if (item.dimensions.actionType === 'list') kv.lists += requests;
    if (item.dimensions.actionType === 'delete') kv.deletes += requests;
  }
  const latestStorage = storage.filter((item) => item.dimensions.date === today).at(-1);
  kv.storageBytes = latestStorage?.max.byteCount ?? 0;

  const d1WritesByDay = new Map<string, number>();
  const d1 = { day: today, rowsRead: 0, rowsWritten: 0 };
  for (const item of d1Rows) {
    if (env.D1_ID && item.dimensions.databaseId !== env.D1_ID) continue;
    const date = item.dimensions.date;
    d1WritesByDay.set(date, (d1WritesByDay.get(date) ?? 0) + item.sum.rowsWritten);
    if (date !== today) continue;
    d1.rowsRead += item.sum.rowsRead;
    d1.rowsWritten += item.sum.rowsWritten;
  }
  return { kv, d1, kvWritesByDay, d1WritesByDay };
}

/**
 * Refresh the usage snapshot inside the Worker (no GitHub Actions).
 * GitHub minutes come from the Actions API; KV/D1 come from Cloudflare
 * Analytics when a read-only CLOUDFLARE_API_TOKEN secret is configured.
 * Without that token those two fields keep their previous values.
 */
export async function refreshUsage(env: Env): Promise<UsageSnapshot> {
  const previous = await getRuntimeJson<UsageSnapshot>(env, KEY);
  const github = await collectGithub(env);
  const days = Array.from({ length: 7 }, (_, index) => utcDay(-index)).reverse();
  let cloudflare: CloudflareUsage | null = null;
  try {
    cloudflare = await collectCloudflare(env, days);
  } catch {
    cloudflare = null;
  }

  const history = days.map((date) => {
    const prior = previous?.history?.find((item) => item.date === date);
    return {
      date,
      kvWrites: cloudflare?.kvWritesByDay.get(date) ?? prior?.kvWrites ?? 0,
      d1Writes: cloudflare?.d1WritesByDay.get(date) ?? prior?.d1Writes ?? 0,
      githubMinutes: Math.ceil(github.byDay.get(date) ?? prior?.githubMinutes ?? 0),
    };
  });

  const snapshot: UsageSnapshot = {
    collectedAt: new Date().toISOString(),
    kv: cloudflare?.kv ?? previous?.kv ?? { day: utcDay(), reads: 0, writes: 0, lists: 0, deletes: 0, storageBytes: 0 },
    d1: cloudflare?.d1 ?? previous?.d1 ?? { day: utcDay(), rowsRead: 0, rowsWritten: 0 },
    github: { month: github.month, minutes: github.minutes, runs: github.runs, private: github.private },
    history,
  };
  await putRuntimeJson(env, KEY, snapshot);
  return snapshot;
}
