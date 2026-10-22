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

import type { Source, VideoInfo } from "./types";
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
/** The rou.video source adapter. */
export const rouSource: Source = {
  id: "rou",
  kind: "video",
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
  transformMedia: unwrapPng,
  mediaHosts: (host) => isRouHost(host) || isCdnHost(host),
  fetchTarget: fetchRou,
};
