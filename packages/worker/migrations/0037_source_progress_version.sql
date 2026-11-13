-- Count definition changed when source metrics moved to "probeable lines only".
-- Existing rows keep version 1 and are ignored as baselines until the next fetch.
ALTER TABLE source_progress ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
