/**
 * Client for the Convex HTTP API (see convex/http.ts).
 *
 * Everything that needs a browser-like User-Agent, PNG unwrapping or CORS happens
 * on the Convex side; this module only talks to our own /api/* endpoints.
 */

const configured = import.meta.env.VITE_CONVEX_SITE_URL;

/** Base URL of the Convex HTTP actions API, e.g. https://<deployment>.convex.site */
export const API_BASE = (configured ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export type StreamInfo = {
  /** Direct upstream URL (informational; not playable from the browser). */
  videoUrl: string;
  /** Absolute, signed URL of the rewritten HLS playlist — hand this to hls.js. */
  playlistUrl: string;
  /** Signed URL of the thumbnail storyboard (VTT), when the page provides one. */
  thumbVttUrl: string | null;
};

/** Resolve a rou.video page URL into a playable playlist URL. */
export async function resolveStream(pageUrl: string): Promise<StreamInfo> {
  if (!API_BASE) {
    throw new ApiError(
      'VITE_CONVEX_SITE_URL 未配置：请把 Convex 部署的 .convex.site 地址写入环境变量后重新构建',
    );
  }

  let res: Response;
  try {
    res = await fetch(
      `${API_BASE}/api/resolve?url=${encodeURIComponent(pageUrl)}`,
    );
  } catch (error) {
    throw new ApiError(
      `无法连接后端：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const body: { error?: string } & Partial<StreamInfo> = await res
    .json()
    .catch(() => ({}) as { error?: string });
  if (!res.ok)
    throw new ApiError(body.error ?? `解析失败（HTTP ${res.status}）`);
  if (!body.playlistUrl) throw new ApiError('后端未返回播放列表地址');

  return {
    videoUrl: body.videoUrl ?? '',
    // The API returns a root-relative path so it works on any deployment origin.
    playlistUrl: body.playlistUrl.startsWith('http')
      ? body.playlistUrl
      : `${API_BASE}${body.playlistUrl}`,
    thumbVttUrl: body.thumbVttUrl
      ? body.thumbVttUrl.startsWith('http')
        ? body.thumbVttUrl
        : `${API_BASE}${body.thumbVttUrl}`
      : null,
  };
}

/** True for pages on rou.video (the only pages the backend will resolve). */
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

/**
 * Normalize an article reference (absolute node URL or a path from the feed /
 * recommendation cards) to the canonical `/archives/<id>/` path the backend
 * accepts. Returns null when the value is not an article at all.
 */
export function toArticlePath(value: string): string | null {
  const match = value.match(/\/archives\/(\d+)(?:[/?#]|$)/);
  return match ? `/archives/${match[1]}/` : null;
}

/* ------------------------------------------------------------------ *
 * 51吃瓜 (cg51.com) source — node discovery, feeds, articles.
 * ------------------------------------------------------------------ */

export type Cg51Video = {
  url: string;
  type: string;
  id: string;
};

export type Cg51Category = { slug: string; name: string };

export type NodeInfo = {
  node: string;
  source: 'api' | 'default';
  main: string | null;
  domains: string[];
  landing: string;
  categories: Cg51Category[];
};

export type FeedItem = {
  id: string;
  url: string;
  title: string;
  cover: string;
  published: string;
  author: string;
  categories: string[];
  views: string;
};

export type FeedResult = {
  node: string;
  path: string;
  page: number;
  totalPages: number;
  items: FeedItem[];
};

export type Cg51Rec = {
  /** Title of the recommended article. */
  title: string;
  /** /archives/<id>/ path on the same node (relative, starts with /). */
  path: string;
  /** Cover image URL (may be empty). */
  cover: string;
  /** Short description (collection TOC entries carry 简要描述). */
  desc: string;
};

export type Cg51BodyBlock =
  | { type: 'p'; text: string }
  | { type: 'h'; level: number; text: string }
  | { type: 'img'; url: string }
  | { type: 'video'; video: Cg51Video }
  | { type: 'quote'; text: string }
  | { type: 'rec'; rec: Cg51Rec };

export type Cg51Article = {
  node: string;
  url: string;
  title: string;
  description: string;
  author: string;
  published: string;
  modified: string;
  categories: string[];
  tags: string[];
  cover: string;
  images: string[];
  /** Ordered body in original site layout (text/heading/image/video/quote). */
  body: Cg51BodyBlock[];
  /** Recommendation ("推介") entries — clickable, jump to the linked article. */
  recommendations: Cg51Rec[];
  video: Cg51Video | null;
  /** Station promo/ad article (Meme/招募/抽奖) — no playable video. */
  isPromo: boolean;
};

async function getJson<T>(path: string): Promise<T> {
  if (!API_BASE) {
    throw new ApiError(
      'VITE_CONVEX_SITE_URL 未配置：请把 Convex 部署的 .convex.site 地址写入环境变量后重新构建',
    );
  }
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

/** Discover the current content node and its category nav. */
export function getNodeInfo(): Promise<NodeInfo> {
  return getJson<NodeInfo>('/api/node');
}

/** List a feed page (home or category). */
export function getFeed(
  path: string,
  page: number,
  node?: string,
): Promise<FeedResult> {
  const q = new URLSearchParams({ path, page: String(page) });
  if (node) q.set('node', node);
  return getJson<FeedResult>(`/api/feed?${q}`);
}

/** Resolve an article page into full metadata + media. */
export function getArticle(path: string, node?: string): Promise<Cg51Article> {
  const q = new URLSearchParams({ path });
  if (node) q.set('node', node);
  return getJson<Cg51Article>(`/api/article?${q}`);
}
