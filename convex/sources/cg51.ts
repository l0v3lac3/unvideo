/**
 * Parsers and node resolution for the 51吃瓜 (cg51.com) source.
 *
 * How the source works (all verified empirically, 2026-10-14):
 *  - cg51.com is a *landing/redirector*, not a content host. Its page embeds
 *    a `window.appConfig = { data: "<base64>", key: "<string>" }` payload that
 *    is AES-CBC encrypted with key `SHA256(key)`. The plaintext is JSON with
 *    `main` (the current content node), `domain[]` (mostly ad landers) and
 *    `backup_domain`.
 *  - `main` currently points at https://www.51ql1.com, which 301-redirects to
 *    https://51qingliang.com/ ("51吃瓜轻量版") — the real content node.
 *  - The content node serves:
 *      feed:  /            (page N > 1: /page/N/)
 *      cats:  /category/<slug>/     (page N > 1: /category/<slug>/N/)
 *      post:  /archives/<id>/
 *  - Every asset the player needs is browser-friendly: the node, the video
 *    CDN (hls.tpbbwcc.cn / tx.doudou520.online) and the image CDN
 *    (pic.jtzatly.cn) all answer with `Access-Control-Allow-Origin: *`, need
 *    no User-Agent, and serve *raw* HLS/TSG/JPGE — no PNG container, no
 *    `ev` payload. Only the cg51.com landing page has no CORS headers, which
 *    is the one step that must happen server-side.
 *  - The article page embeds the stream in
 *    `<div class="dplayer" data-config='{"video":{"url":"...m3u8","type":"hls"},...}'>`
 *    with a *fresh* auth_key on every page render, so the article is re-fetched
 *    server-side each time it is opened.
 */

import { HttpError } from "../proxy";
import type {
  Article,
  FeedItem,
  FeedPage,
  SiteCategory,
  SiteInfo,
  Source,
  VideoBlock,
} from "./types";

export const CG51_LANDING = "https://cg51.com";
export const DEFAULT_NODE = "https://51qingliang.com";

/** Node base URL used by /api/feed and /api/article (set by /api/node). */
let cachedNode: string | null = null;

export function getNode(): string {
  return cachedNode || DEFAULT_NODE;
}

/**
 * Resolve the node to serve a request. Uses an explicit override when given,
 * else the cached node, else a fresh discovery. Module-level `cachedNode` only
 * survives within a single Convex action invocation, so cross-request callers
 * (the frontend) should pass `node` explicitly for speed/consistency; this
 * keeps the API self-sufficient when they don't.
 */
export async function getNodeForRequest(
  override: string | null | undefined,
): Promise<string> {
  if (override) return override.replace(/\/+$/, "");
  if (cachedNode) return cachedNode;
  const info = await refreshNode();
  return info.node;
}

/** Re-run node discovery and remember the result for this runtime. */
export async function refreshNode(): Promise<NodeInfo> {
  const info = await resolveNode();
  cachedNode = info.node;
  return info;
}

export type NodeInfo = {
  /** Content node base URL to use for feeds/articles (no trailing slash). */
  node: string;
  /** Where the node URL came from: "api" (freshly decrypted) or "default". */
  source: "api" | "default";
  /** Value of `main` from the decrypted landing config, if present. */
  main: string | null;
  /** Other listed domains (mostly ad/backup landers — informational). */
  domains: string[];
};

const FETCH_TIMEOUT_MS = 20_000;
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchText(target: string, referer: string | undefined): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": BROWSER_UA, Referer: referer ?? "", Accept: "*/*" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new HttpError(502, `upstream returned ${res.status}`);
    return res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Node discovery
 * ------------------------------------------------------------------ */

function base64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function latin1Decode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

async function sha256Bytes(text: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
}

/**
 * AES-256-CBC decrypt with key = SHA256(keyString). The plaintext is JSON whose
 * length is NOT always PKCS7-padded, so try parsing the full plaintext first
 * and only fall back to stripping the last `pad` bytes.
 */
