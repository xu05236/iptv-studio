import { describe, expect, it } from 'vitest';
import { ChannelRegistry } from '@iptv/core';
import { beijingDay, cctvFallbackUrl, fetchCctvFallback, parseCctvFallbackPayload } from '../src/pipeline/cctvFallback.js';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

const payload = {
  data: {
    cctv1: {
      channelName: 'CCTV-1 综合',
      list: [
        { title: '晚间新闻', startTime: 1793899830, endTime: 1793901750 },
        { title: '新闻联播', startTime: 1793962800, endTime: 1793965165 },
        { title: '', startTime: 1, endTime: 2 },
      ],
    },
  },
};

describe('cctv fallback', () => {
  it('parses the channel-day payload and drops broken entries', () => {
    const parsed = parseCctvFallbackPayload(payload, 'cctv1', 'cctv1')!;
    expect(parsed.channel.names[0]).toBe('CCTV-1 综合');
    expect(parsed.programmes).toHaveLength(2);
    expect(parsed.programmes[0]!.start).toBe(1793899830000);
    expect(parsed.programmes[0]!.stop).toBe(1793901750000);
  });

  it('uses the Beijing calendar day in the URL', () => {
    expect(beijingDay(new Date('2026-11-06T16:00:00Z'))).toBe('20261107');
    expect(cctvFallbackUrl('cctv1', new Date('2026-11-06T04:00:00Z'))).toContain('d=20261106');
  });

  it('fetches only uncovered CCTV channels', async () => {
    const registry = new ChannelRegistry([{ id: 'cctv1', name: 'CCTV-1 综合' }]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const covered = await fetchCctvFallback(registry, new Set(['cctv1']), logger, { fetchImpl, now: new Date('2026-11-06T04:00:00Z') });
    expect(covered.attempted).toBe(0);
    expect(calls).toHaveLength(0);

    const result = await fetchCctvFallback(registry, new Set(), logger, { fetchImpl, now: new Date('2026-11-06T04:00:00Z') });
    expect(result.attempted).toBe(1);
    expect(result.channels[0]!.id).toBe('cctv1');
    expect(result.programmes).toHaveLength(2);
  });

  it('keeps going when one channel fails', async () => {
    const registry = new ChannelRegistry([
      { id: 'cctv1', name: 'CCTV-1 综合' },
      { id: 'cctv2', name: 'CCTV-2 财经' },
    ]);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return new Response(JSON.stringify({ data: { cctv2: { channelName: 'CCTV-2 财经', list: [{ title: 'x', startTime: 10, endTime: 20 }] } } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchCctvFallback(registry, new Set(), logger, { fetchImpl, concurrency: 1 });
    expect(result.attempted).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.channels).toHaveLength(1);
  });
});
