// Build streams/zoko.json: the AniList ids Zoko actually carries.
//
// AniList caps a single query at 5,000 entries, so the catalogue is walked by release year (split further
// when a range is still too deep). Each title is then resolved once through Zoko's embed endpoint. The site
// uses this as an availability index only; episode streams are resolved on demand so source rotations and
// new episodes never wait for a redeploy.
//
//   node scripts/sync-zoko.mjs                 # whole catalogue
//   node scripts/sync-zoko.mjs --years=2024,2025
//   node scripts/sync-zoko.mjs --limit=50      # quick smoke test
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveZoko } from '../zoko.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'streams', 'zoko.json');
const CACHE = join(root, 'scripts', '.anilist-cache.json');
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? 'true'];
    })
);
const LIMIT = Number(args.limit) || Infinity;
const YEARS = args.years ? new Set(String(args.years).split(',').map(Number)) : null;
const PER_PAGE = 50;
const PAGES_PER_REQUEST = 3;
const REQUEST_GAP = 2200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const airedCount = (m) => (m.status === 'NOT_YET_RELEASED' ? 0 : m.format === 'MOVIE' ? 1 : m.episodes || 1);

async function anilist(query, attempt = 0) {
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (res.status === 429 && attempt < 6) {
    const wait = (Number(res.headers.get('retry-after')) || 20 + attempt * 20) * 1000;
    process.stderr.write(`  rate limited; waiting ${Math.round(wait / 1000)}s\n`);
    await sleep(wait);
    return anilist(query, attempt + 1);
  }
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message || 'AniList error');
  return json.data;
}

function pageQuery(from, to, pageStart) {
  const pages = [];
  for (let i = 0; i < PAGES_PER_REQUEST; i++) {
    pages.push(
      `p${i}:Page(page:${pageStart + i},perPage:${PER_PAGE}){` +
        `pageInfo{hasNextPage}media(type:ANIME,isAdult:false,startDate_greater:${from},startDate_lesser:${to},sort:ID){` +
        `id idMal episodes format status title{romaji english}}}`
    );
  }
  return `query{${pages.join('\n')}}`;
}

let seen = new Map();

async function crawlRange(from, to, depth = 0) {
  for (let page = 1; ; page += PAGES_PER_REQUEST) {
    if (page > 100) {
      if (depth > 4) throw new Error(`range ${from}-${to} is too deep`);
      const mid = Math.floor((from + to) / 2);
      await crawlRange(from, mid, depth + 1);
      await crawlRange(mid + 1, to, depth + 1);
      return;
    }
    const data = await anilist(pageQuery(from, to, page));
    let more = false;
    let got = 0;
    for (let i = 0; i < PAGES_PER_REQUEST; i++) {
      const p = data[`p${i}`];
      if (!p) continue;
      got += p.media.length;
      for (const m of p.media) if (!seen.has(m.id)) seen.set(m.id, m);
      more = p.pageInfo.hasNextPage;
      if (!more) break;
    }
    process.stderr.write(`\r  AniList ${from}-${to} p${page}: ${seen.size} titles   `);
    if (!more || got === 0 || seen.size >= LIMIT) return;
    await sleep(REQUEST_GAP);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function crawl() {
  const years = YEARS || new Set(Array.from({ length: 2031 - 1940 }, (_, i) => 1940 + i));
  process.stderr.write(`AniList: ${years.size} year ranges\n`);
  if (years.has(1940)) await crawlRange(1, 19400101);
  for (const year of [...years].sort((a, b) => a - b)) {
    await crawlRange(year * 10000 - 1, (year + 1) * 10000);
    if (seen.size >= LIMIT) break;
    await sleep(REQUEST_GAP);
  }
  await crawlRange(20310101, 21000101);
}

async function main() {
  const fresh = args.fresh === 'true' || !!YEARS || !existsSync(CACHE);
  if (fresh) {
    await crawl();
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify([...seen.values()]));
  } else {
    seen = new Map(JSON.parse(readFileSync(CACHE, 'utf8')).map((m) => [m.id, m]));
    process.stderr.write(`AniList cache: ${seen.size} titles\n`);
  }

  const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  const available = new Map(Object.entries(previous.titles || {}).map(([id, mal]) => [Number(id), Number(mal)]));
  const missing = new Set((previous.missing || []).map(Number));
  const titles = [...seen.values()].filter((m) => airedCount(m) > 0 && (m.idMal || m.id));
  const todo = titles.slice(0, LIMIT).filter((m) => !available.has(m.id));
  process.stderr.write(`\nZoko: ${available.size} known, ${missing.size} unknown, probing ${todo.length}\n`);

  let done = 0;
  const retryable = /network|http-5|http-429|http-403|bad-payload/;
  await mapLimit(todo, 8, async (m) => {
    const source = m.idMal ? 'mal' : 'ani';
    const id = m.idMal || m.id;
    let r = { unavailable: true, reason: 'network' };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        r = await resolveZoko({ source, id, episode: 1, track: 'sub' });
      } catch {
        r = { unavailable: true, reason: 'network' };
      }
      if (r.available || !retryable.test(String(r.reason))) break;
      await sleep(1500 * (attempt + 1));
    }
    // A MAL mapping miss is common for films/ONAs that Zoko has under its AniList id.
    if (!r.available && source === 'mal' && m.id && m.id !== id) {
      try {
        r = await resolveZoko({ source: 'ani', id: m.id, episode: 1, track: 'sub' });
      } catch {}
    }
    if (r.available) {
      available.set(m.id, Number(m.idMal) || 0);
      missing.delete(m.id);
    }
    else if (!retryable.test(String(r.reason))) missing.add(m.id);

    done++;
    if (done % 250 === 0) process.stderr.write(`\r  resolved ${done}/${todo.length}   `);
  });

  const out = {
    updated: new Date().toISOString(),
    titles: Object.fromEntries([...available].sort((a, b) => a[0] - b[0])),
    missing: [...missing].sort((a, b) => a - b),
    counts: { titles: available.size, missing: missing.size },
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  process.stderr.write(`\nwrote ${OUT}: ${available.size} available, ${missing.size} missing\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
