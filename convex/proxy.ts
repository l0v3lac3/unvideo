/**
 * Shared media-proxy plumbing used by every source adapter.
 *
 *  - SSRF guard (https-only, no private/link-local hosts)
 *  - HMAC-signed proxy URLs so this deployment cannot be used as an open
 *    proxy. The signed message is `"<src>\n<target>"` (legacy URLs signed
 *    the bare target and are still accepted on the legacy code path).
 *  - Absolute proxy URLs (the player runs on a different origin — GitHub
 *    Pages — than the API, so root-relative URLs would resolve against the
 *    page, not the backend).
 *  - Browser-UA fetch helper (upstreams 403 requests without a browser UA).
 *  - HLS playlist rewriting (route every URI back through /api/media).
 */


/** Browser-like UA. A UA is mandatory; the exact shape is not (tested). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const FETCH_TIMEOUT_MS = 20_000;

/** Generic upstream fetch with a browser UA, optional referer and timeout. */
export async function fetchWithUa(
  target: string,
  referer: string | undefined,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(target, {
      headers: {
        "User-Agent": UA,
        Referer: referer ?? "",
        Accept: "*/*",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

const PRIVATE_HOST =
  /^(localhost|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

/** Reject non-https and private/link-local targets (SSRF guard). */
export function assertSafeTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "invalid url");
  }
  if (url.protocol !== "https:") throw new HttpError(400, "only https targets allowed");
  if (PRIVATE_HOST.test(url.hostname)) throw new HttpError(400, "blocked private host");
  return url;
}

/* ------------------------------------------------------------------ *
 * Signing
 * ------------------------------------------------------------------ */

const SIG_BYTES = 16;

/**
 * HMAC-SHA256, truncated to 16 bytes, hex. `src` is part of the signed
 * message so a signed URL is bound to the source that minted it. Pass
 * `src = undefined` to reproduce the legacy scheme (bare target).
 */
export async function sign(secret: string, target: string, src?: string): Promise<string> {
  const message = src ? `${src}\n${target}` : target;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return [...mac.subarray(0, SIG_BYTES)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time compare for the 32-hex-char signature. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function b64urlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Absolute URL (on this deployment's own origin) that streams `target` back
 * through /api/media. `src` binds the URL to a source adapter (and is
 * included in the signature).
 */
export async function mediaPath(
  secret: string | undefined,
  origin: string,
  target: string,
  src?: string,
): Promise<string> {
  const encoded = b64urlEncode(target);
  const srcParam = src ? `src=${src}&` : "";
  const sig = secret ? `&s=${await sign(secret, target, src)}` : "";
  return `${origin.replace(/\/+$/, "")}/api/media?${srcParam}u=${encoded}${sig}`;
}

/** Same as mediaPath but for /api/img. */
export async function imgPath(
  secret: string | undefined,
  origin: string,
  target: string,
  src?: string,
): Promise<string> {
  const encoded = b64urlEncode(target);
  const srcParam = src ? `src=${src}&` : "";
  const sig = secret ? `&s=${await sign(secret, target, src)}` : "";
  return `${origin.replace(/\/+$/, "")}/api/img?${srcParam}u=${encoded}${sig}`;
}

/** Read the proxy secret. Absent secret => signature checks degrade to a host allowlist. */
export function proxySecret(): string | undefined {
  // Typed through globalThis so this does not depend on @types/node being
  // present; the Convex runtime exposes environment variables as process.env.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.PROXY_SECRET || undefined;
}

/* ------------------------------------------------------------------ *
 * HLS playlist rewriting
 * ------------------------------------------------------------------ */

const URI_ATTR = 'URI="([^"]+)"';

function resolveAgainst(uri: string, base: string): string {
  return new URL(uri, base).toString();
}

/**
 * Route every URI in a playlist through /api/media, preserving the
 * surrounding markup. Handles bare URI lines (segments, variant playlists)
 * and `URI="..."` attributes (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA,
 * EXT-X-I-FRAME-STREAM-INF, ...).
 */
export async function rewritePlaylist(
  text: string,
  baseUrl: string,
  secret: string | undefined,
  origin: string,
  src?: string,
): Promise<string> {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      out.push(line);
      continue;
    }
    if (!trimmed.startsWith("#")) {
      out.push(await mediaPath(secret, origin, resolveAgainst(trimmed, baseUrl), src));
      continue;
    }
    const matches = [...trimmed.matchAll(new RegExp(URI_ATTR, "g"))];
    if (matches.length === 0) {
      out.push(line);
      continue;
    }
    let rebuilt = "";
    let last = 0;
    for (const m of matches) {
      const index = m.index ?? 0;
      rebuilt +=
        trimmed.slice(last, index) +
        `URI="${await mediaPath(secret, origin, resolveAgainst(m[1], baseUrl), src)}"`;
      last = index + m[0].length;
    }
    out.push(rebuilt + trimmed.slice(last));
  }
  return out.join("\n");
}

/** Sniff a sensible Content-Type for an unwrapped payload. */
export function contentTypeFor(data: Uint8Array): string {
  const head = new TextDecoder().decode(data.subarray(0, 16));
  if (head.startsWith("#EXTM3U")) return "application/vnd.apple.mpegurl";
  if (head.startsWith("WEBVTT")) return "text/vtt";
  if (data[0] === 0x47 && data.length > 188 && data[188] === 0x47) return "video/mp2t";
  if (
    data.length > 8 &&
    data[4] === 0x66 &&
    data[5] === 0x74 &&
    data[6] === 0x79 &&
    data[7] === 0x70
  ) {
    return "video/mp4";
  }
  return "application/octet-stream";
}

/** Sniff an image Content-Type from magic bytes (fallback: octet-stream). */
export function imageContentType(data: Uint8Array): string {
  if (
    data.length > 2 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    data.length > 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    data.length > 3 &&
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46
  ) {
    return "image/gif";
  }
  if (
    data.length > 5 &&
    data[0] === 0x52 &&
    data[1] === 0x57 &&
    data[2] === 0x56 &&
    data[3] === 0x55
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}