export async function decryptCg51Config(
  dataB64: string,
  key: string,
): Promise<Record<string, unknown>> {
  const dec = base64ToBytes(dataB64);
  const iv = dec.subarray(0, 16);
  const ct = dec.subarray(16);
  const akey = await crypto.subtle.importKey(
    "raw",
    await sha256Bytes(key),
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-CBC", iv }, akey, ct),
  );
  // Try full plaintext first; if that fails, strip a PKCS7-style pad.
  const full = latin1Decode(pt);
  try {
    return JSON.parse(full);
  } catch {
    const pad = pt[pt.length - 1];
    if (pad >= 1 && pad <= 16) {
      return JSON.parse(latin1Decode(pt.subarray(0, pt.length - pad)));
    }
    throw new HttpError(502, "failed to decode decrypted config");
  }
}

/** Pull `window.appConfig = { data, key }` out of a cg51.com landing page. */
export function extractCg51Config(html: string): { data: string; key: string } {
  // The active line is NOT `//`-prefixed; the commented decoys start with `//`.
  // A line-anchored `^\s*data:` (with /m) therefore skips the decoys.
  const data = html.match(/^(\s*)data:\s*"([A-Za-z0-9+/=]+)"/m);
  const key = html.match(/^(\s*)key:\s*"([\w]+)"/m);
  if (!data || !key) throw new HttpError(502, "appConfig not found on cg51.com");
  return { data: data[2], key: key[2] };
}

function looksLikeContentNode(html: string): boolean {
  return (
    html.includes('itemtype="http://schema.org/BlogPosting"') ||
    html.includes('"/category/')
  );
}

/**
 * Discover the current content node: decrypt the cg51.com landing config,
 * follow `main` through redirects, and verify the destination is a real
 * content node. Falls back to the known-good default when anything fails.
 */
export async function resolveNode(): Promise<NodeInfo> {
  const fallback: NodeInfo = {
    node: DEFAULT_NODE,
    source: "default",
    main: null,
    domains: [],
  };
  try {
    const html = await fetchText(CG51_LANDING, undefined);
    const cfg = extractCg51Config(html);
    const config = await decryptCg51Config(cfg.data, cfg.key);
    const main =
      typeof config.main === "string" ? config.main : null;
    const domains: string[] = Array.isArray(config.domain)
      ? (config.domain as Array<{ value?: string }>).map(d => d.value ?? "")
      : [];
    let node = main && main.startsWith("http") ? main : DEFAULT_NODE;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(node, {
        headers: { "User-Agent": BROWSER_UA },
        signal: ctrl.signal,
        redirect: "follow",
      });
      if (res.ok && res.url && new URL(res.url).pathname === "/") {
        node = new URL(res.url).origin;
      }
      clearTimeout(timer);
      const home = await fetchText(node + "/", node + "/");
      if (!looksLikeContentNode(home)) throw new Error("not a content node");
    } catch {
      return fallback;
    }
    return { node, source: "api", main, domains };
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ *
 * Feed / list parsing
 * ------------------------------------------------------------------ */

export type RawFeedItem = {
  id: string;
  url: string;
  title: string;
  cover: string;
  published: string;
  author: string;
  categories: string[];
  views: string;
};

export type RawFeedResult = {
  node: string;
  path: string;
  page: number;
  totalPages: number;
  items: RawFeedItem[];
};

export type Cg51Category = { slug: string; name: string };

/** Category slugs+names from the node home page nav. */
export function parseCategories(html: string): Cg51Category[] {
  const seen = new Map<string, string>();
  for (const m of html.matchAll(/href="\/category\/([a-z0-9]+)\/?"[^>]*>\s*([^<]{1,20})</g)) {
    const slug = m[1];
    const name = m[2].trim();
    if (!seen.has(slug) && name && !name.includes("category")) seen.set(slug, name);
  }
  return [...seen.entries()].map(([slug, name]) => ({ slug, name }));
}

/**
 * Build the feed URL path for a given list path + page number.
 *  /            page 1 → /          page N → /page/N/
 *  /category/x  page 1 → /category/x/   page N → /category/x/N/
 *  /tag/x       page 1 → /tag/x/    page N → /tag/x/N/
 * Anything else is rejected (the feed is browsable by home + categories
 * + tag pages only).
 */
export function buildFeedPath(path: string, page: number): string {
  let p = path || "/";
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+$/, "");
  if (page <= 1) return p === "" ? "/" : p + "/";
  if (p === "") return `/page/${page}/`;
  if (/^\/category\/[a-z0-9]+$/.test(p)) return `${p}/${page}/`;
  if (/^\/tag\/[^/]+$/.test(p)) return `${p}/${page}/`;
  throw new HttpError(400, "unsupported feed path (use / or /category/<slug>)");
}

