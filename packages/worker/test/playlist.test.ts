import { describe, expect, it } from 'vitest';
import { buildFromCatalog, buildFromPool, buildFromPools, playlistEtag, subscriptionFromRow, type SubscriptionConfig } from '../src/lib/playlist.js';
import type { ExportCatalog } from '../src/lib/catalog.js';
import type { LineOverrideRow, SubscriptionRow } from '../src/db.js';
import type { LineEntry, PoolSnapshot } from '@iptv/core';

function line(url: string, score: number): LineEntry {
  return {
    key: url,
    sourceId: 's1',
    channelId: 'cctv1',
    name: 'CCTV1',
    url,
    urlKey: url,
    protocol: 'hls',
    status: 'alive',
    failCount: 0,
    resolution: '1920x1080',
    height: 1080,
    speedKbps: score * 40,
    score,
    tags: [],
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
  };
}

const catalog: ExportCatalog = {
  version: 1,
  runId: 'run-1',
  generatedAt: '2026-10-27T04:00:00.000Z',
  items: [
    {
      channel: { id: 'cctv1', name: 'CCTV-1 综合', group: '央视', tvgId: 'CCTV1', aliases: [] },
      lines: [line('http://a/1.m3u8', 90), line('http://b/1.m3u8', 70)],
    },
    {
      channel: { id: 'hunan-weishi', name: '湖南卫视', group: '卫视', aliases: [] },
      lines: [line('http://c/hunan.m3u8', 80)],
    },
  ],
};

