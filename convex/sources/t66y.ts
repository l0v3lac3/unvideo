/**
 * Parsers and adapter for the t66y.com source (草榴社區, "在線成人影院" board).
 *
 * How the source works (all verified empirically, 2026-10-27):
 *  - t66y.com is an old-school forum engine. The 在線成人影院 board is
 *    `thread0806.php?fid=22`; threads live at
 *    `htm_data/<YYMM>/<fid>/<tid>.html`, and `read.php?tid=<tid>` 302-redirects
 *    to that canonical URL (a plain fetch with redirect-follow lands on it).
 *  - List pages render the board announcements + pinned threads first, then
 *    a `<td colspan="5">普通主題</td>` divider and the regular topics in
 *    `<tbody id="tbody">`. Pages 2+ drop the pinned block entirely. Only the
 *    `<tbody id="tbody">` section is parsed — announcements/pinned rows are
 *    filtered out by construction (the site's own label for the wanted part
 *    of the list is 普通主題).
 *  - One row = `<tr class="tr3 …">` with: a `[分類]` tag, then
 *    `<h3><a href="…" id="t<tid>">標題 [時長]</a></h3>`, then an author cell
 *    carrying `<span … data-timestamp="<epoch>s">`. Row links come in two
 *    shapes: `/htm_data/<YYMM>/<fid>/<tid>.html` (root-absolute) or
 *    `read.php?tid=<tid>` (relative).
 *  - The pager's jump box is `<input … value="<cur>/<total>">` (e.g.
 *    "2/6522") — the authoritative total-page count. The `id="last"` link is
 *    capped at page 2500 server-side and is NOT the real last page, so it
 *    is ignored.
 *  - A thread page embeds exactly one `<iframe data-src="…">` — the video
 *    player. `data-src` is HTML-entity-encoded. The video host ROTATES per
 *    poster/day, and at least two player formats exist:
 *      1. `…/video.html?id=N&time=T&sign=S&aff=caoliu&popup=1`
 *         (sese2009.com, yuese999.com, …) — the page's JS calls
 *         `requestVideoUrl("https://cdn.js-static.cc")` →
 *         `GET <base>/videos/playerurl?id=N&t=T&h=S` → JSON
 *         `{"error":0,"content":{"video_url":"https:\\/\\/videos.js-static.cc\\/…list.m3u8?k=…&t=…"}}`
 *         (URL is backslash-escaped in the JSON string). Works with no
 *         special headers.
 *      2. `hyaa20.com/index.php/Index/video.html?id=N` — the page embeds the
 *         (unsigned) master m3u8 directly: `var url = 'https://bf3.qrtuv.com/…/index.m3u8';`
 *         Variant playlists point at segments on another host
 *         (sm.tsbfzy.com).
 *    Both formats serve HLS VOD; format 1's media playlist carries a
 *    relative `#EXT-X-KEY:METHOD=AES-128,URI="vidensc.key"` plus relative
 *    .ts segments (AES-CBC encrypted blobs — NOT raw TS, hls.js decrypts
 *    them). No byte transform is needed: the shared playlist rewriting
 *    in proxy.ts resolves and signs every URI.
 *  - The upstream playlist URL is itself time-bounded (`?k=…&t=…`), so the
 *    stream is resolved lazily through the video endpoint (`pageUrl` block)
 *    instead of being baked into the article.
 */

import {
  FETCH_TIMEOUT_MS,
  HttpError,
  assertSafeTarget,
  mediaPath,
  proxySecret,
} from "../proxy";
import type {
  Article,
  ArticleBlock,
  FeedItem,
  FeedPage,
  SiteCategory,
  SiteInfo,
  Source,
  VideoBlock,
  VideoInfo,
} from "./types";

export const T66Y_BASE = "https://t66y.com";
/** The 在線成人影院 board. */
const FID = 22;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Category nav (stable since 2010): upstream `type=` id → normalized
 * list path → display name. Also the name→path map used for row chips.
 */
