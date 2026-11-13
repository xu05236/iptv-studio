-- Local counter for KV write attempts. The free plan allows 1,000 writes/day;
-- Cloudflare's own analytics lag up to an hour, so the Worker keeps its own
-- count and pauses before the platform starts returning 500s.
CREATE TABLE IF NOT EXISTS kv_write_counter (
  day TEXT PRIMARY KEY,
  puts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
