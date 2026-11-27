// Small, dependency-free helpers shared across the app.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const icon = (name, cls = '') =>
  `<svg class="i ${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Ambient (autoplaying) trailers: off for reduced motion and when the browser asks to save data.
export const ambientVideo = () => !reducedMotion() && !navigator.connection?.saveData;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Media field helpers ---------- */

export const titleOf = (m) => m?.title?.english || m?.title?.userPreferred || m?.title?.romaji || 'Untitled';
export const nativeOf = (m) => m?.title?.native || '';
export const poster = (m) => m?.coverImage?.extraLarge || m?.coverImage?.large || '';
export const tint = (m) => m?.coverImage?.color || '#3b3a42';
export const ytId = (m) => (m?.trailer?.site === 'youtube' && m.trailer.id ? m.trailer.id.trim() : null);
export const ytThumb = (id, q = 'maxresdefault') => `https://i.ytimg.com/vi/${id}/${q}.jpg`;
export const score = (m) => (m?.averageScore ? (m.averageScore / 10).toFixed(1) : null);
export const yearOf = (m) => m?.seasonYear || m?.startDate?.year || '';

const FORMATS = { TV: 'Series', TV_SHORT: 'Short', MOVIE: 'Film', SPECIAL: 'Special', OVA: 'OVA', ONA: 'Series', MUSIC: 'Music' };
export const formatOf = (m) => FORMATS[m?.format] || '';

export function runtime(m) {
  if (!m) return '';
  if (m.format === 'MOVIE' && m.duration) {
    const h = Math.floor(m.duration / 60);
    const mm = m.duration % 60;
    return h ? `${h}h ${mm}m` : `${mm}m`;
  }
  const eps = m.episodes || (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : 0);
  return eps > 0 ? `${eps} Episode${eps === 1 ? '' : 's'}` : '';
}

export function statusOf(m) {
  return { RELEASING: 'Airing', NOT_YET_RELEASED: 'Coming Soon', HIATUS: 'On Hiatus', CANCELLED: 'Cancelled' }[m?.status] || '';
}

export function cleanDesc(html = '') {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(String(html).replace(/<br\s*\/?>/gi, '\n'), 'text/html');
  const text = (doc.body.textContent || '')
    .replace(/\((?:source|sources)\s*:[^)]*\)/gi, '')
    .replace(/\[written by[^\]]*\]/gi, '')
    .replace(/\r/g, '');
  return text
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter((p) => p && !/^notes?\s*:/i.test(p) && !/^-+$/.test(p))
    .join('\n\n');
}

export const paras = (text) => text.split('\n\n').map((p) => `<p>${esc(p)}</p>`).join('');

// Choose the best still for wide surfaces (hero, modal, previews).
// YouTube maxres frames are 1280×720 and look far better than AniList's 1900×400 banners when enlarged,
// but they don't always exist — the placeholder YouTube serves is 120×90, so check the decoded size.
export function wideStill(img, m, { preferBanner = false } = {}) {
  const id = ytId(m);
  const chain = [];
  if (preferBanner && m.bannerImage) chain.push(m.bannerImage);
  if (id) chain.push(ytThumb(id, 'maxresdefault'));
  if (m.bannerImage && !preferBanner) chain.push(m.bannerImage);
  if (id) chain.push(ytThumb(id, 'hqdefault'));
  chain.push(poster(m));
  let i = 0;
  const next = () => {
    if (i >= chain.length) return;
    img.src = chain[i++];
  };
  img.onload = () => {
    if (img.naturalWidth < 200 && i < chain.length) return next();
    img.classList.add('ok');
  };
  img.onerror = next;
  next();
}

/* ---------- Time ---------- */

export function until(sec) {
  if (sec <= 0) return 'now';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export const fmtTime = (ts) =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(ts * 1000));

export const fmtDate = (d) => {
  if (!d?.year) return '';
  const date = new Date(d.year, (d.month || 1) - 1, d.day || 1);
  const opts = d.day ? { month: 'short', day: 'numeric', year: 'numeric' } : d.month ? { month: 'long', year: 'numeric' } : { year: 'numeric' };
  return new Intl.DateTimeFormat(undefined, opts).format(date);
};

/* ---------- Streaming links ---------- */

const STREAM_RANK = ['Crunchyroll', 'Netflix', 'HIDIVE', 'Amazon Prime Video', 'Disney Plus', 'Hulu', 'Max', 'Bilibili TV', 'YouTube'];
const rank = (s) => {
  const i = STREAM_RANK.indexOf(s);
  return i === -1 ? 99 : i;
};
export function streams(m) {
  const seen = new Set();
  return (m?.externalLinks || [])
    .filter((l) => l.type === 'STREAMING' && !seen.has(l.site) && seen.add(l.site))
    .map((l) => ({ ...l, url: l.url.replace(/^http:/, 'https:') }))
    .sort((a, b) => rank(a.site) - rank(b.site));
}

/* ---------- Preferences ---------- */

export const prefs = {
  get muted() {
    try {
      return localStorage.getItem('yoru:muted') !== '0';
    } catch {
      return true;
    }
  },
  set muted(v) {
    try {
      localStorage.setItem('yoru:muted', v ? '1' : '0');
    } catch {}
    dispatchEvent(new CustomEvent('yoru:muted', { detail: v }));
  },
};

/* ---------- Overlay stack (Esc handling + pausing background media) ---------- */

const layers = [];
export const overlay = {
  push(onEscape) {
    const entry = { onEscape };
    layers.push(entry);
    dispatchEvent(new CustomEvent('yoru:overlay', { detail: layers.length }));
    return () => {
      const i = layers.indexOf(entry);
      if (i > -1) layers.splice(i, 1);
      dispatchEvent(new CustomEvent('yoru:overlay', { detail: layers.length }));
    };
  },
  get depth() {
    return layers.length;
  },
};
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && layers.length) {
    e.preventDefault();
    layers[layers.length - 1].onEscape?.();
  }
});

let locks = 0;
export function lockScroll() {
  if (locks++ === 0) document.documentElement.classList.add('locked');
  return () => {
    if (--locks === 0) document.documentElement.classList.remove('locked');
  };
}

/* ---------- Toast ---------- */

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.innerHTML = `<span class="seal seal-xs" aria-hidden="true">夜</span><span>${esc(msg)}</span>`;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
