// Convex HTTP API for unvideo — a thin dispatcher over source adapters
// (see `sources/`). Endpoints:
//
//   GET /api/health    – liveness probe
//   GET /api/selftest  – runtime capability report (no secrets echoed)
//   GET /api/site      – ?src=<id> -> feed source site info (node + category nav)
//   GET /api/video     – ?src=<id>&url=<page> -> stream info + signed playlist
//   GET /api/feed      – ?src=<id>&path=&page=&node= -> list of feed items
//   GET /api/article   – ?src=<id>&path= -> normalized article (signed media)
//   GET /api/media     – ?src=<id>&u=<b64url>&s=<hmac> -> transformed media bytes
//   GET /api/img       – ?src=<id>&u=<b64url>&s=<hmac> -> transformed image bytes
//
// Legacy endpoints (pre-`src` frontends): /api/resolve?url= (rou), /api/node
// (cg51 legacy shape), /api/feed & /api/article without src (cg51),
// /api/media & /api/img without src (rou / cg51, legacy signature scheme).
//
// Docs: https://docs.convex.dev/functions/http-actions
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import {
  HttpError,
  b64urlDecode,
  b64urlEncode,
  contentTypeFor,
  fetchWithUa,
  imageContentType,
  imgPath,
  proxySecret,
  rewritePlaylist,
  sign,
  timingSafeEqual,
  assertSafeTarget,
} from "./proxy";
import { unzlibSync, zlibSync } from "fflate";
import { getSource, legacyNodeInfo } from "./sources";
import { isFeedSource, isVideoSource } from "./sources/types";
import { unwrapPng } from "./sources/rou";
import type { Article, FeedPage, Source } from "./sources/types";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function fail(error: unknown) {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  return json({ error: String(error instanceof Error ? error.message : error) }, 502);
}

/** Sign a URL through the source's image proxy (no-op for non-CDN URLs). */
async function signImgUrl(
  secret: string | undefined,
  origin: string,
  url: string | undefined,
  source: Source,
): Promise<string | undefined> {
  if (!url) return url;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  if (!source.imageHosts?.(host)) return url;
  return imgPath(secret, origin, url, source.id);
}

/** Route every cover in a feed through the image proxy. */
async function signFeed(
  feed: FeedPage,
  source: Source,
  origin: string,
): Promise<FeedPage> {
  const secret = proxySecret();
  const items = [];
  for (const item of feed.items) {
    items.push({ ...item, cover: await signImgUrl(secret, origin, item.cover, source) });
  }
  return { ...feed, items };
}

/** Route every image in an article (cover, gallery, body, rec covers). */
async function signArticleImages(
  article: Article,
  source: Source,
  origin: string,
): Promise<Article> {
  const secret = proxySecret();
  const signOne = (u?: string) => signImgUrl(secret, origin, u, source);
  const blocks = [];
  for (const b of article.blocks) {
    if (b.type === "img") blocks.push({ ...b, url: (await signOne(b.url)) ?? b.url });
    else if (b.type === "rec")
      blocks.push({ ...b, rec: { ...b.rec, cover: await signOne(b.rec.cover) } });
    else blocks.push(b);
  }
  const recommendations = [];
  for (const r of article.recommendations) {
    recommendations.push({ ...r, cover: await signOne(r.cover) });
  }
  return {
    ...article,
    cover: await signOne(article.cover),
    images: article.images
      ? (await Promise.all(article.images.map((u) => signOne(u)))).filter(
          (u): u is string => !!u,
        )
      : undefined,
    blocks,
    recommendations,
  };
}

const http = httpRouter();

http.route({
  path: "/api/health",
  method: "GET",
  handler: httpAction(async () => json({ ok: true, service: "unvideo" })),
});

