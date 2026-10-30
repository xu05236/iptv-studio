import { describe, expect, it } from 'vitest';
import { channelLogo } from '../src/normalize/channels.js';

describe('channelLogo', () => {
  it('builds a jsDelivr URL for the retired fanmingming base', () => {
    expect(channelLogo({ tvgId: 'CCTV1', name: 'CCTV1' }, 'https://live.fanmingming.com/tv/'))
      .toBe('https://cdn.jsdelivr.net/gh/fanmingming/live@main/tv/CCTV1.png');
  });

  it('rewrites an explicit old fanmingming logo', () => {
    expect(channelLogo({ logo: 'https://live.fanmingming.com/tv/CCTV1.png', name: 'CCTV1' }))
      .toBe('https://cdn.jsdelivr.net/gh/fanmingming/live@main/tv/CCTV1.png');
  });

  it('keeps other explicit logos and returns undefined without tvg-id', () => {
    expect(channelLogo({ logo: 'https://example.com/a.png', name: 'A' })).toBe('https://example.com/a.png');
    expect(channelLogo({ name: 'A' })).toBeUndefined();
  });

  it('prefers the Worker proxy for generated and retired logos', () => {
    expect(channelLogo({ tvgId: 'CCTV1', name: 'CCTV1' }, null, 'https://host/api/public/logo'))
      .toBe('https://host/api/public/logo/CCTV1.png');
    expect(channelLogo({ logo: 'https://live.fanmingming.com/tv/CCTV1.png', tvgId: 'CCTV1', name: 'CCTV1' }, null, 'https://host/api/public/logo'))
      .toBe('https://host/api/public/logo/CCTV1.png');
    expect(channelLogo({ logo: 'https://example.com/custom.png', tvgId: 'CCTV1', name: 'CCTV1' }, null, 'https://host/api/public/logo'))
      .toBe('https://example.com/custom.png');
  });
});
