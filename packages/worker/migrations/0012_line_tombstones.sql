-- Permanent tombstones: URLs that must never be re-imported from any source.
CREATE TABLE IF NOT EXISTS line_tombstones (
  url TEXT PRIMARY KEY,
  line_key TEXT,
  channel_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_line_tombstones_created ON line_tombstones(created_at);
