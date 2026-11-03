CREATE TABLE IF NOT EXISTS line_favorites (
  line_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
