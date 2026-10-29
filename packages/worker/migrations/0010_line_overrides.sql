-- Manual pool overrides. Lines themselves stay in state/lines.json; this table
-- only records a human decision on top of the derived pool.
CREATE TABLE IF NOT EXISTS line_overrides (
  line_key TEXT PRIMARY KEY,
  pool TEXT NOT NULL,
  channel_id TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_line_overrides_channel ON line_overrides (channel_id);
