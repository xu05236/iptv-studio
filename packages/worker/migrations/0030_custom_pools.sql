-- User-defined pools. Lines keep living in state/lines.json; a custom pool is
-- just a named set of line keys (a line may belong to any number of pools).
CREATE TABLE IF NOT EXISTS custom_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS custom_pool_lines (
  pool_id TEXT NOT NULL,
  line_key TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (pool_id, line_key)
);

CREATE INDEX IF NOT EXISTS idx_custom_pool_lines_key ON custom_pool_lines (line_key);

-- A subscription in "pools" mode stores the selected pool ids here; the value
-- may mix built-in pools (premium/backup/candidate) and custom pool ids.
ALTER TABLE subscriptions ADD COLUMN pool_ids TEXT NOT NULL DEFAULT '[]';

-- How a pools-mode subscription applies filters: inherit = existing subscription
-- filters, none = export every line in the selected pools, custom = the filter
-- fields on the subscriptions row as edited in the form.
ALTER TABLE subscriptions ADD COLUMN filter_mode TEXT NOT NULL DEFAULT 'inherit';
