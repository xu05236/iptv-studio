import type { ChannelGroup, ChannelSeed } from '../types.js';
import { cleanLabel, diceCoefficient, normalizeChannelName, stripNoise, toSimplified } from '../util/text.js';
import { hashId } from '../util/hash.js';
import { EXTRA_ALIASES } from './extraAliases.js';

/** [id, name, group, tvgId, extra aliases] */
type Row = [string, string, string, string?, string[]?];

const ROWS: Row[] = [
  // ---- CCTV ----
  ['cctv1', 'CCTV-1 综合', '央视', 'CCTV1', ['CCTV1综合', '中央一台', '中央1台', '中央一套', 'CCTV1综合频道']],
  ['cctv2', 'CCTV-2 财经', '央视', 'CCTV2', ['CCTV2财经', '中央二台']],
  ['cctv3', 'CCTV-3 综艺', '央视', 'CCTV3', ['CCTV3综艺', '中央三台']],
  ['cctv4', 'CCTV-4 中文国际', '央视', 'CCTV4', ['CCTV4中文国际', '中央四台', 'CCTV4国际']],
  ['cctv5', 'CCTV-5 体育', '央视', 'CCTV5', ['CCTV5体育', '中央五台', 'CCTV5体育频道']],
  ['cctv5plus', 'CCTV-5+ 体育赛事', '央视', 'CCTV5+', ['CCTV5+', 'CCTV5plus', 'CCTV体育赛事', '央视体育赛事']],
  ['cctv6', 'CCTV-6 电影', '央视', 'CCTV6', ['CCTV6电影', '中央六台', 'CCTV6电影频道']],
  ['cctv7', 'CCTV-7 国防军事', '央视', 'CCTV7', ['CCTV7国防军事', '中央七台']],
  ['cctv8', 'CCTV-8 电视剧', '央视', 'CCTV8', ['CCTV8电视剧', '中央八台']],
  ['cctv9', 'CCTV-9 纪录', '央视', 'CCTV9', ['CCTV9纪录', 'CCTV9纪录片', '中央九台']],
  ['cctv10', 'CCTV-10 科教', '央视', 'CCTV10', ['CCTV10科教', '中央十台']],
  ['cctv11', 'CCTV-11 戏曲', '央视', 'CCTV11', ['CCTV11戏曲', '中央十一台']],
  ['cctv12', 'CCTV-12 社会与法', '央视', 'CCTV12', ['CCTV12社会与法', '中央十二台']],
  ['cctv13', 'CCTV-13 新闻', '央视', 'CCTV13', ['CCTV13新闻', 'CCTV新闻', '中央十三台']],
  ['cctv14', 'CCTV-14 少儿', '央视', 'CCTV14', ['CCTV14少儿', '中央十四台']],
  ['cctv15', 'CCTV-15 音乐', '央视', 'CCTV15', ['CCTV15音乐', '中央十五台']],
  ['cctv16', 'CCTV-16 奥林匹克', '央视', 'CCTV16', ['CCTV16奥林匹克', 'CCTV16', '中央十六台']],
  ['cctv17', 'CCTV-17 农业农村', '央视', 'CCTV17', ['CCTV17农业农村', '中央十七台']],
  ['cctv4k', 'CCTV-4K 超高清', '4K', 'CCTV4K', ['CCTV4K超高清', 'CCTV4K']],
  ['cctv8k', 'CCTV-8K 超高清', '4K', 'CCTV8K', ['CCTV8K超高清', 'CCTV8K']],
  ['cctv16-4k', 'CCTV-16 奥林匹克 4K', '4K', 'CCTV16-4K', ['CCTV16奥林匹克4K', 'CCTV164K']],

  // ---- CGTN ----
  ['cgtn', 'CGTN', '国际', 'CGTN', ['中国国际电视台', 'CGTN英语', 'CGTN主频道']],
  ['cgtn-doc', 'CGTN 纪录', '国际', 'CGTN Documentary', ['CGTN纪录片', 'CGTN纪录频道']],
  ['cgtn-es', 'CGTN 西班牙语', '国际', 'CGTN Spanish', ['CGTN西语']],
  ['cgtn-fr', 'CGTN 法语', '国际', 'CGTN French', ['CGTN法语']],
  ['cgtn-ar', 'CGTN 阿拉伯语', '国际', 'CGTN Arabic', ['CGTN阿语']],
  ['cgtn-ru', 'CGTN 俄语', '国际', 'CGTN Russian', ['CGTN俄语']],

  // ---- 省级卫视 ----
  ['beijing-weishi', '北京卫视', '卫视', '北京卫视', ['北京卫视高清', 'BTV北京']],
  ['tianjin-weishi', '天津卫视', '卫视', '天津卫视'],
  ['hebei-weishi', '河北卫视', '卫视', '河北卫视'],
  ['shanxi-weishi', '山西卫视', '卫视', '山西卫视'],
  ['neimenggu-weishi', '内蒙古卫视', '卫视', '内蒙古卫视', ['内蒙卫视']],
  ['liaoning-weishi', '辽宁卫视', '卫视', '辽宁卫视'],
  ['jilin-weishi', '吉林卫视', '卫视', '吉林卫视'],
  ['heilongjiang-weishi', '黑龙江卫视', '卫视', '黑龙江卫视'],
  ['dongfang-weishi', '东方卫视', '卫视', '东方卫视', ['上海东方卫视', '上海卫视', 'SMG东方卫视']],
  ['jiangsu-weishi', '江苏卫视', '卫视', '江苏卫视'],
  ['zhejiang-weishi', '浙江卫视', '卫视', '浙江卫视'],
  ['anhui-weishi', '安徽卫视', '卫视', '安徽卫视'],
  ['dongnan-weishi', '东南卫视', '卫视', '东南卫视', ['福建东南卫视', '福建卫视']],
  ['jiangxi-weishi', '江西卫视', '卫视', '江西卫视'],
  ['shandong-weishi', '山东卫视', '卫视', '山东卫视'],
  ['henan-weishi', '河南卫视', '卫视', '河南卫视'],
  ['hubei-weishi', '湖北卫视', '卫视', '湖北卫视'],
  ['hunan-weishi', '湖南卫视', '卫视', '湖南卫视', ['湖南卫视高清', 'Hunan TV', 'Hunan Satellite TV', 'HunanTV', 'Hunan TV (2160p)']],
  ['guangdong-weishi', '广东卫视', '卫视', '广东卫视'],
  ['guangxi-weishi', '广西卫视', '卫视', '广西卫视'],
  ['hainan-weishi', '海南卫视', '卫视', '海南卫视', ['旅游卫视']],
  ['chongqing-weishi', '重庆卫视', '卫视', '重庆卫视'],
  ['sichuan-weishi', '四川卫视', '卫视', '四川卫视'],
  ['guizhou-weishi', '贵州卫视', '卫视', '贵州卫视'],
  ['yunnan-weishi', '云南卫视', '卫视', '云南卫视'],
  ['xizang-weishi', '西藏卫视', '卫视', '西藏卫视', ['西藏汉语卫视']],
  ['shaanxi-weishi', '陕西卫视', '卫视', '陕西卫视'],
  ['gansu-weishi', '甘肃卫视', '卫视', '甘肃卫视'],
  ['qinghai-weishi', '青海卫视', '卫视', '青海卫视'],
  ['ningxia-weishi', '宁夏卫视', '卫视', '宁夏卫视'],
  ['xinjiang-weishi', '新疆卫视', '卫视', '新疆卫视'],
  ['shenzhen-weishi', '深圳卫视', '卫视', '深圳卫视'],
  ['xiamen-weishi', '厦门卫视', '卫视', '厦门卫视'],
  ['sansha-weishi', '三沙卫视', '卫视', '三沙卫视'],
  ['bingtuan-weishi', '兵团卫视', '卫视', '兵团卫视'],
  ['yanbian-weishi', '延边卫视', '卫视', '延边卫视'],
  ['shandong-jiaoyu', '山东教育卫视', '卫视', '山东教育卫视'],
  ['dawanqu-weishi', '大湾区卫视', '卫视', '大湾区卫视', ['广东大湾区卫视']],

  // ---- 教育 ----
  ['cetv1', '中国教育 1 台', '地方', 'CETV1', ['CETV1', '中国教育台', '中国教育电视台']],
  ['cetv2', '中国教育 2 台', '地方', 'CETV2', ['CETV2']],
  ['cetv3', '中国教育 3 台', '地方', 'CETV3', ['CETV3']],
  ['cetv4', '中国教育 4 台', '地方', 'CETV4', ['CETV4']],

  // ---- 港澳台 ----
  ['tvb-jade', '翡翠台', '港澳台', '翡翠台', ['TVB翡翠台', '无线翡翠台', 'TVBJade']],
  ['tvb-pearl', '明珠台', '港澳台', '明珠台', ['TVB明珠台', 'TVBPearl']],
  ['tvb-news', '无线新闻台', '港澳台', '无线新闻台', ['TVB新闻台', 'TVBN']],
  ['tvb-finance', '无线财经资讯台', '港澳台', '无线财经资讯台', ['TVB财经台']],
  ['viutv', 'ViuTV', '港澳台', 'ViuTV', ['ViuTV99', 'ViuTV粤语']],
  ['viutv-six', 'ViuTVsix', '港澳台', 'ViuTVsix', ['ViuTV96', 'ViuTV6']],
  ['hoy-tv', '香港开电视', '港澳台', 'HOY TV', ['开电视', 'HOYTV', '奇妙电视']],
  ['rthk31', '港台电视 31', '港澳台', 'RTHK31', ['RTHK31', '港台31']],
  ['rthk32', '港台电视 32', '港澳台', 'RTHK32', ['RTHK32', '港台32']],
  ['phoenix-zhongwen', '凤凰卫视中文台', '港澳台', '凤凰卫视中文台', ['凤凰中文台', '凤凰中文']],
  ['phoenix-zixun', '凤凰卫视资讯台', '港澳台', '凤凰卫视资讯台', ['凤凰资讯台', '凤凰资讯']],
  ['phoenix-hk', '凤凰卫视香港台', '港澳台', '凤凰卫视香港台', ['凤凰香港台']],
  ['austv', '澳视澳门', '港澳台', '澳视澳门', ['澳门卫视', 'TDM澳门']],
  ['lotus-macau', '澳门莲花卫视', '港澳台', '澳门莲花卫视', ['莲花卫视']],
  ['macau-info', '澳门资讯', '港澳台', '澳门资讯'],
  ['ctitv', '中天综合台', '港澳台', '中天综合台', ['中天综合', '中天电视台']],
  ['ctitv-news', '中天新闻台', '港澳台', '中天新闻台', ['中天新闻']],
  ['ettoday', '东森新闻台', '港澳台', '东森新闻台', ['东森新闻', 'ETtoday']],
  ['ettoday-comprehensive', '东森综合台', '港澳台', '东森综合台', ['东森综合']],
  ['set-taiwan', '三立台湾台', '港澳台', '三立台湾台', ['三立台湾']],
  ['set-news', '三立新闻台', '港澳台', '三立新闻台', ['三立新闻']],
  ['tvbs', 'TVBS 新闻台', '港澳台', 'TVBS新闻台', ['TVBS', 'TVBS新闻']],
  ['tvbs-happy', 'TVBS 欢乐台', '港澳台', 'TVBS欢乐台', ['TVBS欢乐']],
  ['ftv', '民视', '港澳台', '民视', ['民视无线台', 'FTV']],
  ['ttv', '台视', '港澳台', '台视', ['TTV台视']],
  ['cts', '中视', '港澳台', '中视', ['CTV中视']],
  ['pts', '公视', '港澳台', '公视', ['PTS公视', '公共电视']],
  ['ctv', '华视', '港澳台', '华视', ['CTS华视']],
  ['videoland', '纬来综合台', '港澳台', '纬来综合台', ['纬来综合']],
  ['videoland-sports', '纬来体育台', '港澳台', '纬来体育台', ['纬来体育']],
  ['videoland-movie', '纬来电影台', '港澳台', '纬来电影台', ['纬来电影']],
  ['lotus-movie', '龙华电影台', '港澳台', '龙华电影台', ['龙华电影']],
  ['lotus-idol', '龙华偶像台', '港澳台', '龙华偶像台', ['龙华偶像']],
  ['era-news', '年代新闻台', '港澳台', '年代新闻台', ['年代新闻']],
  ['next-tv', '壹电视', '港澳台', '壹电视', ['壹新闻']],

  // ---- 地方台 ----
  ['beijing-xinwen', '北京新闻', '地方', '北京新闻', ['北京新闻频道']],
  ['beijing-wenyi', '北京文艺', '地方', '北京文艺'],
  ['beijing-yingshi', '北京影视', '地方', '北京影视'],
  ['beijing-caijing', '北京财经', '地方', '北京财经'],
  ['beijing-jishi', '北京纪实', '地方', '北京纪实'],
  ['shanghai-xinwen', '上海新闻综合', '地方', '上海新闻综合', ['上海新闻']],
  ['shanghai-dushi', '上海都市', '地方', '上海都市'],
  ['shanghai-diyicaijing', '上海第一财经', '地方', '第一财经', ['第一财经']],
  ['shanghai-jishi', '上海纪实', '地方', '上海纪实'],
  ['guangdong-zhuijiang', '广东珠江', '地方', '广东珠江', ['珠江台']],
  ['guangdong-tiyu', '广东体育', '地方', '广东体育'],
  ['guangdong-xinwen', '广东新闻', '地方', '广东新闻'],
  ['nanfang-weishi', '南方卫视', '地方', '南方卫视'],
  ['shenzhen-dushi', '深圳都市', '地方', '深圳都市'],
  ['jiangsu-chengshi', '江苏城市', '地方', '江苏城市'],
  ['jiangsu-zongyi', '江苏综艺', '地方', '江苏综艺'],
  ['zhejiang-minsheng', '浙江民生休闲', '地方', '浙江民生休闲'],
  ['zhejiang-yingshi', '浙江影视', '地方', '浙江影视'],
  ['hunan-jingshi', '湖南经视', '地方', '湖南经视', ['湖南经视综合']],
  ['hunan-dushi', '湖南都市', '地方', '湖南都市'],
  ['shandong-qilu', '山东齐鲁', '地方', '山东齐鲁', ['齐鲁台']],
  ['sichuan-yingshi', '四川影视文艺', '地方', '四川影视文艺'],
  ['chengdu-xinwen', '成都新闻综合', '地方', '成都新闻综合'],
  ['wuhan-xinwen', '武汉新闻综合', '地方', '武汉新闻综合'],
  ['henan-minsheng', '河南民生', '地方', '河南民生'],
  ['hebei-jingji', '河北经济', '地方', '河北经济'],
  ['liaoning-dushi', '辽宁都市', '地方', '辽宁都市'],
  ['jilin-dushi', '吉林都市', '地方', '吉林都市'],
  ['heilongjiang-xinwen', '黑龙江新闻', '地方', '黑龙江新闻'],
  ['shaanxi-dushi', '陕西都市', '地方', '陕西都市'],
  ['gansu-dushi', '甘肃都市', '地方', '甘肃都市'],
  ['yunnan-dushi', '云南都市', '地方', '云南都市'],
  ['guizhou-gonggong', '贵州公共', '地方', '贵州公共'],
  ['guangxi-zongyi', '广西综艺', '地方', '广西综艺'],
  ['fujian-xinwen', '福建新闻', '地方', '福建新闻'],
  ['xiamen-xinwen', '厦门新闻', '地方', '厦门新闻'],

  // ---- 付费 / 特色 ----
  ['fengyun-zuqiu', '风云足球', '付费', '风云足球'],
  ['fengyun-juchang', '风云剧场', '付费', '风云剧场'],
  ['diyi-juchang', '第一剧场', '付费', '第一剧场'],
  ['huaijiu-juchang', '怀旧剧场', '付费', '怀旧剧场'],
  ['shijie-dili', '世界地理', '付费', '世界地理'],
  ['bingqi-keji', '兵器科技', '付费', '兵器科技'],
  ['nvxing-shishang', '女性时尚', '付费', '女性时尚'],
  ['gaoerfu-wangqiu', '高尔夫网球', '付费', '高尔夫网球'],
  ['cctv-taiqiu', '央视台球', '付费', '央视台球'],
  ['weisheng-jiankang', '卫生健康', '付费', '卫生健康'],
  ['cctv-wenhua-jingpin', '央视文化精品', '付费', '央视文化精品'],
  ['laogushi', '老故事', '付费', '老故事'],
  ['liyuan', '梨园', '付费', '梨园'],
  ['faxian-zhilv', '发现之旅', '付费', '发现之旅'],
  ['zhongxuesheng', '中学生', '付费', '中学生'],
  ['zaoqi-jiaoyu', '早期教育', '付费', '早期教育'],
  ['zhengquan-zixun', '证券资讯', '付费', '证券资讯'],
  ['tianyuan-weiqi', '天元围棋', '付费', '天元围棋'],
  ['qimo', '汽摩', '付费', '汽摩'],
  ['youxi-fengyun', '游戏风云', '付费', '游戏风云'],
  ['dongman-xiuchang', '动漫秀场', '付费', '动漫秀场'],
  ['quanjishi', '全纪实', '付费', '全纪实'],
  ['dushi-juchang', '都市剧场', '付费', '都市剧场'],
  ['fazhi-tiandi', '法治天地', '付费', '法治天地'],
  ['huanxiao-juchang', '欢笑剧场', '付费', '欢笑剧场'],
  ['jinse-xuetang', '金色学堂', '付费', '金色学堂'],
  ['leyou', '乐游', '付费', '乐游'],
  ['shenghuo-shishang', '生活时尚', '付费', '生活时尚'],
  ['qicai-xiju', '七彩戏剧', '付费', '七彩戏剧'],
  ['haha-xuandong', '哈哈炫动', '少儿', '哈哈炫动'],
  ['jinbao-tiyu', '劲爆体育', '体育', '劲爆体育'],
  ['wuxing-tiyu', '五星体育', '体育', '五星体育'],
  ['jinying-jishi', '金鹰纪实', '纪录', '金鹰纪实'],
  ['xiaoxiang-dianying', '潇湘电影', '影视频道', '潇湘电影'],
  ['chc-jiating', 'CHC 家庭影院', '影视频道', 'CHC家庭影院'],
  ['chc-dongzuo', 'CHC 动作电影', '影视频道', 'CHC动作电影'],
  ['chc-gaoqing', 'CHC 高清电影', '影视频道', 'CHC高清电影'],

  // ---- 4K 频道 ----
  ['beijing-4k', '北京卫视 4K', '4K', '北京卫视4K'],
  ['guangdong-4k', '广东卫视 4K', '4K', '广东卫视4K'],
  ['shenzhen-4k', '深圳卫视 4K', '4K', '深圳卫视4K'],
  ['hunan-4k', '湖南卫视 4K', '4K', '湖南卫视4K'],
  ['shanghai-4k', '上海东方卫视 4K', '4K', '东方卫视4K', ['东方卫视4K', '上海4K']],
  ['jiangsu-4k', '江苏卫视 4K', '4K', '江苏卫视4K'],
  ['zhejiang-4k', '浙江卫视 4K', '4K', '浙江卫视4K'],
  ['cctv-4k-50fps', 'CCTV-4K 50帧', '4K', 'CCTV4K50', ['CCTV4K50帧']],
];

