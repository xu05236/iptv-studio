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
  };
}

export async function listProxyNodes(env: Env): Promise<ProxyNode[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, protocol, host, port, username, password_enc, region, isp, enabled, kernel_only, sort_score,
            last_ok_at, last_checked_at, last_latency_ms, last_error, last_egress_ip, last_country, last_asn,
            success_count, fail_count
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
}

export async function insertProxyNode(env: Env, input: NewProxyInput): Promise<ProxyNode> {
  const id = `proxy-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO proxy_nodes (id, name, protocol, host, port, username, password_enc, region, isp, kernel_only, sort_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
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
  ).run();
  const created = await getProxyNode(env, id);
  if (!created) throw new Error('新建代理失败');
  return created;
}

export async function updateProxyNode(
  env: Env,
  id: string,
  patch: Partial<Pick<ProxyNode, 'name' | 'protocol' | 'host' | 'port' | 'username' | 'region' | 'isp' | 'enabled' | 'kernelOnly' | 'sortScore'>> & { passwordEnc?: string },
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
  if (patch.region !== undefined) push('region', patch.region);
  if (patch.isp !== undefined) push('isp', patch.isp);
  if (patch.enabled !== undefined) push('enabled', patch.enabled ? 1 : 0);
  if (patch.kernelOnly !== undefined) push('kernel_only', patch.kernelOnly ? 1 : 0);
  if (patch.sortScore !== undefined) push('sort_score', patch.sortScore);
  if (!sets.length) return true;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  await env.DB.prepare(`UPDATE proxy_nodes SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  return true;
}

export async function deleteProxyNode(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM proxy_nodes WHERE id = ?').bind(id).run();
}

export async function recordProxyCheck(env: Env, id: string, result: ProxyCheckResult): Promise<void> {
  if (result.ok) {
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
