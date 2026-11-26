import { describe, expect, it } from 'vitest';
import { trimEpgData } from '../src/epg/trim.js';
import type { EpgData } from '../src/epg/xmltv.js';

const now = Date.UTC(2026, 10, 26, 4, 0, 0);
const hour = 3_600_000;

function data(): EpgData {
  return {
    channels: [
      { id: 'a', names: ['A'] },
      { id: 'b', names: ['B'] },
      { id: 'c', names: ['C'] },
    ],
    programmes: [
      { channelId: 'a', start: now - 3 * hour, title: 'old-a' },
      { channelId: 'a', start: now - hour, title: 'a1' },
      { channelId: 'a', start: now + 2 * hour, title: 'a2' },
      { channelId: 'a', start: now + 20 * hour, title: 'a3' },
      { channelId: 'b', start: now + 4 * hour, title: 'b1' },
      { channelId: 'c', start: now + 1 * hour, title: 'c1' },
    ],
  };
}

describe('trimEpgData', () => {
  it('keeps only programmes in the window and drops empty channels', () => {
    const trimmed = trimEpgData(data(), { now, hours: 12, lookbackHours: 1, maxProgrammesPerChannel: 48 });
    expect(trimmed.programmes.map((item) => item.title)).toEqual(['a1', 'c1', 'a2', 'b1']);
    expect(trimmed.channels.map((channel) => channel.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops channels with no programme left in the window', () => {
    const onlyFuture = trimEpgData(
      {
        channels: data().channels,
        programmes: [{ channelId: 'a', start: now + 20 * hour, title: 'a3' }],
      },
      { now, hours: 12, lookbackHours: 1 },
    );
    expect(onlyFuture.channels).toEqual([]);
  });

  it('caps programmes per channel from the earliest one', () => {
    const programmes = Array.from({ length: 6 }, (_, index) => ({
      channelId: 'a',
      start: now + index * hour,
      title: `p${index}`,
    }));
    const trimmed = trimEpgData({ channels: [{ id: 'a', names: ['A'] }], programmes }, { now, hours: 12, maxProgrammesPerChannel: 3 });
    expect(trimmed.programmes.map((item) => item.title)).toEqual(['p0', 'p1', 'p2']);
  });
});
