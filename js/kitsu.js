// Episode titles from Kitsu.
//
// AniList's `streamingEpisodes` for a sequel sometimes reuse the previous season's Crunchyroll URLs and titles
// (Jujutsu Kaisen S2 is the canonical example). Kitsu carries per-season episode titles, so we use them when
// available and fall back to AniList/generic titles otherwise. Cached for a week in localStorage.
const TTL = 7 * 864e5;
const PREFIX = 'yoru:kitsu:v1:';
const cache = new Map();
const pending = new Map();

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();

async function json(url) {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.api+json' }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Kitsu ${res.status}`);
  return res.json();
}

function readStore(id) {
  try {
    const raw = localStorage.getItem(PREFIX + id);
    if (!raw) return null;
    const { t, titles } = JSON.parse(raw);
    if (Date.now() - t > TTL) return null;
    return new Map(titles);
  } catch {
    return null;
  }
}

function writeStore(id, map) {
  try {
    localStorage.setItem(PREFIX + id, JSON.stringify({ t: Date.now(), titles: [...map] }));
  } catch {}
}

/**
 * Resolve the Kitsu anime for a media and cache its episode titles.
 * Safe to call repeatedly; in-flight calls are de-duplicated.
 */
export async function primeEpisodeTitles(m) {
  if (!m?.id || m.format === 'MOVIE') return null;
  const id = String(m.id);
  if (cache.has(id)) return cache.get(id);
  const stored = readStore(id);
  if (stored) {
    cache.set(id, stored);
    return stored;
  }

  if (pending.has(id)) return pending.get(id);
  const p = (async () => {
    const title = m.title?.romaji || m.title?.english || m.title?.userPreferred || '';
    if (!title) return null;
    const search = await json(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=10`);
    const candidates = search.data || [];
    if (!candidates.length) return null;
    const year = Number(m.seasonYear) || null;
    const wanted = norm(title);
    const score = (x) => {
      const a = x.attributes || {};
      const names = [a.canonicalTitle, a.titles?.en_jp, a.titles?.en_us, a.titles?.ja_jp].filter(Boolean).map(norm);
      const titleScore = names.some((n) => n === wanted) ? 3 : names.some((n) => n.length > 5 && (n.includes(wanted) || wanted.includes(n))) ? 1 : 0;
      const yearScore = year && String(a.startDate || '').startsWith(String(year)) ? 4 : 0;
      const recap = /recap|summary|movie|special|ova/i.test(a.canonicalTitle || '') ? 3 : 0;
      return titleScore + yearScore - recap;
    };
    const best = candidates.map((x) => ({ x, s: score(x) })).sort((a, b) => b.s - a.s)[0];
    if (!best || best.s === 0) return null;

    const map = new Map();
    for (let offset = 0; ; offset += 20) {
      const page = await json(`https://kitsu.io/api/edge/anime/${best.x.id}/episodes?page[limit]=20&page[offset]=${offset}&sort=number`);
      const rows = page.data || [];
      for (const e of rows) {
        const n = Number(e.attributes?.number);
        const t = e.attributes?.canonicalTitle;
        if (Number.isFinite(n) && t && !map.has(n)) map.set(n, t);
      }
      if (rows.length < 20) break;
    }
    if (!map.size) return null;
    writeStore(id, map);
    return map;
  })();

  pending.set(id, p);
  const map = await p.catch(() => null);
  pending.delete(id);
  if (map) cache.set(id, map);
  return map;
}

/** Episode title for a media/episode, or null when Kitsu has no entry. */
export function kitsuTitle(m, n) {
  const map = cache.get(String(m?.id));
  return map?.get(Number(n)) || null;
}
