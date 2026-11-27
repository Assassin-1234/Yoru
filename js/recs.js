// YORU's recommender.
//
// The same three-stage shape production recommenders use (candidate generation → scoring → re-ranking),
// sized to run entirely in the browser:
//
//  1. Feedback → affinity. Explicit ratings, watch depth, completion, abandonment, My List and weak
//     implicit signals (opening details, watching previews/trailers) become a signed, time-decayed
//     affinity per title.
//
//  2. Candidates. A random walk with restart (personalised PageRank) over AniList's community
//     recommendation graph — millions of "if you liked A, watch B" votes acting as collaborative
//     filtering — expanded two hops out from the viewer's titles, plus content candidates drawn from
//     their strongest genres and tags.
//
//  3. Scoring. A hybrid of:
//       • RP3β graph relevance — walk probability divided by popularity^β so hubs don't dominate.
//         (In the RecSys 2019 reproducibility study by Ferrari Dacrema et al., RP3β matched or beat
//         most neural recommenders it was compared with.)
//       • Content similarity — cosine between TF-IDF item embeddings (genres, ranked tags, studio,
//         era, format, source) and a Rocchio-style taste vector that also subtracts disliked titles.
//       • A negative walk from disliked/abandoned titles, Bayesian-smoothed quality, a popularity prior.
//       • Thompson-sampling exploration over genres (Beta posteriors from impressions → clicks).
//
//  4. Re-ranking. Franchise collapse (recommend the entry point, not season 4) and Maximal Marginal
//     Relevance for diversity, then explanations ("Because you watched …") and a calibrated match %.
//
// Everything is local: the profile never leaves the device. Once YORU has a backend and real viewing
// data, a learned model (two-tower retrieval + sequence-aware ranker) can replace stage 3 without
// changing the interface below.
import * as api from './api.js';
import { titles, ratings, signals, banditStats } from './history.js';
import { getList } from './store.js';
import { airedCount } from './sources.js';
import { titleOf } from './util.js';

const DAY = 864e5;
const decay = (t, halfLifeDays) => (t ? 0.5 ** ((Date.now() - t) / (halfLifeDays * DAY)) : 1);

/* =========================================================================================
   1. Feedback → affinity
   ========================================================================================= */

export function affinities() {
  const A = new Map();
  const add = (m, v, why, strength = Math.abs(v)) => {
    if (!m?.id || !v) return;
    const a = A.get(m.id) || { id: m.id, m, aff: 0, why: null, s: 0 };
    a.aff += v;
    if (strength > a.s) {
      a.s = strength;
      a.why = why;
    }
    a.m = { ...a.m, ...m };
    A.set(m.id, a);
  };

  for (const e of Object.values(titles())) {
    const eps = Object.values(e.eps || {});
    if (!eps.length) continue;
    const done = eps.filter((x) => x.done).length;
    const partial = eps.filter((x) => !x.done && x.d && x.p / x.d > 0.25).length;
    const depth = Math.min(1, (done + 0.5 * partial) / Math.min(Math.max(airedCount(e.m), 1), 4));
    const best = Math.max(...eps.map((x) => (x.d ? x.p / x.d : 0)), done ? 1 : 0);
    const idleDays = (Date.now() - e.t) / DAY;
    // Sampled it, barely watched, never came back → treat as a soft negative.
    const v = done === 0 && best < 0.3 && idleDays > 10 ? -0.6 : 0.6 + 1.7 * depth;
    add(e.m, v * decay(e.t, 75), v > 0 ? 'watched' : 'abandoned');
    A.get(e.m.id).completion = done / Math.max(airedCount(e.m), 1);
  }

  const all = titles();
  for (const [id, r] of Object.entries(ratings())) {
    const m = all[id]?.m;
    const v = { 2: 3.2, 1: 1.6, '-1': -2.6 }[r.v] || 0;
    add(m, v * decay(r.t, 365), r.v === 2 ? 'loved' : r.v === 1 ? 'liked' : 'disliked', Math.abs(v) + 1);
  }

  getList().forEach((m, i) => add(m, 1.0 * 0.96 ** i, 'saved'));

  for (const s of Object.values(signals())) {
    const v = Math.min(0.5, 0.12 * s.o + 0.08 * s.p + 0.22 * s.tr) * decay(s.t, 21);
    add(s.m, v, 'viewed', v * 0.5);
  }
  return A;
}

