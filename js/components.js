import { esc, icon, titleOf, poster, tint, score, yearOf, formatOf, runtime, wideStill } from './util.js';
import { inList } from './store.js';
import { ratingOf, resumePoint, titleState } from './history.js';
import { matchOf } from './recs.js';
import { watchHref } from './nav.js';

/* Every media object rendered anywhere is remembered here, so previews, the modal
   and list toggles can work instantly from an id. */
export const media = new Map();
export function remember(list) {
  for (const m of list || []) if (m?.id) media.set(m.id, { ...media.get(m.id), ...m });
  return list || [];
}

export const top10 = new Set();

export const GENRES = [
  ['Action', '戦', '#ff4a2b'],
  ['Romance', '恋', '#ff5d8f'],
  ['Fantasy', '幻', '#8f7cff'],
  ['Psychological', '心', '#3fc1b0'],
  ['Comedy', '笑', '#ffb92e'],
  ['Sci-Fi', '宙', '#3f8cff'],
  ['Slice of Life', '日', '#94cf5c'],
  ['Mystery', '謎', '#b07bff'],
  ['Sports', '競', '#ff8a2b'],
  ['Supernatural', '霊', '#52d6f0'],
  ['Drama', '劇', '#e6a463'],
  ['Adventure', '旅', '#32c98a'],
  ['Horror', '怖', '#d43a46'],
  ['Mecha', '機', '#9aa6ba'],
  ['Thriller', '緊', '#e7e1d4'],
  ['Music', '音', '#ff6fd8'],
];
export const genreMeta = (g) => GENRES.find(([n]) => n.toLowerCase() === String(g).toLowerCase());

/* ---------- Atoms ---------- */

export function listButton(m, cls = 'cbtn') {
  const on = inList(m.id);
  return `<button class="${cls} ${on ? 'on' : ''}" data-list="${m.id}" aria-pressed="${on}" aria-label="${on ? 'Remove from' : 'Add to'} My List" title="My List">
    ${icon('plus', 'ic-add')}${icon('check', 'ic-on')}</button>`;
}

/* Thumbs rating: one button that fans out into "Not for me / I like this / Love this!" on hover or focus. */
export function rateBox(m, cls = '') {
  const v = ratingOf(m.id);
  return `<span class="rate ${cls}" data-rate-box="${m.id}" data-v="${v}">
    <button class="cbtn rate-main" aria-label="Rate this title" aria-haspopup="true">${icon('thumb-up', 'r-up')}${icon('thumb-down', 'r-down')}${icon('thumbs-love', 'r-love')}</button>
    <span class="rate-pop" role="group" aria-label="Rate">
      <button data-rate="-1" aria-label="Not for me" title="Not for me">${icon('thumb-down')}</button>
      <button data-rate="1" aria-label="I like this" title="I like this">${icon('thumb-up')}</button>
      <button data-rate="2" aria-label="Love this!" title="Love this!">${icon('thumbs-love')}</button>
    </span>
  </span>`;
}

// Thin progress bar for titles the viewer is partway through.
function progressBar(m) {
  const st = titleState(m.id);
  if (!st?.t || st.hidden) return '';
  const r = resumePoint(m);
  return r.resume ? `<span class="card-prog" aria-hidden="true"><i style="width:${Math.round(r.pct * 100)}%"></i></span>` : '';
}

function badge(m) {
  if (m.status === 'NOT_YET_RELEASED') return `<span class="badge badge-soon">Coming Soon</span>`;
  if (m.status === 'RELEASING' && m.nextAiringEpisode?.episode > 1) return `<span class="badge">New Episode</span>`;
  return '';
}

const topMark = (m) => (top10.has(m.id) ? `<span class="badge-top" aria-label="Top 10"><small>TOP</small>10</span>` : '');

export function card(m, { lazy = true, top = true } = {}) {
  return `<a class="card" href="#/?t=${m.id}" data-open="${m.id}" data-pv="${m.id}" style="--c:${tint(m)}" aria-label="${esc(titleOf(m))}">
    <img src="${esc(poster(m))}" alt="" ${lazy ? 'loading="lazy"' : ''} decoding="async" draggable="false">
    ${top ? topMark(m) : ''}${badge(m)}${progressBar(m)}
  </a>`;
}

