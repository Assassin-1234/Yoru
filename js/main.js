import { $, $$ } from './util.js';
import { parseRoute, openTitle, titleClosedExternally, watch } from './nav.js';
import { pages } from './pages.js';
import { media } from './components.js';
import { showModal, hideModal, modalOpen } from './modal.js';
import { initPreview, cancelPreview } from './preview.js';
import { openPlayer, closePlayer } from './player.js';
import { toggleList } from './store.js';
import { warmYouTube } from './yt.js';
import { loadCatalog, playable, sourceFor } from './sources.js';
import { rate, hideFromContinue, resumePoint } from './history.js';
import { prefetchStream, playbackUrl } from './prefetch.js';
import { preloadPlayer } from './watch.js';

const view = $('#view');
let current = { key: null, name: null, ctx: null };

function makeCtx() {
  const ctx = {
    dead: false,
    cleanups: [],
    alive: () => !ctx.dead,
    dispose() {
      ctx.dead = true;
      ctx.cleanups.splice(0).forEach((fn) => {
        try {
          fn?.();
        } catch {}
      });
    },
  };
  return ctx;
}

/* ---------- Routing ----------
   Pages render into #view. The player is a *layer* rendered into #stage on top of whatever page (and title
   modal) was open, so leaving the player is instant and lands exactly where the viewer was. Every history
   entry gets an id so Back/Forward between pages restores scroll position. */

const stage = $('#stage');
let layer = null; // { key, ctx } while the player is up
const scrollMemo = new Map();
let lastEntry = null;
let seq = 0;

function entryId() {
  let k = history.state?.yoru;
  if (!k) {
    k = `${Date.now().toString(36)}-${++seq}`;
    history.replaceState({ ...(history.state || {}), yoru: k }, '');
  }
  return k;
}

/* ---------- Stay current after a deploy ---------- */

// A tab left open (or restored by the browser from its cache) keeps running whatever version it loaded.
// Production builds stamp a build id; when /version.txt says a newer one is live, reload — immediately on
// boot, otherwise at the next navigation (never mid-episode).
const BUILD = document.querySelector('meta[name="yoru-build"]')?.content;
let staleBuild = '';
let lastBuildCheck = 0;
async function checkBuild(boot = false) {
  if (!BUILD || staleBuild || Date.now() - lastBuildCheck < 60_000) return;
  lastBuildCheck = Date.now();
  try {
    const live = (await (await fetch('/version.txt', { cache: 'no-store' })).text()).trim();
    if (!/^[0-9a-f]{12}$/.test(live) || live === BUILD) return;
    staleBuild = live;
    // One reload per build id, so a CDN that briefly serves mixed versions can't cause a reload loop.
    let tried = false;
    try { tried = sessionStorage.getItem('yoru:build-reload') === live; sessionStorage.setItem('yoru:build-reload', live); } catch {}
    if (tried) staleBuild = '';
    else if (boot) location.reload();
  } catch {}
}

function route() {
  if (staleBuild && parseRoute().name !== 'watch' && !document.documentElement.classList.contains('watching')) {
    location.reload();
    return;
  }
  checkBuild();
  const r = parseRoute();
  const params = new URLSearchParams(r.params);
  params.delete('t');
  const key = `${r.path}?${params}`;
  const name = pages[r.name] ? r.name : '';
  if (lastEntry && !layer) scrollMemo.set(lastEntry, scrollY);
  const entry = (lastEntry = entryId());

  if (name === 'watch') {
    cancelPreview();
    closePlayer();
    if (layer?.ctx.update) {
      layer.key = key;
      layer.ctx.update(r);
    } else {
      const ctx = makeCtx();
      layer = { key, ctx };
      pages.watch(stage, ctx, r);
    }
    return; // the page and any open title stay mounted underneath
  }
  if (layer) {
    layer.ctx.dispose();
    layer = null;
    stage.replaceChildren();
    dispatchEvent(new CustomEvent('yoru:layer'));
  }

  if (key !== current.key) {
    cancelPreview();
    closePlayer();
    // Pages that can update in place (search-as-you-type).
    if (name === current.name && current.ctx?.update) {
      current.key = key;
      current.ctx.update(r);
    } else {
      const first = current.key === null;
      current.ctx?.dispose();
      const ctx = makeCtx();
      current = { key, name, ctx };
      paintNav(name);
      const saved = scrollMemo.get(entry);
      const render = () => {
        scrollTo({ top: 0, behavior: 'instant' });
        const done = Promise.resolve(pages[name](view, ctx, r));
        if (saved > 0) done.then(() => requestAnimationFrame(() => ctx.alive() && current.ctx === ctx && scrollTo({ top: saved, behavior: 'instant' })));
        return done;
      };
      // Crossfade page to page. Wait briefly for cached content so the old page dissolves straight into the new
      // one instead of flashing a skeleton; slow loads fall back to the skeleton after 350 ms.
      if (!first && document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        view.classList.remove('enter');
        document.startViewTransition(() => Promise.race([render(), new Promise((res) => setTimeout(res, 350))]));
      } else {
        view.classList.remove('enter');
        void view.offsetWidth;
        view.classList.add('enter');
        render();
      }
    }
    syncSearch(r);
  }

  const t = Number(r.params.get('t'));
  if (t) showModal(t);
  else if (modalOpen()) {
    titleClosedExternally();
    hideModal();
  }
}

