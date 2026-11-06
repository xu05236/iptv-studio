import { describe, expect, it } from 'vitest';
import { sortUrlsByPriority } from '../src/pipeline/epg.js';

const urls = ['https://a.example/epg.xml', 'https://epg.pw/x.xml', 'https://fanmingming.com/e.xml'];

describe('EPG source priority', () => {
  it('orders known hosts by priority and keeps unknown last', () => {
    expect(sortUrlsByPriority(urls, ['fanmingming.com', 'epg.pw'])).toEqual([urls[2], urls[1], urls[0]]);
  });

  it('keeps the original order when no priority is configured', () => {
    expect(sortUrlsByPriority(urls, [])).toEqual(urls);
  });
});
