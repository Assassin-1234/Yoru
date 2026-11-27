// AniList GraphQL client with request batching, in-flight de-duplication and a localStorage cache.
// AniList allows ~30 requests/minute, so every page is fetched with a single aliased query.

import { primeEpisodeTitles } from './kitsu.js';

const ENDPOINT = 'https://graphql.anilist.co';
const PREFIX = 'yoru:q2:';
const MIN = 60 * 1000;

export const CARD = `id idMal title{romaji english native userPreferred} coverImage{extraLarge large color} bannerImage
format episodes duration status season seasonYear startDate{year month day} averageScore popularity genres
trailer{id site} nextAiringEpisode{episode airingAt timeUntilAiring}`;

const inflight = new Map();

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function readCache(key, ttl) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const { t, d } = JSON.parse(raw);
    return Date.now() - t < ttl ? d : null;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  const payload = JSON.stringify({ t: Date.now(), d: data });
  try {
    localStorage.setItem(PREFIX + key, payload);
  } catch {
    // Quota exceeded: drop every cached query and try once more.
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('yoru:q')).forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(PREFIX + key, payload);
    } catch {}
  }
}

async function request(query, variables, attempt = 0) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      return request(query, variables, attempt + 1);
    }
    throw err;
  }
  if (res.status === 429 && attempt < 3) {
    const wait = (Number(res.headers.get('Retry-After')) || 3 + attempt * 3) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return request(query, variables, attempt + 1);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) throw new Error(json.errors?.[0]?.message || `AniList error ${res.status}`);
  return json.data;
}

