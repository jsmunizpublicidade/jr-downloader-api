import type { MediaItem, ResolveResult } from "./types.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function decodeJsonUrl(s: string): string {
  return s
    .replace(/\\u0025/gi, "%")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u003f/gi, "?")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .trim();
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const cp = parseInt(h, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
    })
    .replace(/&#(\d+);/g, (_, n) => {
      const cp = parseInt(n, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
    });
}

interface ImgCandidate {
  url: string;
  w?: number;
  h?: number;
  score: number;
}

function sizeHint(u: string): { w?: number; h?: number } {
  // ctp=s1080x1350, p1080x1350, s40x40 etc
  const ctp = u.match(/[?&]ctp=[sp](\d+)x(\d+)/i);
  if (ctp) return { w: Number(ctp[1]), h: Number(ctp[2]) };
  const stp = u.match(/[?&]stp=[^&]*?(?:p|s)(\d+)x(\d+)/i);
  if (stp) return { w: Number(stp[1]), h: Number(stp[2]) };
  const wh = u.match(/[?&](?:width|w)=(\d+).*[?&](?:height|h)=(\d+)/i) || u.match(/[?&](?:height|h)=(\d+).*[?&](?:width|w)=(\d+)/i);
  if (wh) {
    const a = Number(wh[1]), b = Number(wh[2]);
    // ambiguous order in second form, but rare; prefer larger as w-ish
    return u.includes("height=") && u.indexOf("height=") < u.indexOf("width=") ? { w: b, h: a } : { w: a, h: b };
  }
  const p = u.match(/[_-]p(\d+)x(\d+)[_.]/i) || u.match(/[_-]s(\d+)x(\d+)[_.]/i);
  if (p) return { w: Number(p[1]), h: Number(p[2]) };
  return {};
}

function scoreUrl(u: string, w?: number, h?: number): number {
  let score = 0;
  const hint = sizeHint(u);
  const W = w ?? hint.w;
  const H = h ?? hint.h;
  if (W && H) {
    const area = W * H;
    score += Math.min(120, Math.round(area / 5000));
    if (W < 120 || H < 120) score -= 120; // tiny thumb/avatar
    else if (W < 250 || H < 250) score -= 60;
  }
  if (/_n\./i.test(u)) score += 4;
  if (/\/t39\./i.test(u)) score += 3;
  if (/\.png(\?|$)/i.test(u)) score += 1;
  if (/\.jpg(\?|$)/i.test(u)) score += 1;
  if (/emoji|sticker|sprite|rsrc\.php|safe_image\.php|static\.xx\.fbcdn/i.test(u)) score -= 120;
  // profile pic common patterns
  if (/[?&]ctp=s\d{1,3}x\d{1,3}(&|$)/i.test(u)) {
    const m = u.match(/[?&]ctp=s(\d+)x(\d+)/i);
    if (m && (Number(m[1]) <= 120 || Number(m[2]) <= 120)) score -= 80;
  }
  return score;
}

function isImageUrl(u: string): boolean {
  return /^https?:\/\//i.test(u)
    && /(?:fbcdn\.net|fbsbx\.com)/i.test(u)
    && /\.(?:jpg|jpeg|png|webp)(?:\?|$)/i.test(u)
    && !/safe_image\.php|emoji|sticker|sprite|static\.xx\.fbcdn|rsrc\.php/i.test(u);
}

function addCandidate(map: Map<string, ImgCandidate>, rawUrl: string, w?: number, h?: number) {
  const url = decodeJsonUrl(rawUrl).replace(/&amp;/g, "&");
  if (!isImageUrl(url)) return;
  const hint = sizeHint(url);
  const W = w ?? hint.w;
  const H = h ?? hint.h;
  const score = scoreUrl(url, W, H);
  const prev = map.get(url);
  if (!prev || score > prev.score || ((W ?? 0) * (H ?? 0)) > ((prev.w ?? 0) * (prev.h ?? 0))) {
    map.set(url, { url, w: W, h: H, score });
  }
}

