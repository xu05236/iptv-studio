import http from 'node:http';
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

export interface CnProxyNode {
  id: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface CnProbeResult {
  ok: boolean;
  status: number;
  speedKbps: number;
  latencyMs: number;
  error: string;
}

export function buildProxyAgent(node: CnProxyNode): https.Agent {
  const scheme = node.protocol.startsWith('socks') ? 'socks5' : node.protocol === 'https' ? 'https' : 'http';
  const auth = node.username ? `${encodeURIComponent(node.username)}:${encodeURIComponent(node.password ?? '')}@` : '';
  const url = `${scheme}://${auth}${node.host}:${node.port}`;
  return (node.protocol.startsWith('socks') ? new SocksProxyAgent(url) : new HttpsProxyAgent(url)) as unknown as https.Agent;
}

/**
 * Lightweight reachability probe through a domestic proxy: fetch the first
 * 64KB (Range) and treat a 2xx/3xx response with bytes as reachable. Quality
 * (resolution/codec) is deliberately not inferred here; the machine probe owns
 * that. HLS manifests are followed one level so a 404 playlist is not "alive".
 */
export function probeCnUrl(url: string, agent: https.Agent, timeoutMs = 15_000): Promise<CnProbeResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, status: 0, speedKbps: 0, latencyMs: 0, error: '地址不合法' });
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      resolve({ ok: false, status: 0, speedKbps: 0, latencyMs: 0, error: `不支持的协议 ${target.protocol}` });
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (result: CnProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = lib.get(
      target,
      {
        agent,
        timeout: timeoutMs,
        headers: { range: 'bytes=0-262143', 'user-agent': 'iptv-studio-cnprobe/1.0', accept: '*/*' },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 400) {
          response.resume();
          finish({ ok: false, status, speedKbps: 0, latencyMs: Date.now() - startedAt, error: `HTTP ${status}` });
          return;
        }
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes >= 65_536) {
            response.destroy();
            const elapsed = Math.max(1, Date.now() - startedAt);
            finish({ ok: true, status, speedKbps: Math.round((bytes / 1024 / elapsed) * 1000), latencyMs: elapsed, error: '' });
          }
        });
        response.on('end', () => {
          const elapsed = Math.max(1, Date.now() - startedAt);
          finish({
            ok: bytes > 0,
            status,
            speedKbps: Math.round((bytes / 1024 / elapsed) * 1000),
            latencyMs: elapsed,
            error: bytes > 0 ? '' : '没有返回数据',
          });
        });
        response.on('error', (error) => {
          finish({ ok: false, status, speedKbps: 0, latencyMs: Date.now() - startedAt, error: error.message });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`超时（${timeoutMs}ms）`)));
    req.on('error', (error) => finish({ ok: false, status: 0, speedKbps: 0, latencyMs: Date.now() - startedAt, error: error.message }));
  });
}