/* =========================================================================================
   Compact item store — hydrated card + feature data, kept locally for 12 h
   ========================================================================================= */

const IKEY = 'yoru:recs:items:v1';
const ITTL = 12 * 3600 * 1000;
let items = {};
try {
  items = JSON.parse(localStorage.getItem(IKEY)) || {};
} catch {}

function compact(m) {
  const { tags, studios, ...card } = m;
  return {
    ...card,
    tags: (tags || [])
      .filter((t) => !t.isMediaSpoiler && t.rank >= 35)
      .slice(0, 14)
      .map((t) => ({ n: t.name, r: t.rank })),
    studio: studios?.nodes?.[0]?.name || null,
  };
}

function saveItems() {
  const entries = Object.entries(items);
  if (entries.length > 1400) {
    entries.sort((a, b) => b[1].t - a[1].t);
    items = Object.fromEntries(entries.slice(0, 1100));
  }
  try {
    localStorage.setItem(IKEY, JSON.stringify(items));
  } catch {
    items = {};
    try {
      localStorage.removeItem(IKEY);
    } catch {}
  }
}

function putItems(list) {
  const t = Date.now();
  for (const m of list) if (m?.id) items[m.id] = { t, m: compact(m) };
}

async function getItems(ids) {
  const now = Date.now();
  const missing = [...new Set(ids)].filter((id) => !items[id] || now - items[id].t > ITTL);
  if (missing.length) {
    putItems(await api.hydrate(missing));
    saveItems();
  }
  const out = new Map();
  for (const id of ids) if (items[id]) out.set(Number(id), items[id].m);
  return out;
}

/* =========================================================================================
   Math: graph walk, embeddings, diversity, exploration
   ========================================================================================= */

/** Personalised PageRank by power iteration. graph: Map<id, Map<id, weight>>, restart: Map<id, p> (sums to 1). */
export function ppr(graph, restart, { alpha = 0.25, iters = 28 } = {}) {
  const sums = new Map();
  for (const [u, nb] of graph) {
    let s = 0;
    for (const w of nb.values()) s += w;
    sums.set(u, s);
  }
  let x = new Map(restart);
  for (let k = 0; k < iters; k++) {
    const next = new Map();
    for (const [u, p] of restart) next.set(u, alpha * p);
    let dangling = 0;
    for (const [u, xu] of x) {
      const nb = graph.get(u);
      const s = sums.get(u);
      if (!nb || !s) {
        dangling += xu;
        continue;
      }
      const f = ((1 - alpha) * xu) / s;
      for (const [v, w] of nb) next.set(v, (next.get(v) || 0) + f * w);
    }
    if (dangling) for (const [u, p] of restart) next.set(u, next.get(u) + (1 - alpha) * dangling * p);
    x = next;
  }
  return x;
}

export function addEdges(graph, nodes) {
  const link = (a, b, w) => {
    if (!graph.has(a)) graph.set(a, new Map());
    const nb = graph.get(a);
    nb.set(b, Math.max(nb.get(b) || 0, w));
  };
  for (const n of nodes) {
    for (const r of n.recommendations?.nodes || []) {
      const v = r.mediaRecommendation;
      if (!v || v.isAdult || !(r.rating > 0) || v.id === n.id) continue;
      const w = Math.log1p(r.rating);
      link(n.id, v.id, w);
      link(v.id, n.id, w);
    }
  }
  return graph;
}

const FW = { g: 1, t: 1.15, s: 0.6, f: 0.3, e: 0.3, src: 0.22 };
function rawFeatures(m) {
  const f = new Map();
  for (const g of m.genres || []) f.set('g:' + g, FW.g);
  for (const t of m.tags || []) f.set('t:' + t.n, (FW.t * t.r) / 100);
  if (m.studio) f.set('s:' + m.studio, FW.s);
  if (m.format) f.set('f:' + (m.format === 'ONA' ? 'TV' : m.format), FW.f);
  const y = m.seasonYear || m.startDate?.year;
  if (y) f.set('e:' + Math.floor(y / 5) * 5, FW.e);
  if (m.source) f.set('src:' + m.source, FW.src);
  return f;
}

