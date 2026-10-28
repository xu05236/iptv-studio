const CHINA_CONTENT = /央视|卫视|地方|港澳台|国内其他|国内|华语|大陆|cctv|新闻|影视|体育|少儿|纪录|音乐|付费|4k|8k|剧场|电影|其他/i;

const COUNTRY_NAMES: Array<[RegExp, string]> = [
  [/usa|united states/i, '美国'],
  [/india/i, '印度'],
  [/russia/i, '俄罗斯'],
  [/italy/i, '意大利'],
  [/uk|united kingdom|britain/i, '英国'],
  [/germany/i, '德国'],
  [/brazil/i, '巴西'],
  [/poland/i, '波兰'],
  [/sweden/i, '瑞典'],
  [/turkey/i, '土耳其'],
  [/korea/i, '韩国'],
  [/netherlands/i, '荷兰'],
  [/japan/i, '日本'],
  [/france/i, '法国'],
  [/canada/i, '加拿大'],
  [/mexico/i, '墨西哥'],
  [/americas/i, '美洲'],
  [/middle east/i, '中东'],
  [/africa/i, '非洲'],
];

/**
 * Derive the country level from a channel's group title.
 *
 * Chinese content categories (央视/卫视/地方/新闻/影视/付费/4K…) all belong to
 * 中国; international source groups become their country. Unknown custom
 * groups go under 自定义 so users can still create arbitrary sections.
 */
export function countryOfGroup(group: string | null | undefined): string {
  const raw = (group ?? '').trim();
  if (!raw) return '其他';
  const text = raw
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '其他';
  if (/国际|海外/.test(text)) return '国际';
  for (const [pattern, country] of COUNTRY_NAMES) {
    if (pattern.test(text)) return country;
  }
  if (CHINA_CONTENT.test(text)) return '中国';
  if (/^[A-Za-z]/.test(text)) return text;
  return '自定义';
}

export function countryRank(country: string): number {
  if (country === '中国') return 0;
  if (country === '国际') return 1;
  if (country === '自定义') return 2;
  if (country === '其他') return 3;
  return 4;
}
