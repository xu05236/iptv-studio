import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@iptv/core';
import { loadRemoteConfig, type ApiClient } from '../src/store.js';

function fakeApi(overrides: Record<string, unknown> = {}): ApiClient {
  const responses: Record<string, unknown> = {
    '/api/admin/settings': { settings: {} as AppSettings },
    '/api/admin/sources': { items: [] },
    '/api/admin/channels': { items: [] },
    '/api/admin/channels/meta/aliases': { aliases: {} },
    '/api/admin/rules': { items: [] },
    ...overrides,
  };
  return { get: async (path: string) => responses[path] } as unknown as ApiClient;
}

const base = {
  kind: 'auto',
  url: null,
  origin: 'remote',
  priority: 100,
  weight: 1,
  region: null,
  operator: null,
  tags: '[]',
  etag: null,
  last_modified: null,
  reputation: 50,
  tier: 'normal' as const,
  r2_key: null,
  last_fetch_at: null,
  entry_count: 0,
  status: 'active',
};

describe('loadRemoteConfig', () => {
  it('drops disabled sources and sources auto-paused after repeated failures', async () => {
    const api = fakeApi({
      '/api/admin/sources': {
        items: [
          { ...base, id: 'enabled', name: 'ok', enabled: true },
          { ...base, id: 'disabled', name: 'off', enabled: false },
          { ...base, id: 'paused', name: 'paused', enabled: true, status: 'paused' },
        ],
      },
    });

    const config = await loadRemoteConfig(api);

    expect(config.sources.map((source) => source.id)).toEqual(['enabled']);
  });
});
