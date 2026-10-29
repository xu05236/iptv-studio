-- Public YSP static export (63 CCTV/卫视 channels). The upstream GitHub Pages
-- playlists are refreshed automatically; this row only needs to be fetched
-- periodically to refresh its parsed channel list.
INSERT INTO sources
  (id, name, kind, url, origin, enabled, priority, weight, region, tags, notes, reputation, tier, refresh_hours)
SELECT
  'src-ysp-static', '央视频 YSP 静态源', 'm3u', 'https://petem379-cmd.github.io/ysp/all.m3u',
  'remote', 1, 1, 1.2, 'CN', '["ysp","cctv","fallback"]',
  'YSP static export; upstream playlists refresh on GitHub Pages', 60, 'fallback', 1
WHERE NOT EXISTS (
  SELECT 1 FROM sources WHERE url = 'https://petem379-cmd.github.io/ysp/all.m3u'
);
