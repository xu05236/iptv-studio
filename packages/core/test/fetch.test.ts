import { describe, expect, it, vi } from 'vitest';
import { fetchText } from '../src/source/fetch.js';

const ok = (body = '#EXTM3U\n#EXTINF:-1,Test\nhttps://a/b.m3u8', headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers });

describe('fetchText', () => {
  it('304 返回 notModified，不发第二次请求', async () => {
    const impl = vi.fn(async () => new Response(null, { status: 304 }));
    const result = await fetchText('https://x/y.m3u', { etag: '"v1"', fetchImpl: impl as never });
    expect(result.ok).toBe(true);
    expect(result.notModified).toBe(true);
    expect(result.etag).toBe('"v1"');
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('5xx 按退避重试，最终成功', async () => {
    const impl = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad', { status: 502 }))
      .mockResolvedValueOnce(new Response('bad', { status: 502 }))
      .mockResolvedValueOnce(ok());
    const result = await fetchText('https://x/y.m3u', { retries: 2, retryDelayMs: 1, fetchImpl: impl as never });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it('4xx 不重试', async () => {
    const impl = vi.fn(async () => new Response('nope', { status: 404 }));
    const result = await fetchText('https://x/y.m3u', { retries: 2, retryDelayMs: 1, fetchImpl: impl as never });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('http_4xx');
    expect(result.attempts).toBe(1);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('429 属于可重试 4xx', async () => {
    const impl = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(ok());
    const result = await fetchText('https://x/y.m3u', { retries: 2, retryDelayMs: 1, fetchImpl: impl as never });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('Cloudflare 质询不重试并单独归类', async () => {
    const impl = vi.fn(async () => new Response('blocked', { status: 403, headers: { 'cf-mitigated': 'challenge' } }));
    const result = await fetchText('https://x/y.m3u', { retries: 2, retryDelayMs: 1, fetchImpl: impl as never });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('challenge');
    expect(result.attempts).toBe(1);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('5xx 归类为 http_5xx', async () => {
    const impl = vi.fn(async () => new Response('bad', { status: 502 }));
    const result = await fetchText('https://x/y.m3u', { retries: 0, fetchImpl: impl as never });
    expect(result.errorKind).toBe('http_5xx');
  });

  it('超时归类为 timeout 并重试', async () => {
    const impl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const result = await fetchText('https://x/y.m3u', { timeoutMs: 30, retries: 1, retryDelayMs: 1, fetchImpl: impl as never });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('timeout');
    expect(result.attempts).toBe(2);
  });

  it('超过 maxBytes 截断', async () => {
    const impl = vi.fn(async () => new Response('x'.repeat(100)));
    const result = await fetchText('https://x/y.m3u', { maxBytes: 10, fetchImpl: impl as never });
    expect(result.ok).toBe(true);
    expect(result.text?.length).toBe(10);
  });

  it('源级请求头覆盖默认 UA，保留条件请求', async () => {
    let seen: Record<string, string> = {};
    const impl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen = (init?.headers ?? {}) as Record<string, string>;
      return ok();
    });
    await fetchText('https://x/y.m3u', {
      etag: '"v2"',
      headers: { 'User-Agent': 'Custom/1.0', Referer: 'https://site.example/' },
      fetchImpl: impl as never,
    });
    expect(seen['User-Agent']).toBe('Custom/1.0');
    expect(seen.Referer).toBe('https://site.example/');
    expect(seen['If-None-Match']).toBe('"v2"');
  });
});