const ARTICLE_BLOCK = /<article itemscope itemtype="http:\/\/schema.org\/BlogPosting"[\s\S]*?<\/article>/g;
const ARCHIVE_PATH = /itemprop="url mainEntityOfPage" content="(\/archives\/\d+\/)"/;

/** Parse one feed/list page (home or category) into items + total pages. */
export function parseFeed(html: string, node: string, path: string, page: number): RawFeedResult {
  const base = node.replace(/\/+$/, "");
  const items: RawFeedItem[] = [];
  for (const block of html.match(ARTICLE_BLOCK) ?? []) {
    const url = block.match(ARCHIVE_PATH);
    if (!url) continue;
    const title = block.match(/itemprop="headline">\s*([^<]+?)\s*</);
    const cover = block.match(/loadBannerDirect\('([^']+)'/) ?? block.match(/data-xkrkllgl="([^"]+)"/);
    const pub = block.match(/itemprop="datePublished" content="([^"]+)"/);
    // Station promo/ad cards (Meme coin, 招募, 抽奖, 福利) omit the whole
    // post-card-info meta row (no author / date / category span). Legit
    // articles always carry datePublished. Skip the promo cards entirely —
    // verified: every no-date card on the home feed + 往期活动 category was a
    // station ad, and 43/43 normal articles have datePublished.
    if (!pub) continue;
    // Author: 51qingliang puts it inline ("瓜瓜 • "), 51cg1 in a display-none meta.
    const author =
      block.match(/itemprop="author"[^>]*>\s*([^<]+?)\s*•/) ??
      block.match(
        /itemprop="author" itemtype="http:\/\/schema.org\/Person">\s*<meta itemprop="name" content="([^"]*)"/,
      );
    // Category span is the span right after the datePublished span (no bullets
    // on one skin, a trailing "• " on the other — strip bullets below).
    const cats = block.match(
      /itemprop="datePublished" content="[^"]*"[^>]*>[^<]*<\/span>\s*<span>([^<]*?)<\/span>/,
    );
    const views = block.match(/<span>([\d.]+)万?浏览量<\/span>/);
    const id = url[1].match(/\d+/)?.[0] ?? "";
    const coverUrl = cover?.[1] ?? "";
    items.push({
      id,
      url: `${base}${url[1]}`,
      title: title ? title[1].trim() : "",
      cover: coverUrl.startsWith("http") ? coverUrl : coverUrl ? `${base}${coverUrl}` : "",
      published: pub?.[1] ?? "",
      author: author?.[1].trim() ?? "",
      // The span right after the date is the category list on both skins; guard
      // against a skin that places the views span there instead.
      categories: cats
        ? cats[1]
            .replace(/[•]/g, "")
            .split(",")
            .map(c => c.trim())
            .filter(Boolean)
        : [],
      // keep the raw count ("8.4万" reads nicer than 84000); empty on some skins
      views: views ? views[1] : "",
    });
  }
  let totalPages = 0;
  for (const m of html.matchAll(/\/(?:page|category\/[a-z0-9]+|tag\/[^/]+)\/(\d+)\//g)) {
    totalPages = Math.max(totalPages, Number(m[1]));
  }
  return { node: base, path, page, totalPages, items };
}

/* ------------------------------------------------------------------ *
 * Article parsing
 * ------------------------------------------------------------------ */

export type Cg51Video = {
  url: string;
  /** "hls" or "mp4" (video_h265 entries may hold mp4/other). */
  type: string;
  /** Upstream video id (data-video_id), if present. */
  id: string;
};

export type Cg51Rec = {
  /** Title of the recommended article. */
  title: string;
  /** /archives/<id>/ path on the same node (relative, starts with /). */
  path: string;
  /** Cover image URL (may be empty). */
  cover: string;
  /** Short description (collection TOC entries carry 简要描述). */
  desc: string;
};

export type Cg51BodyBlock =
  | { type: "p"; text: string }
  | { type: "h"; level: number; text: string }
  | { type: "img"; url: string }
  | { type: "video"; video: Cg51Video }
  | { type: "quote"; text: string }
  | { type: "rec"; rec: Cg51Rec };