/* ---------- Navigation chrome ---------- */

function paintNav(name) {
  $$('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === name;
    a.classList.toggle('active', on);
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  });
}

const nav = $('.nav');
let ticking = false;
addEventListener(
  'scroll',
  () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      nav.classList.toggle('solid', scrollY > 30);
      ticking = false;
    });
  },
  { passive: true }
);

/* ---------- Search ---------- */

const searchBox = $('.search');
const input = $('#q');
let preSearch = '#/';
let debounce = 0;

function openSearch() {
  searchBox.classList.add('open');
  input.focus();
}
function closeSearch() {
  searchBox.classList.remove('open');
  input.value = '';
}

$('[data-search-toggle]').addEventListener('click', () => {
  if (searchBox.classList.contains('open') && !input.value) closeSearch();
  else openSearch();
});
$('[data-search-clear]').addEventListener('click', () => {
  input.value = '';
  input.dispatchEvent(new Event('input'));
  input.focus();
});

input.addEventListener('input', () => {
  searchBox.classList.toggle('has-text', !!input.value);
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    const q = input.value.trim();
    const onSearch = parseRoute().name === 'search';
    if (q) {
      const target = `#/search?q=${encodeURIComponent(q)}`;
      if (onSearch) location.replace(target);
      else {
        preSearch = location.hash || '#/';
        location.hash = target;
      }
    } else if (onSearch) location.replace(preSearch.includes('search') ? '#/' : preSearch);
  }, 260);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    if (input.value) {
      input.value = '';
      input.dispatchEvent(new Event('input'));
    } else {
      input.blur();
      closeSearch();
    }
  }
});
input.addEventListener('blur', () => {
  if (!input.value) setTimeout(() => document.activeElement !== input && !input.value && closeSearch(), 150);
});

function syncSearch(r) {
  if (r.name === 'search') {
    searchBox.classList.add('open');
    const q = r.params.get('q') || '';
    if (document.activeElement !== input) input.value = q;
    searchBox.classList.toggle('has-text', !!input.value);
  } else if (document.activeElement !== input) {
    closeSearch();
    searchBox.classList.remove('has-text');
  }
}

addEventListener('keydown', (e) => {
  if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName) && !modalOpen()) {
    e.preventDefault();
    openSearch();
  }
});

/* ---------- Global actions (event delegation) ---------- */