/** TF-IDF item embeddings, L2-normalised. */
export function embed(pool) {
  const raw = new Map(pool.map((m) => [m.id, rawFeatures(m)]));
  const df = new Map();
  for (const f of raw.values()) for (const k of f.keys()) df.set(k, (df.get(k) || 0) + 1);
  const N = raw.size;
  // Dampened IDF: rare tags still matter, but one obscure shared tag can't dominate a match.
  const idf = (k) => 1 + 0.6 * Math.log((N + 1) / ((df.get(k) || 0) + 1));
  const vecs = new Map();
  for (const [id, f] of raw) {
    const v = new Map();
    let n = 0;
    for (const [k, w] of f) {
      const x = w * idf(k);
      v.set(k, x);
      n += x * x;
    }
    n = Math.sqrt(n) || 1;
    for (const [k, x] of v) v.set(k, x / n);
    vecs.set(id, v);
  }
  return { vecs, idf };
}

export function cosine(a, b) {
  if (!a || !b) return 0;
  if (a.size > b.size) [a, b] = [b, a];
  let dot = 0;
  for (const [k, x] of a) {
    const y = b.get(k);
    if (y) dot += x * y;
  }
  return dot; // vectors are unit length (or the taste vector is normalised by the caller)
}

/** Maximal Marginal Relevance: trade relevance against similarity to what's already picked. */
export function mmr(cands, vecs, k, lambda = 0.72) {
  const picked = [];
  const rest = cands.slice();
  const maxSim = new Map();
  while (picked.length < k && rest.length) {
    let bi = 0;
    let best = -Infinity;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      const v = lambda * c.score - (1 - lambda) * (maxSim.get(c.id) || 0);
      if (v > best) {
        best = v;
        bi = i;
      }
    }
    const [p] = rest.splice(bi, 1);
    picked.push(p);
    const pv = vecs.get(p.id);
    for (const c of rest) maxSim.set(c.id, Math.max(maxSim.get(c.id) || 0, cosine(pv, vecs.get(c.id))));
  }
  return picked;
}

