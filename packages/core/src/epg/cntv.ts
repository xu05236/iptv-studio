import { cctvApiCode } from './cctv.js';

/**
 * CNTV's epginfo endpoint covers more than CCTV: most provincial satellite
 * channels also have a short code. Unsupported channels keep using XMLTV.
 */
export const CNTV_SATELLITE_CODES: Record<string, string> = {
  'beijing-weishi': 'btv1',
  'tianjin-weishi': 'tianjin',
  'hebei-weishi': 'hebei',
  'liaoning-weishi': 'liaoning',
  'jilin-weishi': 'jilin',
  'heilongjiang-weishi': 'heilongjiang',
  'dongfang-weishi': 'dongfang',
  'jiangsu-weishi': 'jiangsu',
  'zhejiang-weishi': 'zhejiang',
  'anhui-weishi': 'anhui',
  'dongnan-weishi': 'dongnan',
  'jiangxi-weishi': 'jiangxi',
  'shandong-weishi': 'shandong',
  'henan-weishi': 'henan',
  'hubei-weishi': 'hubei',
  'hunan-weishi': 'hunan',
  'guangdong-weishi': 'guangdong',
  'guangxi-weishi': 'guangxi',
  'chongqing-weishi': 'chongqing',
  'sichuan-weishi': 'sichuan',
  'guizhou-weishi': 'guizhou',
  'yunnan-weishi': 'yunnan',
  'xizang-weishi': 'xizang',
  'gansu-weishi': 'gansu',
  'qinghai-weishi': 'qinghai',
  'ningxia-weishi': 'ningxia',
  'xinjiang-weishi': 'xinjiang',
  'shenzhen-weishi': 'shenzhen',
  'xiamen-weishi': 'xiamen',
  'bingtuan-weishi': 'bingtuan',
  'yanbian-weishi': 'yanbian',
};

/** CNTV code for a canonical channel id (CCTV or supported satellite). */
export function cntvApiCode(channelId: string): string | null {
  return cctvApiCode(channelId) ?? CNTV_SATELLITE_CODES[channelId] ?? null;
}