export const CATEGORIES: { type: number; path: string; name: string }[] = [
  { type: 1, path: "/category/1/", name: "亞洲無碼" },
  { type: 2, path: "/category/2/", name: "亞洲有碼" },
  { type: 3, path: "/category/3/", name: "歐美無碼" },
  { type: 4, path: "/category/4/", name: "動漫無碼" },
  { type: 5, path: "/category/5/", name: "動漫有碼" },
  { type: 6, path: "/category/6/", name: "其他電影" },
];

const CAT_PATH_BY_NAME: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.name, c.path]),
);

/** Hosts /api/media may fetch when no PROXY_SECRET is configured. */
export function isT66yMediaHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    // format 1: playlist + segments + AES key (videos.js-static.cc)
    h.endsWith("js-static.cc") ||
    // format 2: master/variant playlists (bf3.qrtuv.com) + segments (sm.tsbfzy.com)
    h.endsWith("qrtuv.com") ||
    h.endsWith("tsbfzy.com")
  );
}

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
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Accept: "*/*",
        Referer: referer ?? "",
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

/** Node base URL used for feed/article requests (override wins). */
function nodeForRequest(nodeOverride: string | null | undefined): string {
  const node = nodeOverride ?? T66Y_BASE;
  if (!node.startsWith("https://")) {
    throw new HttpError(400, "invalid node");
  }
  return node.replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/**
 * Extract the thread id from a t66y thread reference — the canonical
 * normalized path `/t/<tid>/`, a `read.php?tid=` URL, or an
 * `htm_data/<YYMM>/<fid>/<tid>.html` URL (absolute).
 */
export function threadTidFromValue(value: string): string | null {
  const v = value.trim();
  const canon = v.match(/^\/t\/(\d+)\/?$/);
  if (canon) return canon[1];
  const m = v.match(
    /^https?:\/\/(?:www\.)?t66y\.com\/(?:read\.php\?[^#"']*?tid=(\d+)|htm_data\/\d{4}\/\d+\/(\d+)\.html)/i,
  );
  if (!m) return null;
  return m[1] ?? m[2];
}

/** Normalize a thread reference to `/t/<tid>/`; null if not one. */
export function matchArticleValue(value: string): string | null {
  const tid = threadTidFromValue(value);
  return tid ? `/t/${tid}/` : null;
}

/** Build the upstream list URL for a normalized list path + page number. */
export function buildFeedUrl(path: string, page: number, node: string): string {
  let p = path || "/";
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+$/, "");
  const pageParam = page > 1 ? `&page=${page}` : "";

  if (p === "/" || p === "") {
    return `${node}/thread0806.php?fid=${FID}${pageParam}`;
  }
  const cat = p.match(/^\/category\/(\d+)\/?$/);
  if (cat) {
    return `${node}/thread0806.php?fid=${FID}&type=${cat[1]}${pageParam}`;
  }
  if (p.startsWith("/search/")) {
    throw new HttpError(400, "草榴的搜索需要登錄，暂不可用");
  }
  throw new HttpError(400, "unsupported feed path (use / or /category/<n>/)");
}

/* ------------------------------------------------------------------ *
 * List parsing
 * ------------------------------------------------------------------ */

export type RawThread = {
  tid: string;
  title: string;
  category: string;
  /** Epoch seconds from the row's data-timestamp ("" when absent). */
  ts: string;
};

/**
 * Parse the 普通主題 rows of one list page. Everything before
 * `<tbody id="tbody">` (board announcements + pinned threads, present on
 * page 1 and some views) is skipped.
 */
export function parseThreadList(html: string): RawThread[] {
  const marker = html.match(/<tbody[^>]*id="tbody"[^>]*>/);
  const section = marker ? html.slice(marker.index ?? 0) : html;

  const rows: RawThread[] = [];
  const h3 = /<h3><a href="([^"]+)"[^>]*?(?:id="t(\d+)")?>([\s\S]*?)<\/a><\/h3>/g;
  let m: RegExpExecArray | null;
  const matches: { start: number; end: number; href: string; tid: string; title: string }[] = [];
  while ((m = h3.exec(section)) !== null) {
    const href = m[1];
    const tid =
      m[2] ??
      href.match(/tid=(\d+)/)?.[1] ??
      href.match(/htm_data\/\d{4}\/\d+\/(\d+)\.html/)?.[1] ??
      "";
    if (!tid) continue;
    matches.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      href,
      tid,
      title: stripTags(m[3]),
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const prevEnd = i > 0 ? matches[i - 1].end : 0;
    // The `[分類]` tag sits in this row's title cell, just before the <h3>.
    // Scope the search to that cell so a bracketed title in the previous
    // row can't leak in when this row has no tag.
    const before = section.slice(prevEnd, cur.start);
    const cell = before.lastIndexOf('<td class="tal"');
    const scope = cell >= 0 ? before.slice(cell) : before;
    const open = scope.lastIndexOf("[");
    const close = open >= 0 ? scope.lastIndexOf("]") : -1;
    const category =
      open >= 0 && close > open ? scope.slice(open + 1, close) : "";
    const trEnd = section.indexOf("</tr>", cur.end);
    const after = section.slice(
      cur.end,
      trEnd > 0 ? trEnd : cur.end + 800,
    );
    const ts = after.match(/data-timestamp="(\d+)s?"/);
    rows.push({
      tid: cur.tid,
      title: cur.title,
      category,
      ts: ts ? ts[1] : "",
    });
  }
  return rows;
}

