import { Hono } from 'hono';
import { dedupeParsedProxies, parseProxyText, type ProxyCheckResult, type ProxyNode } from '@iptv/core';
import type { AppEnv } from '../env.js';
import { audit } from '../db.js';
import { fail, ok, readJson } from '../lib/http.js';
import { deleteProxyNode, disableMissingSubscriptionNodes, finishProxySubscription, getProxyNode, getProxySubscription, insertProxyNode, insertProxySubscription, listProxyNodes, listProxySubscriptions, proxyNodeKey, recordProxyCheck, updateProxyNode, updateProxySubscription, deleteProxySubscription } from '../lib/proxyDb.js';
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
  // Runner-only view: the probe client needs the plaintext password/config to
  // authenticate, and kernel-only nodes need their original config to start the engine.
  const { results } = await c.env.DB.prepare('SELECT id, password_enc, config_enc FROM proxy_nodes').all<{ id: string; password_enc: string; config_enc: string }>();
  const secretById = new Map(results.map((row) => [row.id, row]));
  const withSecrets = await Promise.all(
    items.map(async (node) => {
      const secrets = secretById.get(node.id);
      return {
        ...node,
        password: secrets?.password_enc ? await decryptProxyPassword(c.env, secrets.password_enc) : '',
        config: secrets?.config_enc ? await decryptProxyPassword(c.env, secrets.config_enc) : '',
      };
    }),
  );
  return ok({ items: withSecrets, currentId });
});

proxyRoutes.post('/', async (c) => {
  const body = (await readJson<Record<string, unknown>>(c)) ?? {};
  const name = cleanText(body.name, 80) || '未命名代理';
  const protocol = protocolOf(body.protocol);
  if (!protocol) return fail('协议只支持 http/https/socks5/socks5h，或 vmess 等需内核协议');
  let host = protocol && KERNEL.has(protocol) ? cleanText(body.host, 200) : validHost(body.host);
  let port = validPort(body.port);
  let username = cleanText(body.username, 120);
  let password = cleanText(body.password, 200);
  const config = cleanText(body.config, 65_536);
  if (KERNEL.has(protocol) && config && (!host || !port)) {
    const parsed = parseProxyText(config).nodes[0];
    if (parsed) {
      host = parsed.host;
      port = parsed.port;
      username = username || parsed.username || '';
      password = password || parsed.password || '';
    }
  }
  if (!host || !port) return fail('请填写有效的服务器地址和端口，或粘贴可用配置');
  const node = await insertProxyNode(c.env, {
    name,
    protocol,
    host,
    port,
    username,
    passwordEnc: password ? await encryptProxyPassword(c.env, password) : '',
    region: cleanText(body.region, 40),
    isp: cleanText(body.isp, 40),
    kernelOnly: KERNEL.has(protocol),
    engine: KERNEL.has(protocol) ? (cleanText(body.engine, 20) || 'mihomo') : '',
    configEnc: config ? await encryptProxyPassword(c.env, config) : '',
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
  const body = (await readJson<{ text?: string; url?: string; userAgent?: string; headers?: Record<string, string>; subscriptionId?: string }>(c)) ?? {};
  let text = typeof body.text === 'string' ? body.text : '';
  const subscriptionId = cleanText(body.subscriptionId, 40);
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
  const parsedTotal = parsed.nodes.length;
  const deduped = parsedTotal - nodes.length;
  if (!nodes.length) return fail(parsed.warnings[0] ?? '没有识别到可用节点');
  const existingNodes = await listProxyNodes(c.env);
  const existing = new Map(existingNodes.map((node) => [proxyNodeKey(node), node]));
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let kernelOnly = 0;
  const keepKeys: string[] = [];
  for (const node of nodes) {
    if (!node.host || !node.port) {
      skipped += 1;
      continue;
    }
    const key = proxyNodeKey(node);
    keepKeys.push(key);
    const passwordEnc = node.password ? await encryptProxyPassword(c.env, node.password) : '';
    const configEnc = node.config ? await encryptProxyPassword(c.env, node.config) : '';
    const previous = existing.get(key);
    if (previous) {
      skipped += 1;
      if (subscriptionId) {
        // A refresh must pick up rotated passwords/configs and re-enable nodes
        // the provider brought back, so update instead of leaving stale copies.
        await updateProxyNode(c.env, previous.id, {
          name: node.name || previous.name,
          enabled: true,
          kernelOnly: node.kernelOnly,
          engine: node.kernelOnly ? 'mihomo' : '',
          subscriptionId,
          ...(passwordEnc ? { passwordEnc } : {}),
          ...(configEnc ? { configEnc } : {}),
        });
        updated += 1;
      }
      continue;
    }
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }
    await insertProxyNode(c.env, {
      name: node.name || `${node.protocol}-${node.host}`,
      protocol: node.protocol,
      host: node.host,
      port: node.port,
      username: node.username,
      passwordEnc,
      kernelOnly: node.kernelOnly,
      engine: node.kernelOnly ? 'mihomo' : '',
      configEnc,
      subscriptionId: subscriptionId || undefined,
    });
    existing.set(key, { id: key } as never);
    added += 1;
    if (node.kernelOnly) kernelOnly += 1;
  }
  let disabled = 0;
  if (subscriptionId) {
    disabled = await disableMissingSubscriptionNodes(c.env, subscriptionId, keepKeys);
    await finishProxySubscription(
      c.env,
      subscriptionId,
      keepKeys.length,
      `新增 ${added} · 更新 ${updated} · 停用 ${disabled}`,
    );
  }
  await audit(c.env, c.get('actor'), 'proxy.import', subscriptionId || 'bulk', { added, updated, skipped, kernelOnly, disabled, parsedTotal, deduped });
  return ok({ added, updated, skipped, kernelOnly, disabled, parsedTotal, deduped, warnings: parsed.warnings.slice(0, 10) });
});

proxyRoutes.get('/subscriptions', async (c) => ok({ items: await listProxySubscriptions(c.env) }));

function headersOf(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [name, raw] of Object.entries(value).slice(0, 20)) {
      const key = cleanText(name, 80);
      const headerValue = cleanText(raw, 500);
      if (key && headerValue && /^[a-z0-9-]+$/i.test(key) && !/^(host|content-length|connection)$/i.test(key)) headers[key] = headerValue;
    }
  }
  return headers;
}

