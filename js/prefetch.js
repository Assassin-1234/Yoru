// Stream warm-up. Pulls the playlists and the first segments a playback will need into the HTTP cache ahead of
// time — at the viewer's resume position and at the rendition the player's ABR will choose — so pressing Play
// (or auto-advancing to the next episode) starts from cache instead of the network.

const BWKEY = 'yoru:bw:v1';

/** Bandwidth (bits/s) the player should assume at start: last session's measurement, else the browser's hint. */
export function startEstimate() {
  try {
    const { bw, t } = JSON.parse(localStorage.getItem(BWKEY)) || {};
    if (bw && Date.now() - t < 7 * 864e5) return Math.max(1e6, bw * 0.85);
  } catch {}
  // Nothing measured yet: use the browser's hint. Chrome caps `downlink` at 10 Mbps, so a "4g" connection reporting
  // the cap is treated as at least that; unknown → a 4G-class default rather than the bottom rung.
  const c = navigator.connection;
  const hint = c?.downlink;
  if (hint) return Math.max(1e6, (c.effectiveType === '4g' ? Math.max(hint, 10) : hint) * 1e6 * 0.8);
  return 8e6;
}

export async function ensureBandwidth() {
  try {
    const { t } = JSON.parse(localStorage.getItem(BWKEY)) || {};
    if (t && Date.now() - t < 6 * 3600e3) return;
  } catch {}
  return probeBandwidth('/zoko/probe');
}

export function rememberBandwidth(bw) {
  if (!bw || !isFinite(bw)) return;
  try {
    localStorage.setItem(BWKEY, JSON.stringify({ bw, t: Date.now() }));
  } catch {}
}

/**
 * First-visit bandwidth probe: fetch one mid-ladder segment once the page is idle and record the real throughput,
 * so a new viewer's very first Play starts at the right rendition. Skipped if we measured recently or on Save-Data.
 */
export async function probeBandwidth(url) {
  try {
    const { t } = JSON.parse(localStorage.getItem(BWKEY)) || {};
    if (t && Date.now() - t < 6 * 3600e3) return;
  } catch {}
  if (!url || navigator.connection?.saveData) return;
  try {
    const t0 = performance.now();
    const r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    const bytes = (await r.arrayBuffer()).byteLength;
    const secs = (performance.now() - t0) / 1000;
    const e = performance.getEntriesByName(String(new URL(url, location.href))).at(-1);
    // Prefer Resource Timing's download window (excludes queueing); fall back to wall time.
    const dl = e && e.responseEnd > e.requestStart ? (e.responseEnd - e.requestStart) / 1000 : secs;
    if (bytes > 200_000) rememberBandwidth((bytes * 8) / dl);
  } catch {}
}

/* ---------- Codec choice (decided once per device, shared by the player and every prefetch) ---------- */

// 10-bit HEVC where Media Capabilities says this device decodes it smoothly *and* power-efficiently (hardware);
// otherwise H.264. Main10 at 1080p60 is the bar, since that's what we'd stream to most screens.
let hevcOk = null;
export const codecReady = (async () => {
  try {
    if (!navigator.mediaCapabilities?.decodingInfo) return (hevcOk = false);
    const r = await navigator.mediaCapabilities.decodingInfo({
      type: 'media-source',
      video: { contentType: 'video/mp4; codecs="hvc1.2.4.L123.90"', width: 1920, height: 1080, framerate: 60, bitrate: 6e6 },
    });
    return (hevcOk = !!(r.supported && r.smooth && r.powerEfficient));
  } catch {
    return (hevcOk = false);
  }
})();

/** The playlist this device should play for a source: its HEVC ladder when hardware-decodable, else H.264. */
export const playbackUrl = (src) => (src?.hevc && hevcOk ? src.hevc : src?.src);

const done = new Map(); // `${url}@${segmentIndex}` → promise
const warm = new Map(); // master src → [{ from, to, bitrate, ready }]

/** If a prefetch already cached the segment at `position`, the bitrate of the rendition it cached. */
export function warmedBitrate(src, position = 0) {
  return (warm.get(src) || []).find((w) => w.ready && position >= w.from && position < w.to)?.bitrate || null;
}

/**
 * Fast start: the richest rendition whose first segment can arrive in under a couple of seconds at the bandwidth we
 * actually measured. ABR climbs from there within a segment or two, so playback never waits on a 1080p segment.
 */
export function fastStartIndex(bitrates, segSeconds = 6) {
  const bw = startEstimate();
  let best = -1;
  bitrates.forEach((b, i) => {
    if ((b * segSeconds) / bw <= 2.0 && (best < 0 || b > bitrates[best])) best = i;
  });
  return best >= 0 ? best : bitrates.indexOf(Math.min(...bitrates));
}

