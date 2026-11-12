import { gunzipSync } from 'node:zlib';
import { isGzipBytes, type AppSettings, type ChannelConfig, type LineEntry, type Rule } from '@iptv/core';

/**
 * 4xx responses other than 408/429 will never succeed on retry; retrying them
 * wastes ~67s per call and delays the failure the operator needs to see.
 */
function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status = /-> (\d{3})\b/.exec(message)?.[1];
  if (!status) return true; // network reset / timeout / abort — transient
  const code = Number(status);
  return code === 408 || code === 429 || code >= 500;
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'x-admin-token': this.token,
      'user-agent': 'iptv-studio-runner/0.1',
      ...extra,
    };
  }

  /** Retry transient connect/TLS/5xx failures; 4xx are deterministic and fail fast. */
  private async retry<T>(operation: () => Promise<T>, attempts = 6): Promise<T> {
    const delays = [2_000, 5_000, 10_000, 20_000, 30_000];
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error) || attempt >= attempts) break;
        await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1] ?? 30_000));
      }
    }
    throw lastError;
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    return this.retry(async () => {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers({ 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
        // A stalled admin API call must fail instead of hanging the whole run.
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 400)}`);
      }
      return (text ? JSON.parse(text) : {}) as T;
    });
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body ?? {});
  }

  private artifactUrl(key: string, contentType?: string): string {
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    const query = contentType ? `?type=${encodeURIComponent(contentType)}` : '';
    return `${this.baseUrl}/api/admin/artifacts/${encoded}${query}`;
  }

  async putArtifact(key: string, body: string | Uint8Array, contentType: string): Promise<void> {
    try {
      await this.retry(async () => {
        const response = await fetch(this.artifactUrl(key, contentType), {
          method: 'PUT',
          headers: this.headers({ 'content-type': 'application/octet-stream' }),
          body: body as unknown as BodyInit,
          // Uploads can be large (up to ~24MB); still bounded so a stalled
          // connection cannot wedge the run forever.
          signal: AbortSignal.timeout(180_000),
        });
        if (!response.ok) {
          throw new Error(`PUT ${key} -> ${response.status}: ${(await response.text()).slice(0, 300)}`);
        }
      });
    } catch (error) {
      throw new Error(`上传 ${key} 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getArtifact(key: string): Promise<string | null> {
    try {
      return await this.retry(async () => {
        const response = await fetch(this.artifactUrl(key), { headers: this.headers(), signal: AbortSignal.timeout(120_000) });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`GET ${key} -> ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        // Sharded state values are stored gzipped (no Content-Encoding header,
        // so fetch does not decompress them for us).
        return isGzipBytes(bytes) ? gunzipSync(bytes).toString('utf8') : new TextDecoder().decode(bytes);
      });
    } catch (error) {
      throw new Error(`读取 ${key} 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteArtifact(key: string): Promise<void> {
    await this.retry(async () => {
      const response = await fetch(this.artifactUrl(key), {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`DELETE ${key} -> ${response.status}`);
      }
    });
  }
}

/** Artifacts are stored in Workers KV through the Worker admin API (no R2/S3). */
export class ArtifactStore {
  constructor(private readonly api: ApiClient) {}

  async put(key: string, body: string | Uint8Array, contentType = 'application/json; charset=utf-8'): Promise<void> {
    await this.api.putArtifact(key, body, contentType);
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.put(key, JSON.stringify(value));
  }

  async getText(key: string): Promise<string | null> {
    return this.api.getArtifact(key);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const text = await this.getText(key);
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      // A corrupt artifact should not abort the whole run (publish reads the
      // guide this way); callers treat null as "missing" and fall back.
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.api.deleteArtifact(key);
  }

  /** F3: 让 Worker 代拉源内容（Actions 出口被源站拦时用），正文不落存储。 */
  fetchRemoteSource(sourceId: string): Promise<{
    notModified?: boolean;
    text?: string;
    encoding?: string;
    status?: number;
    etag?: string | null;
    lastModified?: string | null;
    mirrorIndex?: number;
    error?: string;
  }> {
    return this.api.post(`/api/admin/sources/${encodeURIComponent(sourceId)}/fetch`, {});
  }
}

export interface SourceRecord {
  id: string;
  name: string;
  kind: string;
  url: string | null;
  origin: string;
  /** Worker API serialises this as boolean; tolerate both shapes. */
  enabled: number | boolean;
  priority: number;
  weight: number;
  region: string | null;
  operator: string | null;
  tags: string;
  etag: string | null;
  last_modified: string | null;
  reputation: number;
  tier: 'high' | 'normal' | 'low';
  r2_key: string | null;
  status: string;
  last_fetch_at?: string | null;
  entry_count?: number;
  refresh_hours?: number;
  request_headers?: string | Record<string, string> | null;
  allow_insecure_tls?: number | string | null;
  /** Optional channel folding: every line is attached to one channel. */
  merge_channel_name?: string | null;
  merge_channel_group?: string | null;
  mergeChannelName?: string | null;
  mergeChannelGroup?: string | null;
  mirror_urls?: string | null;
  fetch_mode?: string | null;
  /** F5: per-source fetch parameters. */
  fetch_timeout_ms?: number | null;
  fetch_concurrency?: number | null;
  fetch_delay_ms?: number | null;
  created_at?: string | null;
  filters?: string | { groups?: string[]; excludeGroups?: string[]; keywords?: string[]; excludeKeywords?: string[]; maxEntries?: number; dropNumericNames?: boolean } | null;
}

export interface ChannelRecord {
  id: string;
  name: string;
  tvg_id: string | null;
  group_title: string | null;
  logo: string | null;
  number: number | null;
  enabled: number | boolean;
  aliases: string;
}

export interface RemoteConfig {
  settings: AppSettings;
  sources: SourceRecord[];
  channels: ChannelRecord[];
  aliases: Record<string, string>;
  rules: Rule[];
}

export async function loadRemoteConfig(api: ApiClient): Promise<RemoteConfig> {
  // Sequential on purpose: some networks drop concurrent TLS handshakes to the
  // same Cloudflare host, and these are only five small requests.
  const settingsResponse = await api.get<{ settings: AppSettings }>('/api/admin/settings');
  const sourcesResponse = await api.get<{ items: SourceRecord[] }>('/api/admin/sources');
  const channelsResponse = await api.get<{ items: ChannelRecord[] }>('/api/admin/channels');
  const aliasesResponse = await api.get<{ aliases: Record<string, string> }>('/api/admin/channels/meta/aliases');
  const rulesResponse = await api.get<{ items: Array<Rule & { enabled: boolean }> }>('/api/admin/rules');

  // A half-open recovery run targets one paused source explicitly; every other
  // run keeps skipping auto-paused sources.
  const scopedSourceId = (process.env.SOURCE_ID ?? '').trim();
  return {
    settings: settingsResponse.settings,
    sources: sourcesResponse.items.filter(
      (source) =>
        (source.enabled === true || source.enabled === 1) &&
        (source.status !== 'paused' || source.id === scopedSourceId),
    ),
    channels: channelsResponse.items,
    aliases: aliasesResponse.aliases,
    rules: rulesResponse.items.map((rule) => ({
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      priority: rule.priority,
      match: rule.match ?? {},
      actions: rule.actions ?? {},
    })),
  };
}

export interface ExportCatalogItem {
  channel: ChannelConfig;
  lines: LineEntry[];
}

export interface ExportCatalog {
  version: 1;
  runId: string;
  generatedAt: string;
  items: ExportCatalogItem[];
}
