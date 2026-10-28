import { Hono } from 'hono';
import { mapPool, normalizeUrlForDedupe, parseSource, probeStream, splitUrlHeaders, validateRemoteUrl, type ParsedSource, type SourceFilters } from '@iptv/core';
import type { AppEnv } from '../env.js';
import {
  deleteSource,
  getSource,
  insertSource,
  listSources,
  updateSource,
  audit,
} from '../db.js';
import { fail, isoNow, ok, parseJsonField, randomId, readJson } from '../lib/http.js';
import { fetchSourceText } from '../lib/fetcher.js';
import { getText, putText } from '../lib/r2.js';

export const sourceRoutes = new Hono<AppEnv>();

interface CreateSourceInput {
  name?: string;
  url?: string;
  content?: string;
  kind?: string;
  region?: string;
  operator?: string;
  priority?: number;
  enabled?: boolean;
  notes?: string;
  /** Store a remote URL without fetching it now; the runner fetches it later. */
  skipFetch?: boolean;
  filters?: SourceFilters;
}

sourceRoutes.get('/', async (c) => {
  const sources = await listSources(c.env);
  return ok({
    items: sources.map((source) => ({
      ...source,
      tags: parseJsonField<string[]>(source.tags, []),
      filters: parseJsonField<SourceFilters>(source.filters, {}),
      enabled: source.enabled === 1,
    })),
  });
});

sourceRoutes.get('/:id', async (c) => {
  const source = await getSource(c.env, c.req.param('id'));
  if (!source) return fail('直播源不存在', 404);
  return ok({ source: { ...source, tags: parseJsonField<string[]>(source.tags, []), filters: parseJsonField<SourceFilters>(source.filters, {}), enabled: source.enabled === 1 } });
});

sourceRoutes.get('/:id/content', async (c) => {
  const source = await getSource(c.env, c.req.param('id'));
  if (!source) return fail('直播源不存在', 404);
  if (!source.r2_key) return fail('该源为远程订阅，无本地内容', 404);
  const text = await getText(c.env, source.r2_key);
  if (text === null) return fail('内容文件不存在', 404);
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
});