// Real throughput from our own uncached downloads (the player's estimate is inflated by cache hits).
function measure(url) {
  const e = performance.getEntriesByName(String(url)).at(-1);
  if (!e || e.transferSize < 300_000 || !e.duration) return;
  const bps = (e.transferSize * 8) / (e.duration / 1000);
  let prev = null;
  try {
    prev = JSON.parse(localStorage.getItem(BWKEY))?.bw;
  } catch {}
  rememberBandwidth(prev ? 0.5 * prev + 0.5 * bps : bps);
}
const get = (u) => fetch(u, { credentials: 'omit' });
const lines = (text) => text.split('\n').map((l) => l.trim());

/**
 * Warm a stream so playback can start at `position` seconds.
 * @param {string} src master (or media) playlist URL
 * @param {{position?: number, segments?: number}} o
 */
export function prefetchStream(src, { position = 0, segments = 2 } = {}) {
  if (!src || !(/\.m3u8(\?|$)/.test(src) || src.startsWith('/zoko/hls?')) || navigator.connection?.saveData) return Promise.resolve();
  return run(src, position, segments).catch(() => {});
}

async function run(src, position, count) {
  const base = new URL(src, location.href);
  const master = await (await get(base)).text();
  let mediaUrl = base;
  let audioUrl = null;
  if (master.includes('#EXT-X-STREAM-INF')) {
    const L = lines(master);
    const variants = [];
    L.forEach((l, i) => {
      if (!l.startsWith('#EXT-X-STREAM-INF')) return;
      const bw = Number(/[:,]BANDWIDTH=(\d+)/.exec(l)?.[1] || 0);
      const res = /RESOLUTION=(\d+)x(\d+)/.exec(l);
      const audio = /AUDIO="([^"]+)"/.exec(l)?.[1];
      const uri = L.slice(i + 1).find((x) => x && !x.startsWith('#'));
      if (uri) variants.push({ bw, uri, audio, w: res ? Number(res[1]) : 0, h: res ? Number(res[2]) : 0 });
    });
    if (!variants.length) return;
    // Mirror the player's start-level choice: the richest rendition the assumed bandwidth sustains.
    const budget = startEstimate() * 0.8;
    // Same screen rule as the player: one rung above the picture's physical pixel height, never more.
    const top = variants.reduce((a, b) => (b.h > a.h ? b : a));
    const ar = top.w && top.h ? top.w / top.h : 16 / 9;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const pictureH = Math.min(innerHeight, innerWidth / ar) * dpr;
    const heights = [...new Set(variants.map((x) => x.h))].sort((a, b) => a - b);
    let k = heights.findIndex((hh) => hh >= pictureH * 0.95);
    if (k < 0) k = heights.length - 1;
    const capH = heights[Math.min(heights.length - 1, k + 1)] || Infinity;
    const fits = variants.filter((x) => x.bw <= budget && (!x.h || x.h <= capH)).sort((a, b) => b.bw - a.bw);
    const pick = fits[0] || variants.sort((a, b) => a.bw - b.bw)[0];
    mediaUrl = new URL(pick.uri, base);
    var bitrate = pick.bw;
    if (pick.audio) {
      const media = L.find((l) => l.startsWith('#EXT-X-MEDIA') && l.includes('TYPE=AUDIO') && l.includes(`GROUP-ID="${pick.audio}"`) && /DEFAULT=YES|AUTOSELECT=YES/.test(l));
      const uri = media && /URI="([^"]+)"/.exec(media)?.[1];
      if (uri) audioUrl = new URL(uri, base);
    }
  }
  const [range] = await Promise.all([warmMedia(mediaUrl, position, count), audioUrl && warmMedia(audioUrl, position, count)]);
  if (range) {
    const list = warm.get(src) || [];
    list.push({ ...range, bitrate: bitrate || null, ready: true });
    warm.set(src, list);
  }
}

async function warmMedia(url, position, count) {
  const text = await (await get(url)).text();
  const L = lines(text);
  const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(text)?.[1];
  // Walk EXTINF durations to find the segment containing `position`.
  const segs = [];
  let t = 0;
  for (let i = 0; i < L.length; i++) {
    const m = /^#EXTINF:([\d.]+)/.exec(L[i]);
    if (!m) continue;
    const uri = L.slice(i + 1).find((x) => x && !x.startsWith('#'));
    if (uri) segs.push({ start: t, uri });
    t += Number(m[1]);
  }
  let k = segs.findIndex((s, i) => position < (segs[i + 1]?.start ?? Infinity));
  if (k < 0) k = 0;
  const key = `${url}@${k}`;
  if (done.has(key)) return done.get(key);
  const picked = segs.slice(k, k + count);
  const wanted = [...(map ? [map] : []), ...picked.map((s) => s.uri)];
  const p = Promise.all(
    wanted.map((u) => {
      const abs = new URL(u, url);
      return get(abs)
        .then((r) => r.arrayBuffer())
        .then(() => measure(abs));
    })
  ).then(() => ({ from: picked[0]?.start ?? 0, to: segs[k + count]?.start ?? Infinity }));
  done.set(key, p);
  return p;
}