/**
 * Total pages for the requested list. The pager's jump box
 * (`value="<cur>/<total>"`) is authoritative; the `id="last"` link is
 * server-capped at 2500 and is not the real last page, so it is dropped
 * before scanning page links.
 */
export function parseTotalPages(html: string, page: number): number {
  const jump = html.match(/<input[^>]*value="\d+\/(\d+)"/);
  if (jump) return Number(jump[1]);
  const cleaned = html.replace(/<a [^>]*id="last"[^>]*>[\s\S]*?<\/a>/g, "");
  let maxPage = 0;
  for (const m of cleaned.matchAll(/page=(\d+)"/g)) {
    const n = Number(m[1]);
    if (n > maxPage) maxPage = n;
  }
  return Math.max(maxPage, page);
}

/* ------------------------------------------------------------------ *
 * Thread page + player resolution
 * ------------------------------------------------------------------ */

export type RawThreadPage = {
  title: string;
  category: string;
  author: string;
  /** ISO string ("" when absent). */
  published: string;
  description: string;
  /** The iframe's data-src (the player page URL), entity-decoded. */
  iframe: string | null;
  /** The player's video id, when the player URL carries one. */
  videoId: string | null;
};

/** The video iframe's `data-src` (entity-decoded); null when absent. */
export function extractIframeSrc(html: string): string | null {
  const m = html.match(/<iframe[^>]+data-src="([^"]+)"/);
  return m ? decodeEntities(m[1]) : null;
}

/** Parse a thread page (canonical htm_data view) into metadata + player ref. */
export function parseThreadPage(html: string): RawThreadPage {
  const h4 = html.match(/<h4 class="f16">([\s\S]*?)<\/h4>/);
  let title = h4 ? stripTags(h4[1]) : "";
  let category = "";
  // The title cell carries the category as a leading `[…]` group.
  const cat = title.match(/^\[([^\]]+)\]\s*/);
  if (cat) {
    category = cat[1];
    title = title.slice(cat[0].length);
  }
  const author = html.match(
    /<tr class="tr1 do_not_catch">[\s\S]*?<b>([^<]+)<\/b>/,
  )?.[1];
  const ts = html.match(/Posted:\s*<span data-timestamp="(\d+)"/);

  const iframe = extractIframeSrc(html);
  let videoId: string | null = null;
  if (iframe) {
    try {
      videoId = new URL(iframe).searchParams.get("id");
    } catch {
      videoId = null;
    }
  }

  const description = extractDescription(html);
  return {
    title,
    category,
    author: author ? stripTags(author) : "",
    published: ts ? new Date(Number(ts[1]) * 1000).toISOString() : "",
    description,
    iframe,
    videoId,
  };
}

