import type { Env } from '../env.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * PROXY_KEY wins when it is a base64 32-byte key. Otherwise derive one from
 * ADMIN_TOKEN so a fresh deployment still stores non-plaintext passwords; in
 * that fallback, rotating ADMIN_TOKEN makes existing passwords unreadable.
 */
async function loadKey(env: Env): Promise<CryptoKey> {
  const raw = env.PROXY_KEY?.trim();
  if (raw) {
    try {
      const bytes = base64ToBytes(raw);
      if (bytes.length === 32) return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    } catch {
      // Fall through to the derived key.
    }
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${env.ADMIN_TOKEN ?? ''}|iptv-proxy`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptProxyPassword(env: Env, plaintext: string): Promise<string> {
  if (!plaintext) return '';
  const key = await loadKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return bytesToBase64(combined);
}

export async function decryptProxyPassword(env: Env, blob: string): Promise<string> {
  if (!blob) return '';
  try {
    const key = await loadKey(env);
    const bytes = base64ToBytes(blob);
    if (bytes.length <= 12) return '';
    const iv = bytes.slice(0, 12);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes.slice(12));
    return decoder.decode(plaintext);
  } catch {
    return '';
  }
}

export function maskProxyPassword(value: string | null | undefined): string {
  return value ? '******' : '';
}
