import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { probeProxy, type ProxyProbeResult } from './proxyFetch.js';

/**
 * Kernel-only nodes (vmess/vless/trojan/ss/...) need a local engine. This
 * module turns their stored config into a mihomo config, starts the pinned
 * mihomo binary, and probes through its local SOCKS port.
 */

export interface KernelNode {
  id: string;
  name: string;
  protocol: string;
  /** Clash YAML block, sing-box JSON object, or raw URI (as stored at import). */
  config?: string;
}

export interface KernelConfig {
  yaml: string;
  usable: KernelNode[];
  warnings: string[];
}

export const MIHOMO_VERSION = process.env.MIHOMO_VERSION ?? 'v1.19.9';
export const DEFAULT_KERNEL_DIR = process.env.MIHOMO_DIR ?? path.join(process.cwd(), '.tmp', 'mihomo');
export const MIHOMO_DOWNLOAD_URL =
  process.env.MIHOMO_URL ??
  `https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-linux-amd64-${MIHOMO_VERSION}.gz`;

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Convert one sing-box style outbound object into a Clash/mihomo proxy map. */
export function clashProxyFromJson(record: Record<string, unknown>): Record<string, unknown> | null {
  const rawType = String(record.type ?? record.protocol ?? '').toLowerCase();
  const type = rawType === 'shadowsocks' ? 'ss' : rawType;
  if (!['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic'].includes(type)) return null;
  const server = String(record.server ?? record.address ?? '');
  const port = Number(record.server_port ?? record.port);
  if (!server || !Number.isFinite(port) || port <= 0) return null;
  const proxy: Record<string, unknown> = { type, server, port };
  if (record.password) proxy.password = String(record.password);
  if (record.uuid) proxy.uuid = String(record.uuid);
  if (record.method) proxy.cipher = String(record.method);
  if (record.cipher) proxy.cipher = String(record.cipher);
  if (record.alter_id !== undefined) proxy.alterId = Number(record.alter_id) || 0;
  if (record.flow) proxy.flow = String(record.flow);
  const tls = isPlainRecord(record.tls) ? record.tls : null;
  if (tls) {
    proxy.tls = tls.enabled !== false;
    if (tls.server_name) proxy.servername = String(tls.server_name);
    if (tls.insecure) proxy['skip-cert-verify'] = true;
    if (Array.isArray(tls.alpn) && tls.alpn.length) proxy.alpn = tls.alpn.map(String);
  }
  const transport = isPlainRecord(record.transport) ? record.transport : null;
  const network = String(transport?.type ?? record.network ?? '');
  if (network === 'ws') {
    proxy.network = 'ws';
    proxy['ws-opts'] = {
      path: String((transport?.path as string) ?? record.path ?? '/'),
      headers: isPlainRecord(transport?.headers) ? transport.headers : {},
    };
  } else if (network === 'grpc') {
    proxy.network = 'grpc';
    proxy['grpc-opts'] = { 'grpc-service-name': String((transport?.service_name as string) ?? record.service_name ?? '') };
  } else if (network === 'h2' || network === 'http') {
    proxy.network = 'h2';
  }
  return proxy;
}

function decodeBase64Text(text: string): string | null {
  try {
    const decoded = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return decoded && decoded.includes(':') ? decoded : null;
  } catch {
    return null;
  }
}

