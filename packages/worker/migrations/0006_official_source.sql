-- Official CCTV fallback source. The runner expands builtin:// URLs locally.
-- Disabled by default: the CNTV CDN times out from GitHub Actions egress; the
-- public channel page exposes a stable official link instead.
INSERT OR IGNORE INTO sources
  (id, name, kind, url, origin, enabled, priority, weight, region, tags, notes, reputation, tier, refresh_hours)
VALUES
  ('official-cctv', 'CCTV 官方保底', 'm3u', 'builtin://cctv-official', 'builtin', 0, 1, 2.0, 'CN',
   '["official","cctv","fallback"]', 'CNTV CDN blocks GitHub egress; enable after adding a Worker relay', 90, 'official', 0);