export function gql(query, variables = {}, { ttl = 30 * MIN, store = true } = {}) {
  const key = hash(query + JSON.stringify(variables));
  const cached = ttl > 0 && readCache(key, ttl);
  if (cached) return Promise.resolve(cached);
  if (inflight.has(key)) return inflight.get(key);
  const p = request(query, variables)
    .then((d) => {
      if (store) writeCache(key, d);
      return d;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ---------- Seasons ---------- */

const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
export function currentSeason(d = new Date()) {
  return { season: SEASONS[Math.floor(d.getMonth() / 3)], year: d.getFullYear() };
}
export function nextSeason() {
  const { season, year } = currentSeason();
  const i = SEASONS.indexOf(season);
  return i === 3 ? { season: 'WINTER', year: year + 1 } : { season: SEASONS[i + 1], year };
}
export const seasonName = (s) => s.charAt(0) + s.slice(1).toLowerCase();

/* ---------- Queries ---------- */

const clean = (list) => (list || []).filter((m) => m && !m.isAdult && (m.coverImage?.extraLarge || m.coverImage?.large));

const pageOf = (alias, args, n = 20, extra = '') =>
  `${alias}:Page(perPage:${n}){media(type:ANIME,isAdult:false,${args}){${CARD}${extra}}}`;

function unpack(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) out[k] = clean(v.media);
  return out;
}

const HERO_EXTRA = ' description studios(isMain:true){nodes{name}}';

export async function home() {
  const s = currentSeason();
  const n = nextSeason();
  const data = await gql(`query{
    ${pageOf('trending', 'sort:TRENDING_DESC', 20, HERO_EXTRA)}
    ${pageOf('seasonTop', `season:${s.season},seasonYear:${s.year},sort:TRENDING_DESC`, 10)}
    ${pageOf('season', `season:${s.season},seasonYear:${s.year},sort:POPULARITY_DESC`)}
    ${pageOf('popular', 'sort:POPULARITY_DESC')}
    ${pageOf('acclaimed', 'sort:SCORE_DESC,popularity_greater:40000')}
    ${pageOf('movies', 'format:MOVIE,sort:POPULARITY_DESC')}
    ${pageOf('upcoming', `season:${n.season},seasonYear:${n.year},sort:POPULARITY_DESC`)}
  }`);
  return unpack(data);
}

export async function browse(kind) {
  const y = new Date().getFullYear();
  const f = kind === 'films' ? 'format:MOVIE' : 'format_in:[TV,ONA]';
  const q =
    kind === 'films'
      ? `query{
    ${pageOf('trending', `${f},sort:TRENDING_DESC`, 20, HERO_EXTRA)}
    ${pageOf('popular', `${f},sort:POPULARITY_DESC`)}
    ${pageOf('acclaimed', `${f},sort:SCORE_DESC,popularity_greater:15000`)}
    ${pageOf('recent', `${f},status:FINISHED,startDate_greater:${(y - 3) * 10000},sort:POPULARITY_DESC`)}
    ${pageOf('classics', `${f},startDate_lesser:20060000,sort:POPULARITY_DESC`)}
    ${pageOf('upcoming', `${f},status:NOT_YET_RELEASED,sort:POPULARITY_DESC`)}
  }`
      : `query{
    ${pageOf('trending', `${f},sort:TRENDING_DESC`, 20, HERO_EXTRA)}
    ${pageOf('airing', `${f},status:RELEASING,sort:POPULARITY_DESC`)}
    ${pageOf('popular', `${f},sort:POPULARITY_DESC`)}
    ${pageOf('acclaimed', `${f},sort:SCORE_DESC,popularity_greater:40000`)}
    ${pageOf('recent', `${f},status:FINISHED,startDate_greater:${(y - 3) * 10000},sort:POPULARITY_DESC`)}
    ${pageOf('classics', `${f},startDate_lesser:20080000,sort:POPULARITY_DESC`)}
  }`;
  return unpack(await gql(q));
}

export async function genreRows(genres, kind) {
  const f = kind === 'films' ? 'format:MOVIE,' : kind === 'series' ? 'format_in:[TV,ONA],' : '';
  const q = `query{${genres
    .map((g, i) => pageOf(`g${i}`, `${f}genre:"${g}",sort:POPULARITY_DESC`, 20))
    .join('\n')}}`;
  const data = unpack(await gql(q));
  return genres.map((g, i) => ({ genre: g, items: data[`g${i}`] }));
}

export async function recommendationsFor(id) {
  const data = await gql(
    `query($id:Int){Media(id:$id){id title{english romaji userPreferred} recommendations(perPage:20,sort:RATING_DESC){nodes{mediaRecommendation{${CARD} isAdult}}}}}`,
    { id }
  );
  const m = data.Media;
  return { source: m, items: clean(m.recommendations.nodes.map((n) => n.mediaRecommendation)) };
}

export async function detail(id) {
  const data = await gql(
    `query($id:Int){Media(id:$id){${CARD} isAdult description source countryOfOrigin endDate{year month day}
      studios(isMain:true){nodes{name}}
      tags{name rank isMediaSpoiler}
      characters(sort:[ROLE,RELEVANCE,ID],perPage:12){edges{role node{id name{full} image{large}} voiceActors(language:JAPANESE){name{full}}}}
      streamingEpisodes{title thumbnail url site}
      externalLinks{site url type color icon}
      recommendations(perPage:12,sort:RATING_DESC){nodes{mediaRecommendation{${CARD} isAdult description}}}
      relations{edges{relationType node{${CARD} type isAdult}}}
    }}`,
    { id }
  );
  const m = data.Media;
  if (m) await primeEpisodeTitles(m).catch(() => {});
  return m;
}

export async function search(q) {
  const data = await gql(
    `query($q:String){Page(perPage:42){media(search:$q,type:ANIME,isAdult:false,sort:[SEARCH_MATCH,POPULARITY_DESC]){${CARD}}}}`,
    { q },
    { ttl: 10 * MIN }
  );
  return clean(data.Page.media);
}

export async function byGenre(genre, { sort = 'POPULARITY_DESC', page = 1, kind } = {}) {
  const f = kind === 'films' ? 'format:MOVIE,' : kind === 'series' ? 'format_in:[TV,ONA],' : '';
  const extra = sort === 'SCORE_DESC' ? 'popularity_greater:8000,' : '';
  const data = await gql(
    `query($g:String,$p:Int){Page(page:$p,perPage:30){pageInfo{hasNextPage} media(type:ANIME,isAdult:false,${f}${extra}genre:$g,sort:[${sort}]){${CARD}}}}`,
    { g: genre, p: page }
  );
  return { items: clean(data.Page.media), more: data.Page.pageInfo.hasNextPage };
}

/* ---------- Recommender inputs ---------- */

// AniList caps a query at complexity 500. Measured costs: a full card ≈ 32, an id-only graph node ≈ 7
// (13 with relations), and an id_in page ≈ 43 regardless of size. So the recommender walks the graph
// with id-only queries first and hydrates the shortlisted candidates in pages of 50 afterwards.
const HOUR = 60 * MIN;
const REC = `${CARD} isAdult source tags{name rank isMediaSpoiler} studios(isMain:true){nodes{name}}`;
const ids = (a) => `[${a.map(Number).join(',')}]`;
const strs = (a) => `[${a.map((s) => JSON.stringify(String(s))).join(',')}]`;

/** Community recommendation edges (AniList users voting "if you liked A, watch B") out of each id. */
export async function recGraph(list, { relations = false } = {}) {
  if (!list.length) return [];
  const node = (id, i) =>
    `n${i}:Media(id:${Number(id)}){id recommendations(perPage:25,sort:RATING_DESC){nodes{rating mediaRecommendation{id isAdult}}}${
      relations ? ' relations{edges{relationType node{id type status format}}}' : ''
    }}`;
  const data = await gql(`query{${list.map(node).join('\n')}}`, {}, { ttl: 12 * HOUR });
  return list.map((_, i) => data[`n${i}`]).filter(Boolean);
}

/** Content-based candidate ids matching the viewer's strongest genres and tags. */
export async function recContent({ genres = [], tags = [] }) {
  const parts = [];
  if (genres.length && tags.length)
    parts.push(`a:Page(perPage:40){media(type:ANIME,isAdult:false,genre_in:${strs(genres.slice(0, 2))},tag_in:${strs(tags.slice(0, 4))},popularity_greater:6000,sort:POPULARITY_DESC){id}}`);
  if (tags.length) parts.push(`b:Page(perPage:40){media(type:ANIME,isAdult:false,tag_in:${strs(tags.slice(0, 3))},popularity_greater:9000,sort:SCORE_DESC){id}}`);
  if (genres.length) parts.push(`c:Page(perPage:40){media(type:ANIME,isAdult:false,genre_in:${strs(genres.slice(0, 3))},popularity_greater:15000,sort:SCORE_DESC){id}}`);
  if (!parts.length) return [];
  const data = await gql(`query{${parts.join('\n')}}`, {}, { ttl: 12 * HOUR });
  return Object.values(data).flatMap((p) => p.media.map((m) => m.id));
}

/** Full card + feature data (tags, studio, source) for up to 500 ids, 50 per page. Not cached here; recs.js keeps a compact copy. */
export async function hydrate(list) {
  const out = [];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const pages = [];
    for (let k = 0; k < chunk.length; k += 50) pages.push(`p${k}:Page(perPage:50){media(id_in:${ids(chunk.slice(k, k + 50))}){${REC}}}`);
    const data = await gql(`query{${pages.join('\n')}}`, {}, { ttl: 0, store: false });
    out.push(...Object.values(data).flatMap((p) => clean(p.media)));
  }
  return out;
}

export async function newAndPopular() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const a = Math.floor(start / 1000);
  const b = a + 7 * 86400;
  const today = start.getFullYear() * 10000 + (start.getMonth() + 1) * 100 + start.getDate();
  const sched = (i) =>
    `s${i}:Page(page:${i},perPage:50){airingSchedules(airingAt_greater:${a},airingAt_lesser:${b},sort:TIME){id airingAt episode media{${CARD} isAdult countryOfOrigin popularity}}}`;
  const data = await gql(
    `query{
      ${sched(1)} ${sched(2)} ${sched(3)}
      ${pageOf('top', 'format_in:[TV,ONA],sort:TRENDING_DESC', 10)}
      ${pageOf('soon', `status:NOT_YET_RELEASED,startDate_greater:${today},popularity_greater:3000,sort:START_DATE`, 14, ' description')}
    }`,
    {},
    { ttl: 15 * MIN }
  );
  const schedule = [data.s1, data.s2, data.s3]
    .flatMap((p) => p.airingSchedules)
    .filter((s) => s.media && !s.media.isAdult && s.media.countryOfOrigin === 'JP' && s.media.popularity > 1500);
  return { schedule, top: clean(data.top.media), soon: clean(data.soon.media) };
}
