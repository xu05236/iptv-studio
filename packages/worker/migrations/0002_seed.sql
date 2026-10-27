-- Starter sources. They are public mirrors of well known Chinese playlist
-- projects; disable or replace them from the admin UI at any time.
INSERT OR IGNORE INTO sources (id, name, kind, url, origin, enabled, priority, region, notes)
VALUES
  ('src-iptv-org-cn', 'iptv-org 中国频道', 'm3u', 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/cn.m3u', 'builtin', 1, 10, '海外', 'GitHub 公开源，适合作为打底'),
  ('src-guovin', 'Guovin/iptv-api 结果', 'm3u', 'https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/result.m3u', 'builtin', 1, 20, '国内', '社区维护的测速结果源');

INSERT OR IGNORE INTO settings (key, value) VALUES ('app', '{"logoBaseUrl":"https://live.fanmingming.com/tv/","maxLinesPerChannel":6,"maxLinesPerSource":2,"compensate":true,"keepSuspect":true,"deadReviveDays":14,"probeBudget":12000,"concurrency":64,"probeTimeoutMs":9000,"warmupBytes":524288,"sampleMs":1500,"epgUrls":["https://raw.githubusercontent.com/fanmingming/live/main/e.xml","https://epg.pw/xmltv/epg_CN.xml"],"regionSuffix":true,"notifyTelegram":false,"retentionDays":7,"screenshots":false,"relayEnabled":false}');
