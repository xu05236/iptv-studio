-- Domestic proxy pool used to re-check lines that the datacenter probe marked
-- unreachable. Passwords are stored as AES-GCM blobs, never plaintext.
CREATE TABLE IF NOT EXISTS proxy_nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'http',
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  password_enc TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  isp TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  kernel_only INTEGER NOT NULL DEFAULT 0,
  sort_score INTEGER NOT NULL DEFAULT 0,
  last_ok_at TEXT,
  last_checked_at TEXT,
  last_latency_ms INTEGER,
  last_error TEXT,
  last_egress_ip TEXT,
  last_country TEXT,
  last_asn TEXT,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_proxy_nodes_enabled ON proxy_nodes (enabled, kernel_only);

-- Subscription export can append lines verified from a domestic egress.
ALTER TABLE subscriptions ADD COLUMN include_cn_reachable INTEGER NOT NULL DEFAULT 1;
