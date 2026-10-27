import type { Protocol, RequestHeaders } from '../types.js';

const SCHEME_RE = /^(https?|rtmps?|rtsps?|udp|rtp|mms|ftps?):\/\//i;

/** Parameters that change per session and must not defeat dedupe. */
const EPHEMERAL_PARAMS = new Set([
  'token', 'expires', 'expire', 'sign', 'signature', 'st', 'e', 'ts', 'timestamp',
  'nonce', 'rand', 'r', 'auth', 'auth_key', 'wxtoken', 'playtoken', 'hdnts',
]);

export function isStreamUrl(raw: string): boolean {
  const url = raw.trim().replace(/^[("'<\[]+/, '').replace(/[)"'>\]]+$/, '');
  return SCHEME_RE.test(url);
}

export function guessProtocol(raw: string): Protocol {
  const url = raw.trim().toLowerCase();
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return /\.m3u8?(\?|$)/.test(url.split('|')[0]!) ? 'hls' : 'http';
  }
  if (url.startsWith('rtsp://') || url.startsWith('rtsps://')) return 'rtsp';
  if (url.startsWith('rtmp://') || url.startsWith('rtmps://')) return 'rtmp';
  if (url.startsWith('udp://')) return 'udp';
  if (url.startsWith('rtp://')) return 'rtp';
  return 'unknown';
}

/**
 * Split Kodi/VLC style suffix headers: `http://host/a.m3u8|User-Agent=x&Referer=y`.
 * Returns the clean URL and parsed headers.
 */
export function splitUrlHeaders(raw: string): { url: string; headers: RequestHeaders } {
  const text = raw.trim();
  const pipe = text.indexOf('|');
  if (pipe === -1) return { url: stripAt(text), headers: {} };

  const url = stripAt(text.slice(0, pipe));
  const headers: RequestHeaders = {};
  const tail = text.slice(pipe + 1);
  for (const part of tail.split(/[&|]/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase().replace(/_/g, '-');
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    if (!value) continue;
    if (key === 'user-agent' || key === 'useragent' || key === 'ua') headers.userAgent = value;
    else if (key === 'referer' || key === 'referrer') headers.referer = value;
    else if (key === 'origin') headers.origin = value;
    else if (key === 'cookie') headers.cookie = value;
  }
  return { url, headers };
}

function stripAt(url: string): string {
  // `udp://@239.0.0.1:1234` and `rtp://@239.0.0.1:1234`
  return url.replace(/^([a-z]+:\/\/)@+/i, '$1');
}

/** Canonical form used as dedupe key (not for playback). */
export function normalizeUrlForDedupe(raw: string): string {
  const { url } = splitUrlHeaders(raw);
  if (!url) return '';
  const protocol = guessProtocol(url);
  if (protocol === 'udp' || protocol === 'rtp') {
    return url.toLowerCase().replace(/@/g, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }
    const params = [...parsed.searchParams.entries()].filter(([key]) => !EPHEMERAL_PARAMS.has(key.toLowerCase()));
    params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    let path = parsed.pathname.replace(/\/{2,}/g, '/');
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const search = params.length
      ? `?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
      : '';
    return `${parsed.protocol}//${parsed.host}${path}${search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** `host:port` identity, used to recognise the same origin serving many paths. */
export function originKeyOf(raw: string): string {
  const { url } = splitUrlHeaders(raw);
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${parsed.port || defaultPort(parsed.protocol)}`;
  } catch {
    return url.toLowerCase();
  }
}

function defaultPort(protocol: string): string {
  if (protocol === 'https:') return '443';
  if (protocol === 'rtsp:') return '554';
  if (protocol === 'rtmp:') return '1935';
  return '80';
}

/** SSRF guard for any URL fetched on behalf of a user. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

export function resolveRelative(base: string, ref: string): string {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

/** Validate a user supplied source URL (remote collection only). */
export function validateRemoteUrl(raw: string): { ok: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL 格式不正确' };
  }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, reason: '仅支持 http/https' };
  if (isPrivateHost(parsed.hostname)) return { ok: false, reason: '不允许内网地址（SSRF 防护）' };
  return { ok: true };
}
