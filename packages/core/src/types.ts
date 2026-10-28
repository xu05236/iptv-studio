/**
 * Shared domain types for the whole platform.
 *
 * The pipeline is deliberately modelled as a single chain:
 *   Source -> RawEntry -> LineEntry (one line of a channel) -> Channel -> Subscription
 * Everything the admin UI edits is a node on that chain, which is what makes the
 * modules (collect / probe / aggregate / export) feel connected instead of bolted on.
 */

export type SourceKind = 'auto' | 'm3u' | 'txt' | 'json' | 'tvbox' | 'hwctc';
export type SourceOrigin = 'remote' | 'upload' | 'paste' | 'builtin';
export type Protocol = 'hls' | 'http' | 'rtmp' | 'rtsp' | 'udp' | 'rtp' | 'unknown';
export type LineStatus = 'alive' | 'suspect' | 'dead' | 'unknown';
export type Quality = '2160p' | '1440p' | '1080p' | '720p' | '480p' | 'sd' | 'unknown';
export type ChannelGroup =
  | '央视'
  | '卫视'
  | '地方'
  | '港澳台'
  | '国际'
  | '影视频道'
  | '体育'
  | '少儿'
  | '纪录'
  | '新闻'
  | '音乐'
  | '付费'
  | '4K'
  | '其他';

export interface RequestHeaders {
  userAgent?: string;
  referer?: string;
  origin?: string;
  cookie?: string;
}

export interface RawEntry {
  name: string;
  url: string;
  group?: string;
  logo?: string;
  tvgId?: string;
  tvgName?: string;
  headers?: RequestHeaders;
  catchup?: string;
  catchupSource?: string;
  catchupDays?: number;
  extras?: Record<string, string>;
}

export interface ParsedSource {
  kind: Exclude<SourceKind, 'auto'>;
  entries: RawEntry[];
  epgUrls: string[];
  warnings: string[];
  meta?: Record<string, unknown>;
}

export interface ChannelSeed {
  id: string;
  name: string;
  group: ChannelGroup | string;
  tvgId?: string;
  logo?: string;
  aliases?: string[];
}

export interface ChannelConfig extends ChannelSeed {
  enabled?: boolean;
  number?: number;
  sort?: number;
  epgSource?: string | null;
}

export interface SourceConfig {
  id: string;
  name: string;
  kind: SourceKind;
  url?: string | null;
  origin: SourceOrigin;
  enabled: boolean;
  priority: number;
  weight: number;
  region?: string | null;
  operator?: string | null;
  tags: string[];
  reputation: number;
  tier: 'high' | 'normal' | 'low';
  etag?: string | null;
  lastModified?: string | null;
  entryCount?: number;
  aliveCount?: number;
  status?: 'active' | 'degraded' | 'paused';
}

/** One concrete stream line belonging to one channel, as persisted between runs. */
export interface LineEntry {
  /** stable identity: hash(sourceId + normalized url) */
  key: string;
  sourceId: string;
  channelId: string;
  /** display name advertised by the source */
  name: string;
  url: string;
  urlKey: string;
  protocol: Protocol;
  headers?: RequestHeaders;
  group?: string;
  logo?: string;
  status: LineStatus;
  failCount: number;
  resolution?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  bandwidthKbps?: number;
  speedKbps?: number;
  latencyMs?: number;
  score: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastProbeAt?: string;
  reviveAt?: string;
  region?: string;
  operator?: string;
  tags: string[];
  loop?: boolean;
  catchup?: string;
  catchupSource?: string;
  catchupDays?: number;
  error?: string;
}

export interface ProbeResult {
  ok: boolean;
  status?: number;
  protocol: Protocol;
  /** time from request start to first byte */
  ttfbMs?: number;
  /** total time for the measured window */
  elapsedMs?: number;
  /** steady-state throughput in kbit/s (warm-up bytes discarded) */
  speedKbps?: number;
  bytes?: number;
  resolution?: string;
  quality?: Quality;
  width?: number;
  height?: number;
  frameRate?: number;
  /** bandwidth advertised by the HLS master playlist, kbit/s */
  bandwidthKbps?: number;
  /** short, self-restarting playlist -> likely an advert / filler loop */
  loop?: boolean;
  durationSec?: number;
  segments?: number;
  contentType?: string;
  error?: string;
  checkedAt: string;
}

export interface ChannelCatalogEntry {
  channel: ChannelConfig;
  lines: LineEntry[];
}

export interface Catalog {
  version: 1;
  runId: string;
  generatedAt: string;
  channels: ChannelCatalogEntry[];
  stats: CatalogStats;
}

