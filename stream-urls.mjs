// Shared stream URL helpers for the Zoko and AniZone gateways.
//
// Both providers reject a browser Origin header and require their own Referer. Every URL the player sees is
// same-origin; the gateway fetches upstream with the right referer and no Origin.

const ZOKO_REFERER = 'https://zokoanime.video/';
const ANIZONE_REFERER = 'https://anizone.to/';

export const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
export const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

export function mediaUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  if (h === 'hls.dramahot.top' || h.endsWith('.dramahot.top')) return u;
  if (/^hls\d*\.[a-z0-9-]+\.cfd$/.test(h)) return u;
  // AniZone's video CDN (seiryuu.vid-cdn.xyz and siblings).
  if (h.endsWith('.vid-cdn.xyz')) return u;
  return null;
}

export const refererFor = (raw) => {
  try {
    const h = new URL(raw).hostname.toLowerCase();
    if (h.endsWith('.vid-cdn.xyz')) return ANIZONE_REFERER;
    return ZOKO_REFERER;
  } catch {
    return ZOKO_REFERER;
  }
};

export function hlsProxy(raw) {
  const abs = mediaUrl(raw);
  return abs ? `/zoko/hls?u=${b64(abs.href)}` : raw;
}

export function assetProxy(raw) {
  const abs = mediaUrl(raw);
  return abs ? `/zoko/asset/${b64(abs.href)}.vtt` : raw;
}

export function segProxy(raw) {
  const abs = mediaUrl(raw);
  return abs ? `/zoko/seg/${b64(abs.href)}.jpg` : raw;
}

/** AniZone subtitle sidecars are ASS; this route converts them to WebVTT. */
export function subtitleProxy(raw) {
  const abs = mediaUrl(raw);
  return abs ? `/zoko/anizone-sub?u=${b64(abs.href)}` : raw;
}