export const BUILTIN_CHANNELS: ChannelSeed[] = ROWS.map(([id, name, group, tvgId, aliases]) => ({
  id,
  name,
  group,
  tvgId: tvgId ?? name,
  aliases: [...new Set([...(aliases ?? []), ...(EXTRA_ALIASES[id] ?? [])])],
}));

const GROUP_ALIASES: Array<[RegExp, ChannelGroup]> = [
  [/^(央视|cctv|中央)/i, '央视'],
  [/卫视/, '卫视'],
  [/^(4k|8k|uhd|超高清)/i, '4K'],
  [/港澳|香港|澳门|台湾|tvb|凤凰|翡翠|明珠|中天|东森|三立|tvbs|民视|台视|中视|华视|公视|纬来|龙华/, '港澳台'],
  [/国际|海外|cgtn/, '国际'],
  [/体育|足球|篮球|赛事|网球|台球|电竞/, '体育'],
  [/少儿|卡通|动画|动漫|亲子|教育|学堂/, '少儿'],
  [/纪录|纪实|探索|地理|发现|人文|历史/, '纪录'],
  [/新闻|资讯|财经|法治|社会/, '新闻'],
  [/影视|电影|剧场|影院|电视剧|影迷| drama|movie/i, '影视频道'],
  [/音乐|mtv|演唱会|戏曲|曲艺/, '音乐'],
  [/付费|精品|剧场|风云|chc/i, '付费'],
];

