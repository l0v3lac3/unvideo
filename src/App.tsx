import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Player, type StreamSource } from './components/Player';
import { Feed } from './components/Feed';
import { Article } from './components/Article';
import {
  getNodeInfo,
  isRouPageUrl,
  toArticlePath,
  type FeedItem,
  type NodeInfo,
} from './lib/api';
import {
  goBack,
  navigate,
  routeKey,
  useHashRoute,
  useScrollRestoration,
  type FeedRoute,
  type Route,
} from './lib/router';

type Tab = 'cg51' | 'rou';

const DEFAULT_ROU_URL = 'https://rou.video/v/cmv62vyig000qs6nio33zzlw3';
const HOME_FEED: FeedRoute = { kind: 'feed', path: '/', page: 1 };

/**
 * Two sources, one video-parsing site:
 *  - **51吃瓜 (cg51.com)**: browse the news feed (home or category), open an
 *    article to see its metadata / tags / images and play its video.
 *  - **rou.video**: paste a rou.video page URL and play it ad-free through the
 *    Convex proxy.
 *
 * Navigation lives in the URL hash (see `lib/router.ts`) so browser
 * back/forward, refresh and deep links all work on static GitHub Pages hosting.
 * The cg51 node is discovered server-side (`/api/node`) because the cg51.com
 * landing page sends no CORS headers; everything downstream of that is
 * browser-friendly.
 */
