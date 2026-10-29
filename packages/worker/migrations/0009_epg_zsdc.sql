-- Add the zsdc XMLTV mirror; it is gzip-compressed and complements epg.pw.
UPDATE settings
SET value = json_set(
      value,
      '$.epgUrls',
      json_insert(
        json_extract(value, '$.epgUrls'),
        '$[#]',
        'https://epg.zsdc.eu.org/t.xml.gz'
      )
    ),
    updated_at = datetime('now')
WHERE key = 'app'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(json_extract(value, '$.epgUrls'))
    WHERE value = 'https://epg.zsdc.eu.org/t.xml.gz'
  );