document.addEventListener('click', (e) => {
  const listBtn = e.target.closest('[data-list]');
  if (listBtn) {
    e.preventDefault();
    const m = media.get(Number(listBtn.dataset.list));
    if (m) toggleList(m);
    return;
  }
  const rateBtn = e.target.closest('[data-rate]');
  if (rateBtn) {
    e.preventDefault();
    const m = media.get(Number(rateBtn.closest('[data-rate-box]')?.dataset.rateBox));
    if (m) rate(m, Number(rateBtn.dataset.rate));
    rateBtn.blur();
    return;
  }
  const hide = e.target.closest('[data-cw-hide]');
  if (hide) {
    e.preventDefault();
    const cell = hide.closest('.cw');
    hideFromContinue(Number(hide.dataset.cwHide));
    cell?.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.92)' }], { duration: 260, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).finished.then(() => {
      const row = cell.closest('.row');
      cell.remove();
      if (row && !row.querySelector('.cw')) row.remove();
    });
    return;
  }
  const trailerBtn = e.target.closest('[data-trailer]');
  if (trailerBtn) {
    e.preventDefault();
    const m = media.get(Number(trailerBtn.dataset.trailer));
    if (m) openPlayer(m);
    return;
  }
  const play = e.target.closest('[data-play]');
  if (play) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    const m = media.get(Number(play.dataset.play));
    if (!m) return;
    cancelPreview();
    // Real stream → the YORU player; otherwise fall back to the official trailer.
    if (playable(m)) {
      // Phones: go straight to landscape full screen, like a native app (only allowed inside the tap itself).
      if (matchMedia('(pointer: coarse)').matches && document.fullscreenEnabled && !document.fullscreenElement)
        document.documentElement
          .requestFullscreen({ navigationUI: 'hide' })
          .then(() => screen.orientation?.lock?.('landscape'))
          .catch(() => {});
    }
    if (playable(m)) watch(m.id, Number(play.dataset.ep) || 0, play.closest('.cw-card, .ep, .act-media, .md-hero, .hero, .pv-media') || play.closest('.pv')?.querySelector('.pv-media') || play);
    else openPlayer(m);
    return;
  }
  const open = e.target.closest('[data-open]');
  if (open && !open.closest('.pv')) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    cancelPreview();
    openTitle(Number(open.dataset.open), open);
  }
});

// Fade images in as they decode. Wide stills manage their own fallbacks (they set onload).
document.addEventListener(
  'load',
  (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && !img.onload) img.classList.add('ok');
  },
  true
);
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && !img.onerror) img.classList.add('broken');
  },
  true
);

/* ---------- Warm the stream on intent ---------- */

// Strong intent (pointing at a Play control, opening a title): warm the exact episode + position Play will start.
const edition = () => {
  try {
    return JSON.parse(localStorage.getItem('yoru:player:v1'))?.edition === 'dub' ? 'dub' : 'sub';
  } catch {
    return 'sub';
  }
};
export function warmPlayback(m, ep = 0) {
  if (!m || !playable(m)) return;
  const r = resumePoint(m);
  const n = ep || r.ep;
  preloadPlayer();
  sourceFor(m, n, edition())
    .then((src) => src && prefetchStream(playbackUrl(src), { position: n === r.ep && r.resume ? r.pos : 0, segments: 1 }))
    .catch(() => {});
}
function warm(m) {
  if (!m || !playable(m)) return;
  preloadPlayer();
  // Resolving now means the click's own request is a cache hit; the prefetch above then warms the media.
  sourceFor(m, 1, edition()).catch(() => {});
}
let intentT = 0;
document.addEventListener('pointerover', (e) => {
  const el = e.target.closest?.('[data-play], [data-pv]');
  if (!el) return;
  warm(media.get(Number(el.dataset.play || el.dataset.pv)));
  clearTimeout(intentT);
  if (el.dataset.play) intentT = setTimeout(() => warmPlayback(media.get(Number(el.dataset.play)), Number(el.dataset.ep) || 0), 200);
});
document.addEventListener('pointerout', (e) => e.target.closest?.('[data-play]') && clearTimeout(intentT));
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest?.('[data-play]');
  if (el) warmPlayback(media.get(Number(el.dataset.play)), Number(el.dataset.ep) || 0);
});
addEventListener('yoru:title', (e) => warmPlayback(media.get(e.detail)));
document.addEventListener('focusin', (e) => {
  const el = e.target.closest?.('[data-play]');
  if (el) warm(media.get(Number(el.dataset.play)));
});

/* ---------- Intro ---------- */

function intro() {
  const el = $('#intro');
  if (!el) return;
  if (document.documentElement.classList.contains('no-intro')) return el.remove();
  try {
    sessionStorage.setItem('yoru:intro', '1');
  } catch {}
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    el.classList.add('done');
    setTimeout(() => el.remove(), 900);
  };
  const t = setTimeout(done, 2500);
  const skip = () => {
    clearTimeout(t);
    done();
  };
  el.addEventListener('click', skip);
  addEventListener('keydown', skip, { once: true });
}

/* ---------- Boot ---------- */

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
intro();
initPreview();
addEventListener('hashchange', route);
loadCatalog().finally(route);
checkBuild(true);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkBuild());
(window.requestIdleCallback || setTimeout)(() => {
  warmYouTube();
  preloadPlayer();
}, { timeout: 2500 });
