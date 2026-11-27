import * as api from './api.js';
import { esc, icon, titleOf, tint, poster, wideStill, cleanDesc, fmtTime, formatOf, ytId, sleep, toast } from './util.js';
import { row, top10Row, tilesRow, skeletonRows, hydrateRows, remember, top10, gridCell, GENRES, genreMeta, listButton, continueRow, hydrateStills } from './components.js';
import { heroHTML, mountHero, pickHero } from './hero.js';
import { recommend, peek, resetRecs } from './recs.js';
import { continueWatching, activity, ratings, titles, forgetTitle, clearHistory, banditImpressions } from './history.js';
import { watchPage } from './watch.js';
import { featuredIds } from './sources.js';
import { cancelPreview } from './preview.js';
import { getList } from './store.js';
import { go } from './nav.js';

/* ---------- Shared bits ---------- */

const heroSkeleton = () => `<section class="hero hero-skel" aria-hidden="true">
  <div class="hero-content">
    <span class="sk sk-kicker"></span><span class="sk sk-title"></span><span class="sk sk-title w60"></span>
    <span class="sk sk-line w70"></span><span class="sk sk-line w50"></span>
    <div class="hero-actions"><span class="sk sk-btn"></span><span class="sk sk-btn"></span></div>
  </div></section>`;

function errorState(view, retry) {
  view.innerHTML = `<div class="page empty">
    <span class="empty-k" aria-hidden="true">夜</span>
    <h1>The night went quiet.</h1>
    <p>We couldn’t reach the catalogue just now. Check your connection and try again.</p>
    <button class="btn btn-play" data-retry>${icon('replay')}<span>Try again</span></button>
  </div>`;
  view.querySelector('[data-retry]').addEventListener('click', retry);
}

const GENRE_TITLES = {
  Action: 'Pulse-Pounding Action',
  Romance: 'Romance',
  Fantasy: 'Fantasy Worlds',
  Psychological: 'Psychological Thrillers',
  'Slice of Life': 'Cozy Slice of Life',
  'Sci-Fi': 'Sci-Fi & Future Shock',
  Comedy: 'Comedies',
  Sports: 'Underdog Sports Stories',
  Mystery: 'Mysteries to Unravel',
  Supernatural: 'Supernatural',
  Drama: 'Emotional Dramas',
  Horror: 'Horror After Dark',
};

function lazyRows(view, ctx, loader) {
  const sentinel = view.querySelector('.sentinel');
  const host = view.querySelector('.lazy-rows');
  if (!sentinel || !host) return;
  const io = new IntersectionObserver(
    async ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      host.innerHTML = skeletonRows(2);
      try {
        const html = await loader();
        if (!ctx.alive()) return;
        host.innerHTML = html;
        hydrateRows(host, cancelPreview);
      } catch {
        host.innerHTML = '';
      }
    },
    { rootMargin: '1000px 0px' }
  );
  io.observe(sentinel);
  ctx.cleanups.push(() => io.disconnect());
}

const genreBlock = (rows, kind, startI) =>
  rows
    .map(({ genre, items }, k) =>
      row(kind ? `${genre} ${kind === 'films' ? 'Films' : 'Series'}` : GENRE_TITLES[genre] || genre, items, {
        i: startI + k,
        more: `#/genre/${encodeURIComponent(genre)}${kind ? `?kind=${kind}` : ''}`,
      })
    )
    .join('');

/* ---------- Home ---------- */