export type Cg51Tag = {
  /** Display name of the tag. */
  name: string;
  /** Tag list page on the node (e.g. `/tag/捡尸/`). */
  path: string;
};

export type Cg51Article = {
  node: string;
  url: string;
  title: string;
  description: string;
  author: string;
  published: string;
  modified: string;
  categories: string[];
  tags: Cg51Tag[];
  cover: string;
  images: string[];
  /** Ordered body as it appears on the original site (text/heading/image/video). */
  body: Cg51BodyBlock[];
  /** Recommendation ("推介") entries — site-specific, in order. */
  recommendations: Cg51Rec[];
  video: Cg51Video | null;
  /** True when this is a station promo/ad article (no playable video). */
  isPromo: boolean;
};

/**
 * Extract `data-config='{...}'` — the attribute is single-quoted JSON. Prefer
 * the first closing quote; if that JSON is unparseable (a stray `'` inside a
 * string), rescan for the attribute terminator `'}>'`.
 */
function extractDplayerConfig(attrs: string): Record<string, unknown> | null {
  const start = attrs.indexOf("data-config='");
  if (start < 0) return null;
  const begin = start + "data-config='".length;
  const firstEnd = attrs.indexOf("'", begin);
  const candidates = [
    firstEnd > begin ? attrs.slice(begin, firstEnd) : null,
    attrs.slice(begin, attrs.indexOf("'>", begin)) .replace(/'>$/, "") || null,
  ];
  for (const cand of candidates) {
    if (!cand) continue;
    try {
      return JSON.parse(cand) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

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

/**
 * Extract the real article body: the inner HTML of
 * `<div class="post-content" itemprop="articleBody">`. The site's markup has
 * unbalanced divs (and the whole trailing boilerplate — 版权 / 重磅热瓜 /
 * 最新地址 / 下载APP — lives *after* the body's prev/next nav), so a naive
 * div-balance walk over-captures. The reliable end marker is the first
 * `<div class="post-near"` (上一篇/下一篇 nav) after the body open; fallback to
 * `</article>`. Verified across 68 articles.
 */
function extractArticleBody(html: string): string {
  const startTag = '<div class="post-content" itemprop="articleBody">';
  const start = html.indexOf(startTag);
  if (start < 0) return "";
  const openEnd = html.indexOf(">", start) + 1;
  const near = html.indexOf('<div class="post-near"', start);
  const article = html.indexOf("</article>", start);
  let end: number;
  if (near > start) end = near;
  else if (article > start) end = article;
  else {
    // Fallback: div-balance from the opening tag.
    let pos = openEnd;
    let depth = 1;
    while (pos < html.length) {
      const no = html.indexOf("<div", pos);
      const nc = html.indexOf("</div>", pos);
      if (nc === -1) break;
      if (no !== -1 && no < nc) {
        depth++;
        pos = no + 4;
      } else {
        depth--;
        pos = nc + 6;
        if (depth === 0) break;
      }
    }
    end = pos;
  }
  return html.slice(openEnd, end);
}

/**
 * True for the site's own boilerplate blocks that are not article content:
 *  - the site-nav quote box ("🔗 51吃瓜最新地址 … 国内/海外/永久/交流群/播放异常")
 *  - the in-body hashtag list paragraph ("关键词：#… #…")
 *  - the category-nav heading ("🔥 热门吃瓜")
 * Tags are already sourced from the authoritative `data-video_tag_name`, so the
 * in-body 关键词 hashtag list is redundant and dropped.
 */
function isBodyBoilerplate(kind: "p" | "quote", text: string): boolean {
  if (kind === "quote") {
    const nav =
      text.includes("51吃瓜最新地址") ||
      text.includes("播放异常") ||
      (text.includes("国内") && text.includes("海外")) ||
      text.includes("官方QQ群") ||
      text.includes("官方微信QQ群");
    return nav;
  }
  // kind === "p"
  const trimmed = text.trim();
  return (
    trimmed.startsWith("关键词") ||
    trimmed.includes("热门吃瓜") ||
    trimmed.includes("该文章由") ||
    trimmed.includes("版权声明") ||
    trimmed.includes("下载APP观看完整版") ||
    trimmed.includes("分享好友吃瓜") ||
    // 51吃瓜轻量版 skin puts these site-nav lines as <p> inside the body.
    trimmed.includes("邮件至官方邮箱") ||
    trimmed.includes("TG讨论") ||
    trimmed.includes("telegram.me") ||
    trimmed.includes("重要提示")
  );
}

/**
 * Build a Cg51Video from a dplayer tag's attribute string (empty attrs → null).
 * Used both for the top-level player and for in-body video blocks.
 */
function extractVideoFromDplayer(attrs: string): Cg51Video | null {
  const cfg = extractDplayerConfig(attrs);
  if (!cfg) return null;
  const vid = attrs.match(/data-video_id="(\d+)"/)?.[1] ?? "";
  const v = cfg["video"] as { url?: string; type?: string } | undefined;
  if (v?.url) return { url: v.url, type: v.type ?? "hls", id: vid };
  const h265 = (cfg["video_h265"] as Array<{ url?: string; type?: string }>) ?? [];
  const alt = h265.find(h => h?.url);
  return alt?.url ? { url: alt.url, type: alt.type ?? "mp4", id: vid } : null;
}

/**
 * Parse the ordered articleBody HTML into blocks in original site order:
 * paragraphs, headings, images, in-body videos, quote boxes and recommendation
 * ("推介") entries. The station gambling `txt-apps` row, `line` dividers and
 * `menu_index` anchors are dropped as they are site chrome/ads, not content.
 *
 * Recommendations are identified by the site-specific
 * `<a class="btn btn-primary" href="/archives/<id>/">` link (never used for
 * normal content links). Two formats:
 *  - single: `<p><img 封面><br><a class="btn btn-primary">标题 点击观看</a></p>`
 *  - collection TOC: `<p><a class="btn btn-primary">标题 点击查看详情</a></p>`
 *    followed by `<p><a href=同id><img 封面></a> 简要描述：…</p>` + `<hr>`
 */
export function parseArticleBody(bodyHtml: string): Cg51BodyBlock[] {
  const blocks: Cg51BodyBlock[] = [];
  const BLOCK_RE =
    /<h([23])[^>]*>([\s\S]*?)<\/h[23]>|<blockquote[\s\S]*?<\/blockquote>|<p[^>]*>([\s\S]*?)<\/p>/g;
  const REC_LINK_RE =
    new RegExp('<a href="(/archives/\\d+/)"[^>]*class="btn btn-primary"[^>]*>([\\s\\S]*?)</a>');
  let skipUntil = -1;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(bodyHtml))) {
    if ((m.index ?? 0) < skipUntil) continue;
    if (m[1]) {
      const text = stripTags(m[2]);
      if (text) blocks.push({ type: "h", level: Number(m[1]), text });
    } else if (m[0].startsWith("<blockquote")) {
      const text = stripTags(m[0]);
      if (text && !isBodyBoilerplate("quote", text)) blocks.push({ type: "quote", text });
    } else if (m[3] !== undefined) {
      const inner = m[3];
      const vidMatch = inner.match(/class="dplayer"([^>]*)/);
      const video = vidMatch ? extractVideoFromDplayer(vidMatch[1]) : null;
      if (video) {
        blocks.push({ type: "video", video });
        continue;
      }
      // Recommendation entry? (site-unique btn-primary link to another article)
      const recLink = inner.match(REC_LINK_RE);
      if (recLink) {
        const path = recLink[1];
        const title = stripTags(recLink[2]);
        let cover = inner.match(/data-xkrkllgl="([^"]+)"/)?.[1] ?? "";
        let desc = "";
        if (!cover) {
          // Collection format: the cover + 简要描述 live in the NEXT <p>.
          // Note: the site sometimes points the cover's <a> at the WRONG id
          // (e.g. every cover links to a single 合集 entry). Only treat it as
          // this rec's cover if the wrapped img belongs to a rec cover AND the
          // id matches; otherwise let the next <p> be parsed normally (img +
          // desc blocks).
          const restStart = (m.index ?? 0) + m[0].length;
          const rest = bodyHtml.slice(restStart);
          const nextP = rest.match(/<p[^>]*>([\s\S]*?)<\/p>/);
          if (nextP) {
            const imgUrl = nextP[1].match(/data-xkrkllgl="([^"]+)"/)?.[1] ?? "";
            const descMatch =
              nextP[1].match(/简要描述：<\/strong>\s*([^<]+)/)?.[1] ?? "";
            // The next <p> is the rec's cover when it wraps an image with a
            // 简要描述 note — even if the site points its <a> at a different
            // (wrong) id. Treat it as this rec's cover and skip the <p>.
            if (imgUrl && descMatch) {
              cover = imgUrl;
              desc = descMatch.trim();
              skipUntil = restStart + (nextP.index ?? 0) + nextP[0].length;
            }
          }
        }
        if (title) blocks.push({ type: "rec", rec: { title, path, cover, desc } });
        continue;
      }
      const text = stripTags(inner);
      const imgSrc = inner.match(/data-xkrkllgl="([^"]+)"/)?.[1] ??
        inner.match(/<img[^>]+src="(https:[^"]+)"/)?.[1];
      // Push text and image separately (both, in order) so a mixed paragraph
      // is preserved; image-only paragraphs yield just an img block. The
      // in-body 关键词 hashtag list is dropped (tags already come from
      // data-video_tag_name).
      if (text && !isBodyBoilerplate("p", text)) blocks.push({ type: "p", text });
      if (imgSrc) blocks.push({ type: "img", url: imgSrc });
    }
  }
  return blocks;
}

