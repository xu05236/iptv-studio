/** Text normalisation shared by channel matching, dedupe and export. */

/**
 * Traditional -> simplified, limited to characters that actually appear in
 * Chinese channel names. Kept as whitespace separated pairs so a typo can only
 * damage one mapping (and it is trivially extendable).
 */
const TRAD_TO_SIMP_PAIRS = `
衛卫 視视 臺台 颱台 灣湾 東东 華华 鳳凤 際际 綜综 藝艺 電电 劇剧 場场 體体 聞闻 財财 經经
龍龙 門门 廣广 寧宁 遼辽 蘇苏 慶庆 貴贵 雲云 陝陕 肅肃 爾尔 濱滨 濟济 島岛 開开 關关 陽阳
陰阴 樂乐 優优 質质 選选 頻频 記记 錄录 紀纪 實实 戲戏 貝贝 亞亚 歐欧 國国 縣县 區区 鄉乡
鎮镇 農农 業业 漁渔 礦矿 鐵铁 車车 馬马 鳥鸟 魚鱼 蟲虫 獸兽 紅红 綠绿 藍蓝 黃黄 銀银 錢钱
長长 問问 閒闲 間间 閱阅 閣阁 頭头 題题 頁页 風风 飛飞 飯饭 館馆 廳厅 點点 黨党 齊齐 億亿
僅仅 從从 會会 傳传 傷伤 價价 儀仪 們们 偵侦 側侧 傑杰 備备 傢家 傭佣 參参 雙双 發发 變变
敘叙 葉叶 號号 嘆叹 嚇吓 嗎吗 聽听 啟启 單单 賣卖 圖图 團团 園园 圓圆 壞坏 塊块 堅坚 壓压
壽寿 夢梦 奪夺 奮奋 媽妈 嬰婴 孫孙 學学 寶宝 將将 專专 尋寻 對对 導导 屆届 層层 屬属 歲岁
師师 帳帐 帶带 幫帮 庫库 應应 廢废 彌弥 彈弹 強强 歸归 當当 盡尽 監监 盤盘 眾众 礎础 禮礼
種种 稱称 穩稳 窮穷 競竞 筆笔 節节 範范 築筑 簡简 類类 籃篮 純纯 紙纸 級级 緊紧 線线 練练
組组 細细 終终 結结 給给 統统 絲丝 維维 網网 編编 緣缘 總总 績绩 織织 繼继 續续 罰罚 習习
聯联 聲声 職职 腦脑 腳脚 臉脸 臨临 舉举 舊旧 萬万 蓋盖 蘋苹 虛虚 術术 補补 裝装 製制 複复
見见 觀观 規规 覺觉 覽览 觸触 計计 訂订 認认 討讨 訓训 講讲 讀读 護护 讓让 讚赞 賽赛 趨趋
跡迹 踐践 軍军 軟软 載载 輛辆 輪轮 輸输 辦办 遊游 運运 過过 達达 違违 遠远 適适 遲迟 邊边
邏逻 郵邮 釋释 針针 鋼钢 鏡镜 閉闭 陸陆 隊队 階阶 隨随 險险 隱隐 雜杂 雞鸡 離离 難难 靈灵
靜静 韓韩 項项 順顺 須须 領领 顏颜 願愿 餘余 驗验 麗丽 齒齿 龜龟 產产 兒儿 內内 兩两 冊册
寫写 劃划 勁劲 動动 務务 勝胜 勞劳 勢势 勵励 勸劝 醫医 張张 彎弯 徑径 憂忧 懷怀 戶户 擁拥
擇择 擊击 擔担 據据 擴扩 擺摆 攜携 攝摄 敗败 敵敌 數数 斷断 無无 時时 暢畅 曆历 曉晓 機机
橫横 檢检 權权 歡欢 殘残 殺杀 氣气 漢汉 潔洁 濃浓 災灾 為为 烏乌 煙烟 熱热 燈灯 營营 爺爷
牆墙 狀状 獨独 獲获 環环 現现 疊叠 療疗 盜盗 睜睁 矯矫 碼码 確确 礙碍 禪禅 積积 竊窃 籌筹
籠笼 糧粮 絕绝 脅胁 脈脉 艙舱 粵粤
`;

const TRAD_TO_SIMP: Record<string, string> = (() => {
  const map: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of TRAD_TO_SIMP_PAIRS.trim().split(/\s+/)) {
    const chars = [...pair];
    if (chars.length === 2) map[chars[0]!] = chars[1]!;
  }
  return map;
})();

/** Traditional -> simplified for the characters that appear in channel names. */
export function toSimplified(input: string): string {
  let out = '';
  for (const ch of input) out += TRAD_TO_SIMP[ch] ?? ch;
  return out;
}

export function nfkc(input: string): string {
  return input.normalize('NFKC');
}

