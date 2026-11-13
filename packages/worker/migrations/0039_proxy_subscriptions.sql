-- Proxy subscriptions are refreshable (unlike pasted files): each refresh
-- re-fetches the URL, updates matching nodes, and disables nodes that the
-- provider removed. File imports leave subscription_id empty.
CREATE TABLE IF NOT EXISTS proxy_subscriptions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  headers TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fetch_at TEXT,
  last_status TEXT NOT NULL DEFAULT '',
  node_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE proxy_nodes ADD COLUMN subscription_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_proxy_nodes_subscription ON proxy_nodes (subscription_id);
