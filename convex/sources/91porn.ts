/**
 * Parsers and adapter for the 91porn.com source.
 *
 * How the source works (all verified empirically, 2026-11-05):
 *  - 91porn.com is a single stable host (no node discovery). Pages are SSR
 *    HTML; a browser UA plus `Accept-Language: zh-CN` yields stable Chinese
 *    labels (the site's language is session-based; the header pins zh-CN so
 *    the parser never has to match both skins).
 *  - List pages (`v.php?category=<slug>`, search:
 *    `search_result.php?search_type=search_videos&search_id=<q>`) render video
 *    cards: `<a href="…view_video.php?viewkey=<id>">` +
 *    `<div id="playvthumb_<N>">` + `<img src="https://<cdn>/thumb/<N>.jpg">`
 *    + 时长/标题/添加时间/作者/热度/收藏/留言 spans, 24 per page.
 *  - Category list pages also contain a HIDDEN DECOY GRID: every visible
 *    viewkey is rendered a second time inside a `col-lg-8` wrapper whose
 *    title/thumbnail/numeric-id are scrambled (anti-scrape; verified the same
 *    viewkey resolves to different videos in the decoy vs. the visible grid).
 *    Cards inside `col-lg-8` wrappers are skipped entirely.
 *
 * Anti-piracy flagging (introduced ~2026-11-04, verified 2026-11-05):
 *  - `view_video.php` and the category lists (`v.php`) serve POISONED pages
 *    to non-browser clients: the title becomes a zero-width-laden banner
 *    "请…到91P945.com 观看" (91P945.com is a parked redirect stub), the author
 *    becomes "非法盗用91porn资源", 添加时间 becomes "just added", the stats are
 *    randomized, and the signed MP4 URL embedded in the page points at a
 *    rotating *different* video file. Real browser document navigations get
 *    clean pages. The check is per-request client identity (TLS/h2/TCP
 *    stack level — Chrome-TLS impersonation via curl_cffi fails too), so it
 *    cannot be bypassed from the Convex runtime.
 *  - NOT gated: `search_result.php` (search lists stay clean), the HD video
 *    page `view_video_hd.php`, and the stream-signing endpoint `/vlk.php`.
 *    The HD page is VIP-gated only for *playback* — the page itself serves
 *    the real title, author, 添加时间, duration, stats, description and
 *    recommendation cards to any client (verified against the file's real
 *    duration).
 *  - The canonical MP4 URL comes from `/vlk.php` (POST; JSON body built from
 *    the `var vbG="…",vbGV=<VID>,vbGT="…"` tokens in the standard page's
 *    player script). It is exactly the URL the page's own player plays
 *    (verified: same file as the HD page's videoDuration). The MP4 CDN
 *    (`…rsc.cdn77.org` / `la.btc620.com`) streams the file straight to
 *    browsers (206/Range, refuses non-browser clients — irrelevant, the
 *    browser plays it directly). No media proxy: the article's video block
 *    is a direct MP4 URL the player plays with `video.src`.
 *
 * Strategy:
 *  - article: fetch the standard page (for the vbG/vbGT tokens + the
 *    fallback stream URL) and the ungated HD page (for the real metadata)
 *    in parallel, then ask /vlk.php for the canonical stream URL.
 *  - feed: fetch the list (viewkeys and covers are genuine even when the
 *    list is flagged) and enrich each card with the real title/date/stats
 *    from its ungated HD page (batched, cached in-process).
 */

import { HttpError } from "../proxy";
import type {
  Article,
  ArticleBlock,
  FeedItem,
  FeedPage,
  Recommendation,
  SiteCategory,
  SiteInfo,
  Source,
} from "./types";

export const N91_BASE = "https://91porn.com";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;
/** 24 cards per list page (verified: "视频 1 - 24 的 N"). */
const PAGE_SIZE = 24;
/** Max concurrent HD-page fetches for list enrichment. */
const HD_CONCURRENCY = 8;

/**
 * The server flags our client on the gated pages: the title becomes the
 * migration banner (zero-width-laden "请…到<domain> 观看").
 */
const ZW_RE = /[\u200b-\u200f\u2028\u2029\u2060-\u206f\ufeff]/g;
/** Banner title after zero-width stripping: "请…到<domain> 观看". */
const FLAG_TITLE_RE = /到\s*\S+\.com\s*观看/;

