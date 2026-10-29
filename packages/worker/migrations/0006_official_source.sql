-- Official CCTV fallback source. The runner expands builtin:// URLs locally.
INSERT OR IGNORE INTO sources
  (id, name, kind, url, origin, enabled, priority, weight, region, tags, notes, reputation, tier)
VALUES
  ('official-cctv', 'CCTV 官方保底', 'm3u', 'builtin://cctv-official', 'builtin', 1, 1, 2.0, 'CN',
   '["official","cctv","fallback"]', 'CCTV-1/CCTV-13 official CNTV CDN fallback', 90, 'official');