/** Parse an /archives/<id>/ page into full metadata + ordered body + media. */
export function parseArticle(html: string, node: string, path: string): Cg51Article {
  const base = node.replace(/\/+$/, "");
  const url = `${base}${path}`;

  // og:title is the clean title; <title> carries a site suffix that varies
  // by node skin (" - 51吃瓜轻量版" / " | 51吃瓜网"), so prefer og:title.
  const ogTitle = html.match(/property="og:title" content="([^"]*)"/);
  const titleTag = html.match(/<title>([^<]*)<\/title>/);
  let title = ogTitle?.[1]?.trim() ?? (titleTag ? titleTag[1].trim() : "");
  title = title.replace(/\s*[-|]\s*51吃瓜(轻量版|网).*$/, "").trim();

  const og = html.match(/property="og:description" content="([^"]*)"/);
  const desc = og ? decodeEntities(og[1]) : "";

  // Author: schema.org Person, falling back to the display-none author meta
  // (the two node skins emit different shapes).
  const author =
    html.match(/"author":\s*\{\s*"@type":\s*"Person",\s*"name":\s*"([^"]*)"/) ??
    html.match(
      /itemprop="author" itemtype="http:\/\/schema.org\/Person">\s*<meta itemprop="name" content="([^"]*)"/,
    );

  const published =
    html.match(/"datePublished":\s*"([^"]*)"/) ??
    html.match(/property="article:published_time" content="([^"]*)"/);
  const modified = html.match(/"dateModified":\s*"([^"]*)"/);

  // articleSection is an array on one skin, a single string on the other.
  const sectionsArr = html.match(/"articleSection":\s*\[([^\]]*)\]/);
  const sectionsStr = html.match(/"articleSection":\s*"([^"]*)"/);
  const categories = sectionsArr
    ? [...sectionsArr[1].matchAll(/"([^"]+)"/g)].map(m => m[1])
    : sectionsStr?.[1]
      ? [sectionsStr[1]]
      : [];

  // Ordered body (original site layout) + in-body videos.
  const bodyHtml = extractArticleBody(html);
  const body = parseArticleBody(bodyHtml);

  // The top-level player is the first dplayer anywhere on the page (the site
  // may also embed a preview player outside the body).
  const dplayerTag = html.match(/class="dplayer"([^>]*)/)?.[1] ?? "";
  const video = extractVideoFromDplayer(dplayerTag);
  // The tag cloud under the body: `<div class="tags"><div itemprop="keywords">
  // <a href="/tag/<name>/">name</a>…</div></div>`. Prefer the real links (name
  // + path); fall back to the dplayer/meta names (path synthesized).
  const tagDiv =
    html.match(/<div class="tags"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? "";
  const tags: Cg51Tag[] = [];
  const seenTag = new Set<string>();
  for (const m of tagDiv.matchAll(/<a href="(\/tag\/[^"]+)">([^<]+)<\/a>/g)) {
    const name = decodeEntities(m[2].trim());
    const path = m[1].replace(/\/+$/, "");
    if (!name || seenTag.has(path)) continue;
    seenTag.add(path);
    tags.push({ name, path });
  }
  if (!tags.length) {
    const tagsFromVideo = dplayerTag.match(/data-video_tag_name="([^"]*)"/);
    const metaKeywords = html.match(/name="keywords" content="([^"]*)"/);
    const tagSource = tagsFromVideo?.[1] ?? metaKeywords?.[1] ?? "";
    for (const name of tagSource.split(",").map(t => t.trim()).filter(Boolean)) {
      tags.push({ name, path: `/tag/${encodeURIComponent(name)}/` });
    }
  }

  // Flat image list = every image block, in order (kept for the gallery).
  // Recommendation covers are NOT the article's own photos — they're covers of
  // the linked-to articles — so exclude them.
  const recs = body
    .filter(b => b.type === "rec")
    .map(b => (b as { rec: Cg51Rec }).rec);
  const recCovers = new Set(recs.map(r => r.cover).filter(Boolean));
  const images = body
    .filter(b => b.type === "img")
    .map(b => (b as { url: string }).url)
    .filter(u => !recCovers.has(u));
  const cover = images[0] ?? "";

  // Station promo posts (Meme coin, 招募, 抽奖) never embed a video AND have
  // at most one (self-cross-linking) recommendation. Collections (合集) also
  // have no video but carry a table-of-contents of many recommendations.
  // Verified across 70+ articles, 2026-10-14.
  const isPromo = video === null && recs.length < 2;

  return {
    node: base,
    url,
    title,
    description: desc,
    author: author?.[1] ?? "",
    published: published?.[1] ?? "",
    modified: modified?.[1] ?? "",
    categories,
    tags,
    cover,
    images,
    body,
    recommendations: recs,
    video,
    isPromo,
  };
}