async function home(view, ctx) {
  view.innerHTML = heroSkeleton() + `<div class="rows">${skeletonRows(4)}</div>`;
  const recP = recommend().catch(() => null);
  // An editorially featured title (streams/catalog.json → "featured") takes the billboard when it has a trailer.
  const featP = Promise.all(featuredIds().slice(0, 3).map((id) => api.detail(id).catch(() => null))).then((list) =>
    list.find((m) => m && !m.isAdult && ytId(m) && (m.bannerImage || m.coverImage?.extraLarge))
  );
  let d;
  let feat;
  try {
    [d, feat] = await Promise.all([api.home(), featP]);
  } catch {
    if (ctx.alive()) errorState(view, () => home(view, ctx));
    return;
  }
  if (!ctx.alive()) return;
  // Use personal recommendations in the first paint when they're ready (cached) in time; otherwise slot them in.
  const early = await Promise.race([recP, sleep(650).then(() => undefined)]);
  if (!ctx.alive()) return;
  const R = early?.ready ? early : null;

  Object.values(d).forEach(remember);
  d.seasonTop.slice(0, 10).forEach((m) => top10.add(m.id));
  const cw = continueWatching();
  const pick = feat || R?.picks.find((m) => ytId(m) && m.bannerImage);
  if (pick) remember([pick]);
  const hero = pick || pickHero(d.trending);
  const rank = d.trending.indexOf(hero) + 1;
  const match = R?.match.get(hero.id);
  const kicker = feat
    ? `<b>Top pick</b> · ${match ? `${match}% match` : 'Featured on YORU'}`
    : pick
      ? `<b>${match}% match</b> · Top pick for you`
      : rank > 0 && rank <= 10
        ? `<b>#${rank}</b> in Anime Today`
        : 'Trending Now';
  const s = api.currentSeason();
  const n = api.nextSeason();
  const mine = getList();
  let i = 0;
  const slot = (name) => `<div class="slot" data-slot="${name}" style="--i:${i++}"></div>`;

  view.innerHTML =
    heroHTML(hero, kicker) +
    `<div class="rows">
      ${row('Trending Now', d.trending, { i: i++, top: false })}
      <div class="slot" data-slot="cw" style="--i:${i++}">${continueRow('Continue Watching', cw)}</div>
      ${slot('picks')}
      ${top10Row(`Top 10 Anime This Season`, d.seasonTop, { i: i++, sub: `${api.seasonName(s.season)} ${s.year}` })}
      ${slot('because0')}
      ${mine.length ? row('My List', mine, { i: i++, more: '#/list' }) : ''}
      ${slot('sequels')}
      ${row('New This Season', d.season, { i: i++, sub: `${api.seasonName(s.season)} ${s.year} simulcasts` })}
      ${slot('because1')}
      ${tilesRow('Browse by Genre', { i: i++ })}
      ${row('All-Time Favorites', d.popular, { i: i++ })}
      ${slot('because2')}
      ${row('Critically Acclaimed', d.acclaimed, { i: i++ })}
      ${row('Feature Films', d.movies, { i: i++, more: '#/films' })}
      ${row(`Coming ${api.seasonName(n.season)} ${n.year}`, d.upcoming, { i: i++, more: '#/new' })}
      <div class="lazy-rows"></div><div class="sentinel"></div>
    </div>`;

  ctx.cleanups.push(mountHero(view, hero));
  hydrateStills(view);
  hydrateRows(view, cancelPreview);

  const WHY = { saved: 'saved', watched: 'watched', loved: 'loved', liked: 'liked' };
  const fill = (r) => {
    if (!ctx.alive() || !r?.ready) return;
    const late = r !== R;
    const put = (name, html) => {
      const el = view.querySelector(`[data-slot="${name}"]`);
      if (!el || !html) return;
      el.innerHTML = html;
      hydrateRows(el, cancelPreview);
      if (late) el.animate([{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' });
    };
    const picks = r.picks.filter((m) => m.id !== hero.id);
    remember(picks);
    put('picks', row('Top Picks for You', picks, { top: false, sub: 'Tuned to what you watch and rate' }));
    r.because.forEach((b, k) => put(`because${k}`, row(`Because you ${WHY[b.why] || 'watched'} ${titleOf(b.seed)}`, b.items, { top: false })));
    put('sequels', row('Continue the Story', r.sequels, { top: false, sub: 'New seasons of shows you finished' }));
    banditImpressions(picks.slice(0, 8));
  };
  if (R) fill(R);
  else recP.then(fill);

  // Coming back from the player: refresh Continue Watching (and progress bars) in place, without re-rendering the page.
  let dirty = false;
  const onHistory = () => (dirty = true);
  const onLayer = () => {
    if (!dirty || !ctx.alive()) return;
    dirty = false;
    const el = view.querySelector('[data-slot="cw"]');
    if (!el) return;
    const had = !!el.querySelector('.cw');
    el.innerHTML = continueRow('Continue Watching', continueWatching());
    hydrateStills(el);
    hydrateRows(el, cancelPreview);
    if (!had && el.firstElementChild) el.animate([{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' });
  };
  addEventListener('yoru:history', onHistory);
  addEventListener('yoru:layer', onLayer);
  ctx.cleanups.push(() => {
    removeEventListener('yoru:history', onHistory);
    removeEventListener('yoru:layer', onLayer);
  });

  lazyRows(view, ctx, async () => {
    // Genre rows ordered by the viewer's taste, falling back to a broad default mix.
    const liked = (peek()?.genres || []).filter((g) => GENRE_TITLES[g]);
    const order = [...new Set([...liked, 'Action', 'Romance', 'Psychological', 'Fantasy', 'Slice of Life', 'Sci-Fi', 'Comedy', 'Sports'])].slice(0, 8);
    return genreBlock(await api.genreRows(order), '', 1);
  });
}

/* ---------- Series & Films ---------- */

async function browsePage(view, ctx, kind) {
  const label = kind === 'films' ? 'Films' : 'Series';
  view.innerHTML = heroSkeleton() + `<div class="rows">${skeletonRows(4)}</div>`;
  let d;
  try {
    d = await api.browse(kind);
  } catch {
    if (ctx.alive()) errorState(view, () => browsePage(view, ctx, kind));
    return;
  }
  if (!ctx.alive()) return;
  Object.values(d).forEach(remember);
  const hero = pickHero(d.trending);
  let i = 0;

  const rows =
    kind === 'films'
      ? [
          row('Trending Films', d.trending, { i: i++ }),
          row('Most Popular Films', d.popular, { i: i++ }),
          row('Critically Acclaimed Films', d.acclaimed, { i: i++ }),
          tilesRow('Films by Genre', { i: i++, kind }),
          row('Recent Releases', d.recent, { i: i++ }),
          row('Timeless Classics', d.classics, { i: i++ }),
          row('Coming to Theaters', d.upcoming, { i: i++ }),
        ]
      : [
          row('Trending Series', d.trending, { i: i++ }),
          row('Airing Now', d.airing, { i: i++, sub: 'New episodes weekly' }),
          row('Most Popular Series', d.popular, { i: i++ }),
          tilesRow('Series by Genre', { i: i++, kind }),
          row('Critically Acclaimed Series', d.acclaimed, { i: i++ }),
          row('Recent Hits', d.recent, { i: i++ }),
          row('Before They Were Classics', d.classics, { i: i++ }),
        ];

  view.innerHTML =
    `<div class="page-tag">
      <h1>${label}</h1>
      <label class="select">
        <select aria-label="Browse ${label.toLowerCase()} by genre" data-genre-select>
          <option value="">Genres</option>
          ${GENRES.map(([g]) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}
        </select>${icon('chevron-down')}
      </label>
    </div>` +
    heroHTML(hero, `<b>${label}</b> · Trending now`) +
    `<div class="rows">${rows.join('')}<div class="lazy-rows"></div><div class="sentinel"></div></div>`;

  view.querySelector('[data-genre-select]').addEventListener('change', (e) => {
    if (e.target.value) go(`/genre/${encodeURIComponent(e.target.value)}?kind=${kind}`);
  });
  ctx.cleanups.push(mountHero(view, hero));
  hydrateRows(view, cancelPreview);
  lazyRows(view, ctx, async () => {
    const genres = kind === 'films' ? ['Action', 'Romance', 'Fantasy', 'Drama', 'Sci-Fi', 'Comedy'] : ['Action', 'Romance', 'Psychological', 'Fantasy', 'Mystery', 'Comedy'];
    return genreBlock(await api.genreRows(genres, kind), kind, 0);
  });
}

/* ---------- New & Popular ---------- */

async function newPage(view, ctx) {
  view.innerHTML = `<div class="page page-new">
    <header class="page-head"><p class="eyebrow" lang="ja">新着 · This week</p><h1>New &amp; Popular</h1></header>
    <div class="np-skel">${skeletonRows(2)}</div></div>`;
  let d;
  try {
    d = await api.newAndPopular();
  } catch {
    if (ctx.alive()) errorState(view, () => newPage(view, ctx));
    return;
  }
  if (!ctx.alive()) return;
  remember(d.schedule.map((s) => s.media));
  remember(d.top);
  remember(d.soon);

  // Bucket the week's airings by local day.
  const days = [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  for (let k = 0; k < 7; k++) {
    const day = new Date(base);
    day.setDate(base.getDate() + k);
    days.push({
      start: day.getTime() / 1000,
      label: k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day),
      num: day.getDate(),
      items: [],
    });
  }
  for (const s of d.schedule) {
    const k = Math.floor((s.airingAt - days[0].start) / 86400);
    if (days[k]) days[k].items.push(s);
  }

  const now = Date.now() / 1000;
  const schedList = (day) => {
    if (!day.items.length) return `<li class="sch-empty">Nothing airing — a quiet night.</li>`;
    let nextMarked = false;
    return day.items
      .map((s) => {
        const m = s.media;
        const past = s.airingAt < now;
        const isNext = !past && !nextMarked && (nextMarked = true);
        return `<li class="sch ${past ? 'past' : ''}">
          <time>${fmtTime(s.airingAt)}</time>
          <a class="sch-card" href="#/new?t=${m.id}" data-open="${m.id}" data-pv="${m.id}" style="--c:${tint(m)}">
            <img src="${esc(m.coverImage?.large || poster(m))}" alt="" loading="lazy">
            <span class="sch-text">
              <strong>${esc(titleOf(m))}</strong>
              <span>Episode ${s.episode}${m.episodes ? ` of ${m.episodes}` : ''} · ${formatOf(m) || 'Series'}</span>
            </span>
            ${isNext ? '<span class="sch-next">Up next</span>' : past ? '<span class="sch-aired">Aired</span>' : ''}
          </a>
          ${listButton(m)}
        </li>`;
      })
      .join('');
  };

  const month = (sd) => (sd?.month ? new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(2000, sd.month - 1, 1)) : 'TBA');
  const when = (sd) => {
    if (!sd?.year) return 'Date to be announced';
    if (!sd.month) return `Coming ${sd.year}`;
    if (!sd.day) return `Coming ${new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(sd.year, sd.month - 1))}`;
    return `Premieres ${new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(sd.year, sd.month - 1, sd.day))}`;
  };

  view.innerHTML = `<div class="page page-new">
    <header class="page-head"><p class="eyebrow" lang="ja">新着 · This week</p><h1>New &amp; Popular</h1></header>
    <nav class="seg" aria-label="Sections">
      <button data-to="np-week" class="on">${icon('calendar')}Airing This Week</button>
      <button data-to="np-top">${icon('flame')}Top 10 Series</button>
      <button data-to="np-soon">${icon('bell')}Coming Soon</button>
    </nav>

    <section class="np-sec" id="np-week">
      <header class="np-head"><h2>Airing This Week</h2><p>Simulcasts land on licensed services within hours of Japan broadcast.</p></header>
      <div class="days" role="tablist">${days
        .map(
          (day, k) => `<button role="tab" class="day ${k === 0 ? 'on' : ''}" data-day="${k}" aria-selected="${k === 0}">
          <span>${day.label}</span><b>${day.num}</b><small>${day.items.length}</small></button>`
        )
        .join('')}</div>
      <ol class="sched">${schedList(days[0])}</ol>
    </section>

    <section class="np-sec np-top" id="np-top">
      ${top10Row('Top 10 Series Today', d.top, { i: 0 })}
    </section>

    <section class="np-sec" id="np-soon">
      <header class="np-head"><h2>Coming Soon</h2><p>Set your sights on next season.</p></header>
      <div class="soon-list">${d.soon
        .map(
          (m, k) => `<article class="soon" style="--c:${tint(m)};--i:${k}">
          <div class="soon-date"><span>${month(m.startDate)}</span><b>${m.startDate?.day ? String(m.startDate.day).padStart(2, '0') : '—'}</b></div>
          <a class="soon-card" href="#/new?t=${m.id}" data-open="${m.id}">
            <span class="soon-media"><img alt="" data-wide="${m.id}"></span>
            <span class="soon-body">
              <span class="soon-when">${esc(when(m.startDate))}</span>
              <strong>${esc(titleOf(m))}</strong>
              <span class="soon-desc">${esc(cleanDesc(m.description || '').split('\n\n')[0] || '')}</span>
              <span class="dots">${(m.genres || []).slice(0, 4).map((g) => `<span>${esc(g)}</span>`).join('')}</span>
            </span>
          </a>
          <div class="soon-actions">${listButton(m)}</div>
        </article>`
        )
        .join('')}</div>
    </section>
  </div>`;

  const byId = new Map(d.soon.map((m) => [String(m.id), m]));
  view.querySelectorAll('[data-wide]').forEach((img) => wideStill(img, byId.get(img.dataset.wide), { preferBanner: true }));
  hydrateRows(view, cancelPreview);

  const list = view.querySelector('.sched');
  view.querySelector('.days').addEventListener('click', (e) => {
    const b = e.target.closest('[data-day]');
    if (!b) return;
    view.querySelectorAll('.day').forEach((x) => {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-selected', String(x === b));
    });
    list.innerHTML = schedList(days[Number(b.dataset.day)]);
    list.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' });
  });

  const seg = view.querySelector('.seg');
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-to]');
    if (!b) return;
    const target = view.querySelector('#' + b.dataset.to);
    scrollTo({ top: target.getBoundingClientRect().top + scrollY - 140, behavior: 'smooth' });
  });
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) seg.querySelectorAll('[data-to]').forEach((b) => b.classList.toggle('on', b.dataset.to === e.target.id));
    },
    { rootMargin: '-45% 0px -50% 0px' }
  );
  view.querySelectorAll('.np-sec').forEach((s) => io.observe(s));
  ctx.cleanups.push(() => io.disconnect());
}

