import type { Env } from '../env.js';

export type ProxyMode = 'direct' | 'playlist' | 'full';

const encoder = new TextEncoder();
/** Exported subscription URLs are baked into artifacts, so keep the TTL long. */
export const PROXY_URL_TTL_SECONDS = 7 * 24 * 3600;

export function proxyModeOf(value: unknown): ProxyMode {
  return value === 'playlist' || value === 'full' ? value : 'direct';
}

export function relaySecret(env: Env): string {
  // Runner signs with ADMIN_TOKEN (the only shared secret it has), so prefer it
  // here as well; SESSION_SECRET is the fallback for local dev.
  return env.ADMIN_TOKEN || env.SESSION_SECRET || 'iptv-studio-relay';
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return base64Url(new Uint8Array(signature));
}

function signatureData(target: string, expires: number, token: string, mode: ProxyMode): string {
  return `${target}|${expires}|${token}|${mode}`;
}

/** Sign a proxied URL; the HMAC binds the upstream URL, subscription token, mode and expiry. */
export async function signProxyUrl(
  env: Env,
  origin: string,
  target: string,
  token: string,
  mode: ProxyMode,
  ttlSeconds = PROXY_URL_TTL_SECONDS,
): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = await hmac(relaySecret(env), signatureData(target, expires, token, mode));
  const url = new URL(`${origin.replace(/\/+$/, '')}/relay/proxy`);
  url.searchParams.set('u', target);
  url.searchParams.set('exp', String(expires));
  url.searchParams.set('sig', signature);
  url.searchParams.set('token', token);
  url.searchParams.set('mode', mode);
  return url.toString();
}

export async function verifyProxySignature(
  env: Env,
  target: string,
  expires: number,
  token: string,
  mode: ProxyMode,
  signature: string,
): Promise<boolean> {
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  return (await hmac(relaySecret(env), signatureData(target, expires, token, mode))) === signature;
}