/* ------------------------------------------------------------------ *
 * Image proxy — the 51吃瓜 image CDNs serve *encrypted* bytes. The site's own
 * zzz.js fetches each image then runs `decryptImage()` (CryptoJS AES-CBC) to
 * recover a base64 data-URI. We replicate that: fetch the raw (encrypted)
 * bytes, AES-128-CBC-decrypt them, and stream the real image back.
 *
 * Key/IV (decoded from zzz.js string-rotation, verified 2026-10-14):
 *   key "f5d965df75336270", iv "97b60394abc2fbe1"  (UTF-8, 16 bytes each)
 * Images on these hosts are encrypted; the bytes are NOT a valid image until
 * decrypted (raw magic 0x3eaa708e, real magic 0xffd8ffe0 = JPEG after).
 * ------------------------------------------------------------------ */

export const CG51_IMG_KEY = "f5d965df75336270";
export const CG51_IMG_IV = "97b60394abc2fbe1";

/** Hosts confirmed to serve encrypted images (allowlist for /api/img). */
const IMG_HOSTS = new Set([
  "pic.gyezbp.cn",
  "pic.jtzatly.cn",
  "pic.bxh666.cn",
]);

export function isCg51ImageHost(host: string): boolean {
  return IMG_HOSTS.has(host);
}

