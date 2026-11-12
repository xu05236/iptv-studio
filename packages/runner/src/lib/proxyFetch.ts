import https from 'node:https';
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
