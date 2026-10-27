-- Core relational state. Playlists/EPG/probe snapshots live in R2; D1 only holds
-- the objects the admin edits plus run/feedback history.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'auto',
  url TEXT,
  origin TEXT NOT NULL DEFAULT 'remote',
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  weight REAL NOT NULL DEFAULT 1,
  region TEXT,
  operator TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  etag TEXT,
  last_modified TEXT,
  last_fetch_at TEXT,
  last_ok_at TEXT,
  last_error TEXT,
  entry_count INTEGER NOT NULL DEFAULT 0,
  alive_count INTEGER NOT NULL DEFAULT 0,
  reputation REAL NOT NULL DEFAULT 50,
  tier TEXT NOT NULL DEFAULT 'normal',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  r2_key TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources (enabled, status, priority);

CREATE TABLE IF NOT EXISTS source_stats (
  source_id TEXT NOT NULL,
  day TEXT NOT NULL,
  fetched INTEGER NOT NULL DEFAULT 0,
  parsed INTEGER NOT NULL DEFAULT 0,
  alive INTEGER NOT NULL DEFAULT 0,
  dead INTEGER NOT NULL DEFAULT 0,
  avg_speed INTEGER NOT NULL DEFAULT 0,
  avg_latency INTEGER NOT NULL DEFAULT 0,
  reputation REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, day)
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tvg_id TEXT,
  group_title TEXT,
  logo TEXT,
  number INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  aliases TEXT NOT NULL DEFAULT '[]',
  epg_source TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_channels_group ON channels (group_title, sort);

CREATE TABLE IF NOT EXISTS aliases (
  alias TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aliases_channel ON aliases (channel_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  groups TEXT NOT NULL DEFAULT '[]',
  exclude_groups TEXT NOT NULL DEFAULT '[]',
  channel_ids TEXT NOT NULL DEFAULT '[]',
  min_resolution TEXT NOT NULL DEFAULT 'any',
  min_speed_kbps INTEGER NOT NULL DEFAULT 0,
  protocols TEXT NOT NULL DEFAULT '[]',
  max_lines_per_channel INTEGER NOT NULL DEFAULT 6,
  show_region_suffix INTEGER NOT NULL DEFAULT 1,
  include_epg INTEGER NOT NULL DEFAULT 1,
  format TEXT NOT NULL DEFAULT 'm3u',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  kind TEXT NOT NULL DEFAULT 'filter',
  spec TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL DEFAULT 'schedule',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  sources INTEGER NOT NULL DEFAULT 0,
  channels INTEGER NOT NULL DEFAULT 0,
  lines INTEGER NOT NULL DEFAULT 0,
  alive INTEGER NOT NULL DEFAULT 0,
  dead INTEGER NOT NULL DEFAULT 0,
  probed INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  warnings TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  log_key TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  entry_key TEXT,
  channel_id TEXT,
  source_id TEXT,
  kind TEXT NOT NULL DEFAULT 'dead',
  message TEXT,
  reporter_hash TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback (status, created_at DESC);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