/** True when the server flagged this page (title is the migration banner). */
export function isFlaggedPage(title: string): boolean {
  return FLAG_TITLE_RE.test(title.replace(ZW_RE, ""));
}

/** The site's language is session-based; pinning zh-CN gives stable labels. */
const FETCH_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_UA,
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Accept: "*/*",
};

async function fetchText(
  target: string,
  referer: string | undefined,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      headers: { ...FETCH_HEADERS, Referer: referer ?? "" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new HttpError(502, `upstream returned ${res.status}`);
    return res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Node base URL used for feed/article requests (override wins). */
function nodeForRequest(nodeOverride: string | null | undefined): string {
  const node = nodeOverride ?? N91_BASE;
  if (!node.startsWith("https://")) {
    throw new HttpError(400, "invalid node");
  }
  return node.replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/**
 * Category slugs for this source → upstream v.php query string. The site nav
 * lists ori/hot/top/long/longer/tf/rf/hd/(top&m=-1)/md/mf; "mr" (最新) is the
 * default list and is not in the nav.
 */
export const CATEGORY_QUERIES: Record<string, string> = {
  mr: "category=mr&viewtype=basic",
  ori: "category=ori&viewtype=basic",
  hot: "category=hot&viewtype=basic",
  top: "category=top&viewtype=basic",
  "top-monthly": "category=top&m=-1&viewtype=basic",
  long: "category=long&viewtype=basic",
  longer: "category=longer&viewtype=basic",
  tf: "category=tf&viewtype=basic",
  rf: "category=rf&viewtype=basic",
  hd: "category=hd&viewtype=basic",
  md: "category=md&viewtype=basic",
  mf: "category=mf&viewtype=basic",
};

/**
 * Build the upstream list URL for a normalized list path + page number.
 *  /            → v.php?category=rf (the home "今日排行" continues as rf)
 *  /category/x  → v.php?category=<mapped>
 *  /search/q    → search_result.php?search_type=search_videos&search_id=<q>
 * (the search query stays URL-encoded as a single segment)
 */
export function buildFeedUrl(path: string, page: number, node: string): string {
  let p = path || "/";
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+$/, "");
  const pageParam = page > 1 ? `&page=${page}` : "";

  let query: string;
  let file: string;
  if (p === "/" || p === "") {
    query = CATEGORY_QUERIES["rf"];
    file = "v.php";
  } else if (p.startsWith("/category/")) {
    const slug = p.slice("/category/".length);
    query = CATEGORY_QUERIES[slug];
    if (!query) throw new HttpError(400, `unknown category: ${slug}`);
    file = "v.php";
  } else if (p.startsWith("/search/")) {
    const q = p.slice("/search/".length);
    if (!q) throw new HttpError(400, "empty search query");
    let decoded = q;
    try {
      decoded = decodeURIComponent(q);
    } catch {
      // keep the raw segment
    }
    query = `search_type=search_videos&search_id=${encodeURIComponent(
      decoded,
    )}&viewtype=basic`;
    file = "search_result.php";
  } else {
    throw new HttpError(
      400,
      "unsupported feed path (use /, /category/<slug>/ or /search/<query>/)",
    );
  }
  return `${node}/${file}?${query}${pageParam}`;
}

/**
 * Normalize an article reference to `/view/<viewkey>/`; null if not one.
 * Accepts the canonical path, a bare query string, or a full URL pointing
 * at view_video.php / video.php with a viewkey.
 */
export function matchArticleValue(value: string): string | null {
  const v = value.trim();
  const q = v.match(/view_video\.php\?[^#"']*viewkey=([0-9a-f]{6,40})/i);
  const legacy = v.match(/\bvideo\.php\?[^#"']*viewkey=([0-9a-f]{6,40})/i);
  const p = v.match(/^\/view\/([0-9a-f]{6,40})\/?$/i);
  const m = q ?? legacy ?? p;
  return m ? `/view/${m[1]}/` : null;
}

/* ------------------------------------------------------------------ *
 * Feed / list parsing
 * ------------------------------------------------------------------ */

export type RawCard = {
  viewkey: string;
  title: string;
  cover: string;
  duration: string;
  /** Relative time as shown ("43 分钟 前" / "38 minutes"). */
  added: string;
  author: string;
  views: string;
  favorites: string;
  comments: string;
  /** col-lg width of the wrapper containing the card ("" = none). */
  grid: string;
};

const CARD_ANCHOR = /<a href="[^"]*viewkey=([0-9a-f]{6,40})[^"]*">/g;

/**
 * Extract every video card: `<a …viewkey=…>` + playvthumb + img + duration +
 * title + the info spans after the link. `grid` is the col-lg width of the
 * wrapper div containing the card (8 = hidden decoy grid, 3 = visible grid).
 */
export function extractCards(html: string): RawCard[] {
  const starts: { viewkey: string; at: number }[] = [];
  for (const m of html.matchAll(CARD_ANCHOR)) {
    starts.push({ viewkey: m[1], at: m.index ?? 0 });
  }
  const cards: RawCard[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].at;
    const end =
      i + 1 < starts.length
        ? starts[i + 1].at
        : Math.min(html.length, start + 4000);
    const block = html.slice(start, end);
    // Nearest col-lg wrapper before the anchor (wrappers are sequential, not
    // nested — the last one seen is this card's).
    const before = html.slice(Math.max(0, start - 300), start);
    const grid = before.match(/col-lg-(\d)"/g)?.pop()?.match(/\d/) ?? null;
    const img = block.match(/<img[^>]+src="([^"]+)"/);
    const dur = block.match(/<span class="duration">([^<]*)<\/span>/);
    const title = block.match(/<span class="video-title[^>]*>([\s\S]*?)<\/span>/);
    const added = block.match(
      /(?:添加时间|Added):\s*<\/span>\s*([^<]+?)\s*(?:<br|<\/div)/,
    );
    const author =
      block.match(/(?:作者|From):\s*<\/span>\s*([^<]+?)\s*<br/) ??
      block.match(/(?:作者|From):\s*<\/span>[\s\S]{0,400}?<span class="title">([^<]+)/);
    const views = block.match(/热度:\s*<\/span>\s*([\d,]+)/);
    const favorites = block.match(/收藏:\s*<\/span>\s*([\d,]+)/);
    const comments = block.match(/留言:\s*<\/span>\s*([\d,]+)/);
    cards.push({
      viewkey: starts[i].viewkey,
      title: title ? stripTags(title[1]) : "",
      cover: img ? img[1] : "",
      duration: dur ? dur[1].trim() : "",
      added: added ? added[1].replace(/\s+/g, " ").trim() : "",
      author: author ? stripTags(author[1]) : "",
      views: views ? views[1] : "",
      favorites: favorites ? favorites[1] : "",
      comments: comments ? comments[1] : "",
      grid: grid ? grid[0] : "",
    });
  }
  return cards;
}

export type RawFeedPage = {
  total: number;
  totalPages: number;
  items: RawCard[];
};

/**
 * Parse one list page (category or search) into items + total pages.
 * The hidden `col-lg-8` decoy grid carries scrambled titles/thumbs for the
 * same viewkeys — those cards are dropped (verified: the visible grid's
 * playvthumb/id/title all match the video page, the decoy's don't).
 */
export function parseFeedPage(html: string): RawFeedPage {
  const sectionEnd = html.indexOf('<div id="paging"');
  const section = sectionEnd > 0 ? html.slice(0, sectionEnd) : html;

  let total = 0;
  let maxPageLink = 0;
  const tot = section.match(
    /(?:视频|Videos|搜索结果|Result Videos)\s*(\d+)\s*[-–]\s*(\d+)\s*(?:的|of)\s*([\d,]+)/,
  );
  if (tot) total = Number(tot[3].replace(/,/g, ""));
  for (const m of section.matchAll(/page=(\d+)/g)) {
    const n = Number(m[1]);
    if (n > maxPageLink) maxPageLink = n;
  }

  const seen = new Set<string>();
  const items: RawCard[] = [];
  for (const c of extractCards(section)) {
    if (c.grid === "8") continue; // hidden decoy grid
    if (seen.has(c.viewkey)) continue;
    seen.add(c.viewkey);
    items.push(c);
  }

  const totalPages = Math.max(
    total > 0 ? Math.ceil(total / PAGE_SIZE) : 1,
    maxPageLink,
  );
  return { total, totalPages, items };
}

/** Category nav (最新 + the site's own nav order) as normalized paths. */
export function parseNavCategories(html: string): SiteCategory[] {
  const out: SiteCategory[] = [{ path: "/category/mr/", name: "最新" }];
  const seen = new Set(["/category/mr/"]);
  for (const m of html.matchAll(
    /href="https?:\/\/[^"]*v\.php\?category=([a-z]+)(?:&m=-1)?&viewtype=basic"[^>]*>\s*([^<]+?)\s*</g,
  )) {
    const cat = m[1];
    const slug = /&m=-1/.test(m[0]) ? "top-monthly" : cat;
    if (!CATEGORY_QUERIES[slug]) continue; // future unknown slug — skip
    const path = `/category/${slug}/`;
    const name = decodeEntities(m[2].trim());
    if (!name || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, name });
  }
  return out;
}

const REL_UNITS: Record<string, number> = {
  秒: 1, s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  分钟: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  小时: 3600, h: 3600, hr: 3600, hour: 3600, hours: 3600,
  天: 86400, d: 86400, day: 86400, days: 86400,
  周: 604800, wk: 604800, week: 604800, weeks: 604800,
  月: 2592000, month: 2592000, months: 2592000,
};

/**
 * "43 分钟 前" / "2 days" → approximate epoch ms (server time minus the
 * delta). The list pages carry only relative times, so this is the best
 * (and the site's own) precision.
 */
export function relativeToEpoch(text: string, now: number): number | null {
  const m = text.match(
    /(\d+)\s*(秒|seconds?|secs?|s|分钟|minutes?|mins?|m|小时|hours?|hrs?|h|天|days?|d|周|weeks?|月|months?)/i,
  );
  if (!m) return null;
  const unit = REL_UNITS[m[2].toLowerCase()];
  if (!unit) return null;
  return now - Number(m[1]) * unit * 1000;
}

/* ------------------------------------------------------------------ *
 * Article / video-page parsing
 * ------------------------------------------------------------------ */

export type RawVideo = { url: string; id: string; poster: string };

/**
 * Metadata shared by the standard page and the (ungated) HD page — both
 * carry the same fields; on a *flagged* standard page the title/author/
 * 添加时间/stats are fake (the description and recommendations stay real).
 */
export type PageMeta = {
  title: string;
  description: string;
  author: string;
  /** "YYYY-MM-DD" (the HD page's 添加时间 — real, verified). */
  published: string;
  /** Seconds. */
  duration: number;
  views: string;
  favorites: string;
  comments: string;
  /** Numeric video id (→ poster URL `thumb/<VID>.jpg`). */
  vid: string;
  recommendations: RawCard[];
};

/**
 * `strencode2("…")` is plain URL-encoding: unquoting the argument yields
 * `<source src='…mp4…'>`. The commented-out `<source>` in the page points
 * at a decoy host and is ignored.
 */
export function extractStrencode2(html: string): string | null {
  const m = html.match(/strencode2\("([^"]+")\)/);
  if (!m) return null;
  const full = decodeURIComponent(m[1]);
  const src = full.match(/src='([^']+)'/) ?? full.match(/src="([^"]+)"/);
  return src ? src[1] : null;
}

/** Shared metadata extraction (standard page and HD page layouts match). */
export function extractPageMeta(
  html: string,
  selfViewkey: string,
  vid: string,
): PageMeta {
  // <title> carries the clean title + site suffix; strip the suffix.
  const titleTag = html.match(/<title>([^<]*)<\/title>/);
  let title = titleTag ? decodeEntities(titleTag[1]).trim() : "";
  title = title.replace(/\s*[-|]\s*91porn\s*$/i, "").trim();

  // Description: #v_desc (unquoted attribute). The site appends anti-scam
  // boilerplate ("91版主提醒您：…") — cut at the marker, keep the rest.
  const descStart = html.indexOf("id=v_desc");
  let description = "";
  if (descStart >= 0) {
    const open = html.indexOf(">", descStart) + 1;
    const close = html.indexOf("</div>", open);
    let inner = html.slice(open, close > open ? close : open);
    const marker = inner.indexOf("91版主提醒您");
    if (marker >= 0) inner = inner.slice(0, marker);
    description = stripTags(inner);
  }

  const author =
    html.match(/(?:作者|From):\s*<\/span>[\s\S]{0,400}?<span class="title">([^<]+)/)?.[1] ??
    html.match(/(?:作者|From):\s*<\/span>\s*([^<]+?)\s*<br/)?.[1] ??
    "";
  const published =
    html.match(
      /(?:添加时间|Added):\s*<\/span>\s*<span class="title-yakov">(\d{4}-\d{2}-\d{2})<\/span>/,
    )?.[1] ?? "";
  const duration = Number(html.match(/videoDuration\s*=\s*([\d.]+)/)?.[1] ?? 0);
  const stat = (label: string) =>
    html.match(new RegExp(label + ':\\s*<span class="video-info-span">\\s*([\\d,]+)'))?.[1] ?? "";
  const views = stat("热度");
  const favorites = stat("收藏");
  const comments = stat("留言");

  // Related/hot cards in the sidebar (same card skin as the list pages).
  // Self links in the float menu (留言/举报) share the video's viewkey and
  // are skipped via the `seen` seed.
  const seen = new Set([selfViewkey]);
  const recommendations: RawCard[] = [];
  for (const c of extractCards(html)) {
    if (recommendations.length >= 8) break;
    if (c.grid === "8") continue; // decoy grid (category-page layout)
    if (seen.has(c.viewkey)) continue;
    if (!c.title) continue;
    seen.add(c.viewkey);
    recommendations.push(c);
  }

  return {
    title,
    description,
    author: stripTags(author),
    published,
    duration,
    views,
    favorites,
    comments,
    vid,
    recommendations,
  };
}

/**
 * Parse the standard view_video.php page: metadata + the embedded stream
 * URL + the /vlk.php tokens from the player script. On a flagged page the
 * title/author/添加时间 are fake — `flagged` marks that (the embedded URL
 * still points at a rotating *different* file, so it is only a fallback).
 */
export type StdPage = {
  meta: PageMeta;
  video: RawVideo | null;
  /** /vlk.php tokens from `var vbG="…",vbGV=<VID>,vbGT="…"`. */
  vlk: { g: string; t: string } | null;
  flagged: boolean;
};

export function parseStdPage(html: string, selfViewkey: string): StdPage {
  const vid = html.match(/id=VID[^>]*>\s*(\d+)\s*<\/div>/)?.[1] ?? "";
  const meta = extractPageMeta(html, selfViewkey, vid);
  const videoUrl = extractStrencode2(html);
  const poster =
    html.match(/<video[^>]*poster="([^"]+)"/)?.[1] ??
    (vid ? `https://1729130453.rsc.cdn77.org/thumb/${vid}.jpg` : "");
  const video = videoUrl ? { url: videoUrl, id: vid, poster } : null;
  const tokens = html.match(/var vbG="([0-9a-f]+)",vbGV=\d+,vbGT="([0-9a-f]+)"/);
  return {
    meta,
    video,
    vlk: tokens ? { g: tokens[1], t: tokens[2] } : null,
    flagged: isFlaggedPage(meta.title),
  };
}

/**
 * Parse the HD page (view_video_hd.php) — NOT gated by the anti-piracy
 * check (only HD *playback* is VIP-restricted): it serves the real title,
 * author, 添加时间, duration, stats, description and recommendations to any
 * client. The VID (→ poster) sits in the comment-loading script.
 */
export function parseHdPage(html: string, selfViewkey: string): PageMeta {
  const vid =
    html.match(/show_comments2\.php\?VID=(\d+)/)?.[1] ??
    html.match(/id=VID[^>]*>\s*(\d+)\s*<\/div>/)?.[1] ??
    "";
  return extractPageMeta(html, selfViewkey, vid);
}

/* ------------------------------------------------------------------ *
 * Anti-piracy workarounds
 * ------------------------------------------------------------------ */

/**
 * In-process cache of HD metadata per viewkey (titles/dates are immutable
 * per video) — keeps re-visits and repeated lists cheap and keeps the
 * upstream request rate bounded. Bounded FIFO.
 */
const HD_CACHE_MAX = 2000;
const hdCache = new Map<string, PageMeta | null>();

/**
 * Fetch the ungated HD page for every card, in bounded batches (the host
 * stalls connections beyond ~8 concurrent per IP). Cached failures are
 * kept (null) so one broken video doesn't hammer the endpoint.
 */
async function fetchHdMetas(
  node: string,
  items: RawCard[],
): Promise<(PageMeta | null)[]> {
  const out: (PageMeta | null)[] = new Array(items.length).fill(null);
  for (let i = 0; i < items.length; i += HD_CONCURRENCY) {
    const batch = items.slice(i, i + HD_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (item) => {
        const hit = hdCache.get(item.viewkey);
        if (hit !== undefined) return hit;
        const url = `${node}/view_video_hd.php?viewkey=${item.viewkey}`;
        try {
          const html = await fetchText(
            url,
            `${node}/view_video.php?viewkey=${item.viewkey}`,
          );
          const meta = parseHdPage(html, item.viewkey);
          return meta.title && !isFlaggedPage(meta.title) ? meta : null;
        } catch {
          return null;
        }
      }),
    );
    results.forEach((meta, j) => {
      const vk = batch[j].viewkey;
      if (!hdCache.has(vk)) {
        if (hdCache.size >= HD_CACHE_MAX) {
          const oldest = hdCache.keys().next().value;
          if (oldest !== undefined) hdCache.delete(oldest);
        }
        hdCache.set(vk, meta);
      }
      out[i + j] = meta;
    });
  }
  return out;
}

/**
 * Ask /vlk.php for the canonical stream URL — exactly what the page's own
 * player plays (verified: the same file the HD page's videoDuration
 * describes). Returns null when the endpoint declines the request.
 */
async function fetchVlkUrl(
  node: string,
  viewkey: string,
  tokens: { g: string; t: string },
): Promise<string | null> {
  const body = JSON.stringify({
    g: tokens.g,
    t: tokens.t,
    ev: "pointerdown",
    op: 4200,
    mc: 12,
    tc: 1,
    sc: 2,
    kc: 0,
    wd: 0,
    gl: "NVIDIA GeForce RTX 4060",
    sg: 0,
    nc: 0,
    pl: 5,
    lg: 2,
    ow: 1920,
    oh: 1080,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(node + "/vlk.php", {
      method: "POST",
      headers: {
        ...FETCH_HEADERS,
        "Content-Type": "text/plain",
        Origin: node,
        Referer: `${node}/view_video.php?viewkey=${viewkey}`,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { u?: unknown };
    return typeof data.u === "string" && data.u.startsWith("http")
      ? data.u
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Normalized output
 * ------------------------------------------------------------------ */

function toArticle(
  path: string,
  a: {
    title: string;
    description: string;
    author: string;
    published: string;
    video: RawVideo | null;
    recommendations: RawCard[];
  },
): Article {
  const blocks: ArticleBlock[] = [];
  if (a.video) {
    blocks.push({
      type: "video",
      video: {
        type: "mp4",
        url: a.video.url,
        id: a.video.id || undefined,
        poster: a.video.poster || undefined,
      },
    });
  }
  if (a.description) blocks.push({ type: "p", text: a.description });

  // The site's related/hot cards (sidebar) are part of the page layout —
  // push them as rec blocks so the generic renderer shows them.
  for (const r of a.recommendations) {
    blocks.push({
      type: "rec",
      rec: {
        path: `/view/${r.viewkey}/`,
        title: r.title,
        cover: r.cover || undefined,
      },
    });
  }

  const recommendations: Recommendation[] = a.recommendations.map((r) => ({
    path: `/view/${r.viewkey}/`,
    title: r.title,
    cover: r.cover || undefined,
  }));

  return {
    src: "91porn",
    path,
    title: a.title,
    description: a.description || undefined,
    author: a.author || undefined,
    published: a.published || undefined,
    cover: a.video?.poster || undefined,
    blocks,
    recommendations,
  };
}

export const nineOneSource: Source = {
  id: "91porn",
  kind: "feed",

  async siteInfo(): Promise<SiteInfo> {
    let categories: SiteCategory[] = [];
    try {
      const home = await fetchText(
        `${N91_BASE}/v.php?category=mr&viewtype=basic`,
        N91_BASE + "/",
      );
      categories = parseNavCategories(home);
    } catch {
      // No nav — the home feed still works.
    }
    return {
      src: "91porn",
      node: N91_BASE,
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
    const raw = parseFeedPage(html);
    const now = Date.now();

    const flagged = raw.items.some((i) => isFlaggedPage(i.title));
    // Flagged list: only the viewkeys/covers are genuine — the real
    // title/date/stats come from each card's ungated HD page.
    const metas = flagged ? await fetchHdMetas(node, raw.items) : null;

    const items: FeedItem[] = raw.items.map((i, idx) => {
      if (!flagged) {
        const epoch = relativeToEpoch(i.added, now);
        const meta: string[] = [];
        if (i.views) meta.push(`热度 ${i.views}`);
        if (i.favorites) meta.push(`收藏 ${i.favorites}`);
        return {
          id: i.viewkey,
          path: `/view/${i.viewkey}/`,
          title: i.title,
          cover: i.cover || undefined,
          published: epoch ? new Date(epoch).toISOString() : undefined,
          meta: meta.length ? meta : undefined,
        };
      }
      const m = metas?.[idx];
      const meta: string[] = [];
      if (m?.views) meta.push(`热度 ${m.views}`);
      if (m?.favorites) meta.push(`收藏 ${m.favorites}`);
      return {
        id: i.viewkey,
        path: `/view/${i.viewkey}/`,
        title: m?.title || "",
        cover: i.cover || undefined,
        published: m?.published
          ? new Date(`${m.published}T00:00:00Z`).toISOString()
          : undefined,
        meta: meta.length ? meta : undefined,
      };
    });
    return {
      src: "91porn",
      path,
      page,
      totalPages: raw.totalPages,
      items,
    };
  },

  async article(path, nodeOverride): Promise<Article> {
    const node = nodeForRequest(nodeOverride);
    const vk = path.match(/^\/view\/([0-9a-f]{6,40})\/?$/i);
    if (!vk) throw new HttpError(400, "article path must look like /view/<viewkey>/");
    const stdUrl = `${node}/view_video.php?viewkey=${vk[1]}`;
    const hdUrl = `${node}/view_video_hd.php?viewkey=${vk[1]}`;

    const [stdHtml, hdHtml] = await Promise.all([
      fetchText(stdUrl, node + "/").catch(() => null),
      fetchText(hdUrl, stdUrl).catch(() => null),
    ]);
    const std = stdHtml ? parseStdPage(stdHtml, vk[1]) : null;
    const hd = hdHtml
      ? parseHdPage(hdHtml, vk[1])
      : null;
    const hdUsable = hd ? hd.title && !isFlaggedPage(hd.title) : false;

    if (!std && !hdUsable) {
      throw new HttpError(502, "could not fetch video page");
    }

    // Metadata: prefer the ungated HD page (always real). Fall back to the
    // standard page — but only its real fields when flagged (description,
    // recommendations; title/author/添加时间 are the banner/fake there).
    const meta: PageMeta | null =
      hdUsable ? hd! : std && !std.flagged ? std.meta : null;
    const stdMeta = std?.meta;
    const title = meta?.title ?? "";
    const description = meta?.description || stdMeta?.description || "";
    const author = meta?.author ?? "";
    const published = meta?.published ?? "";
    const recommendations = meta?.recommendations ?? stdMeta?.recommendations ?? [];

    // Stream: the canonical URL from /vlk.php (what the site's own player
    // plays); the page-embedded URL (a rotating different file when the
    // page is flagged) is the fallback.
    let videoUrl: string | null = null;
    if (std?.vlk) videoUrl = await fetchVlkUrl(node, vk[1], std.vlk);
    videoUrl = videoUrl ?? std?.video?.url ?? null;

    const vid = meta?.vid || stdMeta?.vid || "";
    const poster =
      std?.video?.poster ||
      (vid ? `https://1729130453.rsc.cdn77.org/thumb/${vid}.jpg` : "");
    const video: RawVideo | null = videoUrl
      ? { url: videoUrl, id: vid, poster }
      : null;

    if (!video && !title) {
      throw new HttpError(502, "video source not found on page");
    }
    return toArticle(`/view/${vk[1]}/`, {
      title,
      description,
      author,
      published,
      video,
      recommendations,
    });
  },

  matchArticle: (value) => matchArticleValue(value),
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Decode common HTML entities (numeric + named). */
function decodeEntities(s: string): string {
  const NAMED: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

/** Strip all tags from an HTML fragment and collapse whitespace. */
function stripTags(html: string): string {
  const text = html.replace(/<[^>]+>/g, " ");
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}