/**
 * The OP's text content (`#conttpc`), with the player boilerplate
 * ("點擊這里打開新視窗 | 以下內容被隱藏:…") stripped. Empty for the typical
 * video-only posts.
 */
function extractDescription(html: string): string {
  const i = html.indexOf('id="conttpc"');
  if (i < 0) return "";
  const open = html.indexOf(">", i);
  const end = html.indexOf('<div onclick="clickLike', open);
  let text = stripTags(
    html.slice(open + 1, end > open ? end : open + 3000),
  );
  text = text.replace(/點擊這里打開新視窗/g, "");
  text = text.replace(/以下內容被隱藏[:：][^\n]*/g, "");
  text = text.replace(/我已了解這是外部網站[\s\S]*?同意加載/g, "");
  return text.replace(/[|\s]+/g, " ").trim();
}

/**
 * Resolve a player page URL into the playable media URL:
 *  1. an m3u8/mp4 embedded directly in the page (format 2: `var url = '…'`),
 *  2. the playerurl JSON API (format 1: `requestVideoUrl("…")`),
 * throwing 502 when neither yields a URL. `fromPage` marks format 2: those
 * CDNs (qrtuv.com playlists, tsbfzy.com segments) are CORS-open and block
 * datacenter (Convex) egress IPs with 403, so the browser plays them
 * directly — no proxy.
 */
