import { Hono } from 'hono';
import { dedupeParsedProxies, parseProxyText, type ProxyCheckResult, type ProxyNode } from '@iptv/core';
import type { AppEnv } from '../env.js';
import { audit } from '../db.js';
import { fail, ok, readJson } from '../lib/http.js';
import { deleteProxyNode, getProxyNode, insertProxyNode, listProxyNodes, recordProxyCheck, updateProxyNode } from '../lib/proxyDb.js';
import { decryptProxyPassword, encryptProxyPassword } from '../lib/proxyCrypto.js';
import { createTask, dispatchNext } from '../lib/tasks.js';

export const proxyRoutes = new Hono<AppEnv>();

const SUPPORTED = new Set(['http', 'https', 'socks5', 'socks5h']);
const KERNEL = new Set(['vmess', 'vless', 'trojan', 'hysteria2', 'ss', 'anytls', 'tuic']);

function cleanText(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function protocolOf(value: unknown): string {
  const text = cleanText(value, 20).toLowerCase();
  return SUPPORTED.has(text) || KERNEL.has(text) ? text : '';
}

function validPort(value: unknown): number {
  const port = Number(value);
  return Number.isFinite(port) && port > 0 && port <= 65_535 ? Math.floor(port) : 0;
}

function validHost(value: unknown): string {
  const host = cleanText(value, 200);
  return /^[a-zA-Z0-9.\-_:[\]]+$/.test(host) ? host : '';
}

const SORTS = ['default', 'latency', 'success', 'recent', 'name'] as const;
type ProxySort = (typeof SORTS)[number];

function successRatio(node: ProxyNode): number {
  const total = node.successCount + node.failCount;
  return total > 0 ? node.successCount / total : -1;
}

function sortProxyNodes(items: ProxyNode[], sort: ProxySort, currentId: string | null): ProxyNode[] {
  if (sort === 'default') return items;
  const sorted = [...items].sort((a, b) => {
    if (a.kernelOnly !== b.kernelOnly) return a.kernelOnly ? 1 : -1;
    if (sort === 'latency') return (a.lastLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.lastLatencyMs ?? Number.MAX_SAFE_INTEGER);
    if (sort === 'success') return successRatio(b) - successRatio(a);
    if (sort === 'recent') return (b.lastCheckedAt ?? '').localeCompare(a.lastCheckedAt ?? '');
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  if (currentId) {
    const index = sorted.findIndex((node) => node.id === currentId);
    if (index > 0) sorted.unshift(sorted.splice(index, 1)[0]);
  }
  return sorted;
}

proxyRoutes.get('/', async (c) => {
  const loaded = await listProxyNodes(c.env);
  const currentId = loaded.find((node) => node.enabled && !node.kernelOnly)?.id ?? null;
  const rawSort = String(c.req.query('sort') ?? 'default');
  const sort = (SORTS as readonly string[]).includes(rawSort) ? (rawSort as ProxySort) : 'default';
  const items = sortProxyNodes(loaded, sort, currentId);
  if (c.req.query('secrets') !== '1') return ok({ items, currentId });
  // Runner-only view: the probe client needs the plaintext password to authenticate.
  const { results } = await c.env.DB.prepare('SELECT id, password_enc FROM proxy_nodes').all<{ id: string; password_enc: string }>();
  const secretById = new Map(results.map((row) => [row.id, row.password_enc]));
  const withSecrets = await Promise.all(
    items.map(async (node) => ({
      ...node,
      password: secretById.get(node.id) ? await decryptProxyPassword(c.env, secretById.get(node.id)!) : '',
    })),
  );
  return ok({ items: withSecrets, currentId });
});

proxyRoutes.post('/', async (c) => {
  const body = (await readJson<Record<string, unknown>>(c)) ?? {};
  const name = cleanText(body.name, 80) || '未命名代理';
  const protocol = protocolOf(body.protocol);
  if (!protocol) return fail('协议只支持 http/https/socks5/socks5h，或 vmess 等需内核协议');
  const host = protocol && KERNEL.has(protocol) ? cleanText(body.host, 200) : validHost(body.host);
  const port = validPort(body.port);
  if (!host || !port) return fail('请填写有效的服务器地址和端口');
  const password = cleanText(body.password, 200);
  const node = await insertProxyNode(c.env, {
    name,
    protocol,
    host,
    port,
    username: cleanText(body.username, 120),
    passwordEnc: password ? await encryptProxyPassword(c.env, password) : '',
    region: cleanText(body.region, 40),
    isp: cleanText(body.isp, 40),
    kernelOnly: KERNEL.has(protocol),
  });
  await audit(c.env, c.get('actor'), 'proxy.create', node.id, { protocol, host, port });
  return ok({ proxy: node });
});

async function fetchSubscription(url: string, userAgent = 'iptv-studio/1.0', extra: Record<string, string> = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { ...extra, 'user-agent': userAgent } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 2 * 1024 * 1024) throw new Error('订阅内容超过 2MB');
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timer);
  }
}

