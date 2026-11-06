-- Source-level request configuration (Batch 1 / S1):
-- request_headers: JSON object of extra headers (UA / Referer / Cookie / etc.)
-- fetch_mode: direct | worker (worker is used by F3)
ALTER TABLE sources ADD COLUMN request_headers TEXT;
ALTER TABLE sources ADD COLUMN fetch_mode TEXT;
