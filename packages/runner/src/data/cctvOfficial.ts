/**
 * Official CCTV fallback. The CNTV player resolves these CDN URLs without a
 * referer; the playlist is intentionally tiny so it stays a last-resort source.
 */
export const CCTV_OFFICIAL_PLAYLIST = `#EXTM3U
#EXTINF:-1 tvg-id="CCTV1" group-title="央视",CCTV-1 综合
http://ldncctvwbndcnc.v.wscdns.com/ldncctvwbnd/ldcctv1_2/index.m3u8
#EXTINF:-1 tvg-id="CCTV13" group-title="央视",CCTV-13 新闻
http://ldncctvwbndcnc.v.wscdns.com/ldncctvwbnd/ldcctv13_2/index.m3u8
`;

export function builtinPlaylist(url: string): string | null {
  if (url === 'builtin://cctv-official') return CCTV_OFFICIAL_PLAYLIST;
  return null;
}
