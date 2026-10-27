import { createMiddleware } from 'hono/factory';
import type { AppEnv, Env } from '../env.js';
import { fail } from './http.js';

const encoder = new TextEncoder();

function secretOf(env: Env): string {
  const secret = env.SESSION_SECRET || env.ADMIN_TOKEN;
  if (!secret) throw new Error('ADMIN_TOKEN 未配置');
  return `${secret}::iptv-studio-session`;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return toBase64Url(new Uint8Array(signature));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

export async function issueSession(env: Env, ttlSeconds = 7 * 86_400): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: 'admin', iat: now, exp: now + ttlSeconds };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  return `v1.${body}.${await sign(secretOf(env), body)}`;
}

export async function verifySession(env: Env, token: string): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const [, body, signature] = parts;
  if (!body || !signature) return false;
  const expected = await sign(secretOf(env), body);
  if (!timingSafeEqual(expected, signature)) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as { exp?: number };
    return typeof payload.exp === 'number' && payload.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

export function checkAdminToken(env: Env, token: string): boolean {
  return Boolean(env.ADMIN_TOKEN) && timingSafeEqual(token, env.ADMIN_TOKEN!);
}

/**
 * Accepts either a short-lived session (browser) or the raw admin token
 * (GitHub Actions / curl). Keeping both means the runner never needs a login
 * round-trip and the browser never stores the master token.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const serviceToken = c.req.header('x-admin-token') ?? '';

  if ((serviceToken && checkAdminToken(c.env, serviceToken)) || (bearer && checkAdminToken(c.env, bearer))) {
    c.set('actor', 'service');
    return next();
  }
  if (bearer && (await verifySession(c.env, bearer))) {
    c.set('actor', 'admin');
    return next();
  }
  return fail('未授权：请提供有效的管理令牌', 401, 'unauthorized');
});
