/**
 * Parsers and adapter for the 91porn.com source.
 *
 * How the source works (all verified empirically, 2026-10-27):
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
 *  - The video page (`view_video.php?viewkey=<id>`) carries:
 *      - `<title>` = title + " - 91porn" suffix
 *      - `#v_desc` description (site boilerplate "91版主提醒您：…" appended —
 *        cut at the marker)
 *      - `添加时间` → `<span class="title-yakov">YYYY-MM-DD</span>`
 *      - `作者` → `<span class="title">NAME<`
 *      - `videoDuration = <seconds>`
 *      - 时长/热度/收藏/留言 spans
 *      - the real stream in `document.write(strencode2("…"))` — simple URL
 *        encoding of `<source src='…mp4…'>`; the commented-out `<source>` in
 *        the page is a decoy with a dead host. The MP4 lives on a rotating
 *        CDN (`…rsc.cdn77.org` / `la.btc620.com`, `/mp43/<VID>.mp4` with
 *        per-page signature).
 *  - Both CDNs serve the MP4 straight to the browser (206/Range, valid ftyp
 *    header, no UA/referer check; `rsc.cdn77.org` also sends
 *    `Access-Control-Allow-Origin: *`, the other host doesn't — harmless, a
 *    `<video src>` needs no CORS). No media proxy: the article's video block
 *    is a direct MP4 URL the player plays with `video.src`.
 *  - The HD page (`view_video_hd.php`) is VIP-gated ("only VIP member can
 *    watch HD videos") — always use the standard page.
 *  - The site has no per-video tags/categories; the category nav is a flat
 *    list (`v.php?category=<slug>`). The home page's "今日排行" continues as
 *    `category=rf` ("最近加精"), so the feed home maps there.
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
export function relativeToEpoch(
  text: string,
  now: number,
): number | null {
  const m = text.match(
    /(\d+)\s*(秒|seconds?|secs?|s|分钟|minutes?|mins?|m|小时|hours?|hrs?|h|天|days?|d|周|weeks?|月|months?)/i,
  );
  if (!m) return null;
  const unit = REL_UNITS[m[2].toLowerCase()];
  if (!unit) return null;
  return now - Number(m[1]) * unit * 1000;
}

/* ------------------------------------------------------------------ *
 * Article parsing
 * ------------------------------------------------------------------ */

export type RawVideo = { url: string; id: string; poster: string };

export type RawArticle = {
  title: string;
  description: string;
  author: string;
  published: string;
  /** Seconds. */
  duration: number;
  views: string;
  favorites: string;
  comments: string;
  video: RawVideo | null;
  recommendations: RawCard[];
};

/**
 * `strencode2("…")` is plain URL-encoding: unquoting the argument yields
 * `<source src='…mp4…'>`. The commented-out `<source>` in the page points
 * at a decoy host and is ignored.
 */
export function extractStrencode2(html: string): string | null {
  const m = html.match(/strencode2\("([^"]+)"\)/);
  if (!m) return null;
  const full = decodeURIComponent(m[1]);
  const src =
    full.match(/src='([^']+)'/) ?? full.match(/src="([^"]+)"/);
  return src ? src[1] : null;
}

/** Parse a view_video.php page into metadata + video + recommendations. */
export function parseArticlePage(
  html: string,
  selfViewkey: string,
): RawArticle {
  // <title> carries the clean title + site suffix; strip the suffix.
  const titleTag = html.match(/<title>([^<]*)<\/title>/);
  let title = titleTag ? decodeEntities(titleTag[1]).trim() : "";
  title = title.replace(/\s*[-|]\s*91porn\s*$/i, "").trim();

  // Description: #v_desc (unquoted attribute). The site appends anti-scam
  // boilerplate ("91版主提醒您：…") — cut at the marker, keep the rest.
  const descStart = html.indexOf('id=v_desc');
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
    html.match(new RegExp(label + ":</span>\\s*<span class=\"video-info-span\">\\s*([\\d,]+)"))?.[1] ?? "";
  const views = stat("热度");
  const favorites = stat("收藏");
  const comments = stat("留言");

  const videoUrl = extractStrencode2(html);
  const vid = html.match(/id=VID[^>]*>\s*(\d+)\s*<\/div>/)?.[1] ?? "";
  const poster =
    html.match(/<video[^>]*poster="([^"]+)"/)?.[1] ??
    (vid ? `https://1729130453.rsc.cdn77.org/thumb/${vid}.jpg` : "");
  const video: RawVideo | null = videoUrl
    ? { url: videoUrl, id: vid, poster }
    : null;

  // Related/hot cards in the sidebar (same card skin as the list pages).
  const seen = new Set([selfViewkey]);
  const recommendations: RawCard[] = [];
  for (const c of extractCards(html)) {
    if (recommendations.length >= 8) break;
    if (seen.has(c.viewkey)) continue;
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
    video,
    recommendations,
  };
}

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

/* ------------------------------------------------------------------ *
 * Source adapter — normalized models for the dispatcher + frontend.
 * ------------------------------------------------------------------ */

function toArticle(path: string, a: RawArticle): Article {
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
    const items: FeedItem[] = raw.items.map((i) => {
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
    const html = await fetchText(
      `${node}/view_video.php?viewkey=${vk[1]}`,
      node + "/",
    );
    const a = parseArticlePage(html, vk[1]);
    if (!a.video) throw new HttpError(502, "video source not found on page");
    return toArticle(`/view/${vk[1]}/`, a);
  },

  matchArticle: (value) => matchArticleValue(value),
};