export interface ChannelSummary {
  id: string;
  name: string;
  group: string;
  tvgId?: string;
  logo?: string;
  enabled: boolean;
  number?: number;
  lines: number;
  alive: number;
  bestSpeedKbps: number;
  bestResolution?: string;
  sources: number;
  updatedAt: string;
}

export interface ChannelIndex {
  generatedAt: string;
  runId: string;
  totalChannels: number;
  totalLines: number;
  aliveLines: number;
  groups: Array<{ group: string; channels: number; alive: number }>;
  channels: ChannelSummary[];
}

export interface CatalogStats {
  sources: number;
  channels: number;
  lines: number;
  alive: number;
  suspect: number;
  dead: number;
  probed: number;
  avgSpeedKbps: number;
  groups: Record<string, number>;
}

export interface SubscriptionSpec {
  id: string;
  name: string;
  token: string;
  enabled: boolean;
  groups: string[];
  excludeGroups: string[];
  channelIds: string[];
  minResolution: Quality | 'any';
  minSpeedKbps: number;
  protocols: Protocol[];
  maxLinesPerChannel: number;
  showRegionSuffix: boolean;
  includeEpg: boolean;
  format: 'm3u' | 'txt' | 'json' | 'diyp';
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match: RuleMatch;
  actions: RuleActions;
}

export interface RuleMatch {
  groups?: string[];
  namePattern?: string;
  channelPattern?: string;
  protocols?: Protocol[];
  minResolution?: Quality;
  minSpeedKbps?: number;
  sourceIds?: string[];
  tags?: string[];
}

export interface RuleActions {
  exclude?: boolean;
  setGroup?: string;
  addTags?: string[];
  rename?: string;
  setLogo?: string;
}

export interface AppSettings {
  logoBaseUrl: string;
  maxLinesPerChannel: number;
  maxLinesPerSource: number;
  compensate: boolean;
  keepSuspect: boolean;
  deadReviveDays: number;
  probeBudget: number;
  concurrency: number;
  probeTimeoutMs: number;
  warmupBytes: number;
  sampleMs: number;
  epgUrls: string[];
  regionSuffix: boolean;
  notifyTelegram: boolean;
  retentionDays: number;
  screenshots: boolean;
  relayEnabled: boolean;
  directPlayback: boolean;
}

export const DEFAULT_EPG_URLS = [
  // GitHub raw mirror: stable ids (CCTV1 / 湖南卫视), 7 day window.
  'https://raw.githubusercontent.com/fanmingming/live/main/e.xml',
  // epg.pw: numeric ids but reliable display names; merged as a second source.
  'https://epg.pw/xmltv/epg_CN.xml',
];

export const DEFAULT_SETTINGS: AppSettings = {
  logoBaseUrl: 'https://live.fanmingming.com/tv/',
  maxLinesPerChannel: 6,
  maxLinesPerSource: 2,
  compensate: true,
  keepSuspect: true,
  deadReviveDays: 14,
  probeBudget: 12_000,
  concurrency: 64,
  probeTimeoutMs: 9_000,
  warmupBytes: 512 * 1024,
  sampleMs: 1_500,
  epgUrls: DEFAULT_EPG_URLS,
  regionSuffix: true,
  notifyTelegram: false,
  retentionDays: 7,
  screenshots: false,
  relayEnabled: false,
  directPlayback: false,
};

export interface RunReport {
  id: string;
  trigger: 'schedule' | 'manual' | 'source' | 'cli';
  status: 'running' | 'success' | 'partial' | 'failed';
  startedAt: string;
  finishedAt?: string;
  sources: number;
  channels: number;
  lines: number;
  alive: number;
  dead: number;
  probed: number;
  bytes: number;
  durationMs: number;
  warnings: string[];
  error?: string;
  logKey?: string;
  actor?: string;
}

export interface SourceRunStats {
  sourceId: string;
  fetched: boolean;
  parsed: number;
  alive: number;
  dead: number;
  avgSpeedKbps: number;
  avgLatencyMs: number;
  etag?: string | null;
  lastModified?: string | null;
  error?: string;
}

export interface CatalogDiff {
  previousAt: string | null;
  currentAt: string;
  channelsBefore: number;
  channelsAfter: number;
  linesBefore: number;
  linesAfter: number;
  aliveBefore: number;
  aliveAfter: number;
  addedChannels: Array<{ id: string; name: string; group: string }>;
  removedChannels: Array<{ id: string; name: string; group: string }>;
  deadSurge: Array<{ sourceId: string; dead: number }>;
  groups: Array<{ group: string; before: number; after: number }>;
}
