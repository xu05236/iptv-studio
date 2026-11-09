-- Per-token relay usage, one row per token per UTC day (aggregated in memory
-- and flushed every ~5 minutes to stay far below the D1 write budget).
CREATE TABLE IF NOT EXISTS relay_usage (
  token TEXT NOT NULL,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token, day)
);

CREATE INDEX IF NOT EXISTS idx_relay_usage_day ON relay_usage(day);