/**
 * AES-128-CBC decrypt raw bytes (PKCS7). The 51吃瓜 image CDN delivers the
 * ciphertext directly (no base64 wrapper).
 */
export async function decryptCg51Image(data: Uint8Array): Promise<Uint8Array> {
  // Copy onto a fresh ArrayBuffer (crypto.subtle requires one).
  const bytes = new Uint8Array(data);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(CG51_IMG_KEY),
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );
  const iv = new TextEncoder().encode(CG51_IMG_IV);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, bytes),
  );
}


/** Fetch a path on the current content node with a browser UA. */
export async function fetchNodeText(path: string, node: string | null = null): Promise<string> {
  const base = (node || getNode()).replace(/\/+$/, "");
  return fetchText(base + path, base + "/");
}

/** Validate an /archives/<id>/ path (the only article shape we resolve). */
export function assertArchivePath(raw: string): string {
  let p = raw;
  // Accept a full URL on a known node and reduce it to the path.
  try {
    if (p.startsWith("http")) {
      const u = new URL(p);
      p = u.pathname;
    }
  } catch {
    throw new HttpError(400, "invalid path");
  }
  if (!/^\/archives\/\d+\/$/.test(p)) {
    throw new HttpError(400, "article path must look like /archives/123/");
  }
  return p;
}

/* ------------------------------------------------------------------ *
 * Source adapter — normalized models for the dispatcher + frontend.
 * ------------------------------------------------------------------ */