proxyRoutes.post('/import', async (c) => {
  const body = (await readJson<{ text?: string; url?: string; userAgent?: string; headers?: Record<string, string> }>(c)) ?? {};
  let text = typeof body.text === 'string' ? body.text : '';
  const userAgent = cleanText(body.userAgent, 300) || 'iptv-studio/1.0';
  const extraHeaders: Record<string, string> = {};
  if (body.headers && typeof body.headers === 'object') {
    for (const [name, value] of Object.entries(body.headers).slice(0, 20)) {
      const key = cleanText(name, 80);
      const headerValue = cleanText(value, 500);
      if (key && headerValue && /^[a-z0-9-]+$/i.test(key) && !/^(host|content-length|connection)$/i.test(key)) extraHeaders[key] = headerValue;
    }
  }
  if (!text.trim() && typeof body.url === 'string' && /^https?:\/\//i.test(body.url.trim())) {
    try {
      text = await fetchSubscription(body.url.trim(), userAgent, extraHeaders);
    } catch (error) {
      return fail(`拉取订阅失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!text.trim()) return fail('请粘贴节点内容或填写订阅地址');
  const parsed = parseProxyText(text);
  const nodes = dedupeParsedProxies(parsed.nodes);
  if (!nodes.length) return fail(parsed.warnings[0] ?? '没有识别到可用节点');
  const existing = new Set((await listProxyNodes(c.env)).map((node) => `${node.protocol}|${node.host.toLowerCase()}|${node.port}|${node.username}`));
  let added = 0;
  let skipped = 0;
  let kernelOnly = 0;
  for (const node of nodes) {
    const key = `${node.protocol}|${node.host.toLowerCase()}|${node.port}|${node.username}`;
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }
    if (!node.host || !node.port) {
      skipped += 1;
      continue;
    }
    const passwordEnc = node.password ? await encryptProxyPassword(c.env, node.password) : '';
    await insertProxyNode(c.env, {
      name: node.name || `${node.protocol}-${node.host}`,
      protocol: node.protocol,
      host: node.host,
      port: node.port,
      username: node.username,
      passwordEnc,
      kernelOnly: node.kernelOnly,
    });
    existing.add(key);
    added += 1;
    if (node.kernelOnly) kernelOnly += 1;
  }
  await audit(c.env, c.get('actor'), 'proxy.import', 'bulk', { added, skipped, kernelOnly });
  return ok({ added, skipped, kernelOnly, warnings: parsed.warnings.slice(0, 10) });
});

proxyRoutes.post('/check-all', async (c) => {
  const body = (await readJson<{ id?: string }>(c)) ?? {};
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (id && !(await getProxyNode(c.env, id))) return fail('代理不存在', 404);
  const task = await createTask(c.env, {
    type: 'proxy-test',
    source: 'manual',
    priority: 80,
    payload: id ? { proxy_id: id } : {},
    message: id ? '代理测活 · 单个' : '代理测活 · 全部',
  });
  await dispatchNext(c.env);
  await audit(c.env, c.get('actor'), 'proxy.check_all', task.id, { single: Boolean(id) });
  return ok({ taskId: task.id });
});

proxyRoutes.post('/:id/check', async (c) => {
  const id = c.req.param('id');
  if (!(await getProxyNode(c.env, id))) return fail('代理不存在', 404);
  const body = (await readJson<Partial<ProxyCheckResult>>(c)) ?? {};
  const result: ProxyCheckResult = {
    ok: Boolean(body.ok),
    latencyMs: Math.max(0, Math.floor(Number(body.latencyMs) || 0)),
    egressIp: cleanText(body.egressIp, 64),
    country: cleanText(body.country, 40),
    asn: cleanText(body.asn, 40),
    error: cleanText(body.error, 200),
  };
  await recordProxyCheck(c.env, id, result);
  return ok({ recorded: true });
});

proxyRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  if (!(await getProxyNode(c.env, id))) return fail('代理不存在', 404);
  const body = (await readJson<Record<string, unknown>>(c)) ?? {};
  const patch: Parameters<typeof updateProxyNode>[2] = {};
  if (body.name !== undefined) patch.name = cleanText(body.name, 80) || '未命名代理';
  if (body.protocol !== undefined) {
    const protocol = protocolOf(body.protocol);
    if (!protocol) return fail('协议不合法');
    patch.protocol = protocol as ProxyNode['protocol'];
    patch.kernelOnly = KERNEL.has(protocol);
  }
  if (body.host !== undefined) {
    const host = validHost(body.host);
    if (!host) return fail('服务器地址不合法');
    patch.host = host;
  }
  if (body.port !== undefined) {
    const port = validPort(body.port);
    if (!port) return fail('端口不合法');
    patch.port = port;
  }
  if (body.username !== undefined) patch.username = cleanText(body.username, 120);
  if (body.region !== undefined) patch.region = cleanText(body.region, 40);
  if (body.isp !== undefined) patch.isp = cleanText(body.isp, 40);
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
  if (body.password !== undefined) {
    const password = cleanText(body.password, 200);
    patch.passwordEnc = password ? await encryptProxyPassword(c.env, password) : '';
  }
  await updateProxyNode(c.env, id, patch);
  await audit(c.env, c.get('actor'), 'proxy.update', id, { changed: Object.keys(patch) });
  return ok({ proxy: await getProxyNode(c.env, id) });
});

proxyRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const node = await getProxyNode(c.env, id);
  if (!node) return fail('代理不存在', 404);
  await deleteProxyNode(c.env, id);
  await audit(c.env, c.get('actor'), 'proxy.delete', id, { name: node.name });
  return ok({ deleted: id });
});

proxyRoutes.post('/:id/move', async (c) => {
  const id = c.req.param('id');
  const body = (await readJson<{ direction?: string }>(c)) ?? {};
  const items: ProxyNode[] = await listProxyNodes(c.env);
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return fail('代理不存在', 404);
  const target = body.direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= items.length) return ok({ moved: false });
  const [item] = items.splice(index, 1);
  items.splice(target, 0, item!);
  for (const [position, node] of items.entries()) {
    await updateProxyNode(c.env, node.id, { sortScore: (items.length - position) * 10 });
  }
  await audit(c.env, c.get('actor'), 'proxy.move', id, { direction: body.direction ?? 'down' });
  return ok({ moved: true });
});
