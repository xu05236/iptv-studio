import { describe, expect, it } from 'vitest';
import { applyProxyMode } from '../src/lib/proxyRewrite.js';
import { signProxyUrl, verifyProxySignature } from '../src/lib/relaySign.js';

const env = { ADMIN_TOKEN: 'test-admin-token', SESSION_SECRET: 'test-session' } as never;

describe('proxy rewrite', () => {
  it('rewrites only bare URLs in M3U, keeping tags and attributes intact', async () => {
    const input = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="CCTV1" tvg-logo="https://logos.example/cctv1.png" group-title="央视",CCTV-1',
      'https://cdn.example/live/cctv1.m3u8?token=abc',
      '#EXTINF:-1 group-title="卫视",湖南卫视',
      'https://cdn.example/live/hunan.m3u8',
    ].join('\n');
    const output = await applyProxyMode(input, 'm3u', async (url) => `/relay/proxy?u=${encodeURIComponent(url)}`);
    const lines = output.split('\n');
    expect(lines[1]).toContain('tvg-logo="https://logos.example/cctv1.png"');
    expect(lines[2]).toBe('/relay/proxy?u=https%3A%2F%2Fcdn.example%2Flive%2Fcctv1.m3u8%3Ftoken%3Dabc');
    expect(lines[4]).toBe('/relay/proxy?u=https%3A%2F%2Fcdn.example%2Flive%2Fhunan.m3u8');
  });

  it('rewrites only the url field in JSON playlists', async () => {
    const input = JSON.stringify({
      name: 'x',
      channels: [{ name: 'CCTV-1', url: 'https://cdn.example/cctv1.m3u8', logo: 'https://logo/a.png' }],
    });
    const output = await applyProxyMode(input, 'json', async (url) => `/relay/proxy?u=${encodeURIComponent(url)}`);
    const parsed = JSON.parse(output) as { channels: Array<{ url: string; logo: string }> };
    expect(parsed.channels[0]!.url).toMatch(/^\/relay\/proxy/);
    expect(parsed.channels[0]!.logo).toBe('https://logo/a.png');
  });

  it('leaves diyp and txt formats untouched', async () => {
    const body = 'https://cdn.example/a.m3u8';
    expect(await applyProxyMode(body, 'diyp', async () => 'X')).toBe(body);
  });
});

describe('relay signature', () => {
  it('round-trips a signed proxy url and rejects tampering', async () => {
    const target = 'https://cdn.example/live/cctv1.m3u8?token=abc';
    const url = await signProxyUrl(env, 'https://iptv.example', target, 'sub-token-1', 'full');
    const parsed = new URL(url, 'https://iptv.example');
    const exp = Number(parsed.searchParams.get('exp'));
    const sig = parsed.searchParams.get('sig') ?? '';
    expect(await verifyProxySignature(env, target, exp, 'sub-token-1', 'full', sig)).toBe(true);
    expect(await verifyProxySignature(env, target, exp, 'sub-token-2', 'full', sig)).toBe(false);
    expect(await verifyProxySignature(env, target, exp, 'sub-token-1', 'playlist', sig)).toBe(false);
    expect(await verifyProxySignature(env, 'https://evil.example/x.m3u8', exp, 'sub-token-1', 'full', sig)).toBe(false);
  });
});
