const base = (process.env.SMOKE_BASE ?? 'https://iptv.xu05236.dpdns.org').replace(/\/$/, '');
const checks = [
  ['health', '/api/health'],
  ['version', '/api/version'],
  ['home', '/'],
];

let failed = 0;
for (const [name, path] of checks) {
  const url = base + path;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    console.log(`${response.ok ? 'ok  ' : 'FAIL'} ${name} ${response.status} ${url}`);
    if (!response.ok) failed++;
    if (name === 'version') {
      const body = await response.json().catch(() => null);
      console.log(`     commit=${body?.shortCommit ?? '?'} deployedAt=${body?.deployedAt ?? '?'}`);
    }
  } catch (error) {
    console.log(`FAIL ${name} ${String(error).slice(0, 120)}`);
    failed++;
  }
}

if (failed) {
  console.error(`smoke failed: ${failed} check(s)`);
  process.exit(1);
}
console.log('smoke ok');
