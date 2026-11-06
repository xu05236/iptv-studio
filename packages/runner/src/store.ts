import type { AppSettings, ChannelConfig, LineEntry, Rule } from '@iptv/core';

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

  /** Retry transient connect/TLS failures (common after mass probing). */
  private async retry<T>(operation: () => Promise<T>, attempts = 6): Promise<T> {
    const delays = [2_000, 5_000, 10_000, 20_000, 30_000];
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1] ?? 30_000));
      }
    }
    throw lastError;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.retry(async () => {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers({ 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
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
        const response = await fetch(this.artifactUrl(key), { headers: this.headers() });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`GET ${key} -> ${response.status}`);
        return response.text();
      });
    } catch (error) {
      throw new Error(`读取 ${key} 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    return JSON.parse(text) as T;
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
  fetch_mode?: string | null;
  created_at?: string | null;
  filters?: string | { groups?: string[]; excludeGroups?: string[]; keywords?: string[]; excludeKeywords?: string[]; maxEntries?: number } | null;
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
