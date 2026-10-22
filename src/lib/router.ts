import { useEffect, useLayoutEffect, useState } from 'react';
import { sourceById } from './sources';

/**
 * Minimal hash router.
 *
 * The app is deployed as a static SPA on GitHub Pages (see
 * `.github/workflows/deploy.yml` with `base: './'`), so a path-based router
 * would 404 on refresh/deep links. Hash routes survive static hosting and let
 * the browser's back/forward buttons move through the app instead of leaving
 * it.
 *
 * Routes are prefixed with the source id (see `lib/sources.ts`):
 *   #/                      home (site cards)
 *   #/<src>/                feed source home, page 1
 *   #/<src>/page/2/         feed source home, page 2
 *   #/<src>/category/x/     feed source category, page 1
 *   #/<src>/category/x/2/   feed source category, page 2
 *   #/<src>/archives/123/   article
 *   #/<src>?url=<page-url>  video source player
 *
 * Legacy (pre-source-prefix) hashes keep working: #/archives/123/,
 * #/category/x/[n]/, #/page/n/ all map to the 'cg51' source, and
 * #/rou?url=... is the 'rou' source player.
 */
export type Route =
  | { kind: 'home' }
  | { kind: 'feed'; src: string; path: string; page: number }
  | { kind: 'article'; src: string; path: string }
  | { kind: 'play'; src: string; url: string | null };

export type FeedRoute = Extract<Route, { kind: 'feed' }>;
export type PlayRoute = Extract<Route, { kind: 'play' }>;

const MARK = 'unvideo';
const HOME_PAGE = /^\/page\/(\d+)\/?$/;
const CATEGORY = /^\/category\/([a-z0-9_-]+)(?:\/(\d+))?\/?$/;
const ARTICLE = /^\/archives\/(\d+)\/?$/;

type RouterState = { app: typeof MARK; depth: number };

/** URL for a route, always in canonical form. */
export function buildHash(route: Route): string {
  switch (route.kind) {
    case 'home':
      return '#/';
    case 'article':
      return `#/${route.src}${route.path}`;
    case 'play':
      return route.url
        ? `#/${route.src}?url=${encodeURIComponent(route.url)}`
        : `#/${route.src}`;
    case 'feed': {
      const base = route.path === '/' ? '' : route.path.replace(/\/+$/, '');
      if (!base) {
        return route.page > 1
          ? `#/${route.src}/page/${route.page}/`
          : `#/${route.src}/`;
      }
      return route.page > 1
        ? `#/${route.src}${base}/${route.page}/`
        : `#/${route.src}${base}/`;
    }
  }
}

/** Key identifying a route for scroll-position bookkeeping. */
export function routeKey(route: Route): string {
  switch (route.kind) {
    case 'home':
      return 'home';
    case 'article':
      return `article:${route.src}:${route.path}`;
    case 'play':
      return `play:${route.src}:${route.url ?? ''}`;
    case 'feed':
      return `feed:${route.src}:${route.path}:${route.page}`;
  }
}