/* ---------- My List ---------- */

function listPage(view, ctx) {
  const paint = () => {
    const items = getList();
    remember(items);
    view.innerHTML = `<div class="page">
      <header class="page-head"><p class="eyebrow" lang="ja">マイリスト</p><h1>My List</h1>
        ${items.length ? `<p class="page-sub">${items.length} title${items.length === 1 ? '' : 's'} saved on this device</p>` : ''}
        <a class="head-link" href="#/activity">${icon('history')}Viewing activity &amp; taste profile ${icon('chevron-right')}</a></header>
      ${
        items.length
          ? `<div class="grid">${items.map(gridCell).join('')}</div>`
          : `<div class="empty in-page">
              <span class="empty-k" aria-hidden="true">空</span>
              <h2>Your list is waiting.</h2>
              <p>Tap ${icon('plus')} on anything that catches your eye and it’ll live here.</p>
              <a class="btn btn-play" href="#/">${icon('home')}<span>Find something to watch</span></a>
            </div>`
      }
    </div>`;
  };
  paint();
  const onChange = () => {
    // Removing from the list while on this page: let the button animation finish first.
    clearTimeout(ctx.t);
    ctx.t = setTimeout(() => ctx.alive() && paint(), 380);
  };
  addEventListener('yoru:list', onChange);
  ctx.cleanups.push(() => removeEventListener('yoru:list', onChange));
}

