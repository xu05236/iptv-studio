-- Per-source probeable counts at the last fetch. The worker compares the next
-- fetch against this baseline so the card can show a real delta without mixing
-- "all lines" and "probeable lines" definitions.
CREATE TABLE IF NOT EXISTS source_progress (
  source_id TEXT PRIMARY KEY,
  report_at TEXT NOT NULL,
  total INTEGER NOT NULL,
  alive INTEGER NOT NULL,
  pending INTEGER NOT NULL,
  quarantine INTEGER NOT NULL,
  rejected INTEGER NOT NULL,
  delta TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