export default function App() {
  const route = useHashRoute();

  // cg51
  const [nodeInfo, setNodeInfo] = useState<NodeInfo | null>(null);
  const [nodeError, setNodeError] = useState<string | null>(null);

  // rou
  const [rouUrl, setRouUrl] = useState(DEFAULT_ROU_URL);
  const [rouHint, setRouHint] = useState<string | null>(null);
  // Bumped to remount the player when the same URL is submitted again (retry).
  const [playNonce, setPlayNonce] = useState(0);
  // Last rou URL the input was synced to (route → input, back/forward/deep links).
  const [syncedRouUrl, setSyncedRouUrl] = useState<string | null | undefined>(
    undefined,
  );

  // Remember the last 51吃瓜 view, the last feed page (back-button fallback) and
  // the last rou video, so switching tabs returns to what you were looking at
  // instead of resetting to the home page.
  const lastCg51 = useRef<Route>(HOME_FEED);
  const lastFeed = useRef<FeedRoute>(HOME_FEED);
  const lastRou = useRef<string | null>(null);

  if (route.kind === 'rou' && route.url !== syncedRouUrl) {
    setSyncedRouUrl(route.url);
    setRouUrl(route.url ?? DEFAULT_ROU_URL);
  }

  useEffect(() => {
    if (route.kind !== 'rou') lastCg51.current = route;
    if (route.kind === 'feed') lastFeed.current = route;
    if (route.kind === 'rou') lastRou.current = route.url;
  }, [route]);

  // Restores the previous scroll offset on back/forward; scrolls to top on a
  // fresh article/page so jumps don't land mid-page.
  useScrollRestoration(routeKey(route));

  useEffect(() => {
    let cancelled = false;
    getNodeInfo()
      .then((info) => {
        if (!cancelled) {
          setNodeInfo(info);
          setNodeError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          // Fall back to the known-good default node so browsing still works.
          setNodeError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const node = nodeInfo?.node;
  const tab: Tab = route.kind === 'rou' ? 'rou' : 'cg51';

  const selectTab = (next: Tab) => {
    if (next === tab) return;
    if (next === 'rou') setRouUrl(lastRou.current ?? DEFAULT_ROU_URL);
    navigate(
      next === 'cg51'
        ? lastCg51.current
        : { kind: 'rou', url: lastRou.current },
    );
  };

  const openArticle = (item: FeedItem) => {
    const path = toArticlePath(item.url);
    if (path) navigate({ kind: 'article', path });
  };

  const openArticlePath = (value: string) => {
    const path = toArticlePath(value);
    if (path) navigate({ kind: 'article', path });
  };

  const submitRou = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const url = rouUrl.trim();
    if (!isRouPageUrl(url)) {
      setRouHint(
        '请输入 rou.video 的视频页链接，形如 https://rou.video/v/xxxxxxxx',
      );
      return;
    }
    setRouHint(null);
    if (route.kind === 'rou' && route.url === url) {
      // Same page again: remount the player instead of pushing a duplicate entry.
      setPlayNonce((n) => n + 1);
      return;
    }
    navigate({ kind: 'rou', url });
  };

  const rouStream: StreamSource | null =
    route.kind === 'rou' && route.url
      ? { kind: 'rou', pageUrl: route.url }
      : null;

  return (
    <main className="app">
      <header className="app-header">
        <h1>🍉 视频解析站</h1>
        <p className="tagline">
          51吃瓜资讯视频 + rou.video 无广告播放 · React + Convex + Vite
        </p>
      </header>

      <nav className="tabs">
        <button
          className={tab === 'cg51' ? 'tab active' : 'tab'}
          onClick={() => selectTab('cg51')}
        >
          📰 51吃瓜
        </button>
        <button
          className={tab === 'rou' ? 'tab active' : 'tab'}
          onClick={() => selectTab('rou')}
        >
          🎬 rou.video
        </button>
      </nav>

      {route.kind === 'article' ? (
        <button className="back-btn" onClick={() => goBack(lastFeed.current)}>
          ← 返回
        </button>
      ) : null}

      {route.kind !== 'rou' ? (
        <section>
          {nodeInfo ? (
            <div className="node-bar">
              <span>节点</span>
              <code>{nodeInfo.node}</code>
              <span className="node-src">
                {nodeInfo.source === 'api' ? '实时解析' : '默认'}
              </span>
            </div>
          ) : null}
          {nodeError ? (
            <p className="hint">节点发现失败（已用默认节点）：{nodeError}</p>
          ) : null}

          {node ? (
            route.kind === 'article' ? (
              <Article
                key={route.path}
                path={route.path}
                node={node}
                onOpenPath={openArticlePath}
              />
            ) : (
              <>
                <CategoryNav
                  categories={nodeInfo?.categories ?? []}
                  active={route.path}
                  onSelect={(path) => navigate({ kind: 'feed', path, page: 1 })}
                />
                <Feed
                  key={`${route.path}:${route.page}`}
                  path={route.path}
                  page={route.page}
                  node={node}
                  onOpen={openArticle}
                  onPageChange={(page) =>
                    navigate({ kind: 'feed', path: route.path, page })
                  }
                />
              </>
            )
          ) : (
            <p className="status">正在发现内容节点…</p>
          )}
        </section>
      ) : (
        <section>
          <ul className="badges">
            <li>服务端解包 PNG 伪装</li>
            <li>Convex 代理绕过 CORS</li>
            <li>hls.js 直接播放</li>
          </ul>
          <form className="url-bar" onSubmit={submitRou}>
            <input
              value={rouUrl}
              onChange={(e) => setRouUrl(e.target.value)}
              placeholder="粘贴 rou.video 视频页 URL"
              aria-label="rou.video 视频页 URL"
              spellCheck={false}
            />
            <button type="submit">播放</button>
          </form>
          {rouHint ? <p className="hint">{rouHint}</p> : null}
          <Player
            key={`${route.url ?? 'idle'}:${playNonce}`}
            source={rouStream}
          />
        </section>
      )}

      <footer className="app-footer">
        <p>
          51吃瓜节点由 <code>cg51.com</code>{' '}
          落地页解密得到（AES-CBC，服务端完成）， 其页面/视频/图片 CDN 均开放
          CORS，浏览器直接播放，无需代理。
        </p>
        <p>
          rou.video 要求浏览器 UA、载荷被 PNG 包裹且无 CORS 头，因此抓取与解包在
          Convex 服务端完成（<code>/api/resolve</code>、<code>/api/media</code>
          ）。
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
  categories: NodeInfo['categories'];
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
      {categories.map((c) => {
        const p = `/category/${c.slug}/`;
        return (
          <button
            key={c.slug}
            className={active === p ? 'cat active' : 'cat'}
            onClick={() => onSelect(p)}
          >
            {c.name}
          </button>
        );
      })}
    </div>
  );
}
