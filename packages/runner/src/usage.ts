interface UsageSnapshot {
  collectedAt: string;
  kv: { day: string; reads: number; writes: number; lists: number; deletes: number; storageBytes: number };
  d1: { day: string; rowsRead: number; rowsWritten: number };
  github: { month: string; minutes: number; runs: number };
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

function day(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthStart(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

async function collectKv(): Promise<UsageSnapshot['kv']> {
  const today = day();
  const data = await graphql(`query {
    viewer { accounts(filter: {accountTag: "${account}"}) {
      kvOperationsAdaptiveGroups(limit: 200, filter: {date_geq: "${today}"}) {
        dimensions { date actionType }
        sum { requests }
      }
      kvStorageAdaptiveGroups(limit: 5, filter: {date_geq: "${today}"}) {
        dimensions { date }
        max { byteCount }
      }
    } }
  }`);
  const result = data.viewer?.accounts?.[0] ?? {};
  const ops: Array<{ dimensions: { date: string; actionType: string }; sum: { requests: number } }> = result.kvOperationsAdaptiveGroups ?? [];
  const storage: Array<{ dimensions: { date: string }; max: { byteCount: number } }> = result.kvStorageAdaptiveGroups ?? [];
  const totals = { reads: 0, writes: 0, lists: 0, deletes: 0 };
  for (const item of ops) {
    if (item.dimensions.date !== today) continue;
    if (item.dimensions.actionType === 'read') totals.reads += item.sum.requests;
    if (item.dimensions.actionType === 'write') totals.writes += item.sum.requests;
    if (item.dimensions.actionType === 'list') totals.lists += item.sum.requests;
    if (item.dimensions.actionType === 'delete') totals.deletes += item.sum.requests;
  }
  const latest = storage.filter((item) => item.dimensions.date === today).sort((a, b) => a.dimensions.date.localeCompare(b.dimensions.date)).at(-1);
  return { day: today, ...totals, storageBytes: latest?.max.byteCount ?? 0 };
}

async function collectD1(): Promise<UsageSnapshot['d1']> {
  const today = day();
  const data = await graphql(`query {
    viewer { accounts(filter: {accountTag: "${account}"}) {
      d1AnalyticsAdaptiveGroups(limit: 200, filter: {date_geq: "${today}"}) {
        dimensions { date databaseId }
        sum { rowsRead rowsWritten }
      }
    } }
  }`);
  const items: Array<{ dimensions: { date: string; databaseId: string }; sum: { rowsRead: number; rowsWritten: number } }> =
    data.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
  let rowsRead = 0;
  let rowsWritten = 0;
  for (const item of items) {
    if (item.dimensions.date !== today) continue;
    if (d1Id && item.dimensions.databaseId !== d1Id) continue;
    rowsRead += item.sum.rowsRead;
    rowsWritten += item.sum.rowsWritten;
  }
  return { day: today, rowsRead, rowsWritten };
}

async function collectGithub(): Promise<UsageSnapshot['github']> {
  if (!githubToken || !githubRepo) return { month: monthStart(), minutes: 0, runs: 0 };
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
      minutes += ms / 60_000;
      runs++;
    }
    if (data.workflow_runs.length < 100) break;
  }
  return { month: monthStart(), minutes: Math.ceil(minutes), runs };
}

async function main(): Promise<void> {
  if (!token || !account) throw new Error('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 未配置');
  if (!apiBase || !adminToken) throw new Error('API_BASE_URL / ADMIN_TOKEN 未配置');
  const snapshot: UsageSnapshot = {
    collectedAt: new Date().toISOString(),
    kv: await collectKv(),
    d1: await collectD1(),
    github: await collectGithub(),
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
