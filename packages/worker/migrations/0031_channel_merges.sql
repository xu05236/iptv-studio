-- Undo records for channel merges. The merge workbench can merge an auto
-- (`x-`) channel into a real one; before this table, that was permanent. A row
-- keeps the merged-away channel's snapshot plus the line keys that were moved
-- onto the target, so `POST /api/admin/channels/merges/:id/undo` can put the
-- channel and its lines back.
CREATE TABLE IF NOT EXISTS channel_merges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  line_keys TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_channel_merges_created ON channel_merges (created_at DESC);
