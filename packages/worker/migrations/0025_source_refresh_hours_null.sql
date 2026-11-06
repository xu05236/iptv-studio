-- refresh_hours semantics: -1 = follow tiers (12/24/72h), 0 = never, N = custom hours.
-- Older rows stored 24 as "follow tiers" and the column is NOT NULL, so use -1 instead of NULL.
UPDATE sources SET refresh_hours = -1 WHERE refresh_hours = 24;
