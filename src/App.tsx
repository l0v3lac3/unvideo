import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Player, type StreamSource } from './components/Player';
import { Feed } from './components/Feed';
import { Article } from './components/Article';
import { Home } from './components/Home';
import { SOURCES, sourceById, sourceHomeRoute } from './lib/sources';
import type { FeedItem, SiteInfo } from './lib/types';
import {
  goBack,
  navigate,
  routeKey,
  useHashRoute,
  useScrollRestoration,
  type Route,
} from './lib/router';

/**
 * Multi-source video-parsing site.
 *
 * Each upstream site is registered in `lib/sources.ts` (frontend) and
 * `convex/sources/` (backend); the views are source-agnostic:
 *  - **feed sources**: browse the feed (home or category), open an article to
 *    see its metadata / images and play its embedded video.
 *  - **video sources**: paste a page URL and play it ad-free through the
 *    Convex proxy.
 *
 * The site switch bar in the header (and the home cards) move between
 * sources from any page; navigation lives in the URL hash (see
 * `lib/router.ts`) so back/forward, refresh and deep links all work on the
 * static GitHub Pages hosting.
 */
export default function App() {
  const route = useHashRoute();
  const source = route.kind === 'home' ? undefined : sourceById(route.src);

  // Remember each source's last view (site-bar switch returns to where you
  // were) and last feed (the article back-button fallback).
  const lastView = useRef<Record<string, Route>>({});
  const lastFeed = useRef<Record<string, Route>>({});
  useEffect(() => {
    if (route.kind !== 'home') lastView.current[route.src] = route;
    if (route.kind === 'feed') lastFeed.current[route.src] = route;
  }, [route]);

  // Node + category nav of the active feed source (discovered server-side).
  const siteFor =
    route.kind === 'feed' || route.kind === 'article' ? route.src : null;
  const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(null);
  const [siteError, setSiteError] = useState<string | null>(null);
  useEffect(() => {
    if (!siteFor) {
      setSiteInfo(null);
      setSiteError(null);
      return;
    }
    const src = sourceById(siteFor);
    if (!src?.siteInfo) return;
    let cancelled = false;
    setSiteInfo(null);
    setSiteError(null);
    src
      .siteInfo()
      .then((info) => {
        if (!cancelled) {
          setSiteInfo(info);
          setSiteError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          // The backend still falls back to a default node; report the cause.
          setSiteError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [siteFor]);

  // Video source: URL bar state, synced with the route (back/forward/deep link).
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const [playHint, setPlayHint] = useState<string | null>(null);
  // Bumped to remount the player when the same URL is submitted again (retry).
  const [playNonce, setPlayNonce] = useState(0);
  const [syncedPlayUrl, setSyncedPlayUrl] = useState<string | null | undefined>(
    undefined,
  );
  if (route.kind === 'play' && route.url !== syncedPlayUrl) {
    setSyncedPlayUrl(route.url);
    setPlayUrl(route.url ?? source?.defaultUrl ?? '');
  }

  // Restores the previous scroll offset on back/forward; scrolls to top on a
  // fresh article/page so jumps don't land mid-page.
  useScrollRestoration(routeKey(route));

  const activeSrc = route.kind === 'home' ? null : route.src;

  const selectSite = (id: string) => {
    const target = sourceById(id);
    if (!target || activeSrc === id) return;
    const last = lastView.current[id];
    navigate(
      last && last.kind !== 'home' && last.src === id
        ? last
        : sourceHomeRoute(target),
    );
  };

  const openArticle = (item: FeedItem) => {
    if (route.kind !== 'feed' || !item.path.startsWith('/')) return;
    navigate({ kind: 'article', src: route.src, path: item.path });
  };

  const openArticlePath = (value: string) => {
    if (route.kind !== 'feed' && route.kind !== 'article') return;
    if (!value.startsWith('/')) return;
    navigate({ kind: 'article', src: route.src, path: value });
  };

  const submitPlay = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (route.kind !== 'play') return;
    const url = (playUrl ?? '').trim();
    if (!source?.matchPageUrl?.(url)) {
      setPlayHint(source?.urlHint ?? '请输入有效的视频页链接');
      return;
    }
    setPlayHint(null);
    if (route.url === url) {
      // Same page again: remount the player instead of pushing a duplicate
      // history entry.
      setPlayNonce((n) => n + 1);
      return;
    }
    navigate({ kind: 'play', src: route.src, url });
  };

  const playSource: StreamSource | null =
    route.kind === 'play' && route.url
      ? { kind: 'rou', pageUrl: route.url }
      : null;

  const backFallback = (): Route =>
    (route.kind === 'article' || route.kind === 'play') && source
      ? (lastFeed.current[route.src] ?? sourceHomeRoute(source))
      : { kind: 'home' };

  return (
    <main className="app">
      <header className="app-header">
        <h1>
          <a className="logo" href="#/">
            <span className="logo-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path d="M4 2l16 10-16 10V2z" fill="currentColor" />
              </svg>
            </span>
            <span className="logo-text" data-text="UNVIDEO">
              UNVIDEO
            </span>
          </a>
        </h1>
        <p className="tagline">视频解析站 // React + Convex + Vite</p>
      </header>

      <nav className="sites" aria-label="站点切换">
        <a className={activeSrc === null ? 'site active' : 'site'} href="#/">
          首页
        </a>
        {SOURCES.map((s) => (
          <button
            key={s.id}
            className={activeSrc === s.id ? 'site active' : 'site'}
            onClick={() => selectSite(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {route.kind === 'article' ? (
        <button className="back-btn" onClick={() => goBack(backFallback())}>
          ← 返回
        </button>
      ) : null}

      {route.kind === 'home' ? <Home /> : null}

      {route.kind === 'play' ? (
        <section>
          <ul className="badges">
            <li>服务端解包与签名</li>
            <li>Convex 代理绕过 CORS</li>
            <li>hls.js 直接播放</li>
          </ul>
          <form className="url-bar" onSubmit={submitPlay}>
            <input
              value={playUrl ?? ''}
              onChange={(e) => {
                setPlayUrl(e.target.value);
                setPlayHint(null);
              }}
              placeholder={source?.urlPlaceholder ?? '粘贴视频页 URL'}
              aria-label="视频页 URL"
              spellCheck={false}
            />
            <button type="submit">播放</button>
          </form>
          {playHint ? <p className="hint">{playHint}</p> : null}
          <Player
            key={`${route.src}:${route.url ?? 'idle'}:${playNonce}`}
            source={playSource}
          />
        </section>
      ) : null}

      {route.kind === 'feed' || route.kind === 'article' ? (
        <section>
          {siteInfo ? (
            <div className="node-bar">
              <span>节点</span>
              <code>{siteInfo.node}</code>
              <span className="node-src">
                {siteInfo.nodeSource === 'api' ? '实时解析' : '默认'}
              </span>
            </div>
          ) : null}
          {siteError ? (
            <p className="hint">节点发现失败（已用默认节点）：{siteError}</p>
          ) : null}

          {siteInfo ? (
            route.kind === 'article' ? (
              <Article
                key={`${route.src}:${route.path}`}
                src={route.src}
                path={route.path}
                node={siteInfo.node}
                onOpenPath={openArticlePath}
              />
            ) : (
              <>
                <CategoryNav
                  categories={siteInfo.categories}
                  active={route.path}
                  onSelect={(path) =>
                    navigate({ kind: 'feed', src: route.src, path, page: 1 })
                  }
                />
                <Feed
                  key={`${route.src}:${route.path}:${route.page}`}
                  src={route.src}
                  path={route.path}
                  page={route.page}
                  node={siteInfo.node}
                  onOpen={openArticle}
                  onPageChange={(page) =>
                    navigate({
                      kind: 'feed',
                      src: route.src,
                      path: route.path,
                      page,
                    })
                  }
                />
              </>
            )
          ) : (
            <p className="status">正在发现内容节点…</p>
          )}
        </section>
      ) : null}

      <footer className="app-footer">
        <p>
          页面抓取、媒体转换与签名均在 Convex 服务端完成（<code>/api/site</code>
          、<code>/api/feed</code>、<code>/api/article</code>、
          <code>/api/video</code>、<code>/api/media</code>、
          <code>/api/img</code>），前端只做渲染。
        </p>
      </footer>
    </main>
  );
}

function CategoryNav({
  categories,
  active,
  onSelect,
}: {
  categories: { path: string; name: string }[];
  active: string;
  onSelect: (path: string) => void;
}) {
  const homeActive = active === '/' || active === '';
  return (
    <div className="cat-nav">
      <button
        className={homeActive ? 'cat active' : 'cat'}
        onClick={() => onSelect('/')}
      >
        全部
      </button>
      {categories.map((c) => (
        <button
          key={c.path}
          className={active === c.path ? 'cat active' : 'cat'}
          onClick={() => onSelect(c.path)}
        >
          {c.name}
        </button>
      ))}
    </div>
  );
}