export async function resolvePlayerMediaUrl(
  playerUrl: string,
): Promise<{ url: string; fromPage: boolean }> {
  const page = await fetchText(playerUrl, T66Y_BASE + "/");
  const direct = extractMediaUrl(page);
  if (direct) return { url: direct, fromPage: true };

  // The base is the first argument of the call, e.g.
  // `requestVideoUrl("https:\/\/cdn.js-static.cc", params)`.
  const base = page.match(/requestVideoUrl\(\s*["']([^"']+)["']\s*[,)]/)?.[1]
    ?.replace(/\\\//g, "/");
  const params = new URL(playerUrl).searchParams;
  const id = params.get("id");
  const time = params.get("time");
  const sign = params.get("sign");
  if (base && id && time && sign) {
    const res = await fetchText(
      `${base}/videos/playerurl?id=${id}&t=${time}&h=${sign}`,
      playerUrl,
    );
    const data = JSON.parse(res) as {
      error?: number;
      content?: { video_url?: string };
    };
    const u = data.content?.video_url;
    if (data.error === 0 && u) return { url: u.replace(/\\\//g, "/"), fromPage: false };
  }
  throw new HttpError(502, "player page contained no resolvable media url");
}

/**
 * Find a media URL embedded in a player page. Handles both quoted forms and
 * JS `\/`-escaped URLs; the URL may carry a query string.
 */
export function extractMediaUrl(html: string): string | null {
  const flat = html.replace(/\\\//g, "/");
  const m = flat.match(/https?:\/\/[^\s"'<>()]+\.(?:m3u8|mp4)(?:\?[^\s"'<>()]*)?/);
  return m ? m[0] : null;
}

/** Resolve a thread reference into a playable, signed stream. */
async function resolveVideo(url: string, origin: string): Promise<VideoInfo> {
  const tid = threadTidFromValue(url);
  if (!tid) throw new HttpError(400, "not a t66y.com thread url");
  const node = T66Y_BASE;
  const html = await fetchText(`${node}/read.php?tid=${tid}`, node + "/");
  const iframe = extractIframeSrc(html);
  if (!iframe) throw new HttpError(502, "thread had no embedded player");
  const media = await resolvePlayerMediaUrl(iframe);
  const target = assertSafeTarget(media.url);
  if (!/\.(m3u8|mp4)(\?|$)/i.test(target.pathname)) {
    throw new HttpError(502, "unrecognized media type");
  }
  if (/\.mp4(\?|$)/i.test(target.pathname)) {
    // The playerurl API can return a bare mp4; the video endpoint's
    // VideoInfo is HLS-shaped (hls.js consumes playlistUrl).
    throw new HttpError(502, "mp4 direct stream not supported yet");
  }
  const videoUrl = target.toString();
  // Format 2 (m3u8 embedded in the player page): the CDN is CORS-open and
  // blocks datacenter egress, so the browser streams it directly.
  // Format 1 (API-issued): route through the signing media proxy.
  const playlistUrl = media.fromPage
    ? videoUrl
    : await mediaPath(proxySecret(), origin, videoUrl, "t66y");
  return { videoUrl, playlistUrl, thumbVttUrl: null };
}

/* ------------------------------------------------------------------ *
 * Article model
 * ------------------------------------------------------------------ */

function toArticle(path: string, a: RawThreadPage, tid: string): Article {
  const video: VideoBlock = {
    type: "hls",
    url: a.iframe ?? "",
    pageUrl: `${T66Y_BASE}/read.php?tid=${tid}`,
    id: a.videoId ?? undefined,
  };
  const blocks: ArticleBlock[] = [{ type: "video", video }];
  if (a.description) blocks.push({ type: "p", text: a.description });
  return {
    src: "t66y",
    path,
    title: a.title,
    author: a.author || undefined,
    published: a.published || undefined,
    categories: a.category ? [a.category] : undefined,
    blocks,
    recommendations: [],
  };
}

/* ------------------------------------------------------------------ *
 * Source adapter
 * ------------------------------------------------------------------ */

export const t66ySource: Source = {
  id: "t66y",
  kind: "feed",
  matchUrl: (url) => threadTidFromValue(url) !== null,
  resolve: resolveVideo,
  mediaHosts: isT66yMediaHost,

  async siteInfo(): Promise<SiteInfo> {
    let categories: SiteCategory[] = CATEGORIES.map((c) => ({
      path: c.path,
      name: c.name,
    }));
    // The nav order/names on the page win when reachable (the nav is
    // rendered twice per page — top and bottom — so dedupe by path).
    try {
      const html = await fetchText(
        `${T66Y_BASE}/thread0806.php?fid=${FID}`,
        T66Y_BASE + "/",
      );
      const parsed: SiteCategory[] = [];
      const seen = new Set<string>();
      for (const m of html.matchAll(
        /href="thread0806\.php\?fid=\d+&type=(\d+)"[^>]*>\s*([^<]+?)\s*</g,
      )) {
        const p = `/category/${m[1]}/`;
        if (seen.has(p)) continue;
        seen.add(p);
        parsed.push({ path: p, name: decodeEntities(m[2].trim()) || `分類${m[1]}` });
      }
      if (parsed.length) categories = parsed;
    } catch {
      // Fall back to the known static nav.
    }
    return {
      src: "t66y",
      node: T66Y_BASE,
      nodeSource: "default",
      categories: [{ id: "category", label: "分類", categories }],
    };
  },

  async feed(path, page, nodeOverride): Promise<FeedPage> {
    const node = nodeForRequest(nodeOverride);
    const url = buildFeedUrl(path, page, node);
    const html = await fetchText(url, node + "/");
    const rows = parseThreadList(html);
    const totalPages = parseTotalPages(html, page);
    const items: FeedItem[] = rows.map((r) => {
      const tagPath = CAT_PATH_BY_NAME[r.category];
      return {
        id: r.tid,
        path: `/t/${r.tid}/`,
        title: r.title,
        published: r.ts ? new Date(Number(r.ts) * 1000).toISOString() : undefined,
        tags: r.category && tagPath
          ? [{ name: r.category, path: tagPath }]
          : undefined,
      };
    });
    return { src: "t66y", path, page, totalPages, items };
  },

  async article(path, nodeOverride): Promise<Article> {
    const m = path.match(/^\/t\/(\d+)\/?$/);
    if (!m) throw new HttpError(400, "article path must look like /t/<tid>/");
    const tid = m[1];
    const node = nodeForRequest(nodeOverride);
    const html = await fetchText(`${node}/read.php?tid=${tid}`, node + "/");
    const a = parseThreadPage(html);
    if (!a.iframe) throw new HttpError(502, "thread had no embedded player");
    return toArticle(`/t/${tid}/`, a, tid);
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
