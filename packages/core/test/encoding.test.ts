import { describe, expect, it } from 'vitest';
import { decodeSourceText } from '../src/source/encoding.js';
import { fetchText } from '../src/source/fetch.js';

// 「频道」的 GBK 字节；UTF-8 解码会抛错，正好覆盖 F4 的回落路径。
const GBK_CHANNEL = new Uint8Array([0xc6, 0xb5, 0xb5, 0xc0]);
const UTF8_CHANNEL = new TextEncoder().encode('频道');

describe('decodeSourceText', () => {
  it('honours a declared GBK charset', () => {
    const decoded = decodeSourceText(GBK_CHANNEL, 'text/plain; charset=gbk');
    expect(decoded.text).toBe('频道');
    expect(decoded.encoding).toBe('gbk');
  });

  it('normalizes gb2312 to gbk', () => {
    expect(decodeSourceText(GBK_CHANNEL, 'application/octet-stream; charset=GB2312').encoding).toBe('gbk');
  });

  it('decodes UTF-8 by default', () => {
    const decoded = decodeSourceText(UTF8_CHANNEL, 'application/x-mpegURL');
    expect(decoded.text).toBe('频道');
    expect(decoded.encoding).toBe('utf-8');
  });

  it('falls back to GBK when UTF-8 decoding fails', () => {
    const decoded = decodeSourceText(GBK_CHANNEL, 'text/plain');
    expect(decoded.text).toBe('频道');
    expect(decoded.encoding).toBe('gbk');
  });

  it('strips a UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...UTF8_CHANNEL]);
    const decoded = decodeSourceText(bytes, 'text/plain; charset=utf-8');
    expect(decoded.text).toBe('频道');
    expect(decoded.encoding).toBe('utf-8');
  });

  it('fetchText reports the decoding it used', async () => {
    const impl = async () => new Response(GBK_CHANNEL, { status: 200, headers: { 'content-type': 'text/plain; charset=gbk' } });
    const result = await fetchText('https://x/y.m3u', { fetchImpl: impl as never });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('频道');
    expect(result.encoding).toBe('gbk');
  });
});
