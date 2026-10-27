import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Play, RotateCcw, TriangleAlert } from 'lucide-react';
import { Button } from './ui';

interface PlayerProps {
  url: string;
  poster?: string;
  autoPlay?: boolean;
}

/**
 * Minimal HLS/MP4 preview. Many IPTV origins do not send CORS headers, so the
 * browser can fail even when the line is fine; the error copy points at that.
 */
export function Player({ url, poster, autoPlay = false }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(autoPlay);
  const [loading, setLoading] = useState(false);

  const play = useCallback(() => {
    setError(null);
    setLoading(true);
    setStarted(true);
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported() && /\.m3u8(\?|$)/i.test(url)) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 20 });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setLoading(false);
        void video.play().catch(() => undefined);
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setLoading(false);
          setError(
            data.type === Hls.ErrorTypes.NETWORK_ERROR
              ? '网络错误：可能是源站禁止跨域（CORS）或线路已失效'
              : '播放失败，可能是编码格式不受浏览器支持',
          );
          hls.destroy();
        }
      });
      return () => hls.destroy();
    }

    video.src = url;
    video.load();
    const onReady = (): void => {
      setLoading(false);
      void video.play().catch(() => undefined);
    };
    const onError = (): void => {
      setLoading(false);
      setError('无法播放，浏览器可能不支持该协议（RTSP/RTMP 请使用 VLC）');
    };
    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  }, [url]);

  useEffect(() => {
    if (!started) return;
    const cleanup = play();
    return () => {
      if (typeof cleanup === 'function') cleanup();
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
    };
  }, [started, play]);

  return (
    <div className="player">
      <video ref={videoRef} controls playsInline poster={poster} />
      {!started ? (
        <div className="player__overlay">
          <Button variant="glass" size="lg" onClick={() => setStarted(true)}>
            <Play size={18} /> 在线试播
          </Button>
          <span style={{ fontSize: 12, opacity: 0.8 }}>部分源站不允许跨域，试播失败不代表线路失效</span>
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
          <Button variant="glass" size="sm" onClick={() => setStarted(false)}>
            <RotateCcw size={14} /> 重试
          </Button>
        </div>
      ) : null}
    </div>
  );
}
