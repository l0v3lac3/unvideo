/**
 * Client for the Convex HTTP API (see convex/http.ts).
 *
 * Everything that needs a browser-like User-Agent, media transformation or
 * CORS happens on the Convex side; this module only talks to our own
 * /api/* endpoints. All fetchers take a source id and dispatch to the
 * matching backend adapter — views never see source-specific fields.
 */

import type { Article, FeedPage, SiteInfo, StreamInfo } from './types';

const configured = import.meta.env.VITE_CONVEX_SITE_URL;

/** Base URL of the Convex HTTP actions API, e.g. https://<deployment>.convex.site */
export const API_BASE = (configured ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export type { StreamInfo } from './types';

function requireApiBase() {
  if (!API_BASE) {
    throw new ApiError(
      'VITE_CONVEX_SITE_URL 未配置：请把 Convex 部署的 .convex.site 地址写入环境变量后重新构建',
    );
  }
}

async function getJson<T>(path: string): Promise<T> {
  requireApiBase();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`);
  } catch (error) {
    throw new ApiError(
      `无法连接后端：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body: { error?: string } & T = await res.json().catch(() => ({}) as T);
  if (!res.ok)
    throw new ApiError(body.error ?? `请求失败（HTTP ${res.status}）`);
  return body;
}

/**
 * Resolve a page URL into a playable, signed playlist. `src` selects the
 * backend adapter (default: 'rou').
 */
export async function resolveStream(
  pageUrl: string,
  src: string = 'rou',
): Promise<StreamInfo> {
  requireApiBase();
  const q = new URLSearchParams({ src, url: pageUrl });
  const body = await getJson<Partial<StreamInfo>>(`/api/video?${q}`);
  if (!body.playlistUrl) throw new ApiError('后端未返回播放列表地址');
  const abs = (u: string) => (u.startsWith('http') ? u : `${API_BASE}${u}`);
  return {
    videoUrl: body.videoUrl ?? '',
    playlistUrl: abs(body.playlistUrl),
    thumbVttUrl: body.thumbVttUrl ? abs(body.thumbVttUrl) : null,
  };
}

/** True for pages on rou.video (the only pages the 'rou' adapter resolves). */
export function isRouPageUrl(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value.trim());
    return (
      protocol === 'https:' &&
      (hostname === 'rou.video' || hostname.endsWith('.rou.video'))
    );
  } catch {
    return false;
  }
}

/** Site info (content node + category nav) for a feed source. */
export function getSiteInfo(src: string): Promise<SiteInfo> {
  return getJson<SiteInfo>(`/api/site?src=${encodeURIComponent(src)}`);
}

/** List a feed page (home or category) for a feed source. */
export function getFeed(
  src: string,
  path: string,
  page: number,
  node?: string,
): Promise<FeedPage> {
  const q = new URLSearchParams({ src, path, page: String(page) });
  if (node) q.set('node', node);
  return getJson<FeedPage>(`/api/feed?${q}`);
}

/** Resolve an article path into the normalized article for a feed source. */
export function getArticle(
  src: string,
  path: string,
  node?: string,
): Promise<Article> {
  const q = new URLSearchParams({ src, path });
  if (node) q.set('node', node);
  return getJson<Article>(`/api/article?${q}`);
}