const row: SubscriptionRow = {
  id: 'sub-1',
  name: '测试订阅',
  token: 'a'.repeat(32),
  enabled: 1,
  groups: JSON.stringify(['央视']),
  exclude_groups: '[]',
  channel_ids: '[]',
  min_resolution: 'any',
  min_speed_kbps: 0,
  protocols: '[]',
  max_lines_per_channel: 2,
  show_region_suffix: 1,
  include_epg: 1,
  format: 'm3u',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('subscription rendering', () => {
  it('filters by group and writes the EPG url', () => {
    const config = subscriptionFromRow(row);
    const result = buildFromCatalog(catalog, config, { epgUrl: 'https://iptv/epg/a.xml' });
    expect(result.channels).toBe(1);
    expect(result.lines).toBe(2);
    expect(result.body).toContain('#EXTM3U url-tvg="https://iptv/epg/a.xml"');
    expect(result.body).toContain('CCTV-1 综合');
    expect(result.body).not.toContain('湖南卫视');
  });

  it('caps lines per channel and keeps the best one first', () => {
    const config = subscriptionFromRow({ ...row, groups: '[]', max_lines_per_channel: 1 });
    const result = buildFromCatalog(catalog, config, {});
    expect(result.lines).toBe(2);
    expect(result.body).toContain('http://a/1.m3u8');
    expect(result.body).not.toContain('http://b/1.m3u8');
  });

  it('changes the ETag when the subscription changes', () => {
    const one = playlistEtag(catalog, subscriptionFromRow(row));
    const two = playlistEtag(catalog, subscriptionFromRow({ ...row, groups: JSON.stringify(['卫视']) }));
    expect(one).not.toBe(two);
    expect(one).toContain('run-1');
  });

  it('drops tombstoned URLs from pool rendering', () => {
    const poolLine = line('http://a/1.m3u8', 90);
    const snapshot: PoolSnapshot = {
      generatedAt: '2026-10-30T00:00:00Z',
      channels: {
        cctv1: {
          channel: { id: 'cctv1', name: 'CCTV-1 综合', group: '央视', tvgId: 'CCTV1' },
          premium: [poolLine],
          backup: [],
          candidate: [],
        },
      },
    };
    const config: SubscriptionConfig = {
      id: 'sub-test',
      name: 'test',
      token: 'token',
      enabled: true,
      groups: [],
      excludeGroups: [],
      channelIds: [],
      minResolution: 'any',
      minSpeedKbps: 0,
      protocols: [],
      maxLinesPerChannel: 6,
      showRegionSuffix: false,
      includeEpg: false,
      format: 'm3u',
      poolMode: 'premium',
    };
    expect(buildFromPool(snapshot, [], config).lines).toBe(1);
    expect(buildFromPool(snapshot, [], config, {}, new Set([poolLine.url])).lines).toBe(0);
  });
});

describe('custom pool rendering', () => {
  const premium = line('http://a/1.m3u8', 90);
  const backup = line('http://b/1.m3u8', 70);
  const candidate = { ...line('http://c/hunan.m3u8', 60), channelId: 'hunan-weishi' };
  const snapshot: PoolSnapshot = {
    generatedAt: '2026-10-30T00:00:00Z',
    channels: {
      cctv1: {
        channel: { id: 'cctv1', name: 'CCTV-1 综合', group: '央视', tvgId: 'CCTV1' },
        premium: [premium],
        backup: [backup],
        candidate: [],
      },
      'hunan-weishi': {
        channel: { id: 'hunan-weishi', name: '湖南卫视', group: '卫视' },
        premium: [],
        backup: [],
        candidate: [candidate],
      },
    },
  };
  const base: SubscriptionConfig = {
    id: 'sub-pools',
    name: 'pools',
    token: 'token',
    enabled: true,
    groups: ['卫视'],
    excludeGroups: [],
    channelIds: [],
    minResolution: 'any',
    minSpeedKbps: 0,
    protocols: [],
    maxLinesPerChannel: 99,
    showRegionSuffix: false,
    includeEpg: false,
    format: 'm3u',
    poolMode: 'pools',
    poolIds: ['premium', 'backup'],
    filterMode: 'none',
  };

  it('exports every selected line when filters are off, even when the group filter would exclude it', () => {
    const result = buildFromPools(snapshot, [], base, new Map());
    expect(result.channels).toBe(1);
    expect(result.lines).toBe(2);
    expect(result.body).toContain('http://a/1.m3u8');
    expect(result.body).toContain('http://b/1.m3u8');
    expect(result.body).not.toContain('湖南卫视');
  });

  it('includes custom pool members regardless of their automatic bucket', () => {
    const result = buildFromPools(
      snapshot,
      [],
      { ...base, poolIds: ['pool-pick'], groups: [], filterMode: 'none' },
      new Map([['pool-pick', new Set([candidate.key])]]),
    );
    expect(result.channels).toBe(1);
    expect(result.lines).toBe(1);
    expect(result.body).toContain('http://c/hunan.m3u8');
  });

  it('applies the saved filters when filterMode is not none', () => {
    const result = buildFromPools(snapshot, [], { ...base, poolIds: ['premium', 'backup', 'candidate'], filterMode: 'inherit' }, new Map());
    expect(result.channels).toBe(1);
    expect(result.lines).toBe(1);
    expect(result.body).toContain('http://c/hunan.m3u8');
    expect(result.body).not.toContain('http://a/1.m3u8');
  });

  it('honours line overrides when matching built-in pools', () => {
    const overrides: LineOverrideRow[] = [{ line_key: premium.key, pool: 'rejected', channel_id: 'cctv1', reason: null, updated_at: '2026-10-31T00:00:00Z' }];
    const result = buildFromPools(snapshot, overrides, base, new Map());
    expect(result.lines).toBe(1);
    expect(result.body).not.toContain('http://a/1.m3u8');
    expect(result.body).toContain('http://b/1.m3u8');
  });
});

describe('merged channel export rules', () => {
  const normal = line('http://normal/1.m3u8', 90);
  const mergedLines = [
    { ...line('http://huya/1.m3u8', 80), channelId: 'x-mc-src-huya' },
    { ...line('http://huya/2.m3u8', 70), channelId: 'x-mc-src-huya' },
    { ...line('http://huya/3.m3u8', 60), channelId: 'x-mc-src-huya' },
  ];
  const snapshot: PoolSnapshot = {
    generatedAt: '2026-11-12T00:00:00Z',
    channels: {
      cctv1: {
        channel: { id: 'cctv1', name: 'CCTV-1 综合', group: '央视', tvgId: 'CCTV1' },
        premium: [normal],
        backup: [],
        candidate: [],
      },
      'x-mc-src-huya': {
        channel: { id: 'x-mc-src-huya', name: '虎牙直播', group: '影视频道' },
        premium: mergedLines,
        backup: [],
        candidate: [],
      },
    },
  };
  const base: SubscriptionConfig = {
    id: 'sub-merged',
    name: 'merged',
    token: 'token',
    enabled: true,
    groups: [],
    excludeGroups: [],
    channelIds: [],
    minResolution: 'any',
    minSpeedKbps: 0,
    protocols: [],
    maxLinesPerChannel: 0,
    showRegionSuffix: false,
    includeEpg: false,
    format: 'm3u',
    poolMode: 'pools',
    poolIds: ['premium'],
    filterMode: 'none',
  };

  it('excludes merged channels when mergedMode is exclude', () => {
    const result = buildFromPools(snapshot, [], { ...base, mergedMode: 'exclude' }, new Map());
    expect(result.channels).toBe(1);
    expect(result.body).toContain('CCTV-1');
    expect(result.body).not.toContain('虎牙直播');
  });

  it('exports only merged channels when mergedMode is only', () => {
    const result = buildFromPools(snapshot, [], { ...base, mergedMode: 'only' }, new Map());
    expect(result.channels).toBe(1);
    expect(result.lines).toBe(3);
    expect(result.body).toContain('虎牙直播');
    expect(result.body).not.toContain('CCTV-1');
  });

  it('caps merged lines independently of maxLinesPerChannel', () => {
    const result = buildFromPools(snapshot, [], { ...base, mergedMaxLines: 2 }, new Map());
    expect(result.lines).toBe(3);
    expect(result.body).toContain('http://huya/2.m3u8');
    expect(result.body).not.toContain('http://huya/3.m3u8');
  });
});