function toVideoBlock(v: Cg51Video | null | undefined): VideoBlock | undefined {
  if (!v) return undefined;
  return { type: v.type === "hls" ? "hls" : "mp4", url: v.url, id: v.id || undefined };
}

/** Map a parsed article onto the shared Article model. */
function toArticle(path: string, a: Cg51Article): Article {
  return {
    src: "cg51",
    path,
    title: a.title,
    description: a.description || undefined,
    author: a.author || undefined,
    published: a.published || undefined,
    modified: a.modified || undefined,
    categories: a.categories,
    tags: a.tags,
    cover: a.cover || undefined,
    images: a.images,
    video: toVideoBlock(a.video),
    blocks: a.body.map((b) => {
      if (b.type === "video") return { type: "video" as const, video: toVideoBlock(b.video)! };
      if (b.type === "rec")
        return {
          type: "rec" as const,
          rec: { path: b.rec.path, title: b.rec.title, cover: b.rec.cover || undefined, desc: b.rec.desc || undefined },
        };
      if (b.type === "img") return { type: "img" as const, url: b.url };
      if (b.type === "h") return { type: "h" as const, level: b.level, text: b.text };
      if (b.type === "quote") return { type: "quote" as const, text: b.text };
      return { type: "p" as const, text: b.text };
    }),
    recommendations: a.recommendations.map((r) => ({
      path: r.path,
      title: r.title,
      cover: r.cover || undefined,
      desc: r.desc || undefined,
    })),
    promo: a.isPromo,
  };
}

export const cg51Source: Source = {
  id: "cg51",
  kind: "feed",

  async siteInfo(): Promise<SiteInfo> {
    const info = await refreshNode();
    let categories: SiteCategory[] = [];
    try {
      const home = await fetchNodeText("/");
      categories = parseCategories(home).map((c) => ({
        path: `/category/${c.slug}/`,
        name: c.name,
      }));
    } catch {
      // No category nav; the home feed still works.
    }
    return {
      src: "cg51",
      node: info.node,
      nodeSource: info.source,
      categories: categories.length
        ? [{ id: "category", label: "分类", categories }]
        : [],
    };
  },

  async feed(path, page, nodeOverride): Promise<FeedPage> {
    const base = await getNodeForRequest(nodeOverride);
    const feedPath = buildFeedPath(path, page);
    const html = await fetchNodeText(feedPath, base);
    const result = parseFeed(html, base, feedPath, page);
    // The card's category span holds names only; the same page's nav maps
    // name → slug so the chips can link to the category list.
    const slugByName = new Map(parseCategories(html).map(c => [c.name, c.slug]));
    return {
      src: "cg51",
      path,
      page,
      totalPages: result.totalPages,
      items: result.items.map((i): FeedItem => {
        const m = i.url.match(/\/archives\/\d+\//);
        const tags = i.categories
          .map(name => {
            const slug = slugByName.get(name);
            return slug
              ? { name, path: `/category/${slug}/` }
              : null;
          })
          .filter((t): t is { name: string; path: string } => t !== null);
        return {
          id: i.id,
          path: m ? m[0] : i.url,
          title: i.title,
          cover: i.cover || undefined,
          published: i.published || undefined,
          tags: tags.length ? tags : undefined,
          meta: i.views ? [`${i.views}万浏览`] : undefined,
        };
      }),
    };
  },

  async article(path, nodeOverride): Promise<Article> {
    const base = await getNodeForRequest(nodeOverride);
    const html = await fetchNodeText(path, base);
    return toArticle(path, parseArticle(html, base, path));
  },

  matchArticle: (value) => {
    const m = value.match(/\/archives\/(\d+)(?:[/?#]|$)/);
    return m ? `/archives/${m[1]}/` : null;
  },

  imageHosts: isCg51ImageHost,

  transformImage: async (data) => {
    try {
      return await decryptCg51Image(data);
    } catch {
      // Not encrypted (or key rotated) — pass the raw bytes through.
      return data;
    }
  },
};

/** Legacy /api/node response shape (pre-normalization frontends). */
export async function legacyNodeInfo() {
  const info = await refreshNode();
  const home = await fetchNodeText("/");
  return { ...info, landing: CG51_LANDING, categories: parseCategories(home) };
}