// Reports which primitives this runtime really offers, so a deploy problem is
// diagnosable without guessing. Never returns the secret itself.
http.route({
  path: "/api/selftest",
  method: "GET",
  handler: httpAction(async (_ctx: ActionCtx, req: Request) => {
    const checks: Record<string, unknown> = { requestUrl: req.url };
    try {
      const original = new TextEncoder().encode("#EXTM3U\nselftest\n".repeat(20));
      const restored = unzlibSync(zlibSync(original));
      checks.fflateZlibRoundTrip =
        restored.length === original.length &&
        new TextDecoder().decode(restored).startsWith("#EXTM3U");
    } catch (e) {
      checks.fflateZlibRoundTrip = `failed: ${String(e)}`;
    }
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("selftest"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("x"));
      checks.hmac = new Uint8Array(mac).length === 32;
      checks.digest =
        (await crypto.subtle.digest("SHA-256", new TextEncoder().encode("x"))).byteLength === 32;
    } catch (e) {
      checks.hmac = `failed: ${String(e)}`;
    }
    checks.secretConfigured = proxySecret() !== undefined;
    checks.base64 =
      b64urlDecode(b64urlEncode("#EXTM3U")) === "#EXTM3U";
    checks.pngUnwrapOnNonPng =
      unwrapPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).length === 8;
    return json(checks);
  }),
});

// ------------------------------------------------------------------
// Source-dispatched endpoints
// ------------------------------------------------------------------

// Site info for a feed source (content node + category nav).
http.route({
  path: "/api/site",
  method: "GET",
  handler: httpAction(async (_ctx: ActionCtx, req: Request) => {
    try {
      const src = new URL(req.url).searchParams.get("src");
      const source = getSource(src, "cg51");
      if (!isFeedSource(source)) throw new HttpError(400, "not a feed source");
      return json(await source.siteInfo());
    } catch (error) {
      return fail(error);
    }
  }),
});

// Resolve a page URL into a playable, signed stream (video sources).
async function handleVideo(req: Request): Promise<Response> {
  try {
    const params = new URL(req.url).searchParams;
    const pageUrl = params.get("url");
    if (!pageUrl) throw new HttpError(400, "missing url parameter");
    const source = getSource(params.get("src"), "rou");
    if (!isVideoSource(source)) throw new HttpError(400, "not a video source");
    const origin = new URL(req.url).origin;
    return json(await source.resolve(pageUrl, origin));
  } catch (error) {
    return fail(error);
  }
}

http.route({
  path: "/api/video",
  method: "GET",
  handler: httpAction((_ctx: ActionCtx, req: Request) => handleVideo(req)),
});

// Legacy alias (pre-`src` frontends).
http.route({
  path: "/api/resolve",
  method: "GET",
  handler: httpAction((_ctx: ActionCtx, req: Request) => handleVideo(req)),
});

// List feed items for a list path (home or category).
http.route({
  path: "/api/feed",
  method: "GET",
  handler: httpAction(async (_ctx: ActionCtx, req: Request) => {
    try {
      const params = new URL(req.url).searchParams;
      const source = getSource(params.get("src"), "cg51");
      if (!isFeedSource(source)) throw new HttpError(400, "not a feed source");
      const path = params.get("path") || "/";
      const page = Number(params.get("page") || "1");
      const nodeOverride = params.get("node") || undefined;
      const feed = await source.feed(path, page, nodeOverride);
      return json(await signFeed(feed, source, new URL(req.url).origin));
    } catch (error) {
      return fail(error);
    }
  }),
});

// Resolve an article page into the normalized article model.
http.route({
  path: "/api/article",
  method: "GET",
  handler: httpAction(async (_ctx: ActionCtx, req: Request) => {
    try {
      const params = new URL(req.url).searchParams;
      const source = getSource(params.get("src"), "cg51");
      if (!isFeedSource(source)) throw new HttpError(400, "not a feed source");
      const rawPath = params.get("path") || "";
      const path = source.matchArticle?.(rawPath) ?? rawPath;
      if (!path) throw new HttpError(400, "not an article path");
      const nodeOverride = params.get("node") || undefined;
      const article = await source.article(path, nodeOverride);
      return json(await signArticleImages(article, source, new URL(req.url).origin));
    } catch (error) {
      return fail(error);
  }
  }),
});

