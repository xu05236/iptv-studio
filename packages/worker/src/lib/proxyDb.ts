import type { ProxyCheckResult, ProxyNode, ProxyProtocol } from '@iptv/core';
import type { Env } from '../env.js';

interface ProxyRow {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  password_enc: string;
  region: string;
  isp: string;
  enabled: number;
  kernel_only: number;
  engine: string;
  config_enc: string;
  sort_score: number;
  last_ok_at: string | null;
  last_checked_at: string | null;
  last_latency_ms: number | null;
  last_error: string | null;
  last_egress_ip: string | null;
  last_country: string | null;
  last_asn: string | null;
  success_count: number;
  fail_count: number;
  subscription_id: string;
}

function toNode(row: ProxyRow): ProxyNode {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol as ProxyNode['protocol'],
    host: row.host,
    port: row.port,
    username: row.username,
    hasPassword: Boolean(row.password_enc),
    region: row.region,
    isp: row.isp,
    enabled: row.enabled === 1,
    kernelOnly: row.kernel_only === 1,
    engine: row.engine || undefined,
    hasConfig: Boolean(row.config_enc),
    sortScore: row.sort_score,
    lastOkAt: row.last_ok_at,
    lastCheckedAt: row.last_checked_at,
    lastLatencyMs: row.last_latency_ms,
    lastError: row.last_error,
    lastEgressIp: row.last_egress_ip,
    lastCountry: row.last_country,
    lastAsn: row.last_asn,
    successCount: row.success_count,
    failCount: row.fail_count,
    subscriptionId: row.subscription_id || undefined,
  };
}

export async function listProxyNodes(env: Env): Promise<ProxyNode[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, protocol, host, port, username, password_enc, region, isp, enabled, kernel_only, engine, config_enc, sort_score,
            last_ok_at, last_checked_at, last_latency_ms, last_error, last_egress_ip, last_country, last_asn,
            success_count, fail_count, subscription_id
     FROM proxy_nodes
     ORDER BY kernel_only ASC, enabled DESC, sort_score DESC, success_count DESC, id ASC`,
  ).all<ProxyRow>();
  return results.map(toNode);
}

export async function getProxyNode(env: Env, id: string): Promise<ProxyNode | null> {
  const row = await env.DB.prepare('SELECT * FROM proxy_nodes WHERE id = ?').bind(id).first<ProxyRow>();
  return row ? toNode(row) : null;
}

export interface NewProxyInput {
  name: string;
  protocol: ProxyProtocol | string;
  host: string;
  port: number;
  username?: string;
  passwordEnc?: string;
  region?: string;
  isp?: string;
  kernelOnly?: boolean;
  engine?: string;
  configEnc?: string;
  subscriptionId?: string;
}

export async function insertProxyNode(env: Env, input: NewProxyInput): Promise<ProxyNode> {
  const id = `proxy-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO proxy_nodes (id, name, protocol, host, port, username, password_enc, region, isp, kernel_only, engine, config_enc, sort_score, subscription_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).bind(
    id,
    input.name,
    input.protocol,
    input.host,
    input.port,
    input.username ?? '',
    input.passwordEnc ?? '',
    input.region ?? '',
    input.isp ?? '',
    input.kernelOnly ? 1 : 0,
    input.engine ?? '',
    input.configEnc ?? '',
    input.subscriptionId ?? '',
  ).run();
  const created = await getProxyNode(env, id);
  if (!created) throw new Error('新建代理失败');
  return created;
}