/* ---------- Search ---------- */

function searchPage(view, ctx, route) {
  view.innerHTML = `<div class="page page-search">
    <header class="page-head"><p class="eyebrow">Search</p><h1 class="search-q"></h1></header>
    <div class="search-genres"></div>
    <div class="grid search-grid"></div>
  </div>`;
  const qEl = view.querySelector('.search-q');
  const grid = view.querySelector('.search-grid');
  const chips = view.querySelector('.search-genres');
  let seq = 0;

  const run = async (q) => {
    const my = ++seq;
    qEl.innerHTML = q ? `Results for <em>“${esc(q)}”</em>` : 'Popular right now';
    if (!grid.children.length || grid.querySelector('.sk')) grid.innerHTML = '<span class="cell"><span class="sk sk-card"></span></span>'.repeat(12);
    else grid.classList.add('busy');
    let items;
    try {
      items = q ? await api.search(q) : (await api.home()).trending;
    } catch {
      if (my !== seq || !ctx.alive()) return;
      grid.classList.remove('busy');
      grid.innerHTML = `<p class="muted">Search is having a moment. Try again shortly.</p>`;
      return;
    }
    if (my !== seq || !ctx.alive()) return;
    grid.classList.remove('busy');
    remember(items);
    if (!items.length) {
      chips.innerHTML = '';
      grid.innerHTML = `<div class="empty in-page"><span class="empty-k" aria-hidden="true">無</span>
        <h2>No matches for “${esc(q)}”.</h2><p>Try an English or romaji title, a studio favourite, or browse a genre below.</p></div>
        <div class="tile-grid">${GENRES.slice(0, 8)
          .map(([g, k, c]) => `<a class="tile" href="#/genre/${encodeURIComponent(g)}" style="--k:${c}"><span class="tile-k" aria-hidden="true">${k}</span><span class="tile-name">${esc(g)}</span></a>`)
          .join('')}</div>`;
      return;
    }
    const counts = {};
    items.forEach((m) => (m.genres || []).forEach((g) => (counts[g] = (counts[g] || 0) + 1)));
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    chips.innerHTML = top.length
      ? `<span class="muted">Explore titles related to:</span>${top.map(([g]) => `<a href="#/genre/${encodeURIComponent(g)}">${esc(g)}</a>`).join('')}`
      : '';
    grid.innerHTML = items.map(gridCell).join('');
  };

  ctx.update = (r) => run(r.params.get('q')?.trim() || '');
  return run(route.params.get('q')?.trim() || '');
}

