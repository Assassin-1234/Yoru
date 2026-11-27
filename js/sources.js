// Stream registry: decides what the YORU player can play for a title.
//
// The catalogue is ZokoAnime's (zokoanime.video). Every AniList title with a MyAnimeList id is resolved
// through the small /zoko service on our own origin: it decodes Zoko's embed payload and proxies the
// manifests and subtitles, while the video segments come straight from Zoko's CDN at their native bitrate.
// `streams/catalog.json` can still override a title/episode with a stream of our own.
import { titleOf } from './util.js';
import { kitsuTitle } from './kitsu.js';

const ZOKO_TTL = 5 * 60 * 1000;
const ZOKO_MISS_TTL = 60 * 1000;

let catalog = {};
let featured = [];
let zokoTitles = {}; // AniList id → MAL id (0 when Zoko serves it by AniList id)
let zokoMissing = new Set(); // titles a catalogue sync confirmed Zoko does not carry
const resolved = new Map(); // resolve key → { at, promise | data }

/** Load the editorial catalogue and the Zoko availability index once at boot. */
export async function loadCatalog() {
  const [lic, zoko] = await Promise.allSettled([
    fetch('streams/catalog.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)),
    fetch('streams/zoko.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)),
  ]);
  if (lic.status === 'fulfilled' && lic.value) {
    catalog = lic.value.titles || {};
    featured = (lic.value.featured || []).map(Number).filter(Boolean);
  }
  if (zoko.status === 'fulfilled' && zoko.value) {
    zokoTitles = zoko.value.titles || {};
    zokoMissing = new Set((zoko.value.missing || []).map(Number));
  }
  // Warm the AniZone CDN before the first Play (the manifest proxy is same-origin; segments are on the CDN).
  try {
    const l = document.createElement('link');
    l.rel = 'preconnect';
    l.href = 'https://seiryuu.vid-cdn.xyz';
    l.crossOrigin = 'anonymous';
    document.head.append(l);
  } catch {}

  // A first-time viewer has no measured throughput yet. Probe once while the page is idle so the first
  // episode opens on the right rung instead of hls.js's conservative default.
  try {
    if (!localStorage.getItem('yoru:bw:v1')) {
      (window.requestIdleCallback || setTimeout)(() => import('./prefetch.js').then((p) => p.probeBandwidth('/zoko/probe')), { timeout: 1500 });
    }
  } catch {}
}

/* ---------- Episodes ---------- */

/** Episodes that have actually aired (or the film itself), with Crunchyroll titles/thumbnails when AniList has them. */
export function episodeList(m, full = null) {
  if (!m || m.status === 'NOT_YET_RELEASED') return [];
  const meta = new Map();
  (full?.streamingEpisodes || m.streamingEpisodes || []).forEach((e, i) => {
    const mm = e.title.match(/^Episode\s+(\d+(?:\.\d+)?)\s*[-–:]\s*(.*)$/i);
    const n = mm ? Number(mm[1]) : i + 1;
    if (Number.isInteger(n) && !meta.has(n)) meta.set(n, { title: mm ? mm[2] : e.title, thumb: e.thumbnail, url: e.url?.replace(/^http:/, 'https:') });
  });
  if (m.format === 'MOVIE') return [{ n: 1, title: titleOf(m), thumb: null, film: true }];
  const aired = m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : m.episodes || meta.size || 0;
  const out = [];
  for (let n = 1; n <= aired; n++) out.push({ n, title: kitsuTitle(m, n) || meta.get(n)?.title || `Episode ${n}`, thumb: meta.get(n)?.thumb || null, url: meta.get(n)?.url });
  return out;
}

export const airedCount = (m) =>
  !m || m.status === 'NOT_YET_RELEASED' ? 0 : m.format === 'MOVIE' ? 1 : m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : m.episodes || 0;

/* ---------- Sources ---------- */

function zokoId(m) {
  const mapped = zokoTitles[m?.id];
  if (mapped !== undefined) return { source: mapped > 0 ? 'mal' : 'ani', id: mapped > 0 ? mapped : m.id };
  if (m?.idMal) return { source: 'mal', id: m.idMal };
  if (m?.id) return { source: 'ani', id: m.id };
  return null;
}

/**
 * Resolve the stream for an episode. `track` is Zoko's audio edition: sub (Japanese + subtitles),
 * hsub (hard-subbed) or dub (English audio).
 * Resolves to { src, type, intro?, credits?, subtitles?, zoko, track } or null when unavailable.
 */
export async function sourceFor(m, n = 1, track = 'sub') {
  const lic = catalog[m?.id]?.episodes?.[n];
  if (lic?.src) return { type: /\.m3u8(\?|$)/.test(lic.src) ? 'hls' : 'file', ...lic };
  if (!m || n < 1 || n > Math.max(airedCount(m), 0)) return null;

  const target = zokoId(m);
  if (!target) return null;
  const key = `${target.source}:${target.id}:${n}:${track}`;
  const hit = resolved.get(key);
  if (hit) {
    if (hit.promise) return hit.promise;
    if (Date.now() - hit.at < (hit.data ? ZOKO_TTL : ZOKO_MISS_TTL)) return hit.data;
    resolved.delete(key);
  }

  const p = (async () => {
    let cacheable = true;
    const title = m.title?.romaji || m.title?.userPreferred || titleOf(m);
    const titleEn = m.title?.english || '';
    try {
      const qs = new URLSearchParams({
        title,
        titleEn,
        source: target.source,
        id: String(target.id),
        anilist: String(m.id || ''),
        ep: String(n),
        track,
        year: String(m.seasonYear || ''),
        format: String(m.format || ''),
      });
      const r = await fetch(`/zoko/best?${qs}`, { cache: 'no-store' });
      if (r.status === 404) return null;
      if (!r.ok) {
        // A 404 means neither provider has the episode; anything else is transient and worth retrying.
        cacheable = false;
        return null;
      }
      const d = await r.json();
      if (!d?.available || !d.src) return null;
      return {
        type: 'hls',
        src: d.src,
        intro: d.intro || undefined,
        credits: d.credits || undefined,
        subtitles: d.subtitles || [],
        provider: d.provider,
        zoko: d.provider === 'zoko',
        track: d.track || track,
        segment: 10,
      };
    } catch {
      cacheable = false;
      return null;
    } finally {
      if (!cacheable) resolved.delete(key);
    }
  })();

  resolved.set(key, { at: Date.now(), promise: p });
  if (resolved.size > 500) resolved.delete(resolved.keys().next().value);
  const data = await p;
  const entry = resolved.get(key);
  if (entry?.promise === p) resolved.set(key, { at: Date.now(), data });
  return data;
}

/** Can the YORU player play anything for this title? */
export function playable(m) {
  if (!m || airedCount(m) < 1) return false;
  if (catalog[m.id]?.episodes) return Object.keys(catalog[m.id].episodes).length > 0;
  if (zokoMissing.has(m.id)) return false;
  // The synced index is authoritative when it knows the title; anything newer is resolved on demand.
  return zokoTitles[m.id] !== undefined || !!(m.idMal || m.id);
}

/** Editorially pinned titles for the Home billboard (from streams/catalog.json → "featured"). */
export const featuredIds = () => featured.slice();
