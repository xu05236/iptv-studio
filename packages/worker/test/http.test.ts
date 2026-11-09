import { describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import type { Env } from '../src/env.js';

const env = {
  COMMIT_SHA: 'abcdef1234567890',
  DEPLOYED_AT: '2026-11-09T00:00:00.000Z',
  ENVIRONMENT: 'test',
} as unknown as Env;

describe('public http routes', () => {
  it('reports the deployed commit at /api/version', async () => {
    const response = await app.request('/api/version', {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.commit).toBe('abcdef1234567890');
    expect(body.shortCommit).toBe('abcdef1');
    expect(body.deployedAt).toBe('2026-11-09T00:00:00.000Z');
    expect(body.environment).toBe('test');
  });

  it('falls back to dev when no commit is stamped', async () => {
    const response = await app.request('/api/version', {}, {} as Env);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.shortCommit).toBe('dev');
    expect(body.deployedAt).toBeNull();
  });

  it('answers /api/health', async () => {
    const response = await app.request('/api/health', {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it('returns a 404 shape for unknown api routes', async () => {
    const response = await app.request('/api/definitely-not-here', {}, env);
    expect(response.status).toBe(404);
  });

  it('requires auth for admin routes', async () => {
    const response = await app.request('/api/admin/me', {}, env);
    expect(response.status).toBe(401);
  });
});
