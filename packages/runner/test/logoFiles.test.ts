import { describe, expect, it } from 'vitest';
import { matchLogoFile, normalizeLogoName } from '../src/pipeline/logoFiles.js';

describe('logo file matching', () => {
  const files = ['金鹰卡通.png', '湖南电影.png', 'TVBS亚洲.png', 'CCTV1.png', '新疆卫视.png', '精选.png'];

  it('normalizes resolution and punctuation', () => {
    expect(normalizeLogoName('金鹰卡通 (576p)')).toBe('金鹰卡通');
    expect(normalizeLogoName('TVBS 亚洲')).toBe('tvbs亚洲');
  });

  it('matches exact names before contains', () => {
    expect(matchLogoFile('金鹰卡通 (576p)', files)).toBe('金鹰卡通.png');
    expect(matchLogoFile('TVBS亚洲', files)).toBe('TVBS亚洲.png');
    expect(matchLogoFile('湖南电影', files)).toBe('湖南电影.png');
  });

  it('returns undefined when nothing is close', () => {
    expect(matchLogoFile('乐至综合', files)).toBeUndefined();
    expect(matchLogoFile('2021精选5首DJ', files)).toBeUndefined();
  });
});