/** Convert common kernel URIs into a Clash proxy map (best effort). */
export function clashProxyFromUri(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  const hashIndex = text.indexOf('#');
  const label = hashIndex >= 0 ? decodeURIComponent(text.slice(hashIndex + 1)) : '';
  const base = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  const scheme = base.slice(0, base.indexOf('://')).toLowerCase();
  try {
    if (scheme === 'vmess') {
      const body = decodeBase64Text(base.slice('vmess://'.length));
      if (!body) return null;
      const data = JSON.parse(body) as Record<string, unknown>;
      const proxy: Record<string, unknown> = {
        type: 'vmess',
        server: String(data.add ?? ''),
        port: Number(data.port) || 0,
        uuid: String(data.id ?? ''),
        alterId: Number(data.aid ?? 0) || 0,
        cipher: String(data.scy ?? 'auto'),
      };
      if (data.tls === 'tls') {
        proxy.tls = true;
        if (data.sni || data.host) proxy.servername = String(data.sni ?? data.host);
      }
      if (data.net === 'ws') {
        proxy.network = 'ws';
        proxy['ws-opts'] = { path: String(data.path ?? '/'), headers: data.host ? { Host: String(data.host) } : {} };
      }
      if (!proxy.server || !proxy.port) return null;
      return proxy;
    }
    if (scheme === 'ss') {
      const url = new URL(base);
      let method = decodeURIComponent(url.username);
      let password = decodeURIComponent(url.password);
      if (!method || !password) {
        const decoded = decodeBase64Text(decodeURIComponent(url.hostname));
        if (!decoded) return null;
        const split = decoded.indexOf(':');
        method = decoded.slice(0, split);
        password = decoded.slice(split + 1);
      }
      return { type: 'ss', server: url.hostname, port: Number(url.port), cipher: method, password };
    }
    if (scheme === 'trojan') {
      const url = new URL(base);
      return {
        type: 'trojan',
        server: url.hostname,
        port: Number(url.port),
        password: decodeURIComponent(url.username),
        ...(url.searchParams.get('sni') ? { sni: url.searchParams.get('sni') } : {}),
        ...(url.searchParams.get('allowInsecure') === '1' ? { 'skip-cert-verify': true } : {}),
      };
    }
    if (scheme === 'vless') {
      const url = new URL(base);
      const proxy: Record<string, unknown> = { type: 'vless', server: url.hostname, port: Number(url.port), uuid: decodeURIComponent(url.username) };
      if (url.searchParams.get('security') === 'tls' || url.searchParams.get('tls') === '1') proxy.tls = true;
      const sni = url.searchParams.get('sni');
      if (sni) proxy.servername = sni;
      if (url.searchParams.get('type') === 'ws') {
        proxy.network = 'ws';
        proxy['ws-opts'] = { path: url.searchParams.get('path') ?? '/', headers: { Host: url.searchParams.get('host') ?? '' } };
      }
      return proxy;
    }
  } catch {
    return null;
  }
  return null;
}

function parseKernelNode(node: KernelNode): { yaml?: string; proxy?: Record<string, unknown>; warning?: string } {
  const config = (node.config ?? '').trim();
  if (!config) return { warning: `${node.name}：没有保存节点配置` };
  if (config.startsWith('-') || config.startsWith('name:')) {
    const lines = config.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const indented = lines.map((line) => (line.startsWith(' ') ? line : `  ${line}`)).join('\n');
    const nameMatch = indented.match(/^\s*-\s*name:\s*(.+)$/m) ?? indented.match(/^\s*name:\s*(.+)$/m);
    const name = nameMatch?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
    if (name.includes(',')) return { warning: `${node.name}：名称含逗号，无法用 MATCH 规则选中` };
    return { yaml: indented };
  }
  if (config.startsWith('{')) {
    try {
      const record = JSON.parse(config) as Record<string, unknown>;
      const proxy = clashProxyFromJson(record);
      return proxy ? { proxy } : { warning: `${node.name}：不支持的配置类型` };
    } catch {
      return { warning: `${node.name}：配置不是合法 JSON` };
    }
  }
  if (config.includes('://')) {
    const proxy = clashProxyFromUri(config);
    return proxy ? { proxy } : { warning: `${node.name}：暂不支持该 URI 协议` };
  }
  return { warning: `${node.name}：无法识别的配置格式` };
}

/**
 * Build a single-node mihomo config. Each kernel test starts its own process so
 * the MATCH rule can pin one node without cross-node leakage.
 */
export function buildKernelConfig(nodes: KernelNode[], mixedPort = 7890): KernelConfig {
  const usable: KernelNode[] = [];
  const warnings: string[] = [];
  const blocks: string[] = [];
  nodes.forEach((node, index) => {
    const parsed = parseKernelNode(node);
    if (parsed.warning) {
      warnings.push(parsed.warning);
      return;
    }
    if (parsed.proxy) {
      const name = `node-${index}`;
      const lines = [`  - name: ${quoteYaml(name)}`];
      for (const [key, value] of Object.entries(parsed.proxy)) {
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'object') lines.push(`    ${key}: ${JSON.stringify(value)}`);
        else if (typeof value === 'boolean') lines.push(`    ${key}: ${value ? 'true' : 'false'}`);
        else if (typeof value === 'number') lines.push(`    ${key}: ${value}`);
        else lines.push(`    ${key}: ${quoteYaml(String(value))}`);
      }
      blocks.push(lines.join('\n'));
      usable.push(node);
      return;
    }
    if (parsed.yaml) {
      blocks.push(parsed.yaml);
      usable.push(node);
    }
  });
  const rules = usable.length ? `rules:\n  - MATCH,${usable.length === 1 ? firstProxyName(blocks[0] ?? '') : 'node-0'}` : 'rules:\n  - MATCH,DIRECT';
  const yaml = [
    `mixed-port: ${mixedPort}`,
    'allow-lan: false',
    'mode: rule',
    'log-level: warning',
    'proxies:',
    blocks.join('\n'),
    rules,
  ].join('\n');
  return { yaml: `${yaml}\n`, usable, warnings };
}