function extractStructuredImages(html: string, map: Map<string, ImgCandidate>) {
  // "image":{"uri":"...","width":W,"height":H} and similar keyed objects
  const objRe = /"(?:image|photo_image|viewer_image|max_image|image_uri_field|currMedia|preferred_image)"\s*:\s*\{[^{}]{0,500}?"(?:uri|url|src)"\s*:\s*"(https:[^"]+)"[^{}]{0,500}?\}/g;
  for (const m of html.matchAll(objRe)) {
    const block = m[0];
    const url = m[1];
    const w = block.match(/"width"\s*:\s*(\d+)/)?.[1];
    const h = block.match(/"height"\s*:\s*(\d+)/)?.[1];
    // skip blurred/sprite placeholders
    if (/"blurred_image"|prefetch_uris/i.test(block)) continue;
    addCandidate(map, url, w ? Number(w) : undefined, h ? Number(h) : undefined);
  }

  // arrays of image candidates with dimensions
  const arrRe = /\{[^{]{0,120}?"(?:uri|url)"\s*:\s*"(https:\\\/\\\/[^"]+fbcdn[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"[^{]{0,120}?"width"\s*:\s*(\d+)[^{]{0,80}?"height"\s*:\s*(\d+)/g;
  for (const m of html.matchAll(arrRe)) {
    addCandidate(map, m[1], Number(m[2]), Number(m[3]));
  }
}

function extractImageUrls(html: string): string[] {
  const map = new Map<string, ImgCandidate>();

  // 1) Structured image objects with dimensions (best signal)
  extractStructuredImages(html, map);

  // 2) Known image URL fields
  const jsonUrlRe = /"(?:image_uri|display_url|photo_image|viewer_image|preview_url|prefetch_uris_v2|src|url)"\s*:\s*"(https:\\\/\\\/[^"]+)"/g;
  for (const m of html.matchAll(jsonUrlRe)) {
    const u = decodeJsonUrl(m[1]);
    if (isImageUrl(u)) addCandidate(map, u);
  }

  // 3) og:image meta
  const ogRe = /<meta[^>]+(?:property|name)=["']og:image(?::url|:secure_url)?["'][^>]*>/gi;
  for (const m of html.matchAll(ogRe)) {
    const c = m[0].match(/\bcontent=["']([^"']+)["']/i)?.[1];
    if (c) addCandidate(map, c);
  }

  // 4) Raw scontent/fbcdn image URLs
  const rawRe = /https?:\/\/[^\s"'<>\\]+(?:fbcdn\.net|scontent[^\s"'<>\\]*fbcdn)[^\s"'<>\\]*\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>\\]*)?/gi;
  for (const m of html.matchAll(rawRe)) {
    addCandidate(map, m[0]);
  }

  const all = [...map.values()];
  all.sort((a, b) => {
    const da = b.score - a.score;
    if (da !== 0) return da;
    return (b.w ?? 0) * (b.h ?? 0) - (a.w ?? 0) * (a.h ?? 0);
  });
  return all.map((c) => c.url);
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!m?.[1]) return undefined;
  const t = decodeHtmlEntities(decodeJsonUrl(m[1])).replace(/\s+/g, " ").trim();
  if (!t || /^facebook$/i.test(t)) return undefined;
  return t;
}

function extractDescription(html: string): string | undefined {
  const m = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  if (!m?.[1]) return undefined;
  const t = decodeHtmlEntities(decodeJsonUrl(m[1])).replace(/\s+/g, " ").trim();
  return t || undefined;
}

export interface FacebookSourceMedia {
  hd?: string;
  sd?: string;
  audio?: string;
  images: string[];
  title?: string;
}

