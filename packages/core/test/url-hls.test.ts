import { describe, expect, it } from 'vitest';
import { parseHlsManifest, pickBestVariant } from '../src/probe/hls.js';
import { qualityFromHeight, qualityFromResolution } from '../src/probe/measure.js';
import { isPrivateHost, normalizeUrlForDedupe, splitUrlHeaders, validateRemoteUrl } from '../src/util/url.js';

const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,FRAME-RATE=25.000,CODECS="avc1.4d401f,mp4a.40.2"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,FRAME-RATE=50.000
1080p/index.m3u8
`;

const media = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-VERSION:3
#EXTINF:6.0,
seg/1.ts
#EXTINF:5.5,
seg/2.ts
#EXT-X-ENDLIST
`;

describe('HLS manifest', () => {
  it('parses master playlists and picks the best rendition', () => {
    const parsed = parseHlsManifest(master, 'https://cdn/live/master.m3u8');
    expect(parsed?.type).toBe('master');
    expect(parsed?.variants).toHaveLength(2);
    const best = pickBestVariant(parsed!.variants);
    expect(best?.width).toBe(1920);
    expect(best?.bandwidthKbps).toBe(4000);
    expect(best?.uri).toBe('https://cdn/live/1080p/index.m3u8');
  });

  it('parses media playlists, durations and end list', () => {
    const parsed = parseHlsManifest(media, 'https://cdn/live/720p/index.m3u8');
    expect(parsed?.type).toBe('media');
    expect(parsed?.segments).toHaveLength(2);
    expect(parsed?.totalDuration).toBe(11.5);
    expect(parsed?.endList).toBe(true);
    expect(parsed?.segments[0]!.uri).toBe('https://cdn/live/720p/seg/1.ts');
  });

  it('rejects non-HLS bodies', () => {
    expect(parseHlsManifest('<html>nope</html>', 'https://a/b.m3u8')).toBeNull();
  });
});

describe('quality mapping', () => {
  it('maps heights and resolutions', () => {
    expect(qualityFromHeight(2160)).toBe('2160p');
    expect(qualityFromHeight(1080)).toBe('1080p');
    expect(qualityFromResolution('1920x1080')).toBe('1080p');
    expect(qualityFromResolution('unknown')).toBe('unknown');
  });
});

describe('URL normalisation', () => {
  it('drops ephemeral params and sorts the rest', () => {
    const a = normalizeUrlForDedupe('HTTP://CDN.example.com:80/live/a.m3u8?token=1&b=2&a=1');
    const b = normalizeUrlForDedupe('http://cdn.example.com/live/a.m3u8?a=1&b=2&token=999');
    expect(a).toBe(b);
    expect(a).toBe('http://cdn.example.com/live/a.m3u8?a=1&b=2');
  });

  it('keeps different paths apart', () => {
    expect(normalizeUrlForDedupe('http://a/1.m3u8')).not.toBe(normalizeUrlForDedupe('http://a/2.m3u8'));
  });

  it('splits Kodi style request headers', () => {
    const parsed = splitUrlHeaders('http://a/1.m3u8|User-Agent=VLC&Referer=http://ref/');
    expect(parsed.url).toBe('http://a/1.m3u8');
    expect(parsed.headers.userAgent).toBe('VLC');
    expect(parsed.headers.referer).toBe('http://ref/');
  });
});

describe('SSRF guard', () => {
  it('blocks private and loopback hosts', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('10.1.2.3')).toBe(true);
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('169.254.169.254')).toBe(true);
    expect(isPrivateHost('example.com')).toBe(false);
    expect(validateRemoteUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateRemoteUrl('http://127.0.0.1/a').ok).toBe(false);
    expect(validateRemoteUrl('https://example.com/a.m3u').ok).toBe(true);
  });
});
