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
  /** every source that advertised this exact URL (dedupe attribution) */
  sourceIds?: string[];
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
  /** consecutive successful probes; drives the adaptive recheck interval */
  passCount?: number;
  resolution?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  bandwidthKbps?: number;
  codecs?: string;
  speedKbps?: number;
  latencyMs?: number;
  score: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastProbeAt?: string;
  /** Last cheap manifest/range liveness check (pool recheck). */
  lastLivenessAt?: string;
  /** Source no longer advertises this URL, but the tested line is kept for a while. */
  retained?: boolean;
  /** Operator-marked good line; prioritized in exports and pool ordering. */
  favorite?: boolean;
  /** 是否走通过探测；新线路只给一次复测，老线路 3 次失败才淘汰。 */
  everAlive?: boolean;
  /** 进入已淘汰终态的时间（保留 30 天后清理）。 */
  rejectedAt?: string;
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
  /** RFC 6381 codec string from the HLS master playlist */
  codecs?: string;
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
  /** Player export cap per channel; 0 means unlimited. */
  maxLinesPerChannel: number;
  /** Frontend channel detail cap; 0 means show every line. */
  frontLineLimit: number;
  maxLinesPerSource: number;
  compensate: boolean;
  keepSuspect: boolean;
  /** 已淘汰线路保留天数（到期清理，默认 30）。 */
  rejectedRetentionDays: number;
  /** 源连续失败多少次标 degraded（默认 3）。 */
  sourceDegradeThreshold: number;
  /** 源连续失败多少次暂停（默认 5）。 */
  sourcePauseThreshold: number;
  /** 暂停源每隔多少小时做一次半开探测（默认 6）。 */
  sourceHalfOpenHours: number;
  probeBudget: number;
  concurrency: number;
  /** Recheck interval for alive backup lines (hours). */
  probeAliveHours: number;
  /** Recheck interval for premium lines (hours). */
  probePremiumHours: number;
  /** Max candidates per channel in one probe round. */
  probePerChannel: number;
  /** ffprobe resolution enrichment budget per run. */
  ffprobeLimit: number;
  /** Run a cheap manifest/range liveness check before full probes. */
  probePrefilterEnabled: boolean;
  probePrefilterBudget: number;
  /** Days to keep tested lines after their source stops advertising them. */
  lineRetentionDays: number;
  /** Automatic collect scheduler (default off). Times are Beijing-local HH:mm. */
  autoCollectEnabled: boolean;
  autoCollectTimes: string;
  /** Daily pool liveness schedule (default on, cheap). */
  autoLivenessEnabled: boolean;
  autoLivenessTimes: string;
  /** 自动探测的线路状态：待测、待复测（已淘汰不再自动探测）。 */
  autoProbeEnabled: boolean;
  probeBatchSize: number;
  autoProbeIntervalHours: number;
  /** 每月末自动抽检已淘汰线路尝试复活。 */
  monthlyReviveEnabled: boolean;
  /** 自动抽检所需的最低剩余 Actions 分钟数。 */
  monthlyReviveMinRemainingMinutes: number;
  /** 单次抽检的线路条数上限。 */
  monthlyReviveBatchSize: number;
  /** Monthly GitHub Actions minute budget (private repo free plan: 2000). */
  actionsMonthlyBudgetMinutes: number;
  /** Minutes kept free for manual/emergency runs. */
  actionsReserveMinutes: number;
  /** Conservative billed minutes for one workflow run, used for pacing. */
  actionsRunCostMinutes: number;
  /** Phase priority for batched probing, e.g. pending,quarantine,rejected. */
  probePhaseOrder: string;
  /** Phases temporarily skipped by the batch scheduler. */
  probePausedPhases: string;
  /** 定时重抓：每日时刻列表（北京时间，逗号分隔，可多段）。 */
  autoFetchEnabled: boolean;
  fetchTimes: string;
  fetchIntervalDays: number;
  /** Daily publish-only (EPG/catalog) without probing. */
  autoPublishEnabled: boolean;
  autoPublishTimes: string;
  /** Minimum hours between automatic publish-after-probe runs. */
  autoPublishIntervalHours: number;
  /** Publish automatically after a probe changes the pool. */
  autoPublishAfterProbeEnabled: boolean;
  /** Refresh XMLTV once a day, independent of line publishing. */
  epgRefreshEnabled: boolean;
  epgRefreshTimes: string;
  /** Create a rollback snapshot after each successful publish. */
  snapshotOnPublishEnabled: boolean;
  /** Create rollback snapshots on independent daily times. */
  snapshotScheduleEnabled: boolean;
  snapshotScheduleTimes: string;
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
  // 51zmt: covers several provincial channels (山西/陕西/三沙) missing above.
  'http://epg.51zmt.top:8000/e.xml',
  // gotonas: compact gz feed with 135 channels and day-long schedules.
  'https://epg.gotonas.com/t.xml.gz',
  // ziyi: 287 channels including 大湾区/三沙, ~2.4 MB XMLTV.
  'https://tv.ziyi.cc/playback.xml',
  // gdstu: 267 channels, full-day schedules, mirrored streams.
  'https://v.gdstu.fun/playback.xml',
];

export const DEFAULT_SETTINGS: AppSettings = {
  logoBaseUrl: 'https://live.fanmingming.com/tv/',
  maxLinesPerChannel: 0,
  frontLineLimit: 0,
  maxLinesPerSource: 2,
  compensate: true,
  keepSuspect: true,
  rejectedRetentionDays: 30,
  sourceDegradeThreshold: 3,
  sourcePauseThreshold: 5,
  sourceHalfOpenHours: 6,
  probeBudget: 12_000,
  concurrency: 64,
  probeAliveHours: 360,
  probePremiumHours: 168,
  probePerChannel: 24,
  ffprobeLimit: 150,
  probePrefilterEnabled: true,
  probePrefilterBudget: 1200,
  lineRetentionDays: 30,
  autoCollectEnabled: false,
  autoCollectTimes: '08:30',
  autoLivenessEnabled: true,
  autoLivenessTimes: '20:30',
  autoProbeEnabled: true,
  probeBatchSize: 1200,
  autoProbeIntervalHours: 6,
  monthlyReviveEnabled: true,
  monthlyReviveMinRemainingMinutes: 600,
  monthlyReviveBatchSize: 800,
  actionsMonthlyBudgetMinutes: 2000,
  actionsReserveMinutes: 300,
  actionsRunCostMinutes: 6,
  probePhaseOrder: 'pending,quarantine',
  probePausedPhases: '',
  autoFetchEnabled: true,
  fetchTimes: '06:30',
  fetchIntervalDays: 7,
  autoPublishEnabled: true,
  autoPublishTimes: '08:30',
  autoPublishIntervalHours: 6,
  autoPublishAfterProbeEnabled: false,
  epgRefreshEnabled: true,
  epgRefreshTimes: '00:10',
  snapshotOnPublishEnabled: false,
  snapshotScheduleEnabled: false,
  snapshotScheduleTimes: '03:00',
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
  /** Global task queue id, used to mark the task done/failed. */
  taskId?: string;
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
  /** F1: error classification (timeout/network/http_4xx/http_5xx/challenge/not_playlist). */
  errorKind?: string | null;
  parseReport?: import('./source/parseReport.js').SourceParseReport | null;
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