export function gridCell(m, i = 0) {
  const meta = [yearOf(m), formatOf(m)].filter(Boolean).join(' · ');
  return `<div class="cell" style="--i:${i % 12}">
    ${card(m)}
    <div class="cell-cap"><strong>${esc(titleOf(m))}</strong><small>${esc(meta)}</small></div>
  </div>`;
}

export const metaLine = (m, { genres = false, match = true } = {}) => {
  const s = score(m);
  const mt = match ? matchOf(m.id) : null;
  const bits = [
    mt && mt >= 60 && `<span class="match">${mt}% match</span>`,
    s && `<span class="score">${icon('star')} ${s}</span>`,
    yearOf(m) && `<span>${yearOf(m)}</span>`,
    formatOf(m) && `<span class="chip">${formatOf(m)}</span>`,
    runtime(m) && `<span>${runtime(m)}</span>`,
    `<span class="chip chip-hd">HD</span>`,
  ];
  let html = `<div class="meta">${bits.filter(Boolean).join('')}</div>`;
  if (genres && m.genres?.length)
    html += `<div class="dots">${m.genres.slice(0, 3).map((g) => `<span>${esc(g)}</span>`).join('')}</div>`;
  return html;
};

/* ---------- Rows ---------- */

// Fill <img data-still=id> with the best wide still for that title (call after inserting markup).
export function hydrateStills(root) {
  root.querySelectorAll('img[data-still]:not([src])').forEach((img) => {
    const m = media.get(Number(img.dataset.still));
    if (m) wideStill(img, m);
  });
  // Episode thumbnails that fail fall back to the title's still.
  root.querySelectorAll('img[data-fallback]').forEach((img) => {
    img.onerror = () => {
      img.onerror = null;
      const m = media.get(Number(img.dataset.fallback));
      if (m) wideStill(img, m);
    };
  });
}

/* Continue Watching: landscape cards that resume playback directly. */
export function continueRow(title, list, opts = {}) {
  if (!list?.length) return '';
  remember(list.map((x) => x.m));
  const inner = list
    .map(({ m, ep, pct, left, resume, label, epState }) => {
      const movie = m.format === 'MOVIE';
      const sub = resume ? `${movie ? '' : `E${ep} · `}${Math.max(1, Math.round(left / 60))}m left` : movie ? 'Start watching' : `Up next: E${ep}`;
      return `<div class="cw" style="--c:${tint(m)}">
        <a class="cw-card" href="${watchHref(m.id, ep)}" data-play="${m.id}" data-ep="${ep}" aria-label="${esc(`${label} ${titleOf(m)}`)}">
          ${epState?.th ? `<img alt="" src="${esc(epState.th)}" data-fallback="${m.id}" draggable="false">` : `<img alt="" data-still="${m.id}" draggable="false">`}
          <span class="cw-play" aria-hidden="true">${icon('play')}</span>
          <span class="cw-prog" aria-hidden="true"><i style="width:${Math.round((pct || 0) * 100)}%"></i></span>
        </a>
        <div class="cw-meta">
          <span class="cw-text"><strong>${esc(titleOf(m))}</strong><small>${esc(sub)}</small></span>
          <button class="cw-btn" data-open="${m.id}" aria-label="Details">${icon('info')}</button>
          <button class="cw-btn" data-cw-hide="${m.id}" aria-label="Remove from row">${icon('x')}</button>
        </div>
      </div>`;
    })
    .join('');
  return shell(esc(title), inner, { ...opts, cls: 'row-cw' });
}

function shell(title, inner, { cls = '', more = '', i = 0, sub = '' } = {}) {
  return `<section class="row ${cls}" data-row style="--i:${i}">
    <header class="row-head">
      <h2>${title}</h2>${sub ? `<span class="row-sub">${sub}</span>` : ''}
      ${more ? `<a class="row-more" href="${more}">Explore all ${icon('chevron-right')}</a>` : ''}
      <div class="row-pager" aria-hidden="true"></div>
    </header>
    <div class="row-body">
      <button class="row-arrow prev" aria-label="Scroll left" hidden>${icon('chevron-left')}</button>
      <div class="row-track">${inner}</div>
      <button class="row-arrow next" aria-label="Scroll right">${icon('chevron-right')}</button>
    </div>
  </section>`;
}

