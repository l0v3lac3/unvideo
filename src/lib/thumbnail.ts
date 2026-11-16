/**
 * Cover generation for feed items that have no image of their own.
 *
 * Some sources (t66y) publish no images anywhere — list rows, thread pages
 * and player pages are all image-free — so the feed carries each item's page
 * URL (`FeedItem.pageUrl`) instead of a cover. This module resolves that
 * page through the source's `/api/video` endpoint and draws the stream's
 * first decodable frame to a canvas, producing a JPEG data URL.
 *
 * Generation is expensive (one stream resolve + a first-fragment download
 * per item), so it is:
 *  - deduped in flight (one generation per page URL),
 *  - capped at MAX_CONCURRENT simultaneous generations (queued behind),
 *  - cached in-memory for the session and in localStorage while there is
 *    room, so repainting a list or reloading the page does not re-decode.
 */

import { resolveStream } from './api';
import type { FeedItem } from './types';

/** Output size — the feed card is 4:3; we render slightly smaller. */
const THUMB_W = 320;
const THUMB_H = 240;
/** Seek target: past the first frame's fade-in, still within segment 1. */
const SEEK_SECONDS = 1;
/** Give up on a cover after this long (the card keeps its placeholder). */
const TIMEOUT_MS = 30_000;
/** At most this many streams decoded in parallel (segment downloads). */
const MAX_CONCURRENT = 2;

const STORAGE_PREFIX = 'unvideo.cover.';
/** Stop persisting once the stored covers approach this many bytes. */
const STORAGE_CAP = 3_000_000;

const memory = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
let active = 0;
const queue: Array<() => void> = [];

/** Acquire one of the MAX_CONCURRENT decode slots; run; release. */
function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = () => {
    active += 1;
    return fn().finally(() => {
      active -= 1;
      const next = queue.shift();
      if (next) next();
    });
  };
  if (active < MAX_CONCURRENT) return run();
  return new Promise<T>((resolve, reject) => {
    queue.push(() => {
      const p = run();
      p.then(resolve, reject);
    });
  });
}

/** localStorage-backed persistence (best effort, size-capped). */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(STORAGE_PREFIX + key) ?? null;
  } catch {
    return null;
  }
}

function rememberStored(key: string, dataUrl: string): void {
  try {
    let total = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STORAGE_PREFIX)) {
        total += (localStorage.getItem(k) ?? '').length;
        if (total > STORAGE_CAP) return;
      }
    }
    try {
      localStorage.setItem(STORAGE_PREFIX + key, dataUrl);
    } catch {
      /* quota exceeded — keep the in-memory cache only */
    }
  } catch {
    /* storage unavailable (e.g. private mode) — memory cache only */
  }
}

/**
 * Cover for one feed item: its `cover` when the source provides one, else a
 * frame generated from the item's stream (when the item carries a pageUrl).
 * Resolves to null when no cover can be produced (the UI keeps its
 * placeholder); it never rejects.
 */
export function getCoverForItem(
  src: string,
  item: FeedItem,
): Promise<string | null> {
  if (!item.pageUrl) return Promise.resolve(item.cover ?? null);
  const key = item.pageUrl;
  const memo = memory.get(key);
  if (memo !== undefined) return Promise.resolve(memo);
  const stored = readStored(key);
  if (stored) {
    memory.set(key, stored);
    return Promise.resolve(stored);
  }
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = withSlot(() => generateCover(src, item)).then(
    (url) => {
      inflight.delete(key);
      memory.set(key, url);
      if (url) rememberStored(key, url);
      return url;
    },
    (err) => {
      inflight.delete(key);
      console.warn(`cover generation failed (${item.id}):`, err);
      return null;
    },
  );
  inflight.set(key, p);
  return p;
}

/**
 * Resolve the item's stream and draw its first decodable frame.
 * The video element is created detached (never appended to the DOM); hls.js
 * feeds it via MediaSource, so the canvas capture is not cross-origin
 * tainted and no media fetch needs CORS.
 */
async function generateCover(
  src: string,
  item: FeedItem,
): Promise<string | null> {
  const pageUrl = item.pageUrl;
  if (!pageUrl) return null;
  const HlsLib = await import('hls.js');
  const { default: Hls } = HlsLib;

  let info;
  try {
    info = await resolveStream(pageUrl, src);
  } catch (err) {
    console.warn(`cover: stream resolve failed (${item.id}):`, err);
    return null;
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  return await new Promise<string | null>((resolve) => {
    let settled = false;
    let hls: InstanceType<typeof Hls> | null = null;

    const finish = (url: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.pause();
      if (hls) hls.destroy();
      video.removeAttribute('src');
      video.load();
      resolve(url);
    };

    const capture = (): string | null => {
      if (video.readyState < 2 || video.videoWidth === 0) return null;
      const canvas = document.createElement('canvas');
      canvas.width = THUMB_W;
      canvas.height = THUMB_H;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      // Center-crop to the card's 4:3.
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const scale = Math.max(THUMB_W / vw, THUMB_H / vh);
      const sw = THUMB_W / scale;
      const sh = THUMB_H / scale;
      ctx.drawImage(
        video,
        (vw - sw) / 2,
        (vh - sh) / 2,
        sw,
        sh,
        0,
        0,
        THUMB_W,
        THUMB_H,
      );
      try {
        return canvas.toDataURL('image/jpeg', 0.7);
      } catch {
        return null;
      }
    };

    const onTimeUpdate = () => {
      if (video.currentTime >= SEEK_SECONDS) finish(capture());
    };

    const timer = setTimeout(() => finish(capture()), TIMEOUT_MS);

    const start = () => {
      video.currentTime = SEEK_SECONDS;
      void video.play().catch(() => {
        /* muted autoplay should be allowed; the timeout still captures */
      });
    };

    if (Hls.isSupported()) {
      const instance = new Hls({
        enableWorker: true,
        // Only the first fragment is needed; keep the buffer tiny.
        maxBufferLength: 20,
        maxMaxBufferLength: 20,
        maxBufferSize: 5 * 1000 * 1000,
      });
      hls = instance;
      instance.on(Hls.Events.MANIFEST_PARSED, () => start());
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) finish(null);
      });
      instance.loadSource(info.playlistUrl);
      instance.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = info.playlistUrl;
      video.addEventListener('loadedmetadata', start, { once: true });
      video.addEventListener('error', () => finish(null), { once: true });
    } else {
      finish(null);
    }
  });
}
