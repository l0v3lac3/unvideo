/**
 * Normalized models + the source adapter interface.
 *
 * Every upstream site is wrapped in a `Source` that maps its quirks
 * (scraping, byte transforms, URL shapes) onto these models, so the HTTP
 * dispatcher in `http.ts` and the frontend views stay source-agnostic.
 *
 * Adding a new site = implement a Source in its own file, register it in
 * `sources/index.ts`, and add a matching entry to the frontend registry
 * (`src/lib/sources.ts`).
 */

/** Resolved, playable stream for a video page. */
export interface VideoInfo {
  /** Direct upstream URL (informational; usually not playable in-browser). */
  videoUrl: string;
  /** Absolute, signed URL of the (rewritten) playlist — hand to hls.js. */
  playlistUrl: string;
  /** Absolute, signed URL of a thumbnail storyboard, if the page has one. */
  thumbVttUrl: string | null;
}

export interface Recommendation {
  /** Canonical article path within the source (e.g. `/archives/<id>/`). */
  path: string;
  title: string;
  cover?: string;
  desc?: string;
}

export interface VideoBlock {
  type: "hls" | "mp4";
  /**
   * A directly playable stream URL — or, when `pageUrl` is set, the upstream
   * page URL that must be resolved through the source's video endpoint.
   */
  url: string;
  /**
   * When set, the player must resolve the stream through the source's video
   * endpoint (`/api/video`) using this page URL, instead of streaming `url`
   * directly.
   */
  pageUrl?: string;
  /** Upstream id, when available (stable key for the player). */
  id?: string;
  poster?: string;
}

/** Ordered article body block, in original site layout. */
export type ArticleBlock =
  | { type: "p"; text: string }
  | { type: "h"; level: number; text: string }
  | { type: "quote"; text: string }
  | { type: "img"; url: string }
  | { type: "video"; video: VideoBlock }
  | { type: "rec"; rec: Recommendation };

/** Normalized article. All URLs are absolute (signed where needed). */
export interface Article {
  src: string;
  /** Canonical path within the source. */
  path: string;
  title: string;
  description?: string;
  author?: string;
  published?: string;
  modified?: string;
  categories?: string[];
  tags?: string[];
  cover?: string;
  /** Flat gallery (fallback when `blocks` is empty). */
  images?: string[];
  /** Top-level player (fallback when `blocks` is empty). */
  video?: VideoBlock;
  /** Ordered body in original site layout. */
  blocks: ArticleBlock[];
  /** "推介" entries — clickable, jump to the linked article. */
  recommendations: Recommendation[];
  /** Station promo/ad article (no playable video). */
  promo?: boolean;
}

/** One row in a feed list. `path` is the normalized article path. */
export interface FeedItem {
  id: string;
  path: string;
  title: string;
  cover?: string;
  published?: string;
  /** Up to a few chips rendered under the title. */
  tags?: string[];
  /** Footer facts (e.g. view count). */
  meta?: string[];
}

export interface FeedPage {
  src: string;
  /** The list path that was requested (e.g. `/` or `/category/<slug>/`). */
  path: string;
  page: number;
  totalPages: number;
  items: FeedItem[];
}

export interface SiteCategory {
  /** List path within the source (e.g. `/category/<slug>/`). */
  path: string;
  name: string;
}

/** Feed-source site info (node + category nav). */
export interface SiteInfo {
  src: string;
  /** Current content node base URL (no trailing slash). */
  node: string;
  /** Where the node URL came from: "api" (freshly discovered) or "default". */
  nodeSource: "api" | "default";
  categories: SiteCategory[];
}

/**
 * One upstream site. A source may implement the video side
 * (`matchUrl`/`resolve`), the feed side (`siteInfo`/`feed`/`article`),
 * both, or just the proxy hooks for media/images it needs.
 */
export interface Source {
  id: string;
  /**
   * The source's home mode (drives the frontend home route). A source may
   * implement both sides; the capability guards below are method-based, not
   * `kind`-based, so a source can be browsable (feed) *and* resolvable
   * (video) at once.
   */
  kind: "video" | "feed";

  /* ---------------- video side ---------------- */
  /** True when `url` is a page this source can resolve. */
  matchUrl?(url: string): boolean;
  /** Resolve a page URL into a playable stream (origin = this deployment). */
  resolve?(url: string, origin: string): Promise<VideoInfo>;
  /** Hosts /api/media may fetch when no secret is configured. */
  mediaHosts?(host: string): boolean;
  /** Byte transform for proxied media (e.g. PNG unwrap). */
  transformMedia?(data: Uint8Array): Uint8Array;

  /* ---------------- feed side ---------------- */
  /** Site info: content node + category nav. */
  siteInfo?(): Promise<SiteInfo>;
  /** List one page of a feed (path e.g. `/` or `/category/<slug>/`). */
  feed?(path: string, page: number, nodeOverride?: string): Promise<FeedPage>;
  /** Resolve one article page. */
  article?(path: string, nodeOverride?: string): Promise<Article>;
  /** Normalize an article reference to its canonical path; null if not one. */
  matchArticle?(value: string): string | null;

  /* ---------------- proxy hooks ---------------- */
  /** Hosts /api/img may fetch (image CDN allowlist). */
  imageHosts?(host: string): boolean;
  /** Byte transform for proxied images (e.g. decrypt). */
  transformImage?(data: Uint8Array): Promise<Uint8Array>;
  /** Source-specific upstream fetch (headers/referer). Default: UA fetch. */
  fetchTarget?(target: string): Promise<Response>;
}

/** Method-based: a source with `matchUrl` + `resolve` can resolve page URLs. */
export function isVideoSource(s: Source): s is Source & {
  matchUrl: (url: string) => boolean;
  resolve: (url: string, origin: string) => Promise<VideoInfo>;
} {
  return !!s.matchUrl && !!s.resolve;
}

/** Method-based: a source with the feed trio is browsable. */
export function isFeedSource(s: Source): s is Source & {
  siteInfo: () => Promise<SiteInfo>;
  feed: (path: string, page: number, nodeOverride?: string) => Promise<FeedPage>;
  article: (path: string, nodeOverride?: string) => Promise<Article>;
} {
  return !!s.siteInfo && !!s.feed && !!s.article;
}
