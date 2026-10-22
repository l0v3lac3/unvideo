import { useEffect, useLayoutEffect, useState } from 'react';
import { isRouPageUrl } from './api';

/**
 * Minimal hash router.
 *
 * The app is deployed as a static SPA on GitHub Pages (see
 * `.github/workflows/deploy.yml` with `base: './'`), so a path-based router
 * would 404 on refresh/deep links. Hash routes survive static hosting and let
 * the browser's back/forward buttons move through the app instead of leaving
 * it.
 *
 * Canonical hashes mirror the 51吃瓜 paths so they are easy to read:
 *   #/                      home feed, page 1
 *   #/page/2/               home feed, page 2
 *   #/category/<slug>/      category feed, page 1
 *   #/category/<slug>/2/    category feed, page 2
 *   #/archives/<id>/        article
 *   #/rou?url=<page-url>    rou.video player
 */
export type Route =
  | { kind: 'feed'; path: string; page: number }
  | { kind: 'article'; path: string }
  | { kind: 'rou'; url: string | null };

export type FeedRoute = Extract<Route, { kind: 'feed' }>;

const MARK = 'rouvideo';
const HOME_PAGE = /^\/page\/(\d+)\/?$/;
const CATEGORY = /^\/category\/([a-z0-9_-]+)(?:\/(\d+))?\/?$/;
const ARTICLE = /^\/archives\/(\d+)\/?$/;

type RouterState = { app: typeof MARK; depth: number };

/** URL for a route, always in canonical form. */
export function buildHash(route: Route): string {
  switch (route.kind) {
    case 'article':
      return `#${route.path}`;
    case 'rou':
      return route.url ? `#/rou?url=${encodeURIComponent(route.url)}` : '#/rou';
    case 'feed': {
      const base = route.path === '/' ? '' : route.path.replace(/\/+$/, '');
      if (!base) return route.page > 1 ? `#/page/${route.page}/` : '#/';
      return route.page > 1 ? `#${base}/${route.page}/` : `#${base}/`;
    }
  }
}

/** Key identifying a route for scroll-position bookkeeping. */
export function routeKey(route: Route): string {
  switch (route.kind) {
    case 'article':
      return `article:${route.path}`;
    case 'rou':
      return `rou:${route.url ?? ''}`;
    case 'feed':
      return `feed:${route.path}:${route.page}`;
  }
}

function clampPage(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

export function parseHash(hash: string): { route: Route; canonical: string } {
  const raw = hash.replace(/^#/, '') || '/';
  const queryAt = raw.indexOf('?');
  const query = new URLSearchParams(
    queryAt === -1 ? '' : raw.slice(queryAt + 1),
  );
  let path = queryAt === -1 ? raw : raw.slice(0, queryAt);
  if (!path.startsWith('/')) path = `/${path}`;

  if (path === '/rou' || path === '/rou/') {
    const url = query.get('url');
    const route: Route = {
      kind: 'rou',
      url: url && isRouPageUrl(url) ? url.trim() : null,
    };
    return { route, canonical: buildHash(route) };
  }

  const article = path.match(ARTICLE);
  if (article) {
    const route: Route = { kind: 'article', path: `/archives/${article[1]}/` };
    return { route, canonical: buildHash(route) };
  }

  const category = path.match(CATEGORY);
  if (category) {
    const route: Route = {
      kind: 'feed',
      path: `/category/${category[1]}/`,
      page: clampPage(Number(category[2] ?? 1)),
    };
    return { route, canonical: buildHash(route) };
  }

  const homePage = path.match(HOME_PAGE);
  if (homePage) {
    const route: Route = {
      kind: 'feed',
      path: '/',
      page: clampPage(Number(homePage[1])),
    };
    return { route, canonical: buildHash(route) };
  }

  if (path === '/' || path === '') {
    const route: Route = { kind: 'feed', path: '/', page: 1 };
    return { route, canonical: buildHash(route) };
  }

  // Unknown hash: fall back to the home feed instead of rendering nothing.
  const route: Route = { kind: 'feed', path: '/', page: 1 };
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
