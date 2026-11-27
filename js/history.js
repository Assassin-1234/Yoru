// Viewing history: per-episode progress, Continue Watching, ratings and the implicit
// signals (opens, previews, trailers) that feed the recommender. Stored on this device.
import { $$, titleOf, toast } from './util.js';
import { airedCount } from './sources.js';

const KEY = 'yoru:watch:v1';
const FIELDS = ['id', 'title', 'coverImage', 'bannerImage', 'format', 'episodes', 'duration', 'status', 'season', 'seasonYear', 'startDate', 'averageScore', 'popularity', 'genres', 'trailer', 'nextAiringEpisode'];
export const DONE_AT = 0.92; // fraction of runtime after which an episode counts as watched

const blank = () => ({ titles: {}, ratings: {}, signals: {}, bandit: {} });
let db = blank();
try {
  db = { ...blank(), ...JSON.parse(localStorage.getItem(KEY)) };
} catch {}

let saveTimer = 0;
function persist(now = false) {
  clearTimeout(saveTimer);
  const write = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch {}
  };
  if (now) write();
  else saveTimer = setTimeout(write, 400);
}
addEventListener('pagehide', () => persist(true));

const emit = (id) => dispatchEvent(new CustomEvent('yoru:history', { detail: { id } }));
const snap = (m) => Object.fromEntries(FIELDS.filter((k) => k in m).map((k) => [k, m[k]]));

function entry(m) {
  const e = (db.titles[m.id] ||= { m: snap(m), eps: {}, last: 1, t: 0 });
  e.m = { ...e.m, ...snap(m) };
  return e;
}

/* ---------- Progress ---------- */

/** Record playback position for episode n. Call often; it's cheap. */
export function saveProgress(m, n, pos, dur, { credits, thumb } = {}) {
  if (!m?.id || !(dur > 0)) return;
  const e = entry(m);
  const ep = (e.eps[n] ||= { p: 0, d: dur, w: 0, done: false });
  ep.p = pos;
  ep.d = dur;
  ep.w = Date.now();
  if (thumb) ep.th = thumb;
  if (!ep.done && (pos / dur >= DONE_AT || (credits && pos >= credits))) {
    ep.done = true;
    ep.doneAt = Date.now();
  }
  e.last = n;
  e.t = Date.now();
  e.hidden = false;
  persist();
  emit(m.id);
}

export function markWatched(m, n, done = true) {
  const e = entry(m);
  const ep = (e.eps[n] ||= { p: 0, d: 0, w: Date.now(), done: false });
  ep.done = done;
  if (done) ep.doneAt = Date.now();
  else ep.p = 0;
  e.t = Date.now();
  persist();
  emit(m.id);
}

export const titleState = (id) => db.titles[id] || null;
export const episodeState = (id, n) => db.titles[id]?.eps?.[n] || null;
export const watchedCount = (id) => Object.values(db.titles[id]?.eps || {}).filter((e) => e.done).length;

/**
 * Where should "Play" take the viewer?
 * → { ep, pos, pct, label, resume }  — resume = true when picking up mid-episode.
 */
export function resumePoint(m) {
  const e = db.titles[m?.id];
  const aired = airedCount(m);
  if (!e) return { ep: 1, pos: 0, pct: 0, resume: false, label: 'Play' };
  const last = e.eps[e.last];
  if (last && !last.done && last.p > 15) {
    return { ep: e.last, pos: last.p, pct: last.p / last.d, resume: true, left: Math.max(0, last.d - last.p), label: m.format === 'MOVIE' ? 'Resume' : `Resume E${e.last}` };
  }
  // Next unwatched episode after the last one touched.
  const next = last?.done ? e.last + 1 : e.last;
  if (next <= aired) return { ep: next, pos: 0, pct: 0, resume: false, label: next === 1 ? 'Play' : `Play E${next}` };
  return { ep: 1, pos: 0, pct: 0, resume: false, label: m.format === 'MOVIE' || aired <= 1 ? 'Watch Again' : 'Play E1', rewatch: true };
}

