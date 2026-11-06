-- F2: per-subscription proxy mode (direct | playlist | full).
ALTER TABLE subscriptions ADD COLUMN proxy_mode TEXT NOT NULL DEFAULT 'direct';
