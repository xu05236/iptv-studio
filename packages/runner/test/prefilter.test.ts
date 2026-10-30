import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type LineEntry } from '@iptv/core';
import { prefilterLiveness } from '../src/pipeline/liveness.js';
import type { RunLogger } from '../src/logger.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RunLogger;

function line(url: string, key: string): LineEntry {
  return {
    key,
    sourceId: 's1',
    channelId: 'cctv1',
    name: 'CCTV1',
    url,
    urlKey: key,
    protocol: 'hls',
    status: 'unknown',
    failCount: 0,
    score: 0,
    firstSeenAt: '2026-10-01T00:00:00Z',
    lastSeenAt: '2026-10-01T00:00:00Z',
    tags: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prefilterLiveness', () => {
  it('blocks dead pending URLs and lets valid manifests through', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('dead')) return new Response('', { status: 404 });
      return new Response('#EXTM3U\n#EXTINF:10,\nsegment.ts\n', { status: 200 });
    }));

    const lines = [line('https://host/live/ok.m3u8', 'ok'), line('https://host/live/dead.m3u8', 'dead')];
    const blocked = await prefilterLiveness(lines, { ...DEFAULT_SETTINGS, probePrefilterEnabled: true, probePrefilterBudget: 10 }, 2, logger);

    expect(blocked.has('dead')).toBe(true);
    expect(blocked.has('ok')).toBe(false);
    expect(lines[1]?.status).toBe('suspect');
    expect(lines[1]?.lastLivenessAt).toBeTruthy();
    expect(lines[0]?.status).toBe('unknown');
  });

  it('does nothing when the prefilter is disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const blocked = await prefilterLiveness([line('https://host/a.m3u8', 'a')], { ...DEFAULT_SETTINGS, probePrefilterEnabled: false }, 2, logger);
    expect(blocked.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
