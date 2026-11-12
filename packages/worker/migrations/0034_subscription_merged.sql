-- Per-subscription settings for merged live-platform channels (虎牙/斗鱼…),
-- kept separate from the normal per-channel filters and line limit.
ALTER TABLE subscriptions ADD COLUMN merged_mode TEXT NOT NULL DEFAULT 'inherit';
ALTER TABLE subscriptions ADD COLUMN merged_max_lines INTEGER NOT NULL DEFAULT 0;