sourceRoutes.post('/', async (c) => {
  const contentType = c.req.header('content-type') ?? '';
  let input: CreateSourceInput = {};

  if (contentType.includes('application/json')) {
    input = (await readJson<CreateSourceInput>(c)) ?? {};
  } else if (contentType.includes('multipart/form-data')) {
    const body = await c.req.parseBody();
    const file = body['file'];
    input = {
      name: typeof body['name'] === 'string' ? body['name'] : undefined,
      kind: typeof body['kind'] === 'string' ? body['kind'] : undefined,
      region: typeof body['region'] === 'string' ? body['region'] : undefined,
      operator: typeof body['operator'] === 'string' ? body['operator'] : undefined,
      content: file instanceof File ? await file.text() : typeof body['content'] === 'string' ? body['content'] : undefined,
    };
  } else {
    input = { content: await c.req.text(), name: c.req.query('name') ?? undefined, kind: c.req.query('kind') ?? undefined };
  }

  if (!input.url && !input.content) return fail('请提供订阅地址或文件/文本内容');
  if (input.content && input.content.length > 24 * 1024 * 1024) return fail('内容超过 24MB 限制', 413);

  const existingSources = await listSources(c.env);
  if (input.url) {
    const normalized = normalizeUrlForDedupe(input.url);
    const duplicate = existingSources.find((source) => source.url && normalizeUrlForDedupe(source.url) === normalized);
    if (duplicate) return fail(`该订阅已存在：${duplicate.name}`, 409);
  }

  if (input.url && input.skipFetch) {
    const id = `src-${randomId(8)}`;
    const pendingName = input.name?.trim() || new URL(input.url).hostname;
    await insertSource(c.env, {
      id,
      name: pendingName,
      kind: input.kind ?? 'auto',
      url: input.url,
      origin: 'remote',
      enabled: input.enabled === false ? 0 : 1,
      priority: Number(input.priority ?? 100),
      region: input.region ?? null,
      operator: input.operator ?? null,
      r2Key: null,
      notes: input.notes ?? '等待采集器抓取',
      filters: input.filters ?? null,
    });
    await audit(c.env, c.get('actor'), 'source.create.skip_fetch', id, { url: input.url });
    return ok(
      {
        source: await getSource(c.env, id),
        summary: { kind: input.kind ?? 'auto', entries: 0, groups: [], sample: [], warnings: ['已跳过预检，采集器会在下一轮抓取'] },
      },
      201,
    );
  }

  let text = input.content ?? '';
  let etag: string | null = null;
  let lastModified: string | null = null;
  let origin: 'remote' | 'upload' | 'paste' = 'paste';

  if (input.url) {
    const validation = validateRemoteUrl(input.url);
    if (!validation.ok) return fail(validation.reason ?? '订阅地址不合法');
    const fetched = await fetchSourceText(input.url);
    if (!fetched.ok || fetched.notModified) return fail(`抓取失败：${fetched.error ?? '未知错误'}。若源站限制 Cloudflare/海外 IP，可勾选「跳过预检」交给采集器抓取，或下载后上传文件。`);
    text = fetched.text ?? '';
    etag = fetched.etag ?? null;
    lastModified = fetched.lastModified ?? null;
    origin = 'remote';
  } else if (contentType.includes('multipart/form-data')) {
    origin = 'upload';
  }

  const contentHash = await sha256(text);
  const duplicateContent = existingSources.find((source) => source.content_hash === contentHash);
  if (duplicateContent) return fail(`相同内容已存在：${duplicateContent.name}`, 409);

  // Parsing a 1.5MB / 8000-entry playlist exceeds the Workers free CPU budget.
  // Store it now and let the runner parse it during collect.
  const parsed: ParsedSource | null = text.length <= 512 * 1024 ? parseSource(text, (input.kind as never) ?? 'auto') : null;
  if (parsed && !parsed.entries.length) {
    return fail(`解析失败：${parsed.warnings.join('；') || '未发现有效频道条目'}`, 422);
  }

  const id = `src-${randomId(8)}`;
  const name =
    input.name?.trim() ||
    (input.url ? new URL(input.url).hostname : `文本导入 ${new Date().toLocaleDateString('zh-CN')}`);

  const r2Key = origin === 'remote' ? null : `sources/${id}.txt`;
  if (r2Key) await putText(c.env, r2Key, text);

  await insertSource(c.env, {
    id,
    name,
    kind: input.kind ?? 'auto',
    url: input.url ?? null,
    origin,
    enabled: input.enabled === false ? 0 : 1,
    priority: Number(input.priority ?? 100),
    region: input.region ?? null,
    operator: input.operator ?? null,
    r2Key,
    notes: input.notes ?? null,
    filters: input.filters ?? null,
    contentHash,
  });

  await updateSource(c.env, id, {
    entry_count: parsed?.entries.length ?? 0,
    last_fetch_at: isoNow(),
    last_ok_at: parsed ? isoNow() : null,
    last_error: null,
    etag,
    last_modified: lastModified,
  });
  await audit(c.env, c.get('actor'), 'source.create', id, { name, origin, entries: parsed?.entries.length ?? 0 });

  if (!parsed) {
    return ok(
      {
        source: await getSource(c.env, id),
        summary: {
          kind: input.kind ?? 'auto',
          entries: 0,
          groups: [],
          sample: [],
          warnings: ['内容较大，已保存，采集器会在下一次运行时解析'],
        },
      },
      201,
    );
  }

  return ok(
    {
      source: await getSource(c.env, id),
      summary: {
        kind: parsed.kind,
        entries: parsed.entries.length,
        groups: [...new Set(parsed.entries.map((entry) => entry.group).filter(Boolean))].slice(0, 30),
        sample: parsed.entries.slice(0, 10),
        warnings: parsed.warnings,
      },
    },
    201,
  );
});

sourceRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const source = await getSource(c.env, id);
  if (!source) return fail('直播源不存在', 404);
  const patch = (await readJson<Record<string, unknown>>(c)) ?? {};
  if (patch['url']) {
    const validation = validateRemoteUrl(String(patch['url']));
    if (!validation.ok) return fail(validation.reason ?? '订阅地址不合法');
  }
  if (patch['filters'] && typeof patch['filters'] !== 'object') return fail('filters 必须是对象');
  const updated = await updateSource(c.env, id, patch);
  if (!updated) return fail('没有可更新的字段');
  await audit(c.env, c.get('actor'), 'source.update', id, patch);
  return ok({ source: await getSource(c.env, id) });
});

sourceRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const source = await getSource(c.env, id);
  if (!source) return fail('直播源不存在', 404);
  if (source.r2_key) await c.env.KV.delete(source.r2_key);
  await deleteSource(c.env, id);
  await audit(c.env, c.get('actor'), 'source.delete', id);
  return ok({ ok: true });
});

/** Re-fetch a source, parse it and report what it currently contains. */
sourceRoutes.post('/:id/probe', async (c) => {
  const id = c.req.param('id');
  const source = await getSource(c.env, id);
  if (!source) return fail('直播源不存在', 404);

  let text: string | null = null;
  let etag = source.etag;
  let lastModified = source.last_modified;

  if (source.r2_key) {
    text = await getText(c.env, source.r2_key);
  } else if (source.url) {
    const fetched = await fetchSourceText(source.url, { etag: source.etag, lastModified: source.last_modified });
    if (fetched.notModified) {
      return ok({ notModified: true, message: '内容未变化 (304)', source });
    }
    if (!fetched.ok) {
      await updateSource(c.env, id, { last_fetch_at: isoNow(), last_error: fetched.error ?? '抓取失败' });
      return fail(`抓取失败：${fetched.error ?? '未知错误'}`, 502);
    }
    text = fetched.text ?? '';
    etag = fetched.etag ?? null;
    lastModified = fetched.lastModified ?? null;
  }

  if (!text) return fail('没有可解析的内容', 422);
  const parsed = parseSource(text, source.kind as never);

  await updateSource(c.env, id, {
    entry_count: parsed.entries.length,
    last_fetch_at: isoNow(),
    last_ok_at: isoNow(),
    last_error: null,
    etag,
    last_modified: lastModified,
  });

  const groups = new Map<string, number>();
  for (const entry of parsed.entries) {
    const group = entry.group ?? '未分组';
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }

  return ok({
    source: await getSource(c.env, id),
    summary: {
      kind: parsed.kind,
      entries: parsed.entries.length,
      groups: [...groups.entries()].map(([group, count]) => ({ group, count })).sort((a, b) => b.count - a.count),
      sample: parsed.entries.slice(0, 20),
      warnings: parsed.warnings,
    },
  });
});

/** Probe a sample of lines straight from the Worker (bounded, no Actions needed). */
sourceRoutes.post('/:id/probe-lines', async (c) => {
  const id = c.req.param('id');
  const source = await getSource(c.env, id);
  if (!source) return fail('直播源不存在', 404);

  const body = (await readJson<{ limit?: number; offset?: number }>(c)) ?? {};
  const limit = Math.max(1, Math.min(Number(body.limit ?? 8), 24));
  const offset = Math.max(0, Number(body.offset ?? 0));

  let text: string | null = source.r2_key ? await getText(c.env, source.r2_key) : null;
  if (!text && source.url) {
    const fetched = await fetchSourceText(source.url);
    if (!fetched.ok) return fail(`抓取失败：${fetched.error}`, 502);
    text = fetched.text ?? '';
  }
  if (!text) return fail('没有可解析的内容', 422);

  const parsed = parseSource(text, source.kind as never);
  const candidates = parsed.entries
    .slice(offset, offset + limit)
    .map((entry, index) => ({ key: `${offset + index}`, url: splitUrlHeaders(entry.url).url, headers: entry.headers }));

  const started = Date.now();
  const results = await mapPool(candidates, 4, async (item) => {
    const result = await probeStream(item.url, { headers: item.headers, timeoutMs: 8_000, warmupBytes: 256 * 1024, sampleMs: 1_200 });
    return { index: Number(item.key), name: parsed.entries[Number(item.key)]?.name, url: item.url, result };
  });

  return ok({
    total: parsed.entries.length,
    probed: results.length,
    alive: results.filter((item) => item.result.ok).length,
    elapsedMs: Date.now() - started,
    results,
  });
});

sourceRoutes.post('/:id/toggle', async (c) => {
  const id = c.req.param('id');
  const source = await getSource(c.env, id);
  if (!source) return fail('直播源不存在', 404);
  await updateSource(c.env, id, { enabled: source.enabled === 1 ? 0 : 1 });
  return ok({ source: await getSource(c.env, id) });
});

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
