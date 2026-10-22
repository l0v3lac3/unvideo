import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Player, type StreamSource } from './components/Player';
import { Feed } from './components/Feed';
import { Article } from './components/Article';
import { SOURCES, sourceById, sourceHomeRoute } from './lib/sources';
import type {
  FeedItem,
  SiteCategory,
  SiteCategoryGroup,
  SiteInfo,
} from './lib/types';
import {
  isFeedPath,
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

  // Remember each source's last list: the site-bar switch and the article
  // back-button both fall back to it (never to an article — landing on one
  // would make 返回 / browser-back step into a history entry of *another*
  // site, which is where the "back" button used to misfire).
  const lastFeed = useRef<Record<string, Route>>({});
  useEffect(() => {
    if (route.kind === 'feed') lastFeed.current[route.src] = route;
  }, [route]);

  // Node + category nav of the active feed source (discovered server-side).
  // The result is keyed by the src it was fetched for, so switching sources
  // hides the stale result during render — no synchronous reset needed.
  const siteFor =
    route.kind === 'feed' || route.kind === 'article' ? route.src : null;
  const [siteState, setSiteState] = useState<{
    src: string;
    info: SiteInfo | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!siteFor) return;
    const src = sourceById(siteFor);
    if (!src?.siteInfo) return;
    let cancelled = false;
    src
      .siteInfo()
      .then((info) => {
        if (!cancelled) setSiteState({ src: siteFor, info, error: null });
      })
      .catch((err) => {
        if (!cancelled)
          setSiteState({
            // The backend still falls back to a default node; report the cause.
            src: siteFor,
            info: null,
            error: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [siteFor]);
  const siteInfo =
    siteState && siteState.src === siteFor ? siteState.info : null;
  const siteError =
    siteState && siteState.src === siteFor ? siteState.error : null;

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
    // Restore the source's last *list* (home or category), not its last
    // article — an article restored over the current entry would make the
    // browser's back button (and 返回) step into another site's page.
    const last = lastFeed.current[id];
    navigate(
      last && last.kind === 'feed' && last.src === id
        ? last
        : sourceHomeRoute(target),
    );
  };

  const openArticle = (item: FeedItem) => {
    if (route.kind !== 'feed' || !item.path.startsWith('/')) return;
    navigate({ kind: 'article', src: route.src, path: item.path });
  };

  /**
   * Open a normalized in-source path: list paths (category / tag) open the
   * corresponding feed page, everything else is an article. Used by tag
   * chips and recommendation cards alike.
   */
  const openPath = (value: string) => {
    if (route.kind !== 'feed' && route.kind !== 'article') return;
    if (!value.startsWith('/')) return;
    if (isFeedPath(value)) {
      navigate({ kind: 'feed', src: route.src, path: value, page: 1 });
    } else {
      navigate({ kind: 'article', src: route.src, path: value });
    }
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
      {/* Frozen top: identity + site switch + back + category nav. Every
          feed/article page opens with this same header, so entering any
          article or video shows a unified page top. Categories come from the
          active source's siteInfo, so they never leak across sites. */}
      <div className="app-top">
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
          <button className="back-btn" onClick={() => navigate(backFallback())}>
            ← 返回
          </button>
        ) : null}

        {siteFor && siteInfo ? (
          <CategoryNav
            groups={siteInfo.categories}
            active={route.kind === 'feed' ? route.path : ''}
            onSelect={(path) => {
              if (route.kind === 'feed' || route.kind === 'article') {
                navigate({ kind: 'feed', src: route.src, path, page: 1 });
              }
            }}
          />
        ) : null}
      </div>

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
                onOpenPath={openPath}
              />
            ) : (
              <Feed
                key={`${route.src}:${route.path}:${route.page}`}
                src={route.src}
                path={route.path}
                page={route.page}
                node={siteInfo.node}
                onOpen={openArticle}
                onOpenPath={openPath}
                onPageChange={(page) =>
                  navigate({
                    kind: 'feed',
                    src: route.src,
                    path: route.path,
                    page,
                  })
                }
              />
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

/**
 * Grouped category nav (the frozen bar under the site switcher). The first
 * group (primary, e.g. rou 主分類 / cg51 分类) shows its top-level buttons
 * inline; a primary button with `children` carries a caret that reveals the
 * subcategories on the row below. Other groups (题材 / 属性, 分類精選) are
 * collapsible — they open when the user toggles them or when the active
 * route is one of their paths.
 */
function CategoryNav({
  groups,
  active,
  onSelect,
}: {
  groups: SiteCategoryGroup[];
  /** Active list path (`/` or a category/tag path); '' on article pages. */
  active: string;
  onSelect: (path: string) => void;
}) {
  // User-driven expansions, kept across route changes for the nav's lifetime.
  const [openCats, setOpenCats] = useState<ReadonlySet<string>>(new Set());
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());

  const toggleIn =
    (
      set: ReadonlySet<string>,
      apply: (next: Set<string>) => void,
      key: string,
    ) =>
    () => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      apply(next);
    };

  const primary = groups[0];

  // Which group / parent category contains `active` (drives auto-expand).
  let activeGroupId: string | null = null;
  let activeParentPath: string | null = null;
  for (const g of groups) {
    for (const c of g.categories) {
      const hits =
        c.path === active || (c.children ?? []).some((s) => s.path === active);
      if (hits) {
        activeGroupId = g.id;
        activeParentPath = c.path;
      }
    }
  }

  const catOpen = (c: SiteCategory) =>
    openCats.has(c.path) || c.path === activeParentPath;
  const groupOpen = (g: SiteCategoryGroup) =>
    g.id === primary?.id || openGroups.has(g.id) || g.id === activeGroupId;

  const homeActive = active === '/' || active === '';

  return (
    <nav className="cat-nav" aria-label="分类导航">
      <div className="cat-row">
        <button
          className={homeActive ? 'cat active' : 'cat'}
          onClick={() => onSelect('/')}
        >
          全部
        </button>
        {primary ? (
          <span className="cat-group">
            {primary.label ? (
              <span className="cat-group-label">{primary.label}</span>
            ) : null}
            {primary.categories.map((c) => (
              <CatButton
                key={c.path}
                cat={c}
                active={active === c.path}
                related={activeParentPath === c.path && active !== c.path}
                open={catOpen(c)}
                onSelect={onSelect}
                onToggle={toggleIn(openCats, setOpenCats, c.path)}
              />
            ))}
          </span>
        ) : null}
        {groups
          .filter((g) => g !== primary)
          .map((g) => (
            <button
              key={g.id}
              className={
                groupOpen(g) ? 'cat group-toggle open' : 'cat group-toggle'
              }
              onClick={toggleIn(openGroups, setOpenGroups, g.id)}
              aria-expanded={groupOpen(g)}
            >
              {g.label}{' '}
              <span aria-hidden="true">{groupOpen(g) ? '▾' : '▸'}</span>
            </button>
          ))}
      </div>

      {primary
        ? primary.categories
            .filter(catOpen)
            .filter((c) => (c.children ?? []).length > 0)
            .map((c) => (
              <div className="cat-row cat-row-sub" key={c.path}>
                <span className="cat-group-label">{c.name}</span>
                {(c.children ?? []).map((s) => (
                  <button
                    key={s.path}
                    className={active === s.path ? 'cat sub active' : 'cat sub'}
                    onClick={() => onSelect(s.path)}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            ))
        : null}

      {groups
        .filter((g) => g !== primary)
        .filter(groupOpen)
        .map((g) => (
          <div className="cat-row cat-row-sub" key={g.id}>
            {g.categories.map((c) => (
              <button
                key={c.path}
                className={active === c.path ? 'cat sub active' : 'cat sub'}
                onClick={() => onSelect(c.path)}
              >
                {c.name}
              </button>
            ))}
          </div>
        ))}
    </nav>
  );
}

/** A primary-category button; categories with subcategories get a caret. */
function CatButton({
  cat,
  active,
  related,
  open,
  onSelect,
  onToggle,
}: {
  cat: SiteCategory;
  active: boolean;
  /** True when the active route is one of this category's subcategories. */
  related: boolean;
  open: boolean;
  onSelect: (path: string) => void;
  onToggle: () => void;
}) {
  const hasKids = (cat.children ?? []).length > 0;
  if (!hasKids) {
    return (
      <button
        className={active ? 'cat active' : 'cat'}
        onClick={() => onSelect(cat.path)}
      >
        {cat.name}
      </button>
    );
  }
  return (
    <span className="cat-parent">
      <button
        className={active ? 'cat active' : related ? 'cat related' : 'cat'}
        onClick={() => onSelect(cat.path)}
      >
        {cat.name}
      </button>
      <button
        className="cat-caret"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}${cat.name}的子分类`}
      >
        {open ? '▾' : '▸'}
      </button>
    </span>
  );
}