proxyRoutes.post('/subscriptions', async (c) => {
  const body = (await readJson<{ name?: string; url?: string; kind?: string; userAgent?: string; headers?: Record<string, string> }>(c)) ?? {};
  const kind = body.kind === 'file' ? 'file' : 'url';
  const url = cleanText(body.url, 500);
  if (kind === 'url' && !/^https?:\/\//i.test(url)) return fail('请填写 http(s) 订阅地址');
  const name = cleanText(body.name, 80);
  if (kind === 'file' && !name) return fail('请填写订阅名称');
  const sub = await insertProxySubscription(c.env, {
    name: name || url,
    url,
    kind,
    userAgent: cleanText(body.userAgent, 300) || 'clash-verge/v1.0',
    headers: headersOf(body.headers),
  });
  await audit(c.env, c.get('actor'), 'proxy_subscription.create', sub.id, { url, kind });
  return ok({ subscription: sub });
});

proxyRoutes.patch('/subscriptions/:id', async (c) => {
  const id = c.req.param('id');
  const sub = await getProxySubscription(c.env, id);
  if (!sub) return fail('订阅不存在', 404);
  const body = (await readJson<{ name?: string; enabled?: boolean; userAgent?: string; headers?: Record<string, string> }>(c)) ?? {};
  await updateProxySubscription(c.env, id, {
    ...(body.name !== undefined ? { name: cleanText(body.name, 80) || sub.name } : {}),
    ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
    ...(body.userAgent !== undefined ? { userAgent: cleanText(body.userAgent, 300) } : {}),
    ...(body.headers !== undefined ? { headers: headersOf(body.headers) } : {}),
  });
  await audit(c.env, c.get('actor'), 'proxy_subscription.update', id);
  return ok({ subscription: await getProxySubscription(c.env, id) });
});

proxyRoutes.delete('/subscriptions/:id', async (c) => {
  const id = c.req.param('id');
  const sub = await getProxySubscription(c.env, id);
  if (!sub) return fail('订阅不存在', 404);
  const requested = c.req.query('nodes');
  const nodeMode = requested === 'keep_alive' || requested === 'keep_all' ? requested : 'delete_all';
  const result = await deleteProxySubscription(c.env, id, nodeMode);
  await audit(c.env, c.get('actor'), 'proxy_subscription.delete', id, { nodes: nodeMode, deleted: result.deleted });
  return ok({ ok: true, ...result });
});

proxyRoutes.post('/subscriptions/:id/refresh', async (c) => {
  const id = c.req.param('id');
  const sub = await getProxySubscription(c.env, id);
  if (!sub) return fail('订阅不存在', 404);
  if (sub.kind === 'file') return fail('文件订阅不支持刷新，请重新导入文件', 409);
  if (!sub.enabled) return fail('订阅已停用', 409);
  const body = (await readJson<{ mode?: string }>(c)) ?? {};
  const mode = body.mode === 'proxy' ? 'proxy' : 'actions';
  if (mode === 'proxy') {
    const nodes = await listProxyNodes(c.env);
    if (!nodes.some((node) => node.enabled && !node.kernelOnly)) return fail('没有可用代理，请先测活至少一个', 409);
  }
  const task = await createTask(c.env, {
    type: 'proxy-fetch-sub',
    source: 'manual',
    priority: 80,
    payload: { sub_id: sub.id, sub_url: sub.url, user_agent: sub.userAgent, fetch_mode: mode },
    message: `刷新代理订阅 · ${sub.name}`,
  });
  await dispatchNext(c.env);
  await audit(c.env, c.get('actor'), 'proxy_subscription.refresh', sub.id, { taskId: task.id, mode });
  return ok({ taskId: task.id });
});

proxyRoutes.post('/subscriptions/:id/check', async (c) => {
  const id = c.req.param('id');
  const sub = await getProxySubscription(c.env, id);
  if (!sub) return fail('订阅源不存在', 404);
  const nodes = await listProxyNodes(c.env);
  if (!nodes.some((node) => node.enabled && node.subscriptionId === id)) return fail('该订阅没有可用节点', 409);
  const task = await createTask(c.env, {
    type: 'proxy-test',
    source: 'manual',
    priority: 80,
    payload: { proxy_sub_id: id, proxy_sub_name: sub.name },
    message: `代理测活 · ${sub.name}`,
  });
  await dispatchNext(c.env);
  await audit(c.env, c.get('actor'), 'proxy_subscription.check', id, { taskId: task.id });
  return ok({ taskId: task.id });
});

proxyRoutes.post('/pull-subscription', async (c) => {
  const body = (await readJson<{ url?: string; name?: string; userAgent?: string; mode?: string }>(c)) ?? {};
  const url = cleanText(body.url, 500);
  if (!/^https?:\/\//i.test(url)) return fail('请填写 http(s) 订阅地址');
  const mode = body.mode === 'actions' ? 'actions' : 'proxy';
  if (mode === 'proxy') {
    const nodes = await listProxyNodes(c.env);
    if (!nodes.some((node) => node.enabled && !node.kernelOnly)) return fail('没有可用代理，请先测活至少一个', 409);
  }
  const userAgent = cleanText(body.userAgent, 300) || 'clash-verge/v1.0';
  // Pulling always creates a subscription so the result is kept and can be
  // refreshed or deleted later instead of only being imported once.
  const sub = await insertProxySubscription(c.env, {
    name: cleanText(body.name, 80) || url,
    url,
    kind: 'url',
    userAgent,
    headers: {},
  });
  const task = await createTask(c.env, {
    type: 'proxy-fetch-sub',
    source: 'manual',
    priority: 80,
    payload: { sub_id: sub.id, sub_url: url, user_agent: userAgent, fetch_mode: mode },
    message: mode === 'actions' ? 'Actions 直连拉取订阅' : '代理拉取订阅',
  });
  await dispatchNext(c.env);
  await audit(c.env, c.get('actor'), 'proxy.pull_subscription', task.id, { url: url.slice(0, 120), mode, subId: sub.id });
  return ok({ taskId: task.id, subscription: sub });
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
  if (body.config !== undefined) {
    const config = cleanText(body.config, 65_536);
    patch.configEnc = config ? await encryptProxyPassword(c.env, config) : '';
    if (patch.protocol) patch.engine = KERNEL.has(patch.protocol) ? (cleanText(body.engine, 20) || 'mihomo') : '';
    else if (body.engine !== undefined) patch.engine = cleanText(body.engine, 20);
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

proxyRoutes.post('/:id/current', async (c) => {
  const id = c.req.param('id');
  const node = await getProxyNode(c.env, id);
  if (!node) return fail('代理不存在', 404);
  if (!node.enabled) return fail('该代理已停用，请先启用');
  if (node.kernelOnly) return fail('该协议需要内核，不能作为当前补测节点');
  const items = await listProxyNodes(c.env);
  const maxScore = items.reduce((max, item) => Math.max(max, item.sortScore ?? 0), 0);
  await updateProxyNode(c.env, id, { sortScore: maxScore + 10 });
  await audit(c.env, c.get('actor'), 'proxy.set_current', id, { name: node.name });
  return ok({ currentId: id });
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