/* ---------- Genre ---------- */

const SORTS = [
  ['POPULARITY_DESC', 'Most Popular'],
  ['TRENDING_DESC', 'Trending'],
  ['SCORE_DESC', 'Top Rated'],
  ['START_DATE_DESC', 'Newest'],
];

function genrePage(view, ctx, route) {
  const genre = route.arg || 'Action';
  const kind = route.params.get('kind') || '';
  const sort = SORTS.some(([v]) => v === route.params.get('sort')) ? route.params.get('sort') : 'POPULARITY_DESC';
  const [, kanji, color] = genreMeta(genre) || [genre, '夜', '#ff4a2b'];
  const href = (s) => `#/genre/${encodeURIComponent(genre)}?${new URLSearchParams({ ...(kind && { kind }), sort: s })}`;

  view.innerHTML = `<div class="page page-genre" style="--k:${color}">
    <header class="genre-head">
      <span class="genre-k" aria-hidden="true">${kanji}</span>
      <p class="eyebrow">${kind === 'films' ? 'Films' : kind === 'series' ? 'Series' : 'Genre'}</p>
      <h1>${esc(genre)}</h1>
      <nav class="sorts" aria-label="Sort">${SORTS.map(([v, l]) => `<a href="${href(v)}" class="${v === sort ? 'on' : ''}">${l}</a>`).join('')}</nav>
    </header>
    <div class="grid"></div>
    <div class="sentinel"><span class="spinner" aria-hidden="true"></span></div>
  </div>`;

  const grid = view.querySelector('.grid');
  const sentinel = view.querySelector('.sentinel');
  let page = 0;
  let more = true;
  let busy = false;
  let count = 0;

  const loadMore = async () => {
    if (busy || !more) return;
    busy = true;
    try {
      const res = await api.byGenre(genre, { sort, page: page + 1, kind });
      if (!ctx.alive()) return;
      page++;
      more = res.more && page < 12;
      remember(res.items);
      grid.insertAdjacentHTML('beforeend', res.items.map((m) => gridCell(m, count++)).join(''));
      if (!res.items.length && page === 1) grid.innerHTML = `<p class="muted">Nothing here yet.</p>`;
    } catch {
      more = false;
    } finally {
      busy = false;
      // Once the page is gone, stop. (A detached sentinel reports top = 0, which used to re-trigger loadMore()
      // forever against cached responses — an endless microtask loop that froze the tab.)
      if (ctx.alive() && sentinel.isConnected) {
        if (!more) sentinel.classList.add('done');
        else if (sentinel.getBoundingClientRect().top < innerHeight + 800) setTimeout(loadMore, 0);
      }
    }
  };
  const io = new IntersectionObserver(([e]) => e.isIntersecting && loadMore(), { rootMargin: '800px 0px' });
  io.observe(sentinel);
  ctx.cleanups.push(() => io.disconnect());
  // Resolves once the first page is in, so the router can restore scroll position on Back/Forward.
  return new Promise((res) => {
    const check = () => (page > 0 || !more || !ctx.alive() ? res() : setTimeout(check, 50));
    check();
  });
}