export async function updateProxyNode(
  env: Env,
  id: string,
  patch: Partial<Pick<ProxyNode, 'name' | 'protocol' | 'host' | 'port' | 'username' | 'region' | 'isp' | 'enabled' | 'kernelOnly' | 'sortScore'>> & { passwordEnc?: string; configEnc?: string; engine?: string; subscriptionId?: string },
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };
  if (patch.name !== undefined) push('name', patch.name);
  if (patch.protocol !== undefined) push('protocol', patch.protocol);
  if (patch.host !== undefined) push('host', patch.host);
  if (patch.port !== undefined) push('port', patch.port);
  if (patch.username !== undefined) push('username', patch.username);
  if (patch.passwordEnc !== undefined) push('password_enc', patch.passwordEnc);
  if (patch.engine !== undefined) push('engine', patch.engine);
  if (patch.configEnc !== undefined) push('config_enc', patch.configEnc);
  if (patch.region !== undefined) push('region', patch.region);
  if (patch.isp !== undefined) push('isp', patch.isp);
  if (patch.enabled !== undefined) push('enabled', patch.enabled ? 1 : 0);
  if (patch.kernelOnly !== undefined) push('kernel_only', patch.kernelOnly ? 1 : 0);
  if (patch.sortScore !== undefined) push('sort_score', patch.sortScore);
  if (patch.subscriptionId !== undefined) push('subscription_id', patch.subscriptionId);
  if (!sets.length) return true;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  await env.DB.prepare(`UPDATE proxy_nodes SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  return true;
}

export async function deleteProxyNode(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM proxy_nodes WHERE id = ?').bind(id).run();
}

export async function recordProxyCheck(env: Env, id: string, result: ProxyCheckResult): Promise<void> {  if (result.ok) {
    await env.DB.prepare(
      `UPDATE proxy_nodes SET
         last_ok_at = datetime('now'), last_checked_at = datetime('now'), last_latency_ms = ?,
         last_error = NULL, last_egress_ip = ?, last_country = ?, last_asn = ?,
         success_count = success_count + 1, updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(result.latencyMs, result.egressIp, result.country, result.asn, id).run();
    return;
  }
  await env.DB.prepare(
    `UPDATE proxy_nodes SET
       last_checked_at = datetime('now'), last_error = ?, fail_count = fail_count + 1, updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(result.error ?? '检测失败', id).run();
}

/* ------------------------------------------------------- proxy subscriptions */

export interface ProxySubscription {
  id: string;
  name: string;
  url: string;
  userAgent: string;
  headers: Record<string, string>;
  enabled: boolean;
  lastFetchAt: string | null;
  lastStatus: string;
  nodeCount: number;
  createdAt: string;
}

interface SubscriptionRow {
  id: string;
  name: string;
  url: string;
  user_agent: string;
  headers: string;
  enabled: number;
  last_fetch_at: string | null;
  last_status: string;
  node_count: number;
  created_at: string;
}

function toSubscription(row: SubscriptionRow): ProxySubscription {
  let headers: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row.headers) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) headers = parsed as Record<string, string>;
  } catch {
    headers = {};
  }
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    userAgent: row.user_agent,
    headers,
    enabled: row.enabled === 1,
    lastFetchAt: row.last_fetch_at,
    lastStatus: row.last_status,
    nodeCount: row.node_count,
    createdAt: row.created_at,
  };
}

/** Stable identity for de-duplicating and reconciling subscription nodes. */
export function proxyNodeKey(node: Pick<ProxyNode, 'protocol' | 'host' | 'port' | 'username'>): string {
  return `${node.protocol}|${node.host.toLowerCase()}|${node.port}|${node.username}`;
}

export async function listProxySubscriptions(env: Env): Promise<ProxySubscription[]> {
  const { results } = await env.DB.prepare('SELECT * FROM proxy_subscriptions ORDER BY created_at ASC').all<SubscriptionRow>();
  return results.map(toSubscription);
}

export async function getProxySubscription(env: Env, id: string): Promise<ProxySubscription | null> {
  const row = await env.DB.prepare('SELECT * FROM proxy_subscriptions WHERE id = ?').bind(id).first<SubscriptionRow>();
  return row ? toSubscription(row) : null;
}

export async function insertProxySubscription(
  env: Env,
  input: { name: string; url: string; userAgent?: string; headers?: Record<string, string> },
): Promise<ProxySubscription> {
  const id = `psub-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO proxy_subscriptions (id, name, url, user_agent, headers)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, input.name || input.url, input.url, input.userAgent ?? '', JSON.stringify(input.headers ?? {})).run();
  const created = await getProxySubscription(env, id);
  if (!created) throw new Error('新建代理订阅失败');
  return created;
}

export async function updateProxySubscription(
  env: Env,
  id: string,
  patch: { name?: string; enabled?: boolean; userAgent?: string; headers?: Record<string, string> },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    values.push(patch.name);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }
  if (patch.userAgent !== undefined) {
    sets.push('user_agent = ?');
    values.push(patch.userAgent);
  }
  if (patch.headers !== undefined) {
    sets.push('headers = ?');
    values.push(JSON.stringify(patch.headers));
  }
  if (!sets.length) return;
  values.push(id);
  await env.DB.prepare(`UPDATE proxy_subscriptions SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
}

/** Delete the subscription and disable (not delete) the nodes it owned. */
export async function deleteProxySubscription(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE proxy_nodes SET subscription_id = '', enabled = 0 WHERE subscription_id = ?").bind(id).run();
  await env.DB.prepare('DELETE FROM proxy_subscriptions WHERE id = ?').bind(id).run();
}

export async function finishProxySubscription(env: Env, id: string, nodeCount: number, status: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE proxy_subscriptions SET last_fetch_at = datetime('now'), node_count = ?, last_status = ? WHERE id = ?",
  ).bind(nodeCount, status, id).run();
}

/** Record a dispatch so a failed refresh does not retry on every 5-minute tick. */
export async function markProxySubscriptionAttempt(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE proxy_subscriptions SET last_fetch_at = datetime('now'), last_status = '刷新中…' WHERE id = ?").bind(id).run();
}

/** Disable nodes of a subscription that disappeared upstream; returns how many. */
export async function disableMissingSubscriptionNodes(env: Env, id: string, keepKeys: Iterable<string>): Promise<number> {
  const keep = new Set(keepKeys);
  const { results } = await env.DB.prepare(
    'SELECT id, protocol, host, port, username FROM proxy_nodes WHERE subscription_id = ?',
  ).bind(id).all<{ id: string; protocol: string; host: string; port: number; username: string }>();
  let disabled = 0;
  for (const row of results) {
    const key = proxyNodeKey(row as Pick<ProxyNode, 'protocol' | 'host' | 'port' | 'username'>);
    if (keep.has(key)) continue;
    await env.DB.prepare('UPDATE proxy_nodes SET enabled = 0 WHERE id = ?').bind(row.id).run();
    disabled += 1;
  }
  return disabled;
}
