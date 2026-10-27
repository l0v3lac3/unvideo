/**
 * Parsers and adapter for the kanav.ad source (KanAV).
 *
 * How the source works (all verified empirically, 2026-10-27):
 *  - kanav.ad is an Apple CMS (Maccms) site: SSR HTML on one stable host.
 *    A browser UA is required (Cloudflare challenges the default curl UA).
 *  - Video stream: the play page contains NO media URL in its HTML. The real
 *    stream is the `player_aaaa` JS object with `encrypt:2` —
 *    base64(urlencode(m3u8 URL)). Decoding yields the master HLS playlist,
 *    e.g. `https://cdn17.11yun.space/GAV1/345363/345363.m3u8` (1868 x 3s TS
 *    segments for a 93-min video; some listings are multi-hour). The
 *    `<source>` MP4s in the page are ADS (30s 360x480 ExoPlayer preroll on
 *    saawsedge.com, 10.6s 300x250 banner on bkcdn.net) — never use them.
 *  - The media CDN (cdnNN.11yun.space — hosts rotate: cdn16/cdn17/cdn)
 *    requires a browser UA AND `Referer: https://kanav.ad/` (403 without
 *    either). The browser can't connect directly (our pages live on GitHub
 *    Pages → wrong referer), so all media goes through /api/media with a
 *    custom `fetchTarget`. Segments are 3s MPEG-TS, Range-capable, open CORS
 *    (irrelevant — the referer check still applies).
 *  - Lists:
 *      home            /                       curated "精选视频" (16 cards,
 *                                              no pagination)
 *      category        /index.php/vod/type/id/<tid>/.html (p1)
 *                      /index.php/vod/type/id/<tid>/page/<N>.html (p>1)
 *                      24 cards/page, 972 pages on the largest category.
 *      search          /index.php/vod/search.html?wd=<q> (p1)
 *                      /index.php/vod/search/page/<N>/wd/<q>.html (p>1, the
 *                      path form the site's own pager uses) — no login.
 *  - Card skin (home + lists): `<a href="/index.php/vod/play/id/<id>/sid/1/
 *    nid/1.html">` + `<img data-original="https://img.11yun.xyz/<CAT>/<fid>/
 *    <fid>.jpg">` + `<span class="model-view-left">N Views</span>` +
 *    `<span class="model-view">DURATION</span>` (verified: segment count x 3s
 *    equals the span, e.g. 10886 segs ≈ "9小时 4分钟 20") +
 *    `<div class="entry-title"><a title="T">T</a> YYYY / MM / DD</div>`.
 *    The play page's "猜你喜欢" skin is the same but model-view-left carries
 *    the category name instead of a view count.
 *  - Play page metadata: `<h1><p>TITLE</p></h1>`, `MacPlayer.Pic` (poster),
 *    上映日期 (note the site's own `tltle` attribute typo) + category links
 *    (`/index.php/vod/type/id/<tid>.html`) in the hr-categories section,
 *    tag links and the actor in the hr-tags / hr-actor sections
 *    (`/index.php/vod/search.html?wd=<name>&by=time_add`).
 *  - Covers (img.11yun.xyz) serve 200 with any referer and are plain JPEGs —
 *    rendered directly in <img>, no image proxy needed.
 */

import { HttpError, mediaPath, proxySecret } from "../proxy";
import type {
  Article,
  ArticleBlock,
  FeedItem,
  FeedPage,
  Recommendation,
  SiteCategory,
  SiteInfo,
  Source,
  TagRef,
  VideoInfo,
} from "./types";

export const KANAV_BASE = "https://kanav.ad";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;

