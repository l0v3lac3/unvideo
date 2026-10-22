/**
 * Normalized data model shared by all frontend views — mirrors
 * `convex/sources/types.ts`. Views only ever render these shapes, so adding
 * an upstream site never touches a component. Keep the two files in sync.
 */

/** Stream info returned by a video source's `resolve`. */
export type StreamInfo = {
  /** Direct upstream URL (informational; not playable from the browser). */
  videoUrl: string;
  /** Absolute, signed URL of the rewritten HLS playlist — hand to hls.js. */
  playlistUrl: string;
  /** Signed URL of the thumbnail storyboard (VTT), when available. */
  thumbVttUrl: string | null;
};

export type VideoBlock = {
  type: 'hls' | 'mp4';
  /**
   * A directly playable stream URL — or, when `pageUrl` is set, the upstream
   * page URL that must be resolved through the source's video endpoint.
   */
  url: string;
  /** When set, resolve through the source's video endpoint instead of streaming `url`. */
  pageUrl?: string;
  id?: string;
  poster?: string;
};

export type Recommendation = {
  /** Canonical article path within the source (starts with /). */
  path: string;
  title: string;
  cover?: string;
  desc?: string;
};

/** Ordered article body block, in original site layout. */
export type ArticleBlock =
  | { type: 'p'; text: string }
  | { type: 'h'; level: number; text: string }
  | { type: 'quote'; text: string }
  | { type: 'img'; url: string }
  | { type: 'video'; video: VideoBlock }
  | { type: 'rec'; rec: Recommendation };

export type FeedItem = {
  id: string;
  /** Normalized article path within the source (starts with /). */
  path: string;
  title: string;
  cover?: string;
  published?: string;
  /** Chips rendered under the title. */
  tags?: string[];
  /** Footer facts (e.g. view count). */
  meta?: string[];
};

export type FeedPage = {
  src: string;
  path: string;
  page: number;
  totalPages: number;
  items: FeedItem[];
};

export type Article = {
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
};

export type SiteCategory = {
  path: string;
  name: string;
};

export type SiteInfo = {
  src: string;
  node: string;
  nodeSource: 'api' | 'default';
  categories: SiteCategory[];
};
