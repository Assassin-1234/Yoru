// AniZone provider: 1080p H.264 at the correct 23.976 fps, with separate audio renditions (Japanese, English
// dub and others). Its CDN requires an AniZone Referer and its subtitles are ASS, so this module resolves the
// page, then exposes everything through the same-origin /zoko gateway.
import { hlsProxy, subtitleProxy, mediaUrl } from './stream-urls.mjs';

const BASE = 'https://anizone.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TTL = 30 * 60 * 1000;
const cache = new Map();
const FS_URL = process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191';
let clearance = { cookie: '', ua: UA, until: 0 };

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();

async function solve(url) {
  const res = await fetch(`${FS_URL}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60_000 }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const sol = json?.solution;
  if (!sol?.response) return null;
  clearance = {
    cookie: (sol.cookies || []).map((c) => `${c.name}=${c.value}`).join('; '),
    ua: sol.userAgent || UA,
    until: Date.now() + 30 * 60_000,
  };
  return new Response(sol.response, { status: sol.status || 200, headers: { 'content-type': 'text/html' } });
}

async function get(url, referer = `${BASE}/`) {
  const headers = {
    Referer: referer,
    'User-Agent': clearance.ua,
    Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
  };
  if (clearance.cookie && Date.now() < clearance.until) headers.Cookie = clearance.cookie;
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  if (res.status !== 403 && res.status !== 503) return res;
  // The VPS IP is challenged by anizone.to even though the CDN is open. Solve once and reuse the clearance
  // cookie for subsequent searches/episode pages.
  try {
    return (await solve(url)) || res;
  } catch {
    return res;
  }
}

function searchItems(html) {
  const start = html.indexOf("items: JSON.parse('");
  if (start >= 0) {
    const end = html.indexOf("')", start + 19);
    if (end > start) {
      try {
        const raw = html.slice(start + 19, end).replace(/\\u0022/g, '"');
        return JSON.parse(raw).map((x) => ({ slug: x.slug, title: String(x.main_title || '').trim(), year: Number(x.start_year) || null, type: x.type || null, episodes: Number(x.episode_count) || null }));
      } catch {}
    }
  }
  const re = /\\u0022slug\\u0022:\\u0022([a-z0-9]+)\\u0022[\s\S]*?\\u0022main_title\\u0022:\\u0022([^\\]+)/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ slug: m[1], title: m[2].trim() });
  }
  return out;
}

function playerData(page) {
  const m = page.match(/vidstackPlayer\(JSON\.parse\('([\s\S]*?)'\)\)/);
  if (!m) return null;
  try {
    return JSON.parse(m[1].replace(/\\u0022/g, '"'));
  } catch {
    return null;
  }
}

const cleanUrl = (u) => String(u || '').replace(/\\\//g, '/');
const baseTitle = (s) =>
  String(s || '')
    .replace(/\s*(?:[:(]\s*)?(?:\d+(?:st|nd|rd|th)\s+Season|Season\s+\d+|Final Season|Part\s+\d+|Cour\s+\d+|\d{4})\s*\)?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function findTitle(title, titleEn, year) {
  const queries = [...new Set([title, titleEn, baseTitle(title), baseTitle(titleEn)].filter(Boolean))];
  const all = [];
  for (const q of queries) {
    const key = `search:${q.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) {
      all.push(...hit.items);
      continue;
    }
    const res = await get(`${BASE}/anime?search=${encodeURIComponent(q)}`);
    if (!res.ok) continue;
    const items = searchItems(await res.text());
    cache.set(key, { at: Date.now(), items });
    all.push(...items);
  }
  const seen = new Set();
  const unique = all.filter((x) => (seen.has(x.slug) ? false : (seen.add(x.slug), true)));
  const targets = [title, titleEn, baseTitle(title), baseTitle(titleEn)].filter(Boolean).map(norm);
  // Season/part suffixes differ between AniList and AniZone; prefer the matching release year, then an exact title,
  // then a title that contains the query, but only when the query is specific enough to avoid a wrong match.
  const candidates = unique.filter((x) => {
    const n = norm(x.title);
    return targets.some((t) => t.length >= 8 && (n.includes(t) || t.includes(n)));
  });
  if (year) {
    const byYear = candidates.find((x) => x.year === Number(year));
    if (byYear) return byYear;
  }
  const hit = unique.find((x) => targets.includes(norm(x.title)));
  if (hit) return hit;
  return candidates.find((x) => x.type !== 'Movie') || candidates[0] || null;
}

/**
 * Resolve one episode from AniZone.
 * @returns {{available:boolean, provider?:string, src?:string, subtitles?:Array, slug?:string, title?:string}}
 */
export async function resolveAnizone({ title, titleEn, episode = 1, year } = {}) {
  if (!title && !titleEn) return { available: false, reason: 'no-title' };
  const key = `ep:${norm(title)}|${norm(titleEn)}|${year || ''}|${episode}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  const match = await findTitle(title, titleEn, year);
  if (!match) return { available: false, reason: 'not-found' };

  const pageRes = await get(`${BASE}/anime/${match.slug}/${episode}`);
  if (!pageRes.ok) return { available: false, reason: `http-${pageRes.status}` };
  const data = playerData(await pageRes.text());
  const master = cleanUrl(data?.src);
  if (!master || !mediaUrl(master)) return { available: false, reason: 'no-source' };

  const subs = (Array.isArray(data.subtitles) ? data.subtitles : [])
    .map((s) => {
      const file = cleanUrl(s.file);
      if (!file || !mediaUrl(file)) return null;
      return {
        lang: s.language || 'en',
        label: s.title || s.language || 'Subtitles',
        src: subtitleProxy(file),
        default: s.default === true,
      };
    })
    .filter(Boolean);

  const out = {
    available: true,
    provider: 'anizone',
    src: hlsProxy(master),
    subtitles: subs,
    slug: match.slug,
    title: match.title,
    chapter: cleanUrl(data.chapter) || null,
  };
  cache.set(key, { at: Date.now(), data: out });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return out;
}

/** Warm the Cloudflare clearance in the background so the first viewer does not pay the solver latency. */
export async function prewarmAnizone() {
  if (clearance.cookie && Date.now() < clearance.until) return;
  try {
    await get(`${BASE}/anime?search=naruto`);
  } catch {}
}

/* ---------- ASS -> WebVTT ---------- */

const assTime = (t) => {
  const m = String(t).trim().match(/^(\d+):(\d{2}):(\d{2})[.:](\d{1,3})$/);
  if (!m) return '00:00:00.000';
  const ms = Number(m[4].padEnd(3, '0').slice(0, 3));
  return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}.${String(ms).padStart(3, '0')}`;
};

export function assToVtt(ass) {
  const lines = String(ass).split(/\r?\n/);
  const out = ['WEBVTT', ''];
  let events = false;
  for (const line of lines) {
    if (line.trim() === '[Events]') {
      events = true;
      continue;
    }
    if (line.startsWith('[')) {
      events = false;
      continue;
    }
    if (!events || !line.startsWith('Dialogue:')) continue;
    const parts = line.slice(9).split(',');
    if (parts.length < 10) continue;
    const start = assTime(parts[1]);
    const end = assTime(parts[2]);
    const text = parts
      .slice(9)
      .join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/g, '\n')
      .replace(/\\n/g, '\n')
      .trim();
    if (!text) continue;
    out.push(`${start} --> ${end}`, text, '');
  }
  return out.join('\n');
}
