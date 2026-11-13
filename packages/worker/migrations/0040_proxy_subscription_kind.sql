-- File-based proxy subscriptions have no URL to refresh; only URL subscriptions
-- participate in scheduled refresh.
ALTER TABLE proxy_subscriptions ADD COLUMN kind TEXT NOT NULL DEFAULT 'url';
