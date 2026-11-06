import type { AppSettings, ChannelSummary, LineEntry, Rule } from '@iptv/core';

/** Public channel lines never carry the real stream URL or request headers. */
export type PublicLine = Omit<LineEntry, 'url' | 'headers'> & { url?: string; sourceName?: string; sourceSite?: string; pool?: string | null };

export interface Overview {
  ready: boolean;
  message?: string;
  generatedAt?: string;
  runId?: string;
  totals: { channels: number; lines: number; alive: number; dead?: number };
  groups: Array<{ group: string; channels: number; alive: number }>;
  lastRun?: RunItem | null;
  openFeedback?: number;
}

export interface ChannelsResponse {
  items: ChannelSummary[];
  total: number;
  page: number;
  limit: number;
  groups?: Array<{ group: string; channels: number; alive: number }>;
  ready: boolean;
}

export interface ChannelDetailResponse {
  channel: {
    id: string;
    name: string;
    group: string;
    tvgId?: string;
    logo?: string;
  };
  lines: PublicLine[];
  epg?: {
    now?: { title: string; start: number; stop?: number };
    next?: Array<{ title: string; start: number; stop?: number }>;
  } | null;
  features?: { relay: boolean; directPlayback?: boolean; frontLineLimit?: number };
}

export interface SourceItem {
  id: string;
  name: string;
  kind: string;
  url: string | null;
  origin: string;
  enabled: boolean;
  priority: number;
  weight: number;
  region: string | null;
  operator: string | null;
  tags: string[];
  etag: string | null;
  last_fetch_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  lastErrorKind?: string | null;
  entry_count: number;
  alive_count: number;
  reputation: number;
  tier: 'high' | 'normal' | 'low';
  status: string;
  consecutive_failures?: number;
  notes: string | null;
  refresh_hours?: number;
  requestHeaders?: Record<string, string>;
  mirrorUrls?: string[];
  parseReport?: { detectedKind: string; entries: number; bytes: number; encoding?: string | null; warnings: string[]; mirrorIndex: number; fetchedAt: string; dropPercent?: number | null } | null;
  parseDrop?: boolean;
  feedbackOpen?: number;
  fetchMode?: string;
  fetchTimeoutMs?: number;
  fetchConcurrency?: number;
  fetchDelayMs?: number;
  progress?: { total: number; tested: number; alive: number; pending: number; pendingTotal?: number; quarantine: number; quarantineTotal?: number; rejected: number; rejectedTotal?: number; channels?: number };
  report?: { added: number; reused: number; retained: number; disappeared: number; skippedRejected: number } | null;
  filters?: { groups?: string[]; excludeGroups?: string[]; keywords?: string[]; excludeKeywords?: string[]; maxEntries?: number };
  created_at: string;
}

export interface RunItem {
  id: string;
  task_id?: string | null;
  task_type?: string | null;
  task_source?: string | null;
  task_message?: string | null;
  task_label?: string | null;
  task_failure_reason?: string | null;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  sources: number;
  channels: number;
  lines: number;
  alive: number;
  dead: number;
  probed: number;
  bytes: number;
  duration_ms: number;
  warnings: string[];
  error: string | null;
  log_key: string | null;
}

export interface AdminStats {
  index: {
    ready: boolean;
    generatedAt?: string;
    runId?: string;
    totals: { channels: number; lines: number; alive: number };
    groups: Array<{ group: string; channels: number; alive: number }>;
  };
  sources: { total: number; enabled: number; failing: number; reputation: { high: number; normal: number; low: number } };
  channels: number;
  subscriptions: number;
  feedbackOpen: number;
  pool?: { total: number; alive: number; pending: number; quarantine: number; generatedAt: string | null };
  runs: RunItem[];
}

export interface UsageSnapshot {
  collectedAt: string;
  kv: { day: string; reads: number; writes: number; lists: number; deletes: number; storageBytes: number };
  d1: { day: string; rowsRead: number; rowsWritten: number };
  github: { month: string; minutes: number; runs: number };
  history?: Array<{ date: string; kvWrites: number; d1Writes: number; githubMinutes: number }>;
}

export interface SubscriptionItem {
  id: string;
  name: string;
  token: string;
  enabled: boolean;
  groups: string[];
  excludeGroups: string[];
  channelIds: string[];
  min_resolution: string;
  min_speed_kbps: number;
  protocols: string[];
  max_lines_per_channel: number;
  showRegionSuffix: boolean;
  includeEpg: boolean;
  format: string;
  pool_mode?: string;
  proxy_mode?: string;
  matchedChannels?: number;
  updated_at?: string;
  links: Record<string, string>;
}

export interface AdminChannel {
  id: string;
  name: string;
  group: string;
  country?: string;
  tvgId: string | null;
  logo: string | null;
  number: number | null;
  enabled: boolean;
  sort: number;
  aliases: number;
  lines: number;
  alive: number;
  bestResolution?: string;
  bestSpeedKbps: number;
  sources: number;
}

export interface SettingsResponse {
  settings: AppSettings;
  publicBaseUrl: string;
}

export interface RuleItem extends Rule {
  enabled: boolean;
}

export interface ProbeResponse {
  result: {
    ok: boolean;
    status?: number;
    protocol: string;
    ttfbMs?: number;
    speedKbps?: number;
    resolution?: string;
    quality?: string;
    bandwidthKbps?: number;
    durationSec?: number;
    loop?: boolean;
    error?: string;
    checkedAt: string;
  };
}
