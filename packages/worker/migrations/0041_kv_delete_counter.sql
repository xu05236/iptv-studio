-- Cloudflare counts KV writes and deletes against separate daily quotas, so the
-- guard must track them separately. Existing rows keep their historical put
-- count; deletes start from zero and are corrected by the next usage refresh.
ALTER TABLE kv_write_counter ADD COLUMN deletes INTEGER NOT NULL DEFAULT 0;
