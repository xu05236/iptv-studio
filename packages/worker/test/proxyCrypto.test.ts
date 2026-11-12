import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.js';
import { decryptProxyPassword, encryptProxyPassword, maskProxyPassword } from '../src/lib/proxyCrypto.js';

const env = { ADMIN_TOKEN: 'test-admin-token' } as Env;

describe('proxyCrypto', () => {
  it('round-trips a password and never returns the plaintext blob', async () => {
    const blob = await encryptProxyPassword(env, 'p@ss-中文-123');
    expect(blob).not.toContain('p@ss');
    expect(await decryptProxyPassword(env, blob)).toBe('p@ss-中文-123');
  });

  it('keeps empty passwords empty', async () => {
    expect(await encryptProxyPassword(env, '')).toBe('');
    expect(await decryptProxyPassword(env, '')).toBe('');
  });

  it('returns an empty string for a corrupted payload instead of throwing', async () => {
    expect(await decryptProxyPassword(env, 'not-a-valid-blob')).toBe('');
    const blob = await encryptProxyPassword(env, 'secret');
    expect(await decryptProxyPassword(env, `${blob.slice(0, -4)}AAAA`)).toBe('');
  });

  it('masks the presence of a stored password', () => {
    expect(maskProxyPassword('')).toBe('');
    expect(maskProxyPassword('encrypted')).toBe('******');
  });
});
