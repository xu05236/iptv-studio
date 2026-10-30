import { describe, expect, it } from 'vitest';
import { probeLiveness } from '../src/probe/liveness.js';

describe('probeLiveness', () => {
  it('treats non-HTTP protocols as inconclusive instead of failing them', async () => {
    const result = await probeLiveness('rtsp://example.com/live/stream');
    expect(result.inconclusive).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.error).toContain('无法在 HTTP');
  });
});
