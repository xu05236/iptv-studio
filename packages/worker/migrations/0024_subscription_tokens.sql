-- A6: per-device subscription tokens.
-- A subscription keeps its original token (legacy) but devices get their own
-- rows so one device can be revoked without breaking the others.
CREATE TABLE IF NOT EXISTS subscription_tokens (
  token TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscription_tokens_sub ON subscription_tokens(subscription_id);

INSERT OR IGNORE INTO subscription_tokens (token, subscription_id, label, enabled)
  SELECT token, id, '主令牌', enabled FROM subscriptions;
