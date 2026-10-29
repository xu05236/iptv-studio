-- Custom subscriptions can pin specific pool line keys.
ALTER TABLE subscriptions ADD COLUMN line_keys TEXT NOT NULL DEFAULT '[]';
ALTER TABLE subscriptions ADD COLUMN pool_mode TEXT NOT NULL DEFAULT 'premium';
