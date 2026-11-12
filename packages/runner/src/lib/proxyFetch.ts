import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { gunzipSync } from 'node:zlib';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

export interface ProxyProbeInput {
  id: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProxyProbeResult {
  ok: boolean;
  latencyMs: number;
  egressIp: string;
  country: string;
  asn: string;
  error: string;
}

interface Target {
  url: string;
  json: boolean;
}

const TARGETS: Target[] = [
  { url: 'https://ipinfo.io/json', json: true },
  { url: 'https://myip.ipip.net', json: false },
  { url: 'https://www.baidu.com/', json: false },
  { url: 'https://api.ip.sb/geoip', json: true },
];

const TARGET_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 20_000;

export function proxyAgentUrl(proxy: ProxyProbeInput): string {
  const scheme = proxy.protocol.startsWith('socks') ? 'socks5' : proxy.protocol === 'https' ? 'https' : 'http';
  const auth = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@` : '';
  return `${scheme}://${auth}${proxy.host}:${proxy.port}`;
}

function buildAgent(proxy: ProxyProbeInput) {
  const url = proxyAgentUrl(proxy);
  return proxy.protocol.startsWith('socks') ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);
}

function parseEgress(json: boolean, body: string): { egressIp: string; country: string; asn: string } {
  if (json) {
    try {
      const data = JSON.parse(body) as { ip?: string; country?: string; org?: string; asn?: number; isp?: string };
      const org = data.org ?? data.isp ?? '';
      const asn = typeof data.asn === 'number' ? `AS${data.asn}` : (org.match(/AS\d+/)?.[0] ?? '');
      return { egressIp: data.ip ?? '', country: data.country ?? '', asn };
    } catch {
      // Fall through to the text matcher.
    }
  }
  const ip = body.match(/(\d{1,3}\.){3}\d{1,3}/)?.[0] ?? '';
  const asn = body.match(/AS\d+/)?.[0] ?? '';
  return { egressIp: ip, country: '', asn };
}

function request(url: string, agent: https.Agent, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.get(
      target,
      { agent, timeout: timeoutMs, headers: { 'user-agent': 'iptv-studio-proxy-probe/1.0', accept: '*/*' } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (body.length < 200_000) body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        response.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`超时（${timeoutMs}ms）`)));
    req.on('error', reject);
  });
}

