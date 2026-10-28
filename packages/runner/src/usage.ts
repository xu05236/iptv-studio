interface DayUsage {
  date: string;
  kvWrites: number;
  d1Writes: number;
  githubMinutes: number;
}

interface UsageSnapshot {
  collectedAt: string;
  kv: { day: string; reads: number; writes: number; lists: number; deletes: number; storageBytes: number };
  d1: { day: string; rowsRead: number; rowsWritten: number };
  github: { month: string; minutes: number; runs: number };
  history: DayUsage[];
}

const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const d1Id = process.env.D1_ID ?? '';
const apiBase = process.env.API_BASE_URL ?? '';
const adminToken = process.env.ADMIN_TOKEN ?? '';
const githubToken = process.env.GITHUB_TOKEN ?? '';
const githubRepo = process.env.GITHUB_REPO ?? '';

async function graphql(query: string): Promise<Record<string, any>> {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const data = (await response.json()) as { data?: Record<string, any>; errors?: Array<{ message: string }> };
  if (!response.ok || data.errors?.length) throw new Error(data.errors?.map((error) => error.message).join('; ') ?? `GraphQL HTTP ${response.status}`);
  return data.data ?? {};
}

function utcDay(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function monthStart(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function lastSevenDays(): string[] {
  return Array.from({ length: 7 }, (_, index) => utcDay(-index)).reverse();
}

async function collectKv(days: string[]): Promise<{
  kv: UsageSnapshot['kv'];
  writesByDay: Map<string, number>;
}> {
  const since = days[0];
  const today = utcDay();
  const data = await graphql(`query {
    viewer { accounts(filter: {accountTag: "${account}"}) {
      kvOperationsAdaptiveGroups(limit: 500, filter: {date_geq: "${since}"}) {
        dimensions { date actionType }
        sum { requests }
      }
      kvStorageAdaptiveGroups(limit: 20, filter: {date_geq: "${since}"}) {
        dimensions { date }
        max { byteCount }
      }
    } }
  }`);
  const result = data.viewer?.accounts?.[0] ?? {};
  const ops: Array<{ dimensions: { date: string; actionType: string }; sum: { requests: number } }> = result.kvOperationsAdaptiveGroups ?? [];
  const storage: Array<{ dimensions: { date: string }; max: { byteCount: number } }> = result.kvStorageAdaptiveGroups ?? [];
  const writesByDay = new Map<string, number>();
  const todayTotals = { reads: 0, writes: 0, lists: 0, deletes: 0 };
  for (const item of ops) {
    const date = item.dimensions.date;
    const requests = item.sum.requests;
    if (item.dimensions.actionType === 'write') writesByDay.set(date, (writesByDay.get(date) ?? 0) + requests);
    if (date !== today) continue;
    if (item.dimensions.actionType === 'read') todayTotals.reads += requests;
    if (item.dimensions.actionType === 'write') todayTotals.writes += requests;
    if (item.dimensions.actionType === 'list') todayTotals.lists += requests;
    if (item.dimensions.actionType === 'delete') todayTotals.deletes += requests;
  }
  const latest = storage.filter((item) => item.dimensions.date === today).at(-1);
  return {
    kv: { day: today, ...todayTotals, storageBytes: latest?.max.byteCount ?? 0 },
    writesByDay,
  };
}

async function collectD1(days: string[]): Promise<{
  d1: UsageSnapshot['d1'];
  writesByDay: Map<string, number>;
}> {
  const since = days[0];
  const today = utcDay();
  const data = await graphql(`query {
    viewer { accounts(filter: {accountTag: "${account}"}) {
      d1AnalyticsAdaptiveGroups(limit: 500, filter: {date_geq: "${since}"}) {
        dimensions { date databaseId }
        sum { rowsRead rowsWritten }
      }
    } }
  }`);
  const items: Array<{ dimensions: { date: string; databaseId: string }; sum: { rowsRead: number; rowsWritten: number } }> =
    data.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
  const writesByDay = new Map<string, number>();
  const totals = { rowsRead: 0, rowsWritten: 0 };
  for (const item of items) {
    if (d1Id && item.dimensions.databaseId !== d1Id) continue;
    const date = item.dimensions.date;
    writesByDay.set(date, (writesByDay.get(date) ?? 0) + item.sum.rowsWritten);
    if (date !== today) continue;
    totals.rowsRead += item.sum.rowsRead;
    totals.rowsWritten += item.sum.rowsWritten;
  }
  return { d1: { day: today, ...totals }, writesByDay };
}

async function collectGithub(): Promise<{
  github: UsageSnapshot['github'];
  minutesByDay: Map<string, number>;
}> {
  const minutesByDay = new Map<string, number>();
  if (!githubToken || !githubRepo) return { github: { month: monthStart(), minutes: 0, runs: 0 }, minutesByDay };
  let minutes = 0;
  let runs = 0;
  for (let page = 1; page <= 5; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${githubRepo}/actions/runs?per_page=100&page=${page}&created=${encodeURIComponent(`>=${monthStart()}`)}`,
      { headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'iptv-studio-usage' } },
    );
    if (!response.ok) break;
    const data = (await response.json()) as { workflow_runs: Array<{ run_duration_ms?: number; created_at: string; updated_at: string }> };
    for (const run of data.workflow_runs) {
      const ms = run.run_duration_ms ?? Math.max(0, new Date(run.updated_at).getTime() - new Date(run.created_at).getTime());
      const day = run.created_at.slice(0, 10);
      minutes += ms / 60_000;
      minutesByDay.set(day, (minutesByDay.get(day) ?? 0) + ms / 60_000);
      runs++;
    }
    if (data.workflow_runs.length < 100) break;
  }
  return { github: { month: monthStart(), minutes: Math.ceil(minutes), runs }, minutesByDay };
}

async function main(): Promise<void> {
  if (!token || !account) throw new Error('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 未配置');
  if (!apiBase || !adminToken) throw new Error('API_BASE_URL / ADMIN_TOKEN 未配置');

  const days = lastSevenDays();
  const [kvResult, d1Result, githubResult] = await Promise.all([collectKv(days), collectD1(days), collectGithub()]);
  const history: DayUsage[] = days.map((date) => ({
    date,
    kvWrites: kvResult.writesByDay.get(date) ?? 0,
    d1Writes: d1Result.writesByDay.get(date) ?? 0,
    githubMinutes: Math.ceil(githubResult.minutesByDay.get(date) ?? 0),
  }));

  const snapshot: UsageSnapshot = {
    collectedAt: new Date().toISOString(),
    kv: kvResult.kv,
    d1: d1Result.d1,
    github: githubResult.github,
    history,
  };
  const response = await fetch(`${apiBase}/api/admin/usage`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(snapshot),
  });
  if (!response.ok) throw new Error(`用量上报失败 HTTP ${response.status}: ${await response.text()}`);
  console.log(JSON.stringify(snapshot));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
