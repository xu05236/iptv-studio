import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Play, RotateCcw, ShieldAlert, TriangleAlert } from 'lucide-react';
import { Button } from './ui';

interface PlayerProps {
  url?: string;
  protocol?: string;
  lineKey?: string;
  relayAvailable?: boolean;
  directAvailable?: boolean;
  autoPlay?: boolean;
}

/**
 * Browser preview.
 *
 * Three failure modes are handled explicitly instead of showing a generic
 * "unsupported protocol" message:
 *  - RTSP/RTMP/UDP: browsers cannot play these at all.
 *  - HTTP line on an HTTPS page: mixed-content block.
 *  - HLS without CORS: hls.js network error.
 * The optional line relay fixes the last two by proxying through the Worker.
 */
export function Player({ url, protocol, lineKey, relayAvailable = false, directAvailable = false, autoPlay = false }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [mode, setMode] = useState<'direct' | 'relay'>('direct');
  const [directUrl, setDirectUrl] = useState<string | undefined>(undefined);
  const [started, setStarted] = useState(autoPlay && Boolean(url));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveUrl = url ?? directUrl;
  const unsupported = protocol ? /^(rtsp|rtmp|rtmps|udp|rtp)$/i.test(protocol) : /^(rtsp|rtmp|udp|rtp):/i.test(effectiveUrl ?? '');
  const mixed = Boolean(effectiveUrl?.startsWith('http://')) && window.location.protocol === 'https:';
  const path = (effectiveUrl ?? '').split('?')[0]!.toLowerCase();
  const looksLikeFile = /\.(mp4|m4v|webm|ogv|flv|mkv|avi|mov|ts)$/.test(path);
  // Many providers hide HLS behind `/hls/stream` or query-only URLs; treating
  // those as plain <video> yields "unsupported format" on Chrome.
  const isHls =
    protocol === 'hls' ||
    /m3u8|\/hls\//i.test(effectiveUrl ?? '') ||
    mode === 'relay' ||
    (/^https?:/i.test(effectiveUrl ?? '') && !looksLikeFile);

  const play = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setError(null);
    setLoading(true);
    setStarted(true);

    const source = mode === 'relay' && lineKey ? `/relay/line/${encodeURIComponent(lineKey)}` : (effectiveUrl ?? '');
    if (!source) {
      setLoading(false);
      setError('出于安全考虑，页面不展示真实线路地址；请使用中继试播或订阅地址。');
      return;
    }

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 20 });
      hlsRef.current = hls;
      hls.loadSource(source);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setLoading(false);
        void video.play().catch(() => undefined);
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        setLoading(false);
        const status = data.response?.code;
        setError(
          data.type === Hls.ErrorTypes.NETWORK_ERROR
            ? status === 403 || status === 502
              ? `网络错误：源站拒绝中继访问（HTTP ${status}，通常限制地区/IP）`
              : status
                ? `网络错误：线路返回 HTTP ${status}`
                : mixed || !relayAvailable
                  ? '源站拒绝跨域，或 HTTP 线路被 HTTPS 页面拦截；可尝试中继试播'
                  : '网络错误：线路可能已失效'
            : '播放失败：编码格式不受浏览器支持',
        );
        hls.destroy();
      });
      return;
    }

    video.src = source;
    video.load();
    const onReady = (): void => {
      setLoading(false);
      void video.play().catch(() => undefined);
    };
    const onError = (): void => {
      setLoading(false);
      setError('无法播放：可能是 TS/FLV 格式，或线路需要 Referer/User-Agent 请求头。请改用中继试播，或用订阅地址在 VLC 中播放。');
    };
    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  }, [effectiveUrl, mode, lineKey, isHls, mixed, relayAvailable]);
  useEffect(() => {
    if (!started) return;
    play();
    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
    };
  }, [started, play]);

  if (unsupported) {
    return (
      <div className="player">
        <div className="player__overlay">
          <ShieldAlert size={24} />
          <strong>浏览器无法播放 RTSP / RTMP 线路</strong>
          <span style={{ maxWidth: 340 }}>
            这类线路只支持 VLC / PotPlayer / 电视盒子。请使用订阅地址在播放器中观看，页面不再显示真实线路地址。
          </span>
        </div>
      </div>
    );
  }

  const requestDirect = useCallback(async () => {
    if (!lineKey) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/public/lines/${encodeURIComponent(lineKey)}/direct`);
      const data = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !data.url) throw new Error(data.error ?? '直连地址不可用');
      setDirectUrl(data.url);
      setMode('direct');
      setStarted(true);
    } catch (requestError) {
      setLoading(false);
      setError(requestError instanceof Error ? requestError.message : '直连地址不可用');
    }
  }, [lineKey]);

  return (
    <div className="player">
      <video ref={videoRef} controls playsInline />
      {!started || (mixed && mode === 'direct') ? (
        <div className="player__overlay">
          {mixed && mode === 'direct' ? (
            <>
              <TriangleAlert size={22} />
              <strong>该线路是 HTTP，HTTPS 页面会拦截播放</strong>
              <span style={{ maxWidth: 340 }}>可以经由 Worker 中继播放；中继会消耗少量流量，且受源站限速影响。</span>
            </>
          ) : (
            <span style={{ fontSize: 12, opacity: 0.8 }}>点下方按钮开始试播</span>
          )}
          <div className="row" style={{ gap: 8 }}>
            {relayAvailable && lineKey && (mixed || mode === 'direct') ? (
              <Button
                variant="glass"
                size="lg"
                onClick={() => {
                  setMode('relay');
                  setStarted(true);
                }}
              >
                <Play size={18} /> 中继试播
              </Button>
            ) : null}
            {directAvailable && lineKey && !url && !mixed ? (
              <Button variant="glass" size="lg" loading={loading} onClick={() => void requestDirect()}>
                <Play size={18} /> 直连试播
              </Button>
            ) : null}
            {!mixed && url ? (
              <Button
                variant="glass"
                size="lg"
                onClick={() => {
                  setMode('direct');
                  setStarted(true);
                }}
              >                <Play size={18} /> 在线试播
              </Button>
            ) : null}
          </div>
          {!relayAvailable && mixed ? <span style={{ fontSize: 12, opacity: 0.8 }}>管理员可在「设置 → 高级」开启中继</span> : null}
          {!url && !relayAvailable ? <span style={{ fontSize: 12, opacity: 0.8 }}>真实地址已隐藏；请在播放器中使用订阅地址</span> : null}
        </div>
      ) : null}
      {started && loading ? (
        <div className="player__overlay">
          <span>正在加载…</span>
        </div>
      ) : null}
      {error ? (
        <div className="player__overlay">
          <TriangleAlert size={22} />
          <span style={{ maxWidth: 360 }}>{error}</span>
          <div className="row" style={{ gap: 8 }}>
            {relayAvailable && lineKey && mode === 'direct' ? (
              <Button
                variant="glass"
                size="sm"
                onClick={() => {
                  setMode('relay');
                  setStarted(true);
                }}
              >
                改用中继
              </Button>
            ) : null}
            <Button variant="glass" size="sm" onClick={() => setStarted(false)}>
              <RotateCcw size={14} /> 重试
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
