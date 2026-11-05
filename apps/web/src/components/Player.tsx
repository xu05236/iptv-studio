import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Maximize2, Play, RotateCcw, ShieldAlert, TriangleAlert } from 'lucide-react';
import { Button } from './ui';

interface PlayerProps {
  url?: string;
  protocol?: string;
  lineKey?: string;
  codecs?: string;
  relayAvailable?: boolean;
  directAvailable?: boolean;
  directKind?: 'https' | 'http' | 'unsupported';
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
export function Player({ url, protocol, lineKey, codecs, relayAvailable = false, directAvailable = false, directKind, autoPlay = false }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const watchdogRef = useRef<number | null>(null);
  const loadingRef = useRef(false);
  const [mode, setMode] = useState<'direct' | 'relay'>('direct');
  const [directUrl, setDirectUrl] = useState<string | undefined>(undefined);
  const [started, setStarted] = useState(autoPlay && Boolean(url));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const armWatchdog = useCallback((message: string) => {
    clearWatchdog();
    // HLS.js retries failed manifests for a long time. Show a concrete error
    // instead of leaving the player on "正在加载…" forever.
    watchdogRef.current = window.setTimeout(() => {
      if (!loadingRef.current) return;
      setLoading(false);
      setError(message);
      hlsRef.current?.destroy();
      hlsRef.current = null;
    }, 20_000);
  }, [clearWatchdog]);

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
  // Allow a direct attempt whenever the admin enabled it, even if the relay
  // probe has not succeeded yet. Conversely, always expose relay for supported
  // protocols so a failed probe is not a dead end.
  const canDirect = Boolean(url) ? !mixed : directAvailable && Boolean(lineKey) && directKind !== 'http' && directKind !== 'unsupported';
  const canRelay = Boolean(lineKey);

  const play = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setError(null);
    setLoading(true);
    setStarted(true);
    clearWatchdog();
    if (mode === 'relay') {
      armWatchdog('中继加载超时：源站可能拒绝了 Cloudflare 出口，或当前线路分片不可用。请换一条线路或使用订阅地址。');
    }

    const source = mode === 'relay' && lineKey ? `/relay/line/${encodeURIComponent(lineKey)}` : (effectiveUrl ?? '');
    if (!source) {
      setLoading(false);
      clearWatchdog();
      setError('出于安全考虑，页面不展示真实线路地址；请使用中继试播或订阅地址。');
      return;
    }

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 20 });
      hlsRef.current = hls;
      hls.loadSource(source);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        clearWatchdog();
        setLoading(false);
        void video.play().catch(() => undefined);
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        clearWatchdog();
        setLoading(false);
        const status = data.response?.code;
        // The Worker egress is blocked by many Chinese CDNs. If the line is
        // HTTPS, the viewer's own IP can fetch it directly instead.
        if (mode === 'relay' && (status === 403 || status === 502) && directAvailable && directKind === 'https') {
          setError(null);
          void requestDirect();
          return;
        }
        // Direct playback often fails because of CORS / mixed content; try the
        // Worker relay automatically before showing an error.
        if (mode === 'direct' && lineKey && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          setError(null);
          setMode('relay');
          setStarted(true);
          return;
        }
        setError(
          data.type === Hls.ErrorTypes.NETWORK_ERROR
            ? status === 403 || status === 502
              ? `网络错误：源站拒绝中继访问（HTTP ${status}，通常限制地区/IP）`
              : status
                ? `网络错误：线路返回 HTTP ${status}`
                : mixed || !relayAvailable
                  ? '源站拒绝跨域，或 HTTP 线路被 HTTPS 页面拦截；可尝试中继试播'
                  : '网络错误：线路可能已失效'
            : /hvc1|hev1|hvc/i.test(codecs ?? '')
              ? '该线路是 H.265/HEVC，Chrome/Edge 不支持；请换 H.264 线路，或用 Safari / VLC 播放'
              : '播放失败：编码格式不受浏览器支持',
        );
        hls.destroy();
      });
      return;
    }

    video.src = source;
    video.load();
    const onReady = (): void => {
      clearWatchdog();
      setLoading(false);
      void video.play().catch(() => undefined);
    };
    const onError = (): void => {
      clearWatchdog();
      setLoading(false);
      setError('无法播放：可能是 TS/FLV 格式，或线路需要 Referer/User-Agent 请求头。请改用中继试播，或用订阅地址在 VLC 中播放。');
    };
    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  }, [effectiveUrl, mode, lineKey, isHls, mixed, relayAvailable, directAvailable, directKind, codecs, armWatchdog, clearWatchdog, requestDirect]);
  useEffect(() => {
    if (!started) return;
    play();
    return () => {
      clearWatchdog();
      hlsRef.current?.destroy();
      hlsRef.current = null;
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
    };
  }, [started, play, clearWatchdog]);

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

  return (
    <div className="player">
      <video ref={videoRef} controls playsInline />
      <button
        type="button"
        className="player__fullscreen"
        aria-label="全屏播放"
        onClick={() => {
          const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
          if (!video) return;
          if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
          else if (video.requestFullscreen) void video.requestFullscreen().catch(() => undefined);
          else video.webkitEnterFullscreen?.();
        }}
      >
        <Maximize2 size={15} />
      </button>
      {!started || (mixed && mode === 'direct') ? (
        <div className="player__overlay">
          {mixed && mode === 'direct' ? (
            <>
              <TriangleAlert size={22} />
              <strong>该线路是 HTTP，HTTPS 页面会拦截播放</strong>
              <span style={{ maxWidth: 340 }}>可以经由 Worker 中继播放；中继会消耗少量流量，且受源站限速影响。</span>
            </>
          ) : (
            <>
              <strong>选择播放方式</strong>
              <span style={{ fontSize: 12, opacity: 0.8 }}>直连使用你的网络，中继经过 Cloudflare；哪条通用哪条。</span>
            </>
          )}
          <div className="row" style={{ gap: 8 }}>
            {canDirect ? (
              <Button
                variant="glass"
                size="lg"
                loading={loading}
                onClick={() => {
                  if (url) {
                    setMode('direct');
                    setStarted(true);
                  } else {
                    void requestDirect();
                  }
                }}
              >
                <Play size={18} /> 直连试播
              </Button>
            ) : null}
            {canRelay ? (
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
          </div>
          {!canDirect && !canRelay ? (
            <span style={{ fontSize: 12, opacity: 0.8 }}>当前线路没有可用的试播入口，请使用订阅地址在 VLC / 盒子播放。</span>
          ) : null}
          {!canDirect ? <span style={{ fontSize: 12, opacity: 0.8 }}>直连不可用：可能被管理员关闭、线路为 HTTP 或需要中继。</span> : null}
          {!canRelay && !url ? <span style={{ fontSize: 12, opacity: 0.8 }}>真实地址已隐藏，请在播放器中使用订阅地址。</span> : null}
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
            {canRelay && mode === 'direct' ? (
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
            {canDirect && mode === 'relay' ? (
              <Button
                variant="glass"
                size="sm"
                onClick={() => {
                  if (url) {
                    setMode('direct');
                    setStarted(true);
                  } else {
                    void requestDirect();
                  }
                }}
              >
                改用直连
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
