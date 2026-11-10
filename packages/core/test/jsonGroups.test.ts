import { describe, expect, it } from 'vitest';
import { parseJSONSource, parseSource } from '../src/parse/index.js';

const sample = JSON.stringify({
  groups: [
    {
      name: '央视',
      channels: [
        {
          id: 'c1',
          name: 'CCTV-1 综合',
          logo: '',
          sort: 1,
          sources: ['http://tzsswq.szbnrj.com:8080/proxy/ch.m3u8?sid=1&pid=2&defn=fhd'],
        },
        {
          id: 'c2',
          name: 'CCTV-5 体育',
          logo: '',
          sort: 2,
          sources: ['http://tzsswq.szbnrj.com:8080/proxy/ch.m3u8?sid=3', 'http://tzsswq.szbnrj.com:8080/proxy/ch.m3u8?sid=4'],
        },
      ],
    },
    {
      name: '卫视',
      channels: [{ id: 'c3', name: '北京卫视', logo: '', sort: 10, sources: ['http://tzsswq.szbnrj.com:8080/proxy/ch.m3u8?sid=5'] }],
    },
  ],
});

describe('grouped channel JSON (groups[].channels[].sources[])', () => {
  it('detects JSON and keeps channel names and groups', () => {
    const parsed = parseSource(sample, 'auto');
    expect(parsed.kind).toBe('json');
    expect(parsed.entries.map((entry) => ({ name: entry.name, group: entry.group }))).toEqual([
      { name: 'CCTV-1 综合', group: '央视' },
      { name: 'CCTV-5 体育', group: '央视' },
      { name: 'CCTV-5 体育', group: '央视' },
      { name: '北京卫视', group: '卫视' },
    ]);
    expect(parsed.entries.map((entry) => entry.url)).toEqual([
      'http://tzsswq.szbnrj.com:8080/proxy/ch.m3u8?sid=1&pid=2&defn=fhd',
      'http://tzsswq.szbnrj.com:8080/proxy/ch.m3u8?sid=3',
      'http://tzsswq.szbnrj.com:8080/proxy/ch.m3u8?sid=4',
      'http://tzsswq.szbnrj.com:8080/proxy/ch.m3u8?sid=5',
    ]);
  });

  it('never names entries after the "sources" key', () => {
    const parsed = parseJSONSource(sample);
    expect(parsed.entries.some((entry) => entry.name === 'sources')).toBe(false);
  });

  it('still parses a plain array of entries', () => {
    const parsed = parseJSONSource(JSON.stringify([{ name: 'CCTV-1', url: 'http://example.com/1.m3u8' }]));
    expect(parsed.entries).toEqual([expect.objectContaining({ name: 'CCTV-1', url: 'http://example.com/1.m3u8' })]);
  });
});