function firstProxyName(block: string): string {
  const name = block.match(/name:\s*"([^"]+)"/)?.[1] ?? block.match(/name:\s*([^\n,]+)/)?.[1]?.trim() ?? '';
  return name || 'DIRECT';
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error('mihomo 启动超时'));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

export async function ensureMihomoBinary(dir: string, options: { url?: string; sha256?: string } = {}): Promise<string> {
  const binary = path.join(dir, 'mihomo');
  mkdirSync(dir, { recursive: true });
  if (existsSync(binary)) return binary;
  const url = options.url ?? MIHOMO_DOWNLOAD_URL;
  const response = await fetch(url, { headers: { 'user-agent': 'iptv-studio-kernel/1.0' } });
  if (!response.ok) throw new Error(`下载 mihomo 失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const data = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer;
  const expected = options.sha256 ?? process.env.MIHOMO_SHA256 ?? '';
  if (expected) {
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== expected.toLowerCase()) throw new Error(`mihomo 校验失败：${actual}`);
  }
  writeFileSync(binary, data);
  chmodSync(binary, 0o755);
  return binary;
}

export interface KernelHandle {
  port: number;
  logPath: string;
  stop: () => Promise<void>;
}

/** Start mihomo for one node and wait until its mixed port accepts connections. */
export async function startKernel(
  node: KernelNode,
  options: { dir?: string; mixedPort?: number; binary?: string; sha256?: string; startupTimeoutMs?: number } = {},
): Promise<KernelHandle> {
  const dir = options.dir ?? DEFAULT_KERNEL_DIR;
  const port = options.mixedPort ?? 7890;
  const built = buildKernelConfig([node], port);
  if (!built.usable.length) throw new Error(built.warnings[0] ?? '节点配置不可用');
  const binary = options.binary ?? (await ensureMihomoBinary(dir, { sha256: options.sha256 }));
  const configPath = path.join(dir, 'config.yaml');
  writeFileSync(configPath, built.yaml);
  const logPath = path.join(dir, 'mihomo.log');
  const log = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(binary, ['-f', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (chunk: Buffer) => log.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => log.write(chunk));
  const stop = async () => {
    log.end();
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  try {
    await waitForPort(port, options.startupTimeoutMs ?? 15_000);
  } catch (error) {
    await stop();
    const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-800) : '';
    throw new Error(`${error instanceof Error ? error.message : String(error)}${logText ? `：${logText}` : ''}`);
  }
  return { port, logPath, stop };
}

/** Probe one kernel-only node; the engine is started and stopped per node. */
export async function probeKernelNode(node: KernelNode, options: { dir?: string; mixedPort?: number; startupTimeoutMs?: number } = {}): Promise<ProxyProbeResult> {
  let kernel: KernelHandle | null = null;
  try {
    kernel = await startKernel(node, options);
    return await probeProxy({ id: node.id, protocol: 'socks5', host: '127.0.0.1', port: kernel.port });
  } catch (error) {
    return {
      ok: false,
      latencyMs: 0,
      egressIp: '',
      country: '',
      asn: '',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await kernel?.stop();
  }
}

/** Probe up to `limit` kernel nodes with a small concurrency (default 1). */
export async function probeKernelNodes(
  nodes: KernelNode[],
  options: { limit?: number; concurrency?: number; dir?: string; mixedPort?: number } = {},
): Promise<Array<{ id: string; result: ProxyProbeResult }>> {
  const limit = Math.min(nodes.length, options.limit ?? 20);
  const concurrency = Math.max(1, Math.min(3, options.concurrency ?? 1));
  const baseDir = options.dir ?? DEFAULT_KERNEL_DIR;
  const queue = nodes.slice(0, limit);
  const results: Array<{ id: string; result: ProxyProbeResult }> = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const node = queue[cursor++];
      if (!node) return;
      // Different ports/dirs so parallel kernels do not fight over the listener or config file.
      const port = (options.mixedPort ?? 7890) + (cursor % 20);
      results.push({ id: node.id, result: await probeKernelNode(node, { dir: path.join(baseDir, node.id), mixedPort: port }) });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