// Beta(a, b) sampling via two Gamma draws (Marsaglia–Tsang).
function gamma(k) {
  if (k < 1) return gamma(1 + k) * Math.random() ** (1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      const u1 = Math.random() || 1e-12;
      const u2 = Math.random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const beta = (a, b) => {
  const x = gamma(a);
  return x / (x + gamma(b));
};

/** Franchise key: two titles are the same franchise when one normalised title prefixes the other. */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function sameFranchise(a, b) {
  for (const x of [norm(a.title?.romaji), norm(a.title?.english)])
    for (const y of [norm(b.title?.romaji), norm(b.title?.english)]) {
      if (!x || !y) continue;
      const [s, l] = x.length <= y.length ? [x, y] : [y, x];
      if (s.length >= 5 && (l === s || l.startsWith(s + ' '))) return true;
    }
  return false;
}

/* =========================================================================================
   2–4. The pipeline
   ========================================================================================= */

const EMPTY = { ready: false, picks: [], because: [], sequels: [], match: new Map(), reason: new Map(), taste: [], genres: [] };
const RKEY = 'yoru:recs:result:v1';
const RTTL = 6 * 3600 * 1000;
let memo = null; // { sig, promise }

const WHY = { watched: 'watched', loved: 'loved', liked: 'liked', saved: 'saved', viewed: 'checked out' };

function signature(pos, neg) {
  return JSON.stringify([pos.map((a) => [a.id, Math.round(a.aff * 4) / 4]), neg.map((a) => a.id)]);
}

/** Recommendations for the current profile. Memoised; recomputed when the profile meaningfully changes. */
export function recommend() {
  const A = affinities();
  const pos = [...A.values()].filter((a) => a.aff > 0.25).sort((a, b) => b.aff - a.aff).slice(0, 20);
  const neg = [...A.values()].filter((a) => a.aff < -0.4).sort((a, b) => a.aff - b.aff).slice(0, 6);
  if (!pos.length) return Promise.resolve(EMPTY);
  const sig = signature(pos, neg);
  if (memo?.sig === sig) return memo.promise;
  const promise = fromCache(sig) || compute(A, pos, neg).then((r) => (toCache(sig, r), r));
  memo = { sig, promise: promise.catch((e) => ((memo = null), Promise.reject(e))) };
  return memo.promise;
}

export const peek = () => memo?.value || null;

async function compute(A, pos, neg) {
  const engaged = new Set(A.keys());
  const strong = new Set([...A.values()].filter((a) => a.why !== 'viewed').map((a) => a.id));

  // Stage 1a — one hop out from every seed (with relations, for sequels).
  const seeds = [...pos, ...neg];
  const hop1 = await api.recGraph(seeds.map((a) => a.id), { relations: true });
  const graph = addEdges(new Map(), hop1);
  const restart = (list) => {
    const tot = list.reduce((s, a) => s + Math.abs(a.aff), 0) || 1;
    return new Map(list.map((a) => [a.id, Math.abs(a.aff) / tot]));
  };
  const rPos = restart(pos);
  const walk1 = ppr(graph, rPos);
  const firstHop = [...walk1].filter(([id]) => !engaged.has(id)).sort((a, b) => b[1] - a[1]);

  // Sequels of things the viewer actually watched or loved.
  const sequelIds = [];
  for (const n of hop1) {
    const a = A.get(n.id);
    if (!a || !(a.completion >= 0.8)) continue;
    for (const e of n.relations?.edges || [])
      if (e.relationType === 'SEQUEL' && e.node.type === 'ANIME' && e.node.status !== 'NOT_YET_RELEASED' && !strong.has(e.node.id)) sequelIds.push(e.node.id);
  }

  // Stage 1b — second hop from the strongest neighbours; hydrate seeds + first-hop shortlist meanwhile.
  const hop2Ids = firstHop.slice(0, 24).map(([id]) => id);
  const [hop2, seedItems] = await Promise.all([
    api.recGraph(hop2Ids).catch(() => []),
    getItems([...seeds.map((a) => a.id), ...firstHop.slice(0, 140).map(([id]) => id), ...sequelIds]),
  ]);
  addEdges(graph, hop2);

  // Taste vector needs seed features: provisional embedding over what we have so far → top genres/tags for content candidates.
  const provisional = taste(A, seeds, seedItems, embed([...seedItems.values()]).vecs);
  const contentIds = await api.recContent({ genres: provisional.genres, tags: provisional.tags }).catch(() => []);

  // Full walk over the expanded graph (positive and negative restarts).
  const walkPos = ppr(graph, rPos);
  const walkNeg = neg.length ? ppr(graph, restart(neg)) : new Map();
  const shortlist = [...walkPos]
    .filter(([id]) => !strong.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 260)
    .map(([id]) => id);
  const itemMap = await getItems([...new Set([...seedItems.keys(), ...shortlist, ...contentIds])]);

  // Embeddings over the whole pool so IDF reflects the candidate distribution.
  const pool = [...itemMap.values()];
  const { vecs, idf } = embed(pool);
  const u = taste(A, seeds, itemMap, vecs);

  // Exploration: sample a click-through rate per genre from its Beta posterior.
  const bandit = banditStats();
  const theta = new Map();
  const sampleG = (g) => {
    if (!theta.has(g)) {
      const [c, n] = bandit[g] || [0, 0];
      theta.set(g, beta(1 + c, 1 + Math.max(0, n - c)));
    }
    return theta.get(g);
  };

  const pop = (m) => Math.max(m.popularity || 0, 800);
  const BETA = 0.35;
  const seedSet = new Set(seeds.map((a) => a.id));
  const cands = pool.filter((m) => !strong.has(m.id) && !seedSet.has(m.id) &&!m.isAdult && m.status !== 'NOT_YET_RELEASED' && !(A.get(m.id)?.aff < 0));
  let gMax = 1e-12;
  let nMax = 1e-12;
  let cMax = 1e-12;
  const raw = cands.map((m) => {
    const g = (walkPos.get(m.id) || 0) / pop(m) ** BETA;
    const n = (walkNeg.get(m.id) || 0) / pop(m) ** BETA;
    const c = Math.max(0, cosine(u.vec, vecs.get(m.id)));
    gMax = Math.max(gMax, g);
    nMax = Math.max(nMax, n);
    cMax = Math.max(cMax, c);
    return { m, g, n, c };
  });

  const C = 68; // prior mean score
  const M = 15000; // prior weight in "votes" (popularity as a proxy)
  const scored = raw.map(({ m, g, n, c }) => {
    const gn = g / gMax;
    const cn = c / cMax;
    const qn = m.averageScore ? Math.min(1, Math.max(0, ((pop(m) * m.averageScore + M * C) / (pop(m) + M) - 55) / 35)) : 0.3;
    const pn = Math.min(1, Math.max(0, (Math.log10(pop(m)) - 3) / 3));
    const gs = m.genres?.length ? m.genres.reduce((s, x) => s + sampleG(x), 0) / m.genres.length : 0.5;
    const score = 0.42 * gn + 0.33 * cn + 0.12 * qn + 0.05 * pn + 0.08 * gs - 0.3 * (n / nMax);
    const match = Math.round(Math.min(99, 58 + 41 * Math.sqrt(Math.max(0, 0.55 * gn + 0.45 * cn))));
    return { id: m.id, m, score, gn, cn, match };
  });
  scored.sort((a, b) => b.score - a.score);

  // Franchise collapse: keep one entry per franchise (the earliest release), and skip franchises the viewer already knows.
  const seen = [];
  const known = seeds.map((a) => itemMap.get(a.id) || a.m).filter(Boolean);
  const year = (m) => (m.startDate?.year || 9999) * 100 + (m.startDate?.month || 12);
  const collapsed = [];
  for (const s of scored) {
    if (known.some((k) => sameFranchise(k, s.m))) continue;
    const j = seen.findIndex((x) => sameFranchise(x.m, s.m));
    if (j === -1) {
      seen.push(s);
      collapsed.push(s);
    } else if (year(s.m) < year(seen[j].m)) {
      // Earlier entry inherits the stronger score but takes the slot.
      const k = collapsed.indexOf(seen[j]);
      const swapIn = { ...s, score: Math.max(s.score, seen[j].score), match: Math.max(s.match, seen[j].match) };
      collapsed[k] = swapIn;
      seen[j] = swapIn;
    }
  }

  const picks = mmr(collapsed.slice(0, 80), vecs, 24, 0.68);

  // Explanations: the seed contributing most to each pick (direct graph edge × affinity, else content similarity).
  const reason = new Map();
  const seedList = pos.filter((a) => a.why !== 'viewed' || pos.length < 3);
  for (const s of collapsed.slice(0, 120)) {
    let best = null;
    let bv = 0;
    for (const a of seedList) {
      const w = graph.get(a.id)?.get(s.id) || 0;
      const v = w ? w * a.aff : 0.35 * cosine(vecs.get(a.id), vecs.get(s.id)) * a.aff;
      if (v > bv) {
        bv = v;
        best = a;
      }
    }
    if (best) reason.set(s.id, `Because you ${WHY[best.why] || 'watched'} ${titleOf(itemMap.get(best.id) || best.m)}`);
  }

  // "Because you watched X" rows: direct neighbours of the strongest seeds, ranked by the full model.
  const byId = new Map(collapsed.map((s) => [s.id, s]));
  const used = new Set();
  const because = [];
  for (const a of pos.filter((x) => x.why !== 'viewed')) {
    if (because.length >= 3) break;
    const nb = graph.get(a.id);
    if (!nb) continue;
    const list = [...nb.keys()]
      .map((id) => byId.get(id))
      .filter((s) => s && !used.has(s.id))
      .sort((x, y) => y.score - x.score)
      .slice(0, 16);
    if (list.length < 5) continue;
    list.forEach((s) => used.add(s.id));
    because.push({ seed: itemMap.get(a.id) || a.m, why: a.why, items: list.map((s) => s.m) });
  }

  const sequels = [...new Set(sequelIds)].map((id) => itemMap.get(id)).filter((m) => m && !m.isAdult && ['TV', 'ONA', 'MOVIE', 'TV_SHORT'].includes(m.format));

  return {
    ready: true,
    picks: picks.map((s) => s.m),
    because,
    sequels,
    match: new Map(collapsed.map((s) => [s.id, s.match])),
    reason,
    taste: describeTaste(pos, itemMap),
    genres: u.genres,
    seeds: pos.length,
  };
}

/** Rocchio-style taste vector: Σ affinity × item embedding (negatives subtract), unit-normalised. */
function taste(A, seeds, itemMap, vecs) {
  const acc = new Map();
  for (const a of seeds) {
    const v = vecs.get(a.id);
    if (!v) continue;
    for (const [k, x] of v) acc.set(k, (acc.get(k) || 0) + a.aff * x);
  }
  let n = 0;
  for (const x of acc.values()) n += x * x;
  n = Math.sqrt(n) || 1;
  for (const [k, x] of acc) acc.set(k, x / n);
  const top = (p) => [...acc].filter(([k, x]) => k.startsWith(p) && x > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k.slice(p.length));
  return { vec: acc, genres: top('g:').slice(0, 6), tags: top('t:').slice(0, 6) };
}

// Cast/setting descriptors that are true of half the catalogue; useful to the model, meaningless as a "taste".
const GENERIC = new Set(['Male Protagonist', 'Female Protagonist', 'Heterosexual', 'Primarily Adult Cast', 'Primarily Teen Cast', 'Primarily Female Cast', 'Primarily Male Cast', 'Primarily Child Cast', 'Ensemble Cast', 'Urban', 'Japan', 'Rural', 'Episodic', 'Adoption', 'Coming of Age']);

/** What the profile has learned, in plain words: raw (un-IDF'd) features of positive seeds, weighted by affinity. */
function describeTaste(pos, itemMap) {
  const acc = new Map();
  for (const a of pos) {
    const m = itemMap.get(a.id);
    if (!m) continue;
    for (const [k, w] of rawFeatures(m)) if (/^(g|t|s):/.test(k)) acc.set(k, (acc.get(k) || 0) + a.aff * w);
  }
  const top = (p, n) => [...acc].filter(([k]) => k.startsWith(p) && !GENERIC.has(k.slice(2))).sort((a, b) => b[1] - a[1]).slice(0, n);
  const max = Math.max(...[...acc.values()], 1e-9);
  return [...top('g:', 5), ...top('t:', 6), ...top('s:', 2)].map(([k, x]) => ({ kind: { g: 'genre', t: 'theme', s: 'studio' }[k[0]], name: k.slice(2), w: x / max }));
}

/* ---------- Result cache (so returning visits are instant) ---------- */

function toCache(sig, r) {
  memo && (memo.value = r);
  try {
    localStorage.setItem(
      RKEY,
      JSON.stringify({
        t: Date.now(),
        sig,
        r: { ...r, picks: r.picks.map((m) => m.id), sequels: r.sequels.map((m) => m.id), because: r.because.map((b) => ({ ...b, items: b.items.map((m) => m.id) })), match: [...r.match], reason: [...r.reason] },
      })
    );
  } catch {}
}

function fromCache(sig) {
  try {
    const c = JSON.parse(localStorage.getItem(RKEY));
    if (!c || c.sig !== sig || Date.now() - c.t > RTTL) return null;
    const get = (id) => items[id]?.m;
    const ok = (list) => list.map(get).filter(Boolean);
    const r = {
      ...c.r,
      picks: ok(c.r.picks),
      sequels: ok(c.r.sequels),
      because: c.r.because.map((b) => ({ ...b, items: ok(b.items) })),
      match: new Map(c.r.match),
      reason: new Map(c.r.reason),
    };
    if (r.picks.length < 6) return null;
    return Promise.resolve(r).then((x) => (memo && (memo.value = x), x));
  } catch {
    return null;
  }
}

export function resetRecs() {
  memo = null;
  try {
    localStorage.removeItem(RKEY);
  } catch {}
}

/** Match % for a title from the latest computed recommendations (null when unknown). */
export const matchOf = (id) => peek()?.match.get(id) ?? null;
export const reasonOf = (id) => peek()?.reason.get(id) ?? null;
