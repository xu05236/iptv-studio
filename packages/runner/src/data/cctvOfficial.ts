/**
 * Official CCTV fallback. CNTV's CDN requires a cctv.com referer on some
 * edges; M3U #EXTVLCOPT keeps that header attached to the line so both the
 * prober and exported playlists send it.
 */
export const CCTV_OFFICIAL_PLAYLIST = `#EXTM3U
#EXTINF:-1 tvg-id="CCTV1" group-title="央视",CCTV-1 综合
#EXTVLCOPT:http-user-agent=Mozilla/5.0
#EXTVLCOPT:http-referrer=https://tv.cctv.com/
http://ldncctvwbndtxy.liveplay.myqcloud.com/ldncctvwbnd/ldcctv1_2/index.m3u8
#EXTINF:-1 tvg-id="CCTV1" group-title="央视",CCTV-1 综合
http://ldncctvwbndcnc.v.wscdns.com/ldncctvwbnd/ldcctv1_2/index.m3u8
#EXTINF:-1 tvg-id="CCTV13" group-title="央视",CCTV-13 新闻
#EXTVLCOPT:http-user-agent=Mozilla/5.0
#EXTVLCOPT:http-referrer=https://tv.cctv.com/
http://ldncctvwbndtxy.liveplay.myqcloud.com/ldncctvwbnd/ldcctv13_2/index.m3u8
#EXTINF:-1 tvg-id="CCTV13" group-title="央视",CCTV-13 新闻
http://ldncctvwbndcnc.v.wscdns.com/ldncctvwbnd/ldcctv13_2/index.m3u8
`;

export function builtinPlaylist(url: string): string | null {
  if (url === 'builtin://cctv-official') return CCTV_OFFICIAL_PLAYLIST;
  return null;
}
