import { describe, expect, it } from 'vitest';
import { putArtifact } from '../src/lib/store.js';
import type { Env } from '../src/env.js';

function createKv() {
  const data = new Map<string, { bytes: Uint8Array; metadata: unknown }>();
  const calls = { list: 0, get: 0, put: 0 };
  const kv = {
    async list() {
      calls.list++;
      return { keys: [], list_complete: true, cursor: undefined };
    },
    async getWithMetadata(key: string) {
      calls.get++;
      const entry = data.get(key);
      if (!entry) return { value: null, metadata: null, cacheStatus: null };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(entry.bytes);
          controller.close();
        },
      });
      return { value: stream, metadata: entry.metadata, cacheStatus: null };
    },
    async put(key: string, value: Uint8Array, options?: { metadata?: unknown }) {
      calls.put++;
      data.set(key, { bytes: new Uint8Array(value), metadata: options?.metadata });
    },
  };
  return { kv, calls };
}

describe('putArtifact', () => {
  it('writes once without listing the namespace', async () => {
    const { kv, calls } = createKv();
    const env = { KV: kv } as unknown as Env;

    const first = await putArtifact(env, 'state/index.json', 'hello', 'application/json');

    expect(first.size).toBe(5);
    expect(calls).toEqual({ list: 0, get: 1, put: 1 });
  });

  it('skips the write when the etag and content type are unchanged', async () => {
    const { kv, calls } = createKv();
    const env = { KV: kv } as unknown as Env;

    const first = await putArtifact(env, 'state/index.json', 'hello', 'application/json');
    const second = await putArtifact(env, 'state/index.json', 'hello', 'application/json');

    expect(second.etag).toBe(first.etag);
    expect(calls).toEqual({ list: 0, get: 2, put: 1 });
  });

  it('rewrites when the bytes or content type change', async () => {
    const { kv, calls } = createKv();
    const env = { KV: kv } as unknown as Env;

    await putArtifact(env, 'state/index.json', 'hello', 'application/json');
    await putArtifact(env, 'state/index.json', 'hello!', 'application/json');
    await putArtifact(env, 'state/index.json', 'hello!', 'text/plain');

    expect(calls).toEqual({ list: 0, get: 3, put: 3 });
  });
});