export interface ProxyHttpResult {
  status: number;
  body: string;
  finalUrl: string;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Some "HTTP" proxies only accept CONNECT; plain GET through them returns 400. */
function openTunnel(proxy: ProxyProbeInput, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port, timeout: timeoutMs });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.on('connect', () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}\r\n`
        : '';
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const head = buffer.subarray(0, headerEnd).toString('latin1');
      const status = Number(head.split(' ')[1] ?? 0);
      if (status !== 200) {
        fail(new Error(`代理 CONNECT 失败 HTTP ${status}`));
        return;
      }
      settled = true;
      socket.removeAllListeners('data');
      // Bytes that arrived together with the CONNECT response header already
      // belong to the tunnel payload; put them back for the caller to read.
      const rest = buffer.subarray(headerEnd + 4);
      if (rest.length) socket.unshift(rest);
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.on('timeout', () => fail(new Error(`代理连接超时（${timeoutMs}ms）`)));
    socket.on('error', fail);
  });
}

function dechunk(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString('latin1'), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    parts.push(body.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(parts);
}

function parseResponse(raw: Buffer): { status: number; body: string; location?: string } {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0) throw new Error('代理响应不完整');
  const head = raw.subarray(0, headerEnd).toString('latin1');
  const lines = head.split('\r\n');
  const status = Number(lines[0]?.split(' ')[1] ?? 0);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  let body = raw.subarray(headerEnd + 4);
  if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) body = dechunk(body);
  if ((headers['content-encoding'] ?? '').toLowerCase().includes('gzip')) {
    try {
      body = gunzipSync(body);
    } catch {
      // Leave it as-is; a truncated gzip body will fail decoding below.
    }
  }
  return { status, body: body.toString('utf8'), location: headers.location };
}

function requestViaTunnel(
  url: string,
  proxy: ProxyProbeInput,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: string; location?: string }> {
  const target = new URL(url);
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  return new Promise((resolve, reject) => {
    void openTunnel(proxy, target.hostname, port, timeoutMs).then((socket) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`超时（${timeoutMs}ms）`));
      }, timeoutMs);
      socket.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total <= MAX_BODY_BYTES + 65_536) chunks.push(chunk);
      });
      socket.on('end', () => {
        clearTimeout(timer);
        try {
          resolve(parseResponse(Buffer.concat(chunks)));
        } catch (error) {
          reject(error);
        }
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      const requestLines = [
        `GET ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.host}`,
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        'Connection: close',
        '',
        '',
      ];
      socket.write(requestLines.join('\r\n'));
    }, reject);
  });
}

function requestOnce(
  url: string,
  proxy: ProxyProbeInput,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: string; location?: string }> {
  const target = new URL(url);
  // HTTP targets through an HTTP proxy: speak CONNECT manually, because many
  // providers reject absolute-URI GET with 400.
  if (target.protocol !== 'https:' && !proxy.protocol.startsWith('socks')) {
    return requestViaTunnel(url, proxy, headers, timeoutMs);
  }
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:';
    const agent = buildAgent(proxy);
    const transport = isHttps ? https : http;
    const req = transport.get(
      target,
      { agent: agent as http.Agent, timeout: timeoutMs, headers },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = typeof response.headers.location === 'string' ? response.headers.location : undefined;
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (body.length < MAX_BODY_BYTES) body += chunk;
        });
        response.on('end', () => resolve({ status, body, location }));
        response.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`超时（${timeoutMs}ms）`)));
    req.on('error', reject);
  });
}

/** Fetch an http(s) URL through the given proxy (http/https/socks5), following up to 3 redirects. */
export async function fetchViaProxy(
  url: string,
  proxy: ProxyProbeInput,
  options: { userAgent?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<ProxyHttpResult> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const headers: Record<string, string> = {
    'user-agent': options.userAgent?.trim() || 'clash-verge/v1.0',
    accept: '*/*',
    ...(options.headers ?? {}),
  };
  let current = url;
  for (let hop = 0; hop < 4; hop += 1) {
    const result = await requestOnce(current, proxy, headers, timeoutMs);
    if (result.status >= 300 && result.status < 400 && result.location) {
      current = new URL(result.location, current).toString();
      continue;
    }
    if (result.status < 200 || result.status >= 300) throw new Error(`订阅返回 HTTP ${result.status}`);
    if (!result.body.trim()) throw new Error('订阅内容为空');
    if (result.body.length >= MAX_BODY_BYTES) throw new Error('订阅内容超过 2MB');
    return { status: result.status, body: result.body, finalUrl: current };
  }
  throw new Error('订阅跳转次数过多');
}

/** Try the probe targets in order; the first successful response wins. */
export async function probeProxy(proxy: ProxyProbeInput): Promise<ProxyProbeResult> {
  const startedAt = Date.now();
  let lastError = '没有可用的测活目标';
  let agent: https.Agent;
  try {
    agent = buildAgent(proxy) as unknown as https.Agent;
  } catch (error) {
    return { ok: false, latencyMs: 0, egressIp: '', country: '', asn: '', error: error instanceof Error ? error.message : String(error) };
  }
  for (const target of TARGETS) {
    const remaining = TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
    if (remaining <= 0) break;
    try {
      const response = await request(target.url, agent, Math.min(TARGET_TIMEOUT_MS, remaining));
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
      const egress = parseEgress(target.json, response.body);
      if (!egress.egressIp && target !== TARGETS[TARGETS.length - 1]) {
        // A target that responds but exposes no address is still a working path.
        return { ok: true, latencyMs: Date.now() - startedAt, ...egress, error: '' };
      }
      return { ok: true, latencyMs: Date.now() - startedAt, ...egress, error: '' };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, latencyMs: Date.now() - startedAt, egressIp: '', country: '', asn: '', error: lastError };
}