/* ---------- Viewing activity & taste profile ---------- */

const RATED = { 2: ['thumbs-love', 'Loved'], 1: ['thumb-up', 'Liked'], '-1': ['thumb-down', 'Not for me'] };

function activityPage(view, ctx) {
  const dayLabel = (ts) => {
    const d = new Date(ts);
    const today = new Date();
    const y = new Date(today);
    y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(d);
  };

  const historyRow = (e) => {
    const pct = e.done ? 100 : Math.round((e.p / (e.d || 1)) * 100);
    const movie = e.m.format === 'MOVIE';
    return `<li class="act-row">
      <a class="act-media" href="#/watch/${e.m.id}?ep=${e.n}" data-play="${e.m.id}" data-ep="${e.n}" aria-label="Play ${esc(titleOf(e.m))}${movie ? '' : ` episode ${e.n}`}"><img alt="" data-still="${e.m.id}"><span class="act-play">${icon('play')}</span></a>
      <div class="act-text"><a href="#/activity?t=${e.m.id}" data-open="${e.m.id}"><strong>${esc(titleOf(e.m))}</strong></a>
        <small>${movie ? 'Film' : `Episode ${e.n}`} · ${e.done ? 'Watched' : `${pct}% watched`} · ${fmtTime(e.w / 1000)}</small>
        <span class="act-bar"><i style="width:${pct}%"></i></span></div>
      <button class="act-x" data-forget="${e.m.id}" aria-label="Remove ${esc(titleOf(e.m))} from history" title="Remove title from history">${icon('x')}</button>
    </li>`;
  };

  const paint = () => {
    const log = activity();
    const all = titles();
    const rated = Object.entries(ratings())
      .map(([id, r]) => ({ m: all[id]?.m, v: r.v, t: r.t }))
      .filter((x) => x.m)
      .sort((a, b) => b.t - a.t);
    remember(log.map((x) => x.m));
    remember(rated.map((x) => x.m));

    const groups = [];
    for (const e of log) {
      const label = dayLabel(e.w);
      if (groups.at(-1)?.label !== label) groups.push({ label, items: [] });
      groups.at(-1).items.push(e);
    }

    const ratedHTML = rated.length
      ? `<section class="act-sec"><h2>Rated</h2><div class="rated">${rated
          .map(
            ({ m, v }) => `<a class="rated-item" href="#/activity?t=${m.id}" data-open="${m.id}" style="--c:${tint(m)}">
          <img src="${esc(poster(m))}" alt="" loading="lazy"><span>${esc(titleOf(m))}</span><em class="r-${v === 2 ? 'love' : v === 1 ? 'up' : 'down'}" title="${RATED[v][1]}">${icon(RATED[v][0])}</em></a>`
          )
          .join('')}</div></section>`
      : '';

    const historyHTML = groups.length
      ? groups.map((g) => `<h3 class="act-day">${esc(g.label)}</h3><ul class="act-list">${g.items.map(historyRow).join('')}</ul>`).join('')
      : `<div class="empty in-page"><span class="empty-k" aria-hidden="true">始</span><h2>Nothing watched yet.</h2><p>Press play on anything and it’ll show up here, and start shaping your recommendations.</p>
         <a class="btn btn-play" href="#/">${icon('home')}<span>Find something to watch</span></a></div>`;

    view.innerHTML = `<div class="page page-activity">
      <header class="page-head"><p class="eyebrow" lang="ja">視聴履歴</p><h1>Viewing Activity</h1>
        <p class="page-sub">Your history, ratings and taste profile live only on this device.</p></header>
      <section class="taste">
        <header><h2>Your taste profile</h2><p>What YORU’s recommender has learned from what you watch, rate and save.</p></header>
        <div class="taste-body" data-taste><span class="sk sk-line w70"></span><span class="sk sk-line w50"></span></div>
      </section>
      ${ratedHTML}
      <section class="act-sec"><h2>History</h2>${historyHTML}</section>
      ${groups.length || rated.length ? `<section class="act-danger"><button class="btn btn-ghost" data-clear>${icon('x')}<span>Clear history &amp; reset recommendations</span></button></section>` : ''}
    </div>`;
    hydrateStills(view);
    paintTaste();
  };

  const paintTaste = async () => {
    const box = view.querySelector('[data-taste]');
    const r = await recommend().catch(() => null);
    if (!ctx.alive() || !box?.isConnected) return;
    if (!r?.ready || !r.taste.length) {
      box.innerHTML = `<p class="muted">Watch, rate or save a few titles and your profile will appear here.</p>`;
      return;
    }
    const by = (k) => r.taste.filter((t) => t.kind === k);
    const chips = (list, href) =>
      list
        .map((t) => {
          const tag = href ? `a href="${href(t.name)}"` : 'span';
          return `<${tag} class="taste-chip" style="--w:${(0.35 + 0.65 * t.w).toFixed(2)}">${esc(t.name)}</${href ? 'a' : 'span'}>`;
        })
        .join('');
    const group = (label, list, href) => (list.length ? `<div class="taste-group"><h3>${label}</h3><div>${chips(list, href)}</div></div>` : '');
    box.innerHTML = `${group('Genres', by('genre'), (g) => `#/genre/${encodeURIComponent(g)}`)}${group('Themes', by('theme'))}${group('Studios', by('studio'))}
      <p class="taste-note">Built from ${r.seeds} title${r.seeds === 1 ? '' : 's'} · graph + content hybrid, computed on your device.</p>`;
  };

  paint();
  let armed = 0;
  view.addEventListener('click', (e) => {
    const f = e.target.closest('[data-forget]');
    if (f) {
      forgetTitle(Number(f.dataset.forget));
      toast('Removed from your viewing history');
      return;
    }
    const c = e.target.closest('[data-clear]');
    if (!c) return;
    if (Date.now() - armed > 4000) {
      armed = Date.now();
      c.querySelector('span').textContent = 'Click again to clear everything';
      c.classList.add('armed');
      setTimeout(() => {
        if (c.isConnected && Date.now() - armed >= 4000) {
          c.classList.remove('armed');
          c.querySelector('span').textContent = 'Clear history & reset recommendations';
        }
      }, 4100);
      return;
    }
    clearHistory();
    resetRecs();
    toast('Viewing history cleared');
  });
  const onChange = () => {
    clearTimeout(ctx.t);
    ctx.t = setTimeout(() => ctx.alive() && paint(), 200);
  };
  addEventListener('yoru:history', onChange);
  ctx.cleanups.push(() => removeEventListener('yoru:history', onChange));
}

export const pages = {
  '': home,
  series: (v, c) => browsePage(v, c, 'series'),
  films: (v, c) => browsePage(v, c, 'films'),
  new: newPage,
  list: listPage,
  search: searchPage,
  genre: genrePage,
  watch: watchPage,
  activity: activityPage,
};