// Stream media (transformed + optionally playlist-rewritten) to the player.
http.route({
  path: "/api/media",
  method: "GET",
  handler: httpAction(async (_ctx: ActionCtx, req: Request) => {
    try {
      const params = new URL(req.url).searchParams;
      const encoded = params.get("u");
      if (!encoded) throw new HttpError(400, "missing u parameter");
      const srcParam = params.get("src");
      const source = getSource(srcParam, "rou");
      const legacy = !srcParam;
      const target = b64urlDecode(encoded);
      assertSafeTarget(target);

      const secret = proxySecret();
      if (secret) {
        const provided = params.get("s") ?? "";
        const expected = await sign(secret, target, legacy ? undefined : source.id);
        if (!timingSafeEqual(provided, expected)) {
          throw new HttpError(403, "bad signature");
        }
      } else {
        // No secret configured: fall back to the source's host allowlist so
        // this cannot be used as an open proxy.
        const host = new URL(target).hostname;
        if (!source.mediaHosts?.(host)) {
          throw new HttpError(403, "host not allowed (set PROXY_SECRET for signed urls)");
        }
      }

      const fetcher = source.fetchTarget ?? ((t: string) => fetchWithUa(t, undefined));
      const res = await fetcher(target);
      if (!res.ok) throw new HttpError(502, `upstream returned ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const payload = source.transformMedia ? source.transformMedia(bytes) : bytes;
      const contentType = contentTypeFor(payload);

      if (contentType === "application/vnd.apple.mpegurl") {
        const origin = new URL(req.url).origin;
        const text = await rewritePlaylist(
          new TextDecoder().decode(payload),
          target,
          secret,
          origin,
          srcParam ?? undefined,
        );
        return new Response(text, {
          status: 200,
          headers: {
            ...CORS,
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-store",
          },
        });
      }

      return new Response(payload.slice().buffer, {
        status: 200,
        headers: {
          ...CORS,
          "Content-Type": contentType,
          // Segments are immutable; letting the browser keep them avoids
          // re-pulling the same bytes through the deployment.
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    } catch (error) {
      return fail(error);
    }
  }),
});

// Stream a transformed image (e.g. decrypted) to the browser.
http.route({
  path: "/api/img",
  method: "GET",
  handler: httpAction(async (_ctx: ActionCtx, req: Request) => {
    try {
      const params = new URL(req.url).searchParams;
      const encoded = params.get("u");
      if (!encoded) throw new HttpError(400, "missing u parameter");
      const srcParam = params.get("src");
      const source = getSource(srcParam, "cg51");
      const legacy = !srcParam;
      const target = b64urlDecode(encoded);
      const url = assertSafeTarget(target);
      if (!source.imageHosts?.(url.hostname)) {
        throw new HttpError(403, "host not in this source's image allowlist");
      }
      const secret = proxySecret();
      if (secret) {
        const provided = params.get("s") ?? "";
        const expected = await sign(secret, target, legacy ? undefined : source.id);
        if (!timingSafeEqual(provided, expected)) {
          throw new HttpError(403, "bad signature");
        }
      }

      const fetcher = source.fetchTarget ?? ((t: string) => fetchWithUa(t, undefined));
      const res = await fetcher(target);
      if (!res.ok) throw new HttpError(502, `upstream returned ${res.status}`);
      const raw = new Uint8Array(await res.arrayBuffer());
      const payload = source.transformImage ? await source.transformImage(raw) : raw;
      return new Response(payload.slice().buffer, {
        status: 200,
        headers: {
          ...CORS,
          "Content-Type": imageContentType(payload),
          // Images are immutable; let the browser cache them aggressively.
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    } catch (error) {
      return fail(error);
    }
  }),
});

// Legacy node discovery (pre-`src` frontends expect the old shape).
http.route({
  path: "/api/node",
  method: "GET",
  handler: httpAction(async () => {
    try {
      return json(await legacyNodeInfo());
    } catch (error) {
      return fail(error);
    }
  }),
});

// CORS preflight for the /api/* surface.
http.route({
  pathPrefix: "/api/",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: CORS })),
});

export default http;
