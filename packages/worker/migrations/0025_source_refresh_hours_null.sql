-- refresh_hours semantics: NULL = follow tiers (12/24/72h), 0 = never, N = custom hours.
-- Older rows stored 24 as "follow tiers"; convert them so the UI can express "every day".
UPDATE sources SET refresh_hours = NULL WHERE refresh_hours = 24;
