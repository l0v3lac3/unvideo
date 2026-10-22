import type Hls from 'hls.js';
import { useEffect, useRef, useState } from 'react';
import { resolveStream, type StreamInfo } from '../lib/api';

/**
 * What the player should show. Either a rou.video page (resolved through the
 * Convex proxy) or a direct stream URL (the cg51 nodes serve CORS-open HLS /
 * MP4 that the browser can play without a proxy).
 */
export type StreamSource =
  | { kind: 'rou'; pageUrl: string }
  | { kind: 'url'; url: string; type: 'hls' | 'mp4' };

type Status = {
  kind: 'idle' | 'busy' | 'ready' | 'error';
  message: string;
};

const IDLE_STATUS: Status = {
  kind: 'idle',
  message: '就绪。选择或粘贴一个视频后点击播放。',
};

/**
 * Unified video player.
 *
 * - For `kind: 'rou'` it calls the Convex `/api/resolve` proxy (which unwraps
 *   the PNG container and rewrites the HLS playlist) and feeds hls.js.
 * - For `kind: 'url'` with `type: 'hls'` it points hls.js straight at the
 *   upstream m3u8 (the node and its CDN both send `Access-Control-Allow-Origin:
 *   *`, so no proxy is needed).
 * - For `kind: 'url'` with `type: 'mp4'` it sets `video.src` directly.
 *
 * Mount it with `key={...}` so switching sources resets the player state.
 */
export function Player({ source }: { source: StreamSource | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<Status>(() =>
    source ? { kind: 'busy', message: '正在加载视频…' } : IDLE_STATUS,
  );
  const [stream, setStream] = useState<StreamInfo | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!source || !video) return;

    let cancelled = false;
    let hls: Hls | null = null;

    const destroy = () => {
      if (hls) {
        hls.destroy();
        hls = null;
      }
      video.removeAttribute('src');
      video.load();
    };

    const play = () => {
      void video.play().catch(() => {
        /* autoplay may be blocked by the browser; the controls still work */
      });
    };

    const mountHls = (playlistUrl: string, upstreamUrl: string) => {
      setStream({
        videoUrl: upstreamUrl,
        playlistUrl,
        thumbVttUrl: null,
      });
      setStatus({ kind: 'busy', message: '正在加载视频流…' });
      void import('hls.js').then((HlsLib) => {
        if (cancelled) return;
        const { default: Hls } = HlsLib;
        if (Hls.isSupported()) {
          // Tolerant of flaky networks (rou's rotating CDNs, mobile data):
          // retry each fragment far more times before declaring failure.
          const instance = new Hls({
            enableWorker: true,
            manifestLoadingMaxRetry: 5,
            levelLoadingMaxRetry: 5,
            fragLoadingMaxRetry: 10,
            fragLoadingRetryDelay: 1000,
            manifestLoadingRetryDelay: 1000,
          });
          hls = instance;
          (window as Window & { __hls?: Hls }).__hls = instance;
          let netRecoveries = 0;
          instance.loadSource(playlistUrl);
          instance.attachMedia(video);
          instance.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;
            setStatus({ kind: 'ready', message: '播放就绪' });
            play();
          });
          // A fragment that actually landed means the network is fine again —
          // clear the transient retry note.
          instance.on(Hls.Events.FRAG_LOADED, () => {
            if (cancelled) return;
            setStatus((s) =>
              s.kind === 'ready' ? s : { kind: 'ready', message: '播放就绪' },
            );
          });
          instance.on(Hls.Events.ERROR, (_event, data) => {
            if (cancelled) return;
            // Non-fatal (e.g. networkError: fragLoadError): hls.js retries the
            // fragment internally and playback usually continues — show a
            // transient note instead of a hard error.
            if (!data.fatal) {
              if (
                data.type === Hls.ErrorTypes.NETWORK_ERROR ||
                data.type === Hls.ErrorTypes.OTHER_ERROR
              ) {
                setStatus({ kind: 'busy', message: '网络波动，正在自动重试…' });
              }
              return;
            }
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              netRecoveries += 1;
              if (netRecoveries <= 2) {
                setStatus({ kind: 'busy', message: '网络错误，正在重连…' });
                // First failure: resume loading. Second: reload from the
                // manifest. A third: give up.
                if (netRecoveries === 1) instance.startLoad();
                else instance.loadSource(playlistUrl);
                return;
              }
              setStatus({
                kind: 'error',
                message: '网络错误：多次重试后仍无法加载视频',
              });
              destroy();
              return;
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              setStatus({ kind: 'busy', message: '媒体错误，正在恢复…' });
              instance.recoverMediaError();
              return;
            }
            setStatus({ kind: 'error', message: `播放出错：${data.details}` });
            destroy();
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = playlistUrl;
          video.addEventListener(
            'loadedmetadata',
            () => {
              if (cancelled) return;
              setStatus({ kind: 'ready', message: '播放就绪' });
              play();
            },
            { once: true },
          );
        } else {
          setStatus({ kind: 'error', message: '此浏览器不支持 HLS 播放' });
        }
      });
    };

    const run = async () => {
      if (source.kind === 'rou') {
        setStatus({ kind: 'busy', message: '正在解密视频地址…' });
        let info: StreamInfo;
        try {
          info = await resolveStream(source.pageUrl);
        } catch (error) {
          if (!cancelled) {
            setStatus({
              kind: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }
        if (cancelled) return;
        mountHls(info.playlistUrl, info.videoUrl);
      } else if (source.type === 'hls') {
        mountHls(source.url, source.url);
      } else {
        // mp4 (or other progressive format) — play directly.
        setStream({
          videoUrl: source.url,
          playlistUrl: source.url,
          thumbVttUrl: null,
        });
        video.src = source.url;
        video.addEventListener(
          'loadedmetadata',
          () => {
            if (cancelled) return;
            setStatus({ kind: 'ready', message: '播放就绪' });
            play();
          },
          { once: true },
        );
      }
    };

    void run();

    return () => {
      cancelled = true;
      destroy();
    };
  }, [source]);

  return (
    <div className="player">
      <div className="video-frame">
        <video ref={videoRef} controls autoPlay playsInline />
      </div>
      <p className={`status status-${status.kind}`}>
        {status.kind === 'ready' ? '✅ ' : ''}
        {status.message}
      </p>
      {stream ? (
        <dl className="details">
          <dt>上游视频流</dt>
          <dd>{stream.videoUrl}</dd>
          {stream.videoUrl !== stream.playlistUrl ? (
            <>
              <dt>播放列表</dt>
              <dd>{stream.playlistUrl}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}