export function classifyGroup(name: string, hint?: string | null): ChannelGroup {
  const text = `${toSimplified(hint ?? '')} ${toSimplified(name)}`.toLowerCase();
  // explicit, well-formed source group wins
  const hintText = toSimplified(hint ?? '').trim();
  if (hintText) {
    for (const [re, group] of GROUP_ALIASES) if (re.test(hintText)) return group;
    if (['央视', '卫视', '地方', '港澳台', '国际', '体育', '少儿', '纪录', '新闻', '音乐', '付费', '4K', '影视频道'].includes(hintText)) {
      return hintText as ChannelGroup;
    }
  }
  if (/^cctv|cgtn|中央/.test(normalizeChannelName(name))) return /cgtn/.test(text) ? '国际' : '央视';
  for (const [re, group] of GROUP_ALIASES) if (re.test(text)) return group;
  return '地方';
}

/** Human facing name with quality/geo annotations removed (identity keeps them). */
export function displayName(raw: string): string {
  const cleaned = toSimplified(cleanLabel(raw))
    // `[Geo-blocked]`, `[Not 24/7]`, `[1080p]`, `[HD]` …
    .replace(/\[[A-Za-z0-9 /._-]*\]/g, ' ')
    .replace(/[（(]\s*(?:2160p|1440p|1080p|720p|540p|480p|360p|4k|8k|uhd|fhd|hd|sd)\s*[）)]/gi, ' ')
    .replace(/[（(【\[](?:高清|超清|蓝光|标清|4K|8K|UHD|HD)[）)】\]]/gi, '')
    .replace(/\s*[-_|]\s*(?:高清|超清|蓝光|标清|4K|8K|UHD|HD)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || cleanLabel(raw);
}

export interface ResolveOptions {
  tvgId?: string | null;
  group?: string | null;
}

export interface ResolvedChannel {
  id: string;
  name: string;
  group: string;
  tvgId?: string;
  logo?: string;
  confidence: number;
  created: boolean;
}

/**
 * Alias-first channel identity resolver.
 *
 * Resolution order: exact alias -> tvg-id -> CCTV pattern -> fuzzy -> new channel.
 * The registry is cheap enough to rebuild per run (a few hundred entries) and is
 * the single place where "CCTV1" / "CCTV-1 综合" / "中央一台" become one channel.
 */
export class ChannelRegistry {
  private readonly channels = new Map<string, ChannelSeed>();
  private readonly aliases = new Map<string, string>();
  private readonly aliasKeys: string[] = [];
  private readonly fuzzyEnabled: boolean;

  constructor(seeds: ChannelSeed[] = BUILTIN_CHANNELS, extraAliases: Record<string, string> = {}, options: { fuzzy?: boolean } = {}) {
    this.fuzzyEnabled = options.fuzzy ?? true;
    for (const seed of seeds) this.addChannel(seed);
    for (const [alias, channelId] of Object.entries(extraAliases)) this.addAlias(alias, channelId);
  }

  get size(): number {
    return this.channels.size;
  }

  list(): ChannelSeed[] {
    return [...this.channels.values()];
  }

  get(id: string): ChannelSeed | undefined {
    return this.channels.get(id);
  }

  addChannel(seed: ChannelSeed): void {
    const id = seed.id.trim();
    if (!id) return;
    this.channels.set(id, { ...seed, id });
    this.registerAlias(seed.name, id);
    if (seed.tvgId) this.registerAlias(seed.tvgId, id);
    for (const alias of seed.aliases ?? []) this.registerAlias(alias, id);
  }

  addAlias(alias: string, channelId: string): void {
    if (!this.channels.has(channelId)) return;
    this.registerAlias(alias, channelId);
  }

  private registerAlias(alias: string, channelId: string): void {
    const key = normalizeChannelName(alias);
    if (!key) return;
    if (!this.aliases.has(key)) this.aliasKeys.push(key);
    this.aliases.set(key, channelId);
  }

  /** Normalise an EPG id so `CCTV-1` and `CCTV1` collide. */
  static normalizeTvgId(tvgId: string): string {
    return normalizeChannelName(tvgId);
  }

  resolve(rawName: string, options: ResolveOptions = {}): ResolvedChannel {
    const name = cleanLabel(rawName) || '未命名频道';
    const key = normalizeChannelName(name);
    const direct = key ? this.aliases.get(key) : undefined;
    if (direct) return this.found(direct, 1);

    if (options.tvgId) {
      const tvgKey = ChannelRegistry.normalizeTvgId(options.tvgId);
      const byTvg = tvgKey ? this.aliases.get(tvgKey) : undefined;
      if (byTvg) return this.found(byTvg, 0.97);
    }

    const cctv = /^cctv(\d{1,2})(4k|8k|plus)?/.exec(key);
    if (cctv) {
      const id = `cctv${Number(cctv[1])}${cctv[2] ?? ''}`;
      const seed = this.channels.get(id);
      if (seed) return this.found(id, 0.94);
      const fallback: ChannelSeed = {
        id,
        name: `CCTV-${Number(cctv[1])}${cctv[2] ? ` ${cctv[2].toUpperCase()}` : ''}`,
        group: cctv[2] ? '4K' : '央视',
        tvgId: `CCTV${Number(cctv[1])}${cctv[2] ?? ''}`.toUpperCase(),
      };
      this.addChannel(fallback);
      return this.found(id, 0.9);
    }

    const central = /^中央(\d{1,2})(?:台|套|频道)?$/.exec(key);
    if (central) {
      const id = `cctv${Number(central[1])}`;
      if (this.channels.has(id)) return this.found(id, 0.92);
    }

    if (this.fuzzyEnabled && key.length >= 3) {
      const fuzzy = this.fuzzyMatch(key);
      if (fuzzy) return this.found(fuzzy, 0.78);
    }

    const id = `x-${hashId(key || name, 8)}`;
    const created: ChannelSeed = {
      id,
      name: displayName(name),
      group: classifyGroup(name, options.group),
    };
    this.channels.set(id, created);
    this.registerAlias(name, id);
    return { id, name: created.name, group: created.group, confidence: 0.5, created: true };
  }

  private found(id: string, confidence: number): ResolvedChannel {
    const seed = this.channels.get(id)!;
    return {
      id: seed.id,
      name: seed.name,
      group: seed.group,
      tvgId: seed.tvgId,
      logo: seed.logo,
      confidence,
      created: false,
    };
  }

  private fuzzyMatch(key: string): string | null {
    let best: { id: string; score: number } | null = null;
    for (const candidate of this.aliasKeys) {
      if (Math.abs(candidate.length - key.length) > 2) continue;
      if (!candidate || candidate[0] !== key[0]) continue;
      const score = diceCoefficient(candidate, key);
      if (score >= 0.86 && (!best || score > best.score)) {
        const id = this.aliases.get(candidate);
        if (id) best = { id, score };
      }
    }
    return best?.id ?? null;
  }
}

/** Build a logo URL only when the channel has no explicit logo. */
export function channelLogo(channel: { logo?: string | null; tvgId?: string | null; name: string }, baseUrl?: string | null): string | undefined {
  if (channel.logo) {
    // Old data may still point at the retired fanmingming host.
    return channel.logo.replace(
      /^https?:\/\/live\.fanmingming\.com\/tv\//i,
      'https://cdn.jsdelivr.net/gh/fanmingming/live@main/tv/',
    );
  }
  if (!channel.tvgId) return undefined;
  // live.fanmingming.com is frequently unreachable; keep old settings working
  // by mapping its known base to the same pack on jsDelivr.
  const base = !baseUrl || /live\.fanmingming\.com/i.test(baseUrl)
    ? 'https://cdn.jsdelivr.net/gh/fanmingming/live@main/tv/'
    : baseUrl;
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(channel.tvgId)}.png`;
}

export { stripNoise };