/** Page fetch (browser UA; referer optional for HTML pages). */
async function fetchText(
  target: string,
  referer: string | undefined,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      headers: {
        "User-Agent": BROWSER_UA,
        Referer: referer ?? "",
        Accept: "*/*",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new HttpError(502, `upstream returned ${res.status}`);
    return res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Media fetch for /api/media and /api/img. The CDN validates the referer —
 * it must be this site (any other referer, or none, yields 403).
 */
async function fetchMedia(target: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(target, {
      headers: {
        "User-Agent": BROWSER_UA,
        Referer: KANAV_BASE + "/",
        Accept: "*/*",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Node base URL used for requests (override wins). */
function nodeForRequest(nodeOverride: string | null | undefined): string {
  const node = nodeOverride ?? KANAV_BASE;
  if (!node.startsWith("https://")) {
    throw new HttpError(400, "invalid node");
  }
  return node.replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/**
 * Build the upstream list URL for a normalized list path + page number.
 *  /            → home (curated 精选视频, single page)
 *  /category/N  → type/id/<N>[/page/<P>]
 *  /search/q    → search.html?wd=<q> / search/page/<P>/wd/<q>.html
 * (the search query stays URL-encoded as a single segment)
 */
export function buildFeedUrl(path: string, page: number, node: string): string {
  let p = path || "/";
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+$/, "");

  if (p === "/" || p === "") {
    // The home has no pagination; deep pages simply re-show the curation.
    return `${node}/`;
  }
  if (p.startsWith("/category/")) {
    const tid = p.slice("/category/".length);
    if (!/^\d+$/.test(tid)) throw new HttpError(400, `invalid category: ${tid}`);
    return page > 1
      ? `${node}/index.php/vod/type/id/${tid}/page/${page}.html`
      : `${node}/index.php/vod/type/id/${tid}.html`;
  }
  if (p.startsWith("/search/")) {
    const q = p.slice("/search/".length);
    if (!q) throw new HttpError(400, "empty search query");
    let decoded = q;
    try {
      decoded = decodeURIComponent(q);
    } catch {
      // keep the raw segment
    }
    const enc = encodeURIComponent(decoded);
    return page > 1
      ? `${node}/index.php/vod/search/page/${page}/wd/${enc}.html`
      : `${node}/index.php/vod/search.html?wd=${enc}`;
  }
  throw new HttpError(
    400,
    "unsupported feed path (use /, /category/<id>/ or /search/<query>/)",
  );
}

/**
 * Normalize an article reference to `/vod/<id>/`; null if not one. Accepts
 * the canonical path or an upstream play URL (absolute or root-relative).
 */
export function matchArticleValue(value: string): string | null {
  const v = value.trim();
  const m =
    v.match(/^\/vod\/(\d+)\/?$/) ??
    v.match(/\/index\.php\/vod\/play\/id\/(\d+)/);
  return m ? `/vod/${m[1]}/` : null;
}

/** True when `url` is a kanav play page this source can resolve. */
export function isKanavPlayUrl(url: string): boolean {
  const m = url.match(/^(https:\/\/[^/]+)?\/index\.php\/vod\/play\/id\/\d+\/sid\/\d+\/nid\/\d+\.html$/);
  if (!m) return false;
  const host = m[1] ? m[1].replace(/^https:\/\//, "").replace(/\/$/, "") : "kanav.ad";
  return host === "kanav.ad" || host.endsWith(".kanav.ad");
}

/* ------------------------------------------------------------------ *
 * Stream resolution
 * ------------------------------------------------------------------ */

/**
 * `player_aaaa` line: `var player_aaaa={...single-line JSON...}`. Returns
 * the (encrypted) url field + the encrypt mode.
 */
export function extractPlayerEntry(
  html: string,
): { encrypt: number; url: string } | null {
  const at = html.indexOf("player_aaaa");
  if (at < 0) return null;
  const lineEnd = html.indexOf("\n", at);
  const line = html.slice(at, lineEnd < 0 ? at + 4000 : lineEnd);
  const enc = line.match(/"encrypt"\s*:\s*(\d+)/);
  const url = line.match(/"url"\s*:\s*"([^"]+)"/);
  if (!enc || !url) return null;
  return { encrypt: Number(enc[1]), url: url[1] };
}

/**
 * Decode the `player_aaaa.url` field:
 *  encrypt 2 → base64(urlencode(url))   encrypt 1 → base64(url)
 *  encrypt 0 → urlencode(url)           (0/1/2 all observed: 2 everywhere)
 */
export function decodePlayerUrl(raw: string, encrypt: number): string {
  let s = raw;
  if (encrypt >= 1) {
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    s = new TextDecoder().decode(bytes);
  }
  if (encrypt === 2 || encrypt === 0) s = decodeURIComponent(s);
  return s;
}

/** Resolve a play page URL into a signed, playable HLS playlist. */
async function resolveVideo(
  pageUrl: string,
  origin: string,
): Promise<VideoInfo> {
  const node = KANAV_BASE;
  const html = await fetchText(pageUrl, node + "/");
  const entry = extractPlayerEntry(html);
  if (!entry) throw new HttpError(502, "player entry not found on page");
  const m3u8 = decodePlayerUrl(entry.url, entry.encrypt);
  if (!m3u8.startsWith("https://")) {
    throw new HttpError(502, "decoded stream url is not https");
  }
  return {
    videoUrl: m3u8,
    playlistUrl: await mediaPath(proxySecret(), origin, m3u8, "kanav"),
    thumbVttUrl: null,
  };
}

/* ------------------------------------------------------------------ *
 * Feed / list parsing
 * ------------------------------------------------------------------ */

export type RawCard = {
  id: string;
  title: string;
  cover: string;
  /** List/home skin: "N Views". Play-page skin: category name. */
  left: string;
  /** Duration as displayed ("9小时 4分钟 20"). */
  duration: string;
  /** "YYYY / MM / DD" as displayed. */
  date: string;
};

/**
 * Card image anchor — the first play link inside a card wraps an <img>.
 * (The entry-title link also points at the play page; matching only the
 * img anchor keeps one start per card so each block holds the full card.)
 */
const CARD_ANCHOR =
  /<a href="(\/index\.php\/vod\/play\/id\/(\d+)\/sid\/\d+\/nid\/\d+\.html)"[^>]*>\s*<img/g;

/**
 * Extract every video card (home/list skin and the play-page "猜你喜欢"
 * skin share the same markup).
 */
export function extractCards(html: string): RawCard[] {
  const starts: { at: number; id: string }[] = [];
  for (const m of html.matchAll(CARD_ANCHOR)) {
    starts.push({ at: m.index ?? 0, id: m[2] });
  }
  const cards: RawCard[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].at;
    const end =
      i + 1 < starts.length ? starts[i + 1].at : Math.min(html.length, start + 1500);
    const block = html.slice(start, end);
    const img =
      block.match(/data-original="([^"]+)"/) ?? block.match(/<img[^>]+src="([^"]+)"/);
    const left = block.match(/model-view-left">([^<]*)</)?.[1] ?? "";
    const duration = block.match(/model-view">([^<]*)</)?.[1] ?? "";
    const head = block.match(
      /<div class="entry-title"><a(?: title="([^"]*)")? href="[^"]*"[^>]*>([\s\S]*?)<\/a>\s*(\d{4}\s*\/\s*\d{1,2}\s*\/\s*\d{1,2})?(?:\s*<\/span>)?\s*<\/div>/,
    );
    cards.push({
      id: starts[i].id,
      title: head ? decodeEntities(head[1] ?? head[2]).replace(/\s+/g, " ").trim() : "",
      cover: img ? img[1] : "",
      left: left.replace(/\s+/g, " ").trim(),
      duration: duration.replace(/\s+/g, " ").trim(),
      date: head && head[3] ? head[3].replace(/\s+/g, " ") : "",
    });
  }
  return cards;
}

export type RawFeedPage = {
  totalPages: number;
  items: RawCard[];
};

/** Max page number in the site's pager links — category pages use
 * `page/<N>.html`, search uses `page/<N>/wd/<q>.html`. */
export function maxPagerPage(html: string): number {
  let max = 1;
  for (const m of html.matchAll(/page\/(\d+)/g)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

/**
 * Parse a category or search list page: every card + the pager's last page.
 * The search empty state ("没有…" / no cards) yields zero items.
 */
export function parseListPage(html: string): RawFeedPage {
  const seen = new Set<string>();
  const items: RawCard[] = [];
  for (const c of extractCards(html)) {
    if (!c.title || seen.has(c.id)) continue;
    seen.add(c.id);
    items.push(c);
  }
  return { totalPages: maxPagerPage(html), items };
}

/**
 * Parse the home page: only the curated "精选视频" section (the first
 * `category-count` block) — the rest are category teasers. No pagination.
 * Falls back to all cards if the section marker is missing.
 */
export function parseHomePage(html: string): RawFeedPage {
  const marker = html.indexOf("精选视频");
  const sectionEnd =
    marker >= 0 ? html.indexOf("category-count", marker + 4) : -1;
  const scope =
    marker >= 0 && sectionEnd > marker ? html.slice(marker, sectionEnd) : html;
  return parseListPage(scope);
}

/**
 * Category nav from the home header (`nav-main`). Top-level items are
 * `<li class="dropdown">` with a `rel="tag"` link; subcategories sit in a
 * `categories-wrapper` inside the same `<li>` (plain `title=` links).
 */
export function parseNavCategories(html: string): SiteCategory[] {
  const navStart = html.indexOf("nav-main");
  const ulEnd = navStart >= 0 ? html.indexOf("</ul>", navStart) : -1;
  const scope =
    navStart >= 0 && ulEnd > navStart ? html.slice(navStart, ulEnd) : html;
  const out: SiteCategory[] = [];
  const seen = new Set<string>();
  for (const li of scope.split('<li class="dropdown">').slice(1)) {
    const main = li.match(
      /<a [^>]*href="\/index\.php\/vod\/type\/id\/(\d+)\.html" rel="tag" title="([^"]+)"/,
    );
    if (!main) continue;
    const cat: SiteCategory = {
      path: `/category/${main[1]}/`,
      name: decodeEntities(main[2]).trim(),
    };
    const children: SiteCategory[] = [];
    for (const m of li.matchAll(
      /<a href="\/index\.php\/vod\/type\/id\/(\d+)\.html" title="([^"]+)">/g,
    )) {
      const child: SiteCategory = {
        path: `/category/${m[1]}/`,
        name: decodeEntities(m[2]).trim(),
      };
      if (!child.name || children.some((c) => c.path === child.path)) continue;
      children.push(child);
    }
    if (children.length) cat.children = children;
    if (!cat.name || seen.has(cat.path)) continue;
    seen.add(cat.path);
    out.push(cat);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Article parsing
 * ------------------------------------------------------------------ */

export type RawArticle = {
  title: string;
  cover: string;
  /** "YYYY-MM-DD". */
  published: string;
  categories: string[];
  tags: string[];
  actors: string[];
  recommendations: RawCard[];
};

/** Parse a play page into metadata + recommendations. */
export function parsePlayPage(html: string, selfId: string): RawArticle {
  const title =
    html.match(/<h1><p>([\s\S]*?)<\/p><\/h1>/)?.[1] ??
    html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
  const cleanTitle = decodeEntities(title)
    .replace(/\s*-\s*KanAV.*$|KanAV-免费高清中文AV在线看.*$/g, "")
    .replace(/\s*在线播放\s*-\s*/, " ")
    .replace(/\s+/g, " ")
    .trim();

  const cover =
    html.match(/MacPlayer\.Pic\s*=\s*"([^"]+)"/)?.[1] ??
    html.match(/class="countext-img"[^>]*src="([^"]+)"/)?.[1] ?? "";

  // 上映日期 lives in the hr-categories section (the site's own `tltle`
  // attribute typo is matched on purpose).
  const published =
    html.match(/tltle="(\d{4}-\d{2}-\d{2})"/)?.[1] ??
    html.match(/上映日期：\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";

  const categories: string[] = [];
  const catSeen = new Set<string>();
  for (const m of html.matchAll(
    /<a [^>]*href="\/index\.php\/vod\/type\/id\/\d+\.html"[^>]*rel="tag"[^>]*>([^<]+)</g,
  )) {
    const name = decodeEntities(m[1]).trim();
    if (!name || catSeen.has(name)) continue;
    catSeen.add(name);
    categories.push(name);
  }

  const sectionAnchors = (start: number, end: number): string[] => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const m of html.slice(start, end).matchAll(
      /<a href="\/index\.php\/vod\/search\.html\?wd=([^&"]+)&by=time_add"[^>]*>([^<]+)</g,
    )) {
      const name = decodeEntities(m[2]).trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    return names;
  };
  const tagsIdx = html.indexOf("hr-tags");
  const actorIdx = html.indexOf("hr-actor");
  const tags = tagsIdx >= 0
    ? sectionAnchors(tagsIdx, actorIdx > tagsIdx ? actorIdx : tagsIdx + 2000)
    : [];
  const actors = actorIdx >= 0 ? sectionAnchors(actorIdx, actorIdx + 2000) : [];

  // "猜你喜欢" recommendations (same card skin; model-view-left = category).
  const recStart = html.indexOf("猜你喜欢");
  const recommendations: RawCard[] = [];
  const recSeen = new Set([selfId]);
  for (const c of recStart >= 0 ? extractCards(html.slice(recStart)) : []) {
    if (recommendations.length >= 8) break;
    if (!c.title || recSeen.has(c.id)) continue;
    recSeen.add(c.id);
    recommendations.push(c);
  }

  return {
    title: cleanTitle,
    cover,
    published,
    categories,
    tags,
    actors,
    recommendations,
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Decode common HTML entities (numeric + named). */
function decodeEntities(s: string): string {
  const NAMED: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

/** "2026 / 10 / 27" → "2026-10-27" (ISO date). "" stays "". */
export function parseCardDate(display: string): string {
  const m = display.match(/(\d{4})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (!m) return "";
  const pad = (n: string) => n.padStart(2, "0");
  return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
}

/** Feed item meta: duration first, then the view count, when present. */
export function cardMeta(card: RawCard): string[] {
  const meta: string[] = [];
  if (card.duration) meta.push(card.duration);
  if (/^\d[\d,]*\s*Views$/.test(card.left)) meta.push(card.left);
  return meta;
}

/* ------------------------------------------------------------------ *
 * Source adapter — normalized models for the dispatcher + frontend.
 * ------------------------------------------------------------------ */

export const kanavSource: Source = {
  id: "kanav",
  kind: "feed",

  matchUrl: isKanavPlayUrl,
  resolve: resolveVideo,

  /** The media CDN rotates hosts under 11yun.space (cdn/cdn16/cdn17/…). */
  mediaHosts: (host) => host === "11yun.space" || host.endsWith(".11yun.space"),

  /** The CDN validates the referer — always present it. */
  fetchTarget: fetchMedia,

  async siteInfo(): Promise<SiteInfo> {
    let categories: SiteCategory[] = [];
    try {
      const home = await fetchText(KANAV_BASE + "/", KANAV_BASE + "/");
      categories = parseNavCategories(home);
    } catch {
      // No nav — the home feed still works.
    }
    return {
      src: "kanav",
      node: KANAV_BASE,
      nodeSource: "default",
      categories: categories.length
        ? [{ id: "category", label: "分类", categories }]
        : [],
    };
  },

  async feed(path, page, nodeOverride): Promise<FeedPage> {
    const node = nodeForRequest(nodeOverride);
    const url = buildFeedUrl(path, page, node);
    const html = await fetchText(url, node + "/");
    const raw = path === "/" || path === "" ? parseHomePage(html) : parseListPage(html);
    const items: FeedItem[] = raw.items.map((c) => {
      const meta = cardMeta(c);
      return {
        id: c.id,
        path: `/vod/${c.id}/`,
        title: c.title,
        cover: c.cover || undefined,
        published: parseCardDate(c.date) || undefined,
        meta: meta.length ? meta : undefined,
      };
    });
    return {
      src: "kanav",
      path,
      page,
      totalPages: raw.totalPages,
      items,
    };
  },

  async article(path, nodeOverride): Promise<Article> {
    const node = nodeForRequest(nodeOverride);
    const m = path.match(/^\/vod\/(\d+)\/?$/);
    if (!m) throw new HttpError(400, "article path must look like /vod/<id>/");
    const id = m[1];
    const pagePath = `/index.php/vod/play/id/${id}/sid/1/nid/1.html`;
    const html = await fetchText(node + pagePath, node + "/");
    const a = parsePlayPage(html, id);
    if (!a.title) throw new HttpError(502, "article title not found on page");

    const pageUrl = node + pagePath;
    const blocks: ArticleBlock[] = [
      {
        type: "video",
        video: {
          type: "hls",
          url: pageUrl,
          pageUrl,
          id,
          poster: a.cover || undefined,
        },
      },
    ];

    const tags: TagRef[] = a.tags.map((name) => ({
      name,
      path: `/search/${encodeURIComponent(name)}/`,
    }));

    const recommendations: Recommendation[] = a.recommendations.map((r) => ({
      path: `/vod/${r.id}/`,
      title: r.title,
      cover: r.cover || undefined,
    }));

    return {
      src: "kanav",
      path: `/vod/${id}/`,
      title: a.title,
      cover: a.cover || undefined,
      author: a.actors.join(" ") || undefined,
      published: a.published || undefined,
      categories: a.categories.length ? a.categories : undefined,
      tags: tags.length ? tags : undefined,
      blocks,
      recommendations,
    };
  },

  matchArticle: (value) => matchArticleValue(value),
};
