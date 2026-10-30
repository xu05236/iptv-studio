import { describe, expect, it } from 'vitest';
import { cntvApiCode } from '../src/epg/cntv.js';

describe('cntvApiCode', () => {
  it('maps CCTV and supported satellite channels', () => {
    expect(cntvApiCode('cctv1')).toBe('cctv1');
    expect(cntvApiCode('hunan-weishi')).toBe('hunan');
    expect(cntvApiCode('dongfang-weishi')).toBe('dongfang');
    expect(cntvApiCode('beijing-weishi')).toBe('btv1');
  });

  it('returns null for channels without a confirmed CNTV code', () => {
    expect(cntvApiCode('hainan-weishi')).toBeNull();
    expect(cntvApiCode('x-unknown')).toBeNull();
  });
});
