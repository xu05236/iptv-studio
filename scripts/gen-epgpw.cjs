const fs = require('node:fs');
const text = fs.readFileSync('china_epg.py', 'utf8');
const re = /"(\d+)":\s*"([^"]+)"/g;
const map = {};
let match;
while ((match = re.exec(text))) map[match[1]] = match[2];
const header = '// epg.pw numeric channel ids -> standard names.\n// Mapping data derived from funwukong/china-live (MIT); IDs are factual.\n';
fs.writeFileSync(
  'packages/core/src/epg/epgpw.ts',
  `${header}export const EPGPW_ID_MAP: Record<string, string> = ${JSON.stringify(map, null, 2)};\n`,
);
console.log('count', Object.keys(map).length, map['545932'], map['539726']);
