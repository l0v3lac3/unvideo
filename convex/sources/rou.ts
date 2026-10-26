/**
 * rou.video source adapter.
 *
 * Why a server-side proxy is needed at all (all of this was verified
 * empirically, not assumed):
 *  1. rou.video and its video CDNs answer 403 to requests without a
 *     browser-like `User-Agent` header. Browsers cannot set `User-Agent`
 *     on media requests, so this cannot be done client-side.
 *  2. Every media response is a *PNG container* smuggling the real payload
 *     in a custom `roUd` chunk (optionally zlib-compressed), so the raw
 *     bytes are not playable and not even parseable as HLS until unwrapped.
 *  3. The responses carry no CORS headers, so `fetch`/hls.js in a browser
 *     cannot read them directly.
 *
 * Deliberately NOT needed: TLS/JA3/JA4 fingerprint impersonation
 * (curl_cffi, impers, cycletls, ...). Plain `fetch` from the Convex runtime
 * is accepted by Cloudflare for these endpoints — tested with a bare UA and
 * with several UA shapes.
 */
import { unzlibSync } from "fflate";
import {
  FETCH_TIMEOUT_MS,
  HttpError,
  UA,
  assertSafeTarget,
  mediaPath,
  proxySecret,
} from "../proxy";

import type {
  Article,
  ArticleBlock,
  FeedItem,
  FeedPage,
  SiteCategoryGroup,
  SiteInfo,
  Source,
  VideoBlock,
  VideoInfo,
} from "./types";
export const ROU_ORIGIN = "https://rou.video";
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
/** Custom PNG chunk type 0x726f5564 = ASCII "roUd" (capital U). */
const ROUD_TYPE = 0x726f5564;
/** Page markup embeds the stream descriptor as: ev:{d:"<base64>",k:<int>} */
const EV_RE = /ev:(?:\$R\[\d+\]=)?\{d:"([A-Za-z0-9+/=]+)",k:(\d+)\}/;
/** Pull the payload out of a "roUd" PNG container. Returns input unchanged if not one. */
export function unwrapPng(data: Uint8Array): Uint8Array {
  if (data.length < 8) return data;
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PNG_SIG[i]) return data;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let i = 8;
  while (i + 8 <= data.length) {
    const length = view.getUint32(i);
    const type = view.getUint32(i + 4);
    const dataStart = i + 8;
    if (dataStart + length > data.length) break;
    if (type === ROUD_TYPE) {
      const flag = data[dataStart];
      const payload = data.subarray(dataStart + 1, dataStart + length);
      return flag & 1 ? unzlibSync(payload) : payload.slice();
    }
    i = dataStart + length + 4; // advance past data + CRC
  }
  return data;
}
/** Decode `ev:{d,k}`: base64, then subtract k from every byte, then parse the JSON. */
export function decryptEv(d: string, k: number): RouStreamInfo {
  const bin = atob(d);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) - k;
  return JSON.parse(new TextDecoder().decode(bytes)) as RouStreamInfo;
}
export type RouStreamInfo = {
  videoUrl?: string;
  thumbVTTUrl?: string;
};
/** Fetch a rou.video-side URL with the headers the origin insists on. */
export async function fetchRou(target: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(target, {
      headers: {
        "User-Agent": UA,
        Referer: `${ROU_ORIGIN}/`,
        Accept: "*/*",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}
export function isRouHost(host: string): boolean {
  return host === "rou.video" || host.endsWith(".rou.video");
}
/** Video CDNs rotate through hosts like v1.basp65.xyz / v3.gokj68.xyz. */
const CDN_HOST = /^v\d+\.[a-z0-9-]{2,}\.[a-z]{2,}$/i;
export function isCdnHost(host: string): boolean {
  return CDN_HOST.test(host);
}
/** Only rou.video pages may be resolved (the one endpoint that takes user input). */
export function assertResolvable(raw: string): URL {
  const url = assertSafeTarget(raw);
  if (!isRouHost(url.hostname)) throw new HttpError(400, "only rou.video page urls can be resolved");
  return url;
}
export function extractStreamInfo(html: string): RouStreamInfo {
  const m = html.match(EV_RE);
  if (!m) throw new HttpError(502, "ev payload not found in page");
  return decryptEv(m[1], Number(m[2]));
}
/* ------------------------------------------------------------------ *
 * Feed side — rou.video is a React SSR app; its list pages embed a
 * structured item array and its video pages embed an ld+json VideoObject.
 * Both are far more reliable than the visible HTML cards, so we parse the
 * embedded data directly.
 * ------------------------------------------------------------------ */

/** Unescape a JSON string fragment (the value part, quotes not included). */
function jsonStr(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}

/** Index of the `}` matching the `{` at `start` (string-aware). */
function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Format seconds as e.g. "1小時57分36秒" / "38分1秒" / "45秒". */
function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "";
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}小時${m}分${sec}秒`;
  if (m > 0) return `${m}分${sec}秒`;
  return `${sec}秒`;
}

/** Format a view count as e.g. "1.7萬次觀看" / "6,450次觀看". */
function formatViews(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 10000)
    return `${(n / 10000).toFixed(1).replace(/\.0$/, "")}萬次觀看`;
  return `${n.toLocaleString("en-US")}次觀看`;
}

/** Parse an ISO-8601 duration ("PT643S", "PT1H38M12S") into seconds. */
function parseIsoDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

type RawRouItem = {
  id: string;
  vid: string;
  name: string;
  tags: string[];
  createdAt: string;
  viewCount: number;
  duration: number;
  cover: string;
};

/**
 * Parse a list page's embedded item array. The array is written as
 * `videos:$R[n]=[$R[a]={id:"…",vid:…,…},$R[b]={…},…]` — top-level items are
 * `{id:"…",vid:…` (a `vid` key, possibly null), which distinguishes them from
 * the nested `sources` entries (`{id:"…",videoId:…`).
 */
function extractRouFeed(html: string): { items: RawRouItem[]; totalPage: number } {
  const totalPage = Number(html.match(/totalPage:(\d+)/)?.[1] ?? 0);
  const marker = html.indexOf("videos:$R[");
  if (marker < 0) return { items: [], totalPage };
  const arrOpen = html.indexOf("[", marker);
  const spanEnd = html.indexOf("],pageNum:", arrOpen);
  const span = html.slice(arrOpen, spanEnd < 0 ? html.length : spanEnd);
  const items: RawRouItem[] = [];
  for (const m of span.matchAll(/\{id:"[^"]*",vid:/g)) {
    const start = m.index ?? 0;
    const end = matchBrace(span, start);
    if (end < 0) continue;
    const raw = span.slice(start, end + 1);
    const id = raw.match(/^\{id:"([^"]*)"/)?.[1] ?? "";
    if (!id) continue;
    const tagsM = raw.match(/tags:(?:\$R\[\d+\]=)?\[([^\]]*)\]/);
    const tags = tagsM
      ? [...tagsM[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((t) => jsonStr(t[1]))
      : [];
    items.push({
      id,
      vid: raw.match(/,vid:"([^"]*)"/)?.[1] ?? "",
      name: jsonStr(raw.match(/,name:"((?:[^"\\]|\\.)*)"/)?.[1] ?? ""),
      tags,
      createdAt: raw.match(/createdAt:"([^"]*)"/)?.[1] ?? "",
      viewCount: Number(raw.match(/viewCount:(\d+)/)?.[1] ?? 0),
      duration: Number(raw.match(/duration:([\d.]+)/)?.[1] ?? 0),
      cover: raw.match(/coverImageUrl:"([^"]*)"/)?.[1] ?? "",
    });
  }
  return { items, totalPage };
}

/**
 * The /cat page's full category taxonomy, embedded as
 * `taxonomy:$R[n]={cats:$R[a]=[…],genre:$R[b]=[…],byParent:$R[c]={…}}`:
 *  - `cats`     main categories, in site order (ids = display names);
 *  - `genre`    the 題材 / 屬性 tag list;
 *  - `byParent` main-category name → its sublabels (片商 / 子標籤).
 * The 分類精選 grid is visible HTML: each main re-linked with `?order=<sort>`.
 */
type RouTaxonomy = {
  mains: { name: string; subs: string[] }[];
  genres: string[];
  featured: { name: string; order: string }[];
};

/** All `{id:"…"}` entries of an embedded array segment, unescaped. */
function embeddedIds(seg: string): string[] {
  return [...seg.matchAll(/\{id:"((?:[^"\\]|\\.)*)"/g)].map((m) => jsonStr(m[1]));
}

export function parseRouTaxonomy(html: string): RouTaxonomy {
  const at = html.indexOf("taxonomy:$R[");
  if (at < 0) return { mains: [], genres: [], featured: [] };
  const rest = html.slice(at);

  const catsM = rest.match(/cats:\$R\[\d+\]=\[/);
  const genreM = rest.match(/genre:\$R\[\d+\]=\[/);
  const byParentM = rest.match(/byParent:\$R\[\d+\]=\{/);

  // `index` is optional on the DOM lib type; the matched text is
  // authoritative, so locate it if `index` is missing.
  const posOf = (m: RegExpMatchArray): number =>
    m.index ?? rest.indexOf(m[0]);

  const catsAt = catsM ? posOf(catsM) : -1;
  const genreAt = genreM ? posOf(genreM) : -1;
  const byParentAt = byParentM ? posOf(byParentM) : -1;

  const mains: { name: string; subs: string[] }[] = [];
  let genres: string[] = [];
  if (catsM && genreM) {
    const mainsSeg = rest.slice(catsAt + catsM[0].length, genreAt);
    for (const name of embeddedIds(mainsSeg)) mains.push({ name, subs: [] });
    const genreEnd =
      byParentAt >= 0 ? byParentAt : rest.indexOf("]", genreAt);
    genres = embeddedIds(
      rest.slice(genreAt + genreM[0].length, genreEnd),
    );
  }
  if (byParentM) {
    // The byParent object is inline: `"主分类":$R[n]=[…],…` — brace-match it.
    const braceAt = byParentAt + byParentM[0].length - 1;
    const objEnd = matchBrace(rest, braceAt);
    const obj = objEnd > 0 ? rest.slice(braceAt, objEnd + 1) : "";
    // The array body is `$R[n]={id:"…",count:N},…` — the reference brackets
    // inside it (`$R[106]`) must not end the match, so skip `[digits]` runs.
    for (const pair of obj.matchAll(
      /"((?:[^"\\]|\\.)*)":\$R\[\d+\]=\[((?:[^[\]]|\[\d+\])*)\]/g,
    )) {
      const parent = jsonStr(pair[1]);
      const main = mains.find((m) => m.name === parent);
      if (main) main.subs = embeddedIds(pair[2]);
    }
  }

  // 分類精選 chips are the only `/t/…?order=…` links on the page.
  const featured: { name: string; order: string }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href="\/t\/([^"?]+)\?order=([A-Za-z]+)"/g)) {
    const key = m[1] + m[2];
    if (seen.has(key)) continue;
    seen.add(key);
    let name = m[1];
    try {
      name = decodeURIComponent(m[1]);
    } catch {
      // Keep the raw slug if it is not valid percent-encoding.
    }
    featured.push({ name, order: m[2] });
  }
  if (!featured.length && mains.length) {
    // Section missing — 精選 is the mains re-sorted by likes.
    for (const m of mains) featured.push({ name: m.name, order: "likeCount" });
  }

  return { mains, genres, featured };
}

/** The ld+json VideoObject embedded in a video page, if present. */
function parseVideoObject(html: string): Record<string, unknown> | null {
  for (const m of html.matchAll(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
  )) {
    try {
      const j = JSON.parse(m[1]) as Record<string, unknown>;
      if (j["@type"] === "VideoObject") return j;
    } catch {
      // Not valid JSON — skip this block.
    }
  }
  return null;
}

type RawRouRec = { id: string; title: string; cover: string; studio: string };

/** The "相關視頻" list on a video page (bounded by the next `<h2>`). */
function parseRouRelated(html: string): RawRouRec[] {
  const start = html.indexOf("相關視頻");
  if (start < 0) return [];
  const nextH2 = html.indexOf("<h2", start + 4);
  const seg = html.slice(start, nextH2 > start ? nextH2 : html.length);
  const recs: RawRouRec[] = [];
  for (const part of seg.split('<a href="/v/').slice(1)) {
    const id = part.match(/^([a-z0-9]+)"/)?.[1] ?? "";
    if (!id) continue;
    const title = part.match(/<h3[^>]*>([^<]+)</)?.[1] ?? "";
    // `<p …>studio · <!-- -->1,234<!-- -->次觀看</p>` — strip comments + tags.
    const p = part.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
    const ptext = p
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const studio = ptext.includes("·") ? ptext.split("·")[0].trim() : "";
    const cover = part.match(/<img src="([^"]+)"/)?.[1] ?? "";
    if (title) recs.push({ id, title, cover, studio });
  }
  return recs;
}

/** Sort values the site's list pages accept (see the /cat 分類精選 links). */
const ROU_ORDERS = new Set(["createdAt", "likeCount"]);

/**
 * Upstream URL for a normalized list path + page:
 *  /                       home feed
 *  /category/<slug>/       category feed
 *  /category/<order>/<slug>/  category feed sorted (e.g. 分類精選)
 *  /search/<query>/        search results (video tab, relevance order)
 * Slugs in the normalized path are already URL-encoded — pass through.
 */
function buildRouFeedPath(path: string, page: number): string {
  let p = path || "/";
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+$/, "");
  const q = new URLSearchParams({
    order: "createdAt",
    page: String(Math.max(1, page)),
  });
  if (p === "") return `${ROU_ORIGIN}/v?${q}`;
  const search = p.match(/^\/search\/(.+)$/);
  if (search) {
    let query = search[1];
    try {
      query = decodeURIComponent(query);
    } catch {
      // Keep the raw slug if it is not valid percent-encoding.
    }
    const sq = new URLSearchParams({ q: query, page: String(Math.max(1, page)) });
    return `${ROU_ORIGIN}/search?${sq}`;
  }
  const cat = p.match(/^\/category\/(.+)$/);
  if (!cat) throw new HttpError(400, "unsupported feed path (use / or /category/<slug>/)");
  const segs = cat[1].split("/").filter(Boolean);
  let order = "createdAt";
  let slug = "";
  if (segs.length === 1) slug = segs[0];
  else if (segs.length === 2 && ROU_ORDERS.has(segs[0])) {
    order = segs[0];
    slug = segs[1];
  } else {
    throw new HttpError(400, "unsupported feed path (use / or /category/<slug>/)");
  }
  if (!slug) throw new HttpError(400, "unsupported feed path (use / or /category/<slug>/)");
  q.set("order", order);
  return `${ROU_ORIGIN}/t/${slug}?${q}`;
}

/**
 * Map a raw list item onto the normalized FeedItem. Home / category feeds
 * and search results all embed the same item shape, so they share this.
 */
function toFeedItem(i: RawRouItem): FeedItem {
  const meta = [
    i.vid,
    formatDuration(i.duration),
    formatViews(i.viewCount),
  ].filter(Boolean);
  return {
    id: i.id,
    path: `/v/${i.id}/`,
    title: i.name,
    cover: i.cover || undefined,
    published: i.createdAt || undefined,
    // Tags are /t/<name>/ list pages — the normalized category path.
    tags: i.tags.length
      ? i.tags.map((name) => ({
          name,
          path: `/category/${encodeURIComponent(name)}/`,
        }))
      : undefined,
    meta: meta.length ? meta : undefined,
  };
}

/** The rou.video source adapter. */
export const rouSource: Source = {
  id: "rou",
  kind: "feed",
  matchUrl: (url) => isRouHost(new URL(url).hostname),
  async resolve(url, origin): Promise<VideoInfo> {
    const target = assertResolvable(url);
    const res = await fetchRou(target.toString());
    if (!res.ok) throw new HttpError(502, `upstream page returned ${res.status}`);
    const info = extractStreamInfo(await res.text());
    if (!info.videoUrl) throw new HttpError(502, "page had no videoUrl");
    const videoUrl = new URL(info.videoUrl, ROU_ORIGIN).toString();
    const secret = proxySecret();
    // Fail fast here if the CDN does not look like a video CDN, instead of
    // handing the player a URL that will 403 later.
    assertSafeTarget(videoUrl);
    return {
      videoUrl,
      playlistUrl: await mediaPath(secret, origin, videoUrl, "rou"),
      thumbVttUrl: info.thumbVTTUrl
        ? await mediaPath(
            secret,
            origin,
            new URL(info.thumbVTTUrl, ROU_ORIGIN).toString(),
            "rou",
          )
        : null,
    };
  },

  /* ---------------- feed side ---------------- */

  async siteInfo(): Promise<SiteInfo> {
    const groups: SiteCategoryGroup[] = [];
    try {
      const res = await fetchRou(`${ROU_ORIGIN}/cat`);
      if (res.ok) {
        const tax = parseRouTaxonomy(await res.text());
        if (tax.mains.length) {
          groups.push({
            id: "main",
            label: "主分類",
            categories: tax.mains.map((m) => ({
              path: `/category/${encodeURIComponent(m.name)}/`,
              name: m.name,
              children: m.subs.length
                ? m.subs.map((s) => ({
                    path: `/category/${encodeURIComponent(s)}/`,
                    name: s,
                  }))
                : undefined,
            })),
          });
        }
        if (tax.genres.length) {
          groups.push({
            id: "genre",
            label: "題材 / 屬性",
            categories: tax.genres.map((g) => ({
              path: `/category/${encodeURIComponent(g)}/`,
              name: g,
            })),
          });
        }
        if (tax.featured.length) {
          groups.push({
            id: "featured",
            label: "分類精選",
            categories: tax.featured.map((f) => ({
              path: `/category/${encodeURIComponent(f.order)}/${encodeURIComponent(f.name)}/`,
              name: `${f.name}精選`,
            })),
          });
        }
      }
    } catch {
      // No category nav; the home feed still works.
    }
    return { src: "rou", node: ROU_ORIGIN, nodeSource: "default", categories: groups };
  },

  async feed(path, page): Promise<FeedPage> {
    const res = await fetchRou(buildRouFeedPath(path, page));
    if (!res.ok) throw new HttpError(502, `upstream returned ${res.status}`);
    const { items, totalPage } = extractRouFeed(await res.text());
    return {
      src: "rou",
      path,
      page,
      totalPages: totalPage,
      items: items.map(toFeedItem),
    };
  },

  async article(path): Promise<Article> {
    const m = path.match(/^\/v\/([a-z0-9]+)\/?$/);
    if (!m) throw new HttpError(400, "not a rou video path");
    const id = m[1];
    const pageUrl = `${ROU_ORIGIN}/v/${id}`;
    const res = await fetchRou(pageUrl);
    if (!res.ok) throw new HttpError(502, `upstream returned ${res.status}`);
    const html = await res.text();
    const vo = parseVideoObject(html);
    const og = html.match(/property="og:title" content="([^"]*)"/);
    const title = (vo?.name as string) || og?.[1] || "";

    const genre = vo?.genre;
    const genres = Array.isArray(genre)
      ? (genre as unknown[]).filter((g): g is string => typeof g === "string")
      : typeof genre === "string" && genre
        ? [genre]
        : [];
    // The first genre is the breadcrumb category; the rest are tag pages.
    const categories = genres.length ? [genres[0]] : undefined;
    const tags = genres.length
      ? genres.map((g) => ({
          name: g,
          path: `/category/${encodeURIComponent(g)}/`,
        }))
      : undefined;
    const cover = Array.isArray(vo?.thumbnailUrl)
      ? ((vo!.thumbnailUrl as string[])[0] ?? undefined)
      : undefined;
    const views =
      (vo?.interactionStatistic as { userInteractionCount?: number } | undefined)
        ?.userInteractionCount;
    const durationSec = parseIsoDuration((vo?.duration as string) ?? "");
    const series = vo?.partOfSeries as { name?: string } | undefined;
    const episode = vo?.episodeNumber as string | number | undefined;

    // One meta line (views · duration · series · episode), only present parts.
    const metaLine = [
      formatViews(views ?? 0),
      formatDuration(durationSec),
      series?.name,
      episode != null && episode !== "" ? `第${episode}集` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");

    const video: VideoBlock = { type: "hls", url: pageUrl, pageUrl, id };
    const recs = parseRouRelated(html).map((r) => ({
      path: `/v/${r.id}/`,
      title: r.title,
      cover: r.cover || undefined,
      desc: r.studio || undefined,
    }));

    // The related videos render as `rec` blocks (the frontend paints `rec`
    // blocks as clickable cards); the flat `recommendations` list mirrors it.
    const blocks: ArticleBlock[] = [];
    if (metaLine) blocks.push({ type: "p", text: metaLine });
    blocks.push({ type: "video", video });
    for (const rec of recs) blocks.push({ type: "rec", rec });

    return {
      src: "rou",
      path: `/v/${id}/`,
      title,
      description: (vo?.description as string) || undefined,
      published: (vo?.uploadDate as string) || undefined,
      categories,
      tags,
      cover,
      video,
      blocks,
      recommendations: recs,
    };
  },

  matchArticle: (value) => {
    const m = value.match(/\/v\/([a-z0-9]+)(?:[/?#]|$)/);
    return m ? `/v/${m[1]}/` : null;
  },

  transformMedia: unwrapPng,
  mediaHosts: (host) => isRouHost(host) || isCdnHost(host),
  fetchTarget: fetchRou,
};