function clampPage(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

function feedRoute(src: string, path: string, page: number): Route {
  return { kind: 'feed', src, path, page };
}

/**
 * Parse the current hash into a route. Legacy hashes (no source prefix) map
 * to the 'cg51' source so old bookmarks keep working.
 */
export function parseHash(hash: string): { route: Route; canonical: string } {
  const raw = hash.replace(/^#/, '') || '/';
  const queryAt = raw.indexOf('?');
  const query = new URLSearchParams(
    queryAt === -1 ? '' : raw.slice(queryAt + 1),
  );
  let path = queryAt === -1 ? raw : raw.slice(0, queryAt);
  if (!path.startsWith('/')) path = `/${path}`;

  // New-style route: first segment is a source id.
  const firstSeg = path.split('/').filter(Boolean)[0] ?? '';
  const source = sourceById(firstSeg);
  if (source) {
    if (source.kind === 'video') {
      const url = query.get('url');
      const route: Route = {
        kind: 'play',
        src: source.id,
        url: url && source.matchPageUrl?.(url) ? url.trim() : null,
      };
      return { route, canonical: buildHash(route) };
    }
    const rest = path.slice(1 + firstSeg.length);
    if (rest === '' || rest === '/') {
      const route = feedRoute(source.id, '/', 1);
      return { route, canonical: buildHash(route) };
    }
    const page = rest.match(HOME_PAGE);
    if (page) {
      const route = feedRoute(source.id, '/', clampPage(Number(page[1])));
      return { route, canonical: buildHash(route) };
    }
    const cat = rest.match(CATEGORY);
    if (cat) {
      const route = feedRoute(
        source.id,
        `/category/${cat[1]}/`,
        clampPage(Number(cat[2] ?? 1)),
      );
      return { route, canonical: buildHash(route) };
    }
    const art = rest.match(ARTICLE);
    if (art) {
      const route: Route = {
        kind: 'article',
        src: source.id,
        path: `/archives/${art[1]}/`,
      };
      return { route, canonical: buildHash(route) };
    }
    // Unknown path under a known source: fall back to its home.
    const route = feedRoute(source.id, '/', 1);
    return { route, canonical: buildHash(route) };
  }

  // Legacy routes (no source prefix) — all map to the 'cg51' source.
  const art = path.match(ARTICLE);
  if (art) {
    const route: Route = {
      kind: 'article',
      src: 'cg51',
      path: `/archives/${art[1]}/`,
    };
    return { route, canonical: buildHash(route) };
  }
  const cat = path.match(CATEGORY);
  if (cat) {
    const route = feedRoute(
      'cg51',
      `/category/${cat[1]}/`,
      clampPage(Number(cat[2] ?? 1)),
    );
    return { route, canonical: buildHash(route) };
  }
  const homePage = path.match(HOME_PAGE);
  if (homePage) {
    const route = feedRoute('cg51', '/', clampPage(Number(homePage[1])));
    return { route, canonical: buildHash(route) };
  }

  const route: Route = { kind: 'home' };
  return { route, canonical: buildHash(route) };
}

/* ------------------------------------------------------------------ *
 * History plumbing
 * ------------------------------------------------------------------ */

const listeners = new Set<() => void>();
const scrollPositions = new Map<string, number>();

/** Route currently rendered — the source of `positions` when navigating away. */
let currentKey: string | null = null;
/** Route whose scroll offset still needs restoring (cleared once applied). */
let pendingKey: string | null = null;

function readState(): RouterState | null {
  const state: unknown = window.history.state;
  if (
    state &&
    typeof state === 'object' &&
    (state as { app?: unknown }).app === MARK
  ) {
    const depth = (state as { depth?: unknown }).depth;
    return {
      app: MARK,
      depth: typeof depth === 'number' && depth > 0 ? depth : 0,
    };
  }
  return null;
}

function saveScroll() {
  if (currentKey) scrollPositions.set(currentKey, window.scrollY);
}

/** Last hash the router rendered; dedupes the popstate+hashchange pair. */
let lastSyncedHash: string | null = null;

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Scroll the current route back to its remembered offset. Called on a timer
 * after navigation and again when async content (feed/article) has rendered.
 * No-op once the offset has been reached or the user has scrolled.
 */
export function restoreScroll() {
  if (!pendingKey) return;
  const target = scrollPositions.get(pendingKey) ?? 0;
  window.scrollTo(0, target);
  if (Math.abs(window.scrollY - target) < 2) pendingKey = null;
}

/**
 * Push (or replace) a route and re-render. Saves the outgoing scroll offset so
 * returning via back/forward lands where the user left off.
 */
export function navigate(route: Route, options: { replace?: boolean } = {}) {
  const hash = buildHash(route);
  if (parseHash(window.location.hash).canonical === hash) return;

  saveScroll();
  const depth = readState()?.depth ?? 0;
  const state: RouterState = {
    app: MARK,
    depth: options.replace ? depth : depth + 1,
  };
  if (options.replace) window.history.replaceState(state, '', hash);
  else window.history.pushState(state, '', hash);
  emit();
}

/**
 * Go back one in-app step when possible; otherwise replace the current entry
 * with `fallback` so the button never kicks the user off the site.
 */
export function goBack(fallback: Route) {
  if ((readState()?.depth ?? 0) > 0) {
    window.history.back();
    return;
  }
  saveScroll();
  window.history.replaceState(
    { app: MARK, depth: 0 } satisfies RouterState,
    '',
    buildHash(fallback),
  );
  emit();
}

/** Current route, kept in sync with hash changes, back/forward and events. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(
    () => parseHash(window.location.hash).route,
  );

  useEffect(() => {
    if ('scrollRestoration' in window.history) {
      // We restore offsets ourselves; the browser cannot know when async
      // content has grown tall enough.
      window.history.scrollRestoration = 'manual';
    }

    const parsed = parseHash(window.location.hash);
    const state = readState();
    if (!state) {
      window.history.replaceState(
        { app: MARK, depth: 0 } satisfies RouterState,
        '',
        parsed.canonical,
      );
    } else if (window.location.hash !== parsed.canonical) {
      window.history.replaceState(state, '', parsed.canonical);
    }
    lastSyncedHash = parsed.canonical;

    const sync = () => {
      const next = parseHash(window.location.hash);
      // Browsers fire popstate *and* hashchange for one navigation; the second
      // event would otherwise save the already-reset scroll of the new route.
      if (next.canonical === lastSyncedHash) return;
      saveScroll();
      lastSyncedHash = next.canonical;
      setRoute(next.route);
    };
    listeners.add(sync);
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  return route;
}

/**
 * Remember/restore the window scroll offset for a route key. Retries briefly so
 * lists/articles that paint after their data arrives still land correctly.
 */
export function useScrollRestoration(key: string) {
  useLayoutEffect(() => {
    currentKey = key;
    pendingKey = key;

    const target = scrollPositions.get(key) ?? 0;
    if (target <= 0) {
      pendingKey = null;
      window.scrollTo(0, 0);
      return;
    }

    const timers = [0, 150, 400, 900, 1600].map((ms) =>
      window.setTimeout(restoreScroll, ms),
    );
    const cancel = () => {
      pendingKey = null;
    };
    const options: AddEventListenerOptions = { passive: true };
    window.addEventListener('wheel', cancel, options);
    window.addEventListener('touchstart', cancel, options);
    window.addEventListener('pointerdown', cancel, options);
    window.addEventListener('keydown', cancel);

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      pendingKey = null;
      window.removeEventListener('wheel', cancel);
      window.removeEventListener('touchstart', cancel);
      window.removeEventListener('pointerdown', cancel);
      window.removeEventListener('keydown', cancel);
    };
  }, [key]);
}