function pushVideoUrl(map: { hd?: string; sd?: string; audio?: string }, key: "hd" | "sd" | "audio", raw: string | undefined) {
  if (!raw) return;
  const u = decodeJsonUrl(raw).replace(/&amp;/g, "&");
  if (!/^https?:\/\//i.test(u)) return;
  // prefer longer/param-rich URLs as they often have auth tokens
  if (!map[key] || u.length >= (map[key]?.length ?? 0)) map[key] = u;
}

export function extractFromFacebookSource(html: string): FacebookSourceMedia {
  const videos: { hd?: string; sd?: string; audio?: string } = {};

  const patterns: Array<[RegExp, "hd" | "sd" | "audio"]> = [
    [/"playable_url_quality_hd"\s*:\s*"([^"]+)"/g, "hd"],
    [/"browser_native_hd_url"\s*:\s*"([^"]+)"/g, "hd"],
    [/"hd_src(?:_no_ratelimit)?"\s*:\s*"([^"]+)"/g, "hd"],
    [/"hd_src"\s*:\s*"([^"]+)"/g, "hd"],
    [/"playable_url"\s*:\s*"([^"]+)"/g, "sd"],
    [/"browser_native_sd_url"\s*:\s*"([^"]+)"/g, "sd"],
    [/"sd_src(?:_no_ratelimit)?"\s*:\s*"([^"]+)"/g, "sd"],
    [/"sd_src"\s*:\s*"([^"]+)"/g, "sd"],
    [/"audio_url"\s*:\s*"([^"]+)"/g, "audio"],
  ];
  for (const [re, key] of patterns) {
    for (const m of html.matchAll(re)) pushVideoUrl(videos, key, m[1]);
  }

  // Sometimes video URLs appear as unescaped in some contexts
  const unescapedHd = html.match(/hd_src\s*[:=]\s*"(https:[^"]+)"/i)?.[1];
  const unescapedSd = html.match(/sd_src\s*[:=]\s*"(https:[^"]+)"/i)?.[1];
  if (!videos.hd && unescapedHd) pushVideoUrl(videos, "hd", unescapedHd);
  if (!videos.sd && unescapedSd) pushVideoUrl(videos, "sd", unescapedSd);

  // If we got playable_url as sd but there might be a better one, try to detect quality hints
  if (!videos.hd && videos.sd && /[?&](?:height|h)=([0-9]{3,4})/i.test(videos.sd)) {
    // keep as sd; can't upgrade
  }

  const images = extractImageUrls(html);
  const title = extractTitle(html) || extractDescription(html);

  return { ...videos, images, title };
}

export function resolveFacebookFromSource(sourceHtml: string, pageUrl: string): ResolveResult | null {
  const media = extractFromFacebookSource(sourceHtml);
  const title = media.title || "Mídia do Facebook";
  const caption = extractDescription(sourceHtml) || media.title || undefined;

  // Prefer videos if present (private video flow)
  if (media.hd || media.sd) {
    const items: MediaItem[] = [];
    if (media.hd) items.push({ id: items.length, kind: "video", ext: "mp4", url: media.hd });
    if (media.sd && media.sd !== media.hd) items.push({ id: items.length, kind: "video", ext: "mp4", url: media.sd });
    const thumb = media.images[0];
    // annotate quality via id ordering? we'll label in API layer
    return {
      source: pageUrl,
      title,
      caption,
      thumb,
      resolver: "http",
      items,
    };
  }

  // Fallback: images from source
  if (media.images.length > 0) {
    const primary = media.images[0];
    const item: MediaItem = { id: 0, kind: "image", ext: extFromUrl(primary), url: primary };
    return {
      source: pageUrl,
      title: title || "Foto do Facebook",
      caption,
      thumb: primary,
      resolver: "http",
      items: [item],
    };
  }

  return null;
}

async function fetchHtml(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "cache-control": "no-cache",
        pragma: "no-cache",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "upgrade-insecure-requests": "1",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function pickPrimaryImage(urls: string[]): string | undefined {
  if (urls.length === 0) return undefined;
  return urls[0];
}

function extFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname.toLowerCase();
    const m = p.match(/\.([a-z0-9]{2,5})(?:$|\?)/);
    if (m) {
      const e = m[1] === "jpeg" ? "jpg" : m[1];
      if (["jpg", "png", "webp", "gif"].includes(e)) return e;
    }
  } catch {
    /* ignore */
  }
  return "jpg";
}

/**
 * Resolve uma publicação do Facebook sem login.
 * Posts (/posts/, /share/p/, /permalink/) podem conter vídeo: nesse caso o
 * vídeo vem primeiro. Links de foto continuam priorizando a imagem.
 */
export async function resolveFacebookMedia(
  url: string,
  preferVideo = false,
): Promise<ResolveResult | null> {
  try {
    const html = await fetchHtml(url);

    if (preferVideo) {
      const fromSource = resolveFacebookFromSource(html, url);
      if (fromSource && fromSource.items.length > 0) return fromSource;
    }

    const images = extractImageUrls(html);
    const image = pickPrimaryImage(images);
    if (!image) return null;

    const title = extractTitle(html) || "Foto do Facebook";
    const caption = extractDescription(html) || title;
    const item: MediaItem = {
      id: 0,
      kind: "image",
      ext: extFromUrl(image),
      url: image,
    };

    return {
      source: url,
      title,
      caption,
      thumb: image,
      resolver: "http",
      items: [item],
    };
  } catch {
    return null;
  }
}

/** Mantém o nome antigo para compatibilidade com outros chamadores. */
export async function resolveFacebookPhoto(url: string): Promise<ResolveResult | null> {
  return resolveFacebookMedia(url, false);
}
