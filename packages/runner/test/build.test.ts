import { describe, expect, it } from 'vitest';
import { buildArtifacts } from '../src/pipeline/publish.js';
import type { ArtifactStore } from '../src/store.js';
import {
  BUILTIN_CHANNELS,
  ChannelRegistry,
  DEFAULT_SETTINGS,
  bucketOf,
  type LineEntry,
  type Rule,
} from '@iptv/core';
import { publish } from '../src/pipeline/publish.js';

function line(overrides: Partial<LineEntry>): LineEntry {
  return {
    key: Math.random().toString(36),
    sourceId: 's1',
    channelId: 'cctv1',
    name: 'CCTV1',
    url: 'http://a/1.m3u8',
    urlKey: 'http://a/1.m3u8',
    protocol: 'hls',
    status: 'alive',
    failCount: 0,
    resolution: '1920x1080',
    height: 1080,
    speedKbps: 3000,
    latencyMs: 40,
    score: 90,
    tags: [],
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
    lastProbeAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('buildArtifacts', () => {
  const registry = new ChannelRegistry(BUILTIN_CHANNELS);
  const settings = { ...DEFAULT_SETTINGS, maxLinesPerChannel: 3, maxLinesPerSource: 2 };

  it('merges duplicate lines and ranks by score', () => {
    const lines = [
      line({ key: '1', sourceId: 'a', score: 80 }),
      line({ key: '2', sourceId: 'b', score: 92, speedKbps: 6000, url: 'http://b/1.m3u8', urlKey: 'http://b/1.m3u8' }),
      line({ channelId: 'hunan-weishi', name: '湖南卫视', url: 'http://c/hunan.m3u8', urlKey: 'http://c/hunan.m3u8', key: '3', sourceId: 'a', score: 70 }),
    ];
    const output = buildArtifacts({
      runId: 'run-1',
      generatedAt: '2026-10-27T04:00:00.000Z',
      registry,
      lines,
      settings,
      rules: [],
      epg: { channels: [], programmes: [] },
    });

    expect(output.catalog.items).toHaveLength(2);
    const cctv = output.catalog.items.find((item) => item.channel.id === 'cctv1')!;
    expect(cctv.lines).toHaveLength(2);
    expect(cctv.lines[0]!.sourceId).toBe('b');
    expect(output.index.totalChannels).toBe(2);
    expect(output.index.aliveLines).toBe(3);
    expect(output.shards).toHaveLength(2);
    expect(output.channels.map((channel) => channel.id)).toContain('hunan-weishi');
  });

  it('applies rules that exclude groups', () => {
    const rules: Rule[] = [{
      id: 'r1',
      name: '过滤港澳台',
      enabled: true,
      priority: 10,
      match: { groups: ['港澳台'] },
      actions: { exclude: true },
    }];
    const lines = [
      line({ key: '1' }),
      line({ key: '2', channelId: 'tvb-jade', name: '翡翠台', url: 'http://d/jade.m3u8', urlKey: 'http://d/jade.m3u8' }),
    ];
    const output = buildArtifacts({
      runId: 'run-2',
      generatedAt: '2026-10-27T04:00:00.000Z',
      registry,
      lines,
      settings,
      rules,
      epg: { channels: [], programmes: [] },
    });
    expect(output.catalog.items.map((item) => item.channel.id)).toEqual(['cctv1']);
  });
});

describe('publish', () => {
  it('writes catalog, index, shards and logs', async () => {
    const written: Record<string, string> = {};
    const fakeR2 = {
      put: async (key: string, body: string) => {
        written[key] = body;
      },
    } as unknown as ArtifactStore;

    const registry = new ChannelRegistry(BUILTIN_CHANNELS);
    const output = buildArtifacts({
      runId: 'run-3',
      generatedAt: '2026-10-27T04:00:00.000Z',
      registry,
      lines: [line({ key: '1' })],
      settings: DEFAULT_SETTINGS,
      rules: [],
      epg: { channels: [], programmes: [] },
    });

    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;
    await publish(fakeR2, output, {
      lines: [line({ key: '1' })],
      epgXml: '<?xml version="1.0"?><tv></tv>',
      log: '{"ok":true}\n',
      runId: 'run-3',
      generatedAt: '2026-10-27T04:00:00.000Z',
    }, logger);

    expect(written['out/catalog.json']).toContain('"cctv1"');
    expect(written['state/index.json']).toContain('"totalChannels"');
    expect(written[`state/bucket/${bucketOf('cctv1')}.json`]).toContain('"lines"');
    expect(written['out/epg.xml']).toContain('<tv>');
    expect(written['logs/2026-10-27/run-3.jsonl']).toContain('"ok":true');
  });
});
