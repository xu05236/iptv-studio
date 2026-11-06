-- S2: optional mirror URLs for a source. JSON array of http(s) URLs tried in
-- order after the primary URL fails (404/timeout/5xx/network).
ALTER TABLE sources ADD COLUMN mirror_urls TEXT;
