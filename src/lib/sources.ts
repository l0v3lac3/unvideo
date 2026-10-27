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

import { getArticle, getFeed, getSiteInfo } from './api';
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
    id: '91porn',
    label: '91porn',
    desc: '91porn：分类浏览、MP4 直连播放（CDN 直出，无需代理）',
    kind: 'feed',
    siteInfo: () => getSiteInfo('91porn'),
    feed: (path, page, node) => getFeed('91porn', path, page, node),
    article: (path, node) => getArticle('91porn', path, node),
  },
  {
    id: 'rou',
    label: 'rou.video',
    desc: 'rou.video 视频库：分类浏览、无广告播放（服务端解包 + 代理）',
    kind: 'feed',
    siteInfo: () => getSiteInfo('rou'),
    feed: (path, page, node) => getFeed('rou', path, page, node),
    article: (path, node) => getArticle('rou', path, node),
  },
  {
    id: 't66y',
    label: '草榴社區',
    desc: 't66y 在線成人影院：普通主題列表（视频 + 标题），HLS 代理播放',
    kind: 'feed',
    siteInfo: () => getSiteInfo('t66y'),
    feed: (path, page, node) => getFeed('t66y', path, page, node),
    article: (path, node) => getArticle('t66y', path, node),
  },
  {
    id: 'kanav',
    label: 'KanAV',
    desc: 'KanAV 视频库：分类/搜索浏览，HLS 代理播放（服务端解码 + 代理）',
    kind: 'feed',
    siteInfo: () => getSiteInfo('kanav'),
    feed: (path, page, node) => getFeed('kanav', path, page, node),
    article: (path, node) => getArticle('kanav', path, node),
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