/** Remove wrapping quotes/brackets and control characters. */
export function cleanLabel(input: string): string {
  return nfkc(String(input ?? ''))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CJK_NOISE = [
  '高清', '超清', '蓝光', '标清', '原画', '流畅', '极速', '智能', '备用', '测试', '官方',
  '直播', '信号', '线路', '体验', '稳定', '秒开', '频道',
];

const LATIN_NOISE = [
  'uhd', 'fhd', 'hdr', 'hevc', 'h265', 'h264', 'ipv6', 'ipv4', '50fps', '60fps', '25fps', '30fps',
  '2160p', '1440p', '1080p', '720p', '480p', '360p',
];

/** Strip quality/route noise that must not affect channel identity. */
export function stripNoise(input: string): string {
  let out = input.toLowerCase();
  for (const token of CJK_NOISE) out = out.replaceAll(token, '');
  for (const token of LATIN_NOISE) {
    out = out.replace(new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, 'g'), '$1$2');
  }
  out = out.replace(/(^|[^a-z0-9])(uhd|fhd|hd|sd)([^a-z0-9]|$)/g, '$1$3');
  out = out.replace(/[-\s]+$/g, '');
  return out;
}

/**
 * Canonical key used for alias lookups and fuzzy matching.
 * `CCTV-1 综合（高清）` -> `cctv1综合` -> alias table -> `cctv1`
 */
export function normalizeChannelName(raw: string): string {
  let s = toSimplified(nfkc(String(raw ?? '')));
  s = s
    .replace(/＋/g, '+')
    .replace(/[－—–−]/g, '-')
    .replace(/[／]/g, '/')
    .replace(/[｜]/g, '|')
    // keep meaningful qualifiers (欧洲版 / 体育赛事) but drop quality-only ones
    .replace(/[（(【\[]([^）)】\]]*)[）)】\]]/g, (_match, inner: string) => {
      const text = String(inner).trim();
      if (!text) return '';
      const noise = /^(高清|超清|蓝光|标清|原画|流畅|4k|8k|uhd|fhd|hd|sd|hdr|ipv6|ipv4|\d{3,4}p?|\d{3,4}\s*[x×]\s*\d{3,4})$/i;
      return noise.test(text) ? '' : ` ${text} `;
    })
    .replace(/[·•・、]/g, '')
    .replace(/\s+/g, ' ');
  s = s.toLowerCase();
  s = s.replace(/\s+/g, '');

  // CCTV variants keep their quality suffix because it is part of the identity.
  const cctv = /^cctv-?(\d{1,2})\s*(4k|8k)?\s*(\+|plus|p)?$/.exec(s);
  if (cctv) {
    const base = `cctv${Number(cctv[1])}${cctv[2] ?? ''}`;
    return cctv[3] ? `${base}plus` : base;
  }
  if (/^cctv-?4k$/.test(s)) return 'cctv4k';
  if (/^cctv-?8k$/.test(s)) return 'cctv8k';

  s = s.replace(/^cctv[\s-]*/i, 'cctv');
  s = s.replace(/cctv-?(\d{1,2})\s*(?:\+|plus|p)/gi, 'cctv$1plus');
  s = stripNoise(s);
  s = s.replace(/^-+|-+$/g, '');
  return s;
}

/**
 * Key used to fold duplicate channels created from noisy source names.
 * Strips trailing speed tags such as `(0.001 MB/s)` before the normal
 * quality/punctuation normalisation, so `安徽卫视 (0.001 MB/s)` and
 * `安徽卫视` share one identity.
 */
export function channelIdentityKey(raw: string): string {
  const speed = /[（(]\s*\d+(?:\.\d+)?\s*(?:MB|KB)\s*[/／]\s*s\s*[)）]\s*$/i;
  let s = cleanLabel(raw).replace(speed, '').trim();
  s = s.replace(/^[\s*]+/, '').replace(/[-_\s]*mcp\s*$/i, '').trim();
  s = s.replace(/[\s\-—–_|·]+$/g, '');
  return normalizeChannelName(s);
}

/** Chinese numerals -> arabic, for single/double digit channel numbers. */
const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18,
};

export function chineseToNumber(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  return CN_NUM[text] ?? null;
}

export function bigrams(input: string): string[] {
  const chars = [...input];
  if (chars.length < 2) return chars;
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i]! + chars[i + 1]!);
  return out;
}

/** Sørensen–Dice coefficient over character bigrams, 0..1. */
export function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  if (!left.length || !right.length) return 0;
  const counts = new Map<string, number>();
  for (const g of left) counts.set(g, (counts.get(g) ?? 0) + 1);
  let overlap = 0;
  for (const g of right) {
    const n = counts.get(g) ?? 0;
    if (n > 0) {
      overlap++;
      counts.set(g, n - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length);
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

export function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Infer a resolution from a channel/line label (`Hunan TV (2160p)`,
 * `/live/1080p/index.m3u8`). Used only when probing did not provide real
 * dimensions; ffprobe remains the source of truth.
 */
export function inferResolution(input: string): string | undefined {
  const text = input.toLowerCase();
  if (/(?:^|[^0-9])(2160p|4k|uhd)(?:[^0-9]|$)/.test(text)) return '2160p';
  if (/(?:^|[^0-9])(1440p|2k)(?:[^0-9]|$)/.test(text)) return '1440p';
  if (/(?:^|[^0-9])(1080p|fhd)(?:[^0-9]|$)/.test(text)) return '1080p';
  if (/(?:^|[^0-9])(720p)(?:[^0-9]|$)/.test(text)) return '720p';
  if (/(?:^|[^0-9])(480p)(?:[^0-9]|$)/.test(text)) return '480p';
  return undefined;
}