/** Titles in progress, most recent first. A finished series drops off unless new episodes have aired. */
export function continueWatching() {
  return Object.values(db.titles)
    .filter((e) => !e.hidden && e.t)
    .map((e) => ({ e, r: resumePoint(e.m) }))
    .filter(({ r }) => !r.rewatch)
    .sort((a, b) => b.e.t - a.e.t)
    .map(({ e, r }) => ({ m: e.m, ...r, epState: e.eps[r.ep] || null }));
}

/** Titles the viewer finished (every aired episode watched). */
export function finished() {
  return Object.values(db.titles)
    .filter((e) => {
      const aired = airedCount(e.m);
      return aired > 0 && Object.values(e.eps).filter((x) => x.done).length >= aired;
    })
    .sort((a, b) => b.t - a.t)
    .map((e) => e.m);
}

export function hideFromContinue(id) {
  if (!db.titles[id]) return;
  db.titles[id].hidden = true;
  persist();
  emit(id);
}

/** Full activity log, newest first: one row per episode touched. */
export function activity() {
  const rows = [];
  for (const e of Object.values(db.titles))
    for (const [n, ep] of Object.entries(e.eps)) if (ep.w) rows.push({ m: e.m, n: Number(n), ...ep });
  return rows.sort((a, b) => b.w - a.w);
}

export function forgetTitle(id) {
  delete db.titles[id];
  delete db.signals[id];
  persist();
  emit(id);
}

export function clearHistory() {
  db = blank();
  persist(true);
  emit(null);
}

/* ---------- Ratings (thumbs) ---------- */

// -1 = not for me, 1 = I like this, 2 = love this
export const ratingOf = (id) => db.ratings[id]?.v || 0;

export function rate(m, v) {
  if (!m?.id) return;
  const prev = ratingOf(m.id);
  if (prev === v) delete db.ratings[m.id];
  else {
    db.ratings[m.id] = { v, t: Date.now() };
    entry(m); // keep a snapshot so the profile can show it
    if (!db.titles[m.id].t) db.titles[m.id].hidden = true;
  }
  persist();
  const now = ratingOf(m.id);
  $$(`[data-rate-box="${m.id}"]`).forEach((b) => (b.dataset.v = String(now)));
  toast(now === 2 ? `Love it — we'll find more like “${titleOf(m)}”` : now === 1 ? 'Thanks — your picks will reflect this' : now === -1 ? `Got it — fewer like “${titleOf(m)}”` : 'Rating removed');
  emit(m.id);
}

/* ---------- Implicit signals ---------- */

// o = opened details, p = watched a hover preview, tr = played the trailer
export function signal(m, kind) {
  if (!m?.id) return;
  const s = (db.signals[m.id] ||= { o: 0, p: 0, tr: 0, t: 0 });
  s[kind] = (s[kind] || 0) + 1;
  s.t = Date.now();
  // Snapshot so seeds can be described ("Because you looked at …") without refetching.
  s.m = snap(m);
  banditClick(m);
  persist();
}

export const signals = () => db.signals;
export const ratings = () => db.ratings;
export const titles = () => db.titles;

/* ---------- Exploration statistics (Thompson sampling over genres) ---------- */

const shown = new Set();
export function banditImpressions(list) {
  for (const m of list) {
    if (shown.has(m.id)) continue;
    shown.add(m.id);
    for (const g of m.genres || []) (db.bandit[g] ||= [0, 0])[1]++;
  }
  persist();
}
function banditClick(m) {
  if (!shown.has(m.id)) return;
  for (const g of m.genres || []) {
    const b = (db.bandit[g] ||= [0, 0]);
    b[0] = Math.min(b[0] + 1, b[1]);
  }
}
export const banditStats = () => db.bandit;
