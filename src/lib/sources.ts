/**
 * Frontend source registry — mirrors `convex/sources/index.ts`.
 *
 * Adding an upstream site: implement the backend adapter, add one entry to
 * the backend registry, and one entry here. The views (App, Feed, Article,
 * Home, router) are source-agnostic and never change.
 *
 * Route segments are derived from `id`, so ids must not collide with the
 * reserved words used in feed/article paths: `page`, `category`, `archives`,
 * `play`.
 */

import {
  getArticle,
  getFeed,
  getSiteInfo,
  isRouPageUrl,
  resolveStream,
} from './api';
import type { Article, FeedPage, SiteInfo, StreamInfo } from './types';

export type FrontendSource = {
  /** Stable id — also the route prefix and the `src` API parameter. */
  id: string;
  /** Display name in the site switch bar and on the home cards. */
  label: string;
  /** Short description shown on the home card. */
  desc: string;
  kind: 'video' | 'feed';
  /** Video sources: validate a pasted page URL. */
  matchPageUrl?: (value: string) => boolean;
  /** Video sources: placeholder + hint for the URL bar. */
  urlPlaceholder?: string;
  urlHint?: string;
  /** Video sources: the URL pre-filled on first visit. */
  defaultUrl?: string;
  resolveVideo?: (pageUrl: string) => Promise<StreamInfo>;
  /** Feed sources: node + category nav for this source. */
  siteInfo?: () => Promise<SiteInfo>;
  feed?: (path: string, page: number, node?: string) => Promise<FeedPage>;
  article?: (path: string, node?: string) => Promise<Article>;
};

export const SOURCES: FrontendSource[] = [
  {
    id: 'cg51',
    label: '51吃瓜',
    desc: '吃瓜资讯：分类浏览、图文详情、内嵌视频播放',
    kind: 'feed',
    siteInfo: () => getSiteInfo('cg51'),
    feed: (path, page, node) => getFeed('cg51', path, page, node),
    article: (path, node) => getArticle('cg51', path, node),
  },
  {
    id: 'rou',
    label: 'rou.video',
    desc: '粘贴视频页链接，无广告播放（服务端解包 + 代理）',
    kind: 'video',
    matchPageUrl: isRouPageUrl,
    urlPlaceholder: '粘贴 rou.video 视频页 URL',
    urlHint: '请输入 rou.video 的视频页链接，形如 https://rou.video/v/xxxxxxxx',
    defaultUrl: 'https://rou.video/v/cmv62vyig000qs6nio33zzlw3',
    resolveVideo: (pageUrl) => resolveStream(pageUrl, 'rou'),
  },
];

export function sourceById(
  id: string | null | undefined,
): FrontendSource | undefined {
  return SOURCES.find((s) => s.id === id);
}

/** Route prefix for a source (the bar / cards navigate to these). */
export function sourceHomeRoute(
  src: FrontendSource,
):
  | { kind: 'feed'; src: string; path: string; page: number }
  | { kind: 'play'; src: string; url: string | null } {
  return src.kind === 'video'
    ? { kind: 'play', src: src.id, url: null }
    : { kind: 'feed', src: src.id, path: '/', page: 1 };
}