export const row = (title, items, opts = {}) =>
  items?.length ? shell(esc(title), remember(items).map((m) => card(m, { top: opts.top !== false })).join(''), opts) : '';

export function top10Row(title, items, opts = {}) {
  const list = remember(items).slice(0, 10);
  list.forEach((m) => top10.add(m.id));
  const inner = list
    .map(
      (m, i) => `<div class="t10">
        <svg class="t10-num ${i === 9 ? 'two' : ''}" viewBox="0 0 100 140" aria-hidden="true"><text x="100" y="134" text-anchor="end">${i + 1}</text></svg>
        ${card(m, { top: false })}
      </div>`
    )
    .join('');
  return shell(esc(title), inner, { ...opts, cls: 'row-t10' });
}

export function tilesRow(title, opts = {}) {
  const href = (g) => `#/genre/${encodeURIComponent(g)}${opts.kind ? `?kind=${opts.kind}` : ''}`;
  const inner = GENRES.map(
    ([g, k, c]) => `<a class="tile" href="${href(g)}" style="--k:${c}">
      <span class="tile-k" aria-hidden="true">${k}</span>
      <span class="tile-name">${esc(g)}</span>
    </a>`
  ).join('');
  return shell(esc(title), inner, { ...opts, cls: 'row-tiles' });
}

export function skeletonRows(n = 3, start = 0) {
  return Array.from(
    { length: n },
    (_, i) => `<section class="row row-skel" style="--i:${start + i}">
      <header class="row-head"><span class="sk sk-h"></span></header>
      <div class="row-body"><div class="row-track">${'<span class="sk sk-card"></span>'.repeat(9)}</div></div>
    </section>`
  ).join('');
}

/* Arrow paging + page indicators for horizontal rows. */
export function hydrateRows(root, onScroll) {
  root.querySelectorAll('[data-row]:not([data-ready])').forEach((rowEl) => {
    rowEl.dataset.ready = '';
    const track = rowEl.querySelector('.row-track');
    const prev = rowEl.querySelector('.prev');
    const next = rowEl.querySelector('.next');
    const pager = rowEl.querySelector('.row-pager');
    const first = track.firstElementChild;
    if (!first) return;

    const metrics = () => {
      const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
      const pad = parseFloat(getComputedStyle(track).paddingLeft) || 0;
      const step = first.getBoundingClientRect().width + gap;
      const perPage = Math.max(1, Math.round((track.clientWidth - pad * 2 + gap) / step));
      return { step, perPage, pageW: perPage * step };
    };

    let pages = 1;
    const paint = () => {
      const { pageW, perPage } = metrics();
      const count = Math.ceil(track.children.length / perPage);
      if (count !== pages || !pager.children.length) {
        pages = count;
        pager.innerHTML = count > 1 ? '<i></i>'.repeat(count) : '';
      }
      const max = track.scrollWidth - track.clientWidth;
      const atEnd = track.scrollLeft >= max - 4;
      const active = atEnd ? pages - 1 : Math.round(track.scrollLeft / pageW);
      [...pager.children].forEach((d, i) => d.classList.toggle('on', i === active));
      prev.hidden = track.scrollLeft < 4;
      next.hidden = atEnd || max <= 4;
    };

    let raf = 0;
    track.addEventListener(
      'scroll',
      () => {
        onScroll?.();
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(paint);
      },
      { passive: true }
    );
    const page = (dir) => {
      const { pageW } = metrics();
      track.scrollBy({ left: dir * pageW, behavior: 'smooth' });
    };
    prev.addEventListener('click', () => page(-1));
    next.addEventListener('click', () => page(1));
    new ResizeObserver(() => requestAnimationFrame(paint)).observe(track);
    paint();
  });
}
