-- Enable built-in EPG sources for installs that still have an empty list.
UPDATE settings
SET value = json_set(
      value,
      '$.epgUrls',
      json('["https://raw.githubusercontent.com/fanmingming/live/main/e.xml","https://epg.pw/xmltv/epg_CN.xml"]')
    ),
    updated_at = datetime('now')
WHERE key = 'app'
  AND (
    json_extract(value, '$.epgUrls') IS NULL
    OR json_array_length(json_extract(value, '$.epgUrls')) = 0
  );
