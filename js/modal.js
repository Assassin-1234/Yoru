// Title details: Netflix-style modal with ambient trailer, episodes, where-to-watch and recommendations.
import {
  esc, icon, titleOf, nativeOf, ytId, cleanDesc, paras, wideStill, tint, prefs, reducedMotion, ambientVideo,
  overlay, lockScroll, streams, fmtDate, until, fmtTime, statusOf, score, yearOf, formatOf, runtime,
} from './util.js';
import { media, remember, metaLine, listButton, rateBox, hydrateStills } from './components.js';
import { detail } from './api.js';
import { trailer } from './yt.js';
import { takeSource, closeTitle, watchHref } from './nav.js';
import { playable, episodeList } from './sources.js';
import { resumePoint, episodeState, signal } from './history.js';
import { reasonOf } from './recs.js';

let st = null;

export const modalOpen = () => !!st;

export function showModal(id) {
  const src = takeSource();
  const m0 = media.get(id) || { id, title: {}, coverImage: {} };
  if (st) {
    if (st.id !== id) swap(id, m0);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'md-wrap';
  wrap.innerHTML = `<div class="md-scrim"></div><div class="md-scroll"><article class="md" role="dialog" aria-modal="true"></article></div>`;
  document.body.append(wrap);
  const scroller = wrap.querySelector('.md-scroll');
  const dlg = wrap.querySelector('.md');

  st = { wrap, dlg, scroller, id, ctl: null, timer: 0, token: 0, ended: false, returnFocus: src || document.activeElement };
  st.unlock = lockScroll();
  st.pop = overlay.push(() => closeTitle());
  st.layer = overlay.depth;

  scroller.addEventListener('click', (e) => {
    if (e.target === scroller) closeTitle();
  });
  dlg.addEventListener('click', onDialogClick);

  render(m0);
  requestAnimationFrame(() => wrap.classList.add('in'));
  animateIn(dlg, src);
  dlg.focus({ preventScroll: true });
  load(id);
}

// The player opens as a layer over the modal; when it closes, bring Resume / episode progress up to date.
addEventListener('yoru:layer', () => {
  if (!st?.full) return;
  const top = st.scroller.scrollTop;
  fillBody(media.get(st.id), st.full);
  st.scroller.scrollTop = top;
  syncVideo();
});

export function hideModal() {
  if (!st) return;
  const s = st;
  st = null;
  clearTimeout(s.timer);
  s.ctl?.destroy();
  s.pop();
  s.unlock();
  removeEventListener('yoru:overlay', syncVideo);
  s.wrap.classList.remove('in');
  s.wrap.classList.add('out');
  s.dlg.animate(
    [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'translateY(28px) scale(.965)' },
    ],
    { duration: 240, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }
  ).onfinish = () => {
    s.wrap.remove();
    // Hand focus back to whatever opened the title, so keyboard users don't land at the top of the page.
    const f = s.returnFocus;
    if (f?.isConnected && typeof f.focus === 'function' && !document.documentElement.classList.contains('watching')) f.focus({ preventScroll: true });
  };
}

function swap(id, m0) {
  st.id = id;
  clearTimeout(st.timer);
  st.ctl?.destroy();
  st.ctl = null;
  const { dlg, scroller } = st;
  dlg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' }).onfinish = () => {
    if (!st) return;
    render(m0);
    scroller.scrollTop = 0;
    dlg.animate(
      [
        { opacity: 0, transform: 'translateY(14px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' }
    );
    load(id);
  };
}

function animateIn(dlg, src) {
  const d = dlg.getBoundingClientRect();
  if (src?.isConnected && !reducedMotion()) {
    const r = src.getBoundingClientRect();
    const s = Math.max(0.2, r.width / d.width);
    const dx = r.left + r.width / 2 - (d.left + d.width / 2);
    const dy = r.top - d.top;
    dlg.animate(
      [
        { transform: `translate(${dx}px,${dy}px) scale(${s})`, opacity: 0.35, borderRadius: '14px' },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 460, easing: 'cubic-bezier(.2,.85,.25,1)' }
    );
  } else {
    dlg.animate(
      [
        { transform: 'translateY(40px) scale(.97)', opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' }
    );
  }
}

function load(id) {
  const tok = ++st.token;
  const body = st.dlg.querySelector('.md-body');
  detail(id)
    .then((full) => {
      if (!st || st.token !== tok) return;
      if (full.isAdult) return closeTitle();
      remember([full]);
      st.full = full;
      remember(full.recommendations?.nodes?.map((n) => n.mediaRecommendation).filter(Boolean));
      remember(full.relations?.edges?.map((e) => e.node).filter((n) => n.type === 'ANIME'));
      const m = media.get(id);
      signal(m, 'o');
      dispatchEvent(new CustomEvent('yoru:title', { detail: id }));
      if (!st.dlg.querySelector('.md-title')?.textContent.trim() || st.dlg.dataset.partial) render(m, full);
      else fillBody(m, full);
    })
    .catch(() => {
      if (!st || st.token !== tok) return;
      body.innerHTML = `<div class="md-error"><p>We couldn’t load this title right now.</p><button class="btn btn-ghost" data-retry>${icon('replay')}<span>Try again</span></button></div>`;
      body.querySelector('[data-retry]').onclick = () => load(id);
    });
}

/* ---------- Rendering ---------- */

function render(m, full = null) {
  const { dlg } = st;
  const partial = !m.title?.english && !m.title?.romaji;
  dlg.dataset.partial = partial && !full ? '1' : '';
  dlg.style.setProperty('--c', tint(m));
  dlg.setAttribute('aria-label', titleOf(m));
  dlg.tabIndex = -1;
  dlg.innerHTML = `
    <button class="md-close round-btn" data-close aria-label="Close">${icon('x')}</button>
    <header class="md-hero">
      <div class="md-media" aria-hidden="true"><img class="md-still" alt=""><div class="md-video"></div></div>
      <div class="md-shade" aria-hidden="true"></div>
      <div class="md-hero-content">
        ${nativeOf(m) ? `<p class="md-native" lang="ja">${esc(nativeOf(m))}</p>` : ''}
        <h2 class="md-title">${partial ? '' : esc(titleOf(m))}</h2>
        <div class="md-actions">${partial ? '' : actions(m)}</div>
        <div class="md-resume">${partial ? '' : resumeLine(m)}</div>
      </div>
      <button class="round-btn md-mute" data-md-mute hidden aria-label="Toggle sound">${icon('vol-off', 'ic-off')}${icon('vol-on', 'ic-on')}${icon('replay', 'ic-replay')}</button>
    </header>
    <div class="md-body">${full ? '' : skeletonBody(m)}</div>`;
  if (!partial) wideStill(dlg.querySelector('.md-still'), m);
  if (full) fillBody(m, full);
  if (!partial) armTrailer(m);
}

function actions(m) {
  const can = playable(m);
  const r = can ? resumePoint(m) : null;
  return `${can || ytId(m) ? `<button class="btn btn-play" data-play="${m.id}">${icon('play')}<span>${can ? esc(r.label) : 'Play Trailer'}</span></button>` : ''}
    ${can && ytId(m) ? `<button class="btn btn-ghost" data-trailer="${m.id}">${icon('film')}<span>Trailer</span></button>` : ''}
    ${listButton(m, 'cbtn cbtn-lg')}
    ${rateBox(m, 'rate-lg')}`;
}

function resumeLine(m) {
  if (!playable(m)) return '';
  const r = resumePoint(m);
  if (!r.resume) return '';
  return `<span class="md-bar"><i style="width:${Math.round(r.pct * 100)}%"></i></span><span>${m.format === 'MOVIE' ? '' : `E${r.ep} · `}${Math.max(1, Math.round(r.left / 60))}m left</span>`;
}

function skeletonBody(m) {
  return `<div class="md-info">
      <div class="md-left">${m.title?.english || m.title?.romaji ? metaLine(m) : '<span class="sk sk-line w40"></span>'}
        <span class="sk sk-line"></span><span class="sk sk-line"></span><span class="sk sk-line w70"></span></div>
      <div class="md-right"><span class="sk sk-line w70"></span><span class="sk sk-line w50"></span></div>
    </div>`;
}

function fillBody(m, full) {
  const { dlg } = st;
  const d = { ...m, ...full };
  const s = streams(full);
  const primary = s[0];

  dlg.querySelector('.md-actions').innerHTML = actions(d);
  dlg.querySelector('.md-resume').innerHTML = resumeLine(d);
  const why = reasonOf(d.id);

  const desc = cleanDesc(full.description);
  const vas = (full.characters?.edges || []).flatMap((e) => e.voiceActors.slice(0, 1).map((v) => v.name.full));
  const cast = [...new Set(vas)].slice(0, 4);
  const tags = (full.tags || []).filter((t) => !t.isMediaSpoiler && t.rank >= 60).slice(0, 3);
  const next = d.nextAiringEpisode;

  dlg.querySelector('.md-body').innerHTML = `
    <div class="md-info">
      <div class="md-left">
        ${metaLine(d)}
        ${why ? `<p class="md-why">${esc(why)}</p>` : ''}
        ${next ? `<p class="md-airing"><span class="live-dot"></span>Episode ${next.episode} arrives ${esc(dayOf(next.airingAt))} · in ${until(next.timeUntilAiring)}</p>` : ''}
        ${!next && d.status === 'NOT_YET_RELEASED' && d.startDate?.year ? `<p class="md-airing soon">Premieres ${esc(fmtDate(d.startDate))}</p>` : ''}
        <div class="md-desc">${desc ? paras(desc) : '<p class="muted">No synopsis available yet.</p>'}</div>
      </div>
      <div class="md-right">
        ${cast.length ? `<p><span class="lbl">Voice cast:</span> ${cast.map(esc).join(', ')}, <a href="#md-about" data-jump>more</a></p>` : ''}
        ${d.genres?.length ? `<p><span class="lbl">Genres:</span> ${d.genres.map((g) => `<a href="#/genre/${encodeURIComponent(g)}">${esc(g)}</a>`).join(', ')}</p>` : ''}
        ${tags.length ? `<p><span class="lbl">This anime is:</span> ${tags.map((t) => esc(t.name)).join(', ')}</p>` : ''}
        ${full.studios?.nodes?.length ? `<p><span class="lbl">Studio:</span> ${esc(full.studios.nodes[0].name)}</p>` : ''}
      </div>
    </div>
    ${whereToWatch(s)}
    ${episodes(d, full)}
    ${related(full)}
    ${moreLikeThis(full)}
    ${characters(full)}
    ${about(d, full)}
    <p class="md-fine">${primary ? `Also streaming on ${esc(primary.site)} and the services listed above. ` : ''}Your progress and ratings stay on this device.</p>`;
  hydrateStills(dlg);

  const toggle = dlg.querySelector('[data-eps-toggle]');
  toggle?.addEventListener('click', () => {
    const list = dlg.querySelector('.eps');
    const open = list.classList.toggle('all');
    toggle.innerHTML = open ? `Show fewer ${icon('chevron-down', 'flip')}` : `Show all ${list.children.length} episodes ${icon('chevron-down')}`;
    if (!open) list.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  dlg.querySelectorAll('.ep-thumb img:not([data-still])').forEach((img) => (img.onerror = () => wideStill(img, d)));
  dlg.querySelectorAll('.mlt-media img').forEach((img) => {
    img.addEventListener('error', () => img.classList.add('broken'), { once: true });
  });
}

const dayOf = (ts) => new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(ts * 1000)) + ' at ' + fmtTime(ts);

function whereToWatch(s) {
  if (!s.length) return '';
  return `<section class="md-sec md-wtw">
    <h3>Where to watch</h3>
    <div class="wtw">${s
      .map(
        (l) => `<a class="wtw-chip" href="${esc(l.url)}" target="_blank" rel="noopener" style="--sc:${esc(l.color || '#888')}">
        ${l.icon ? `<img src="${esc(l.icon)}" alt="" loading="lazy">` : '<i></i>'}<span>${esc(l.site)}</span>${icon('external')}</a>`
      )
      .join('')}</div>
  </section>`;
}

function episodes(d, full) {
  if (d.format === 'MOVIE') return '';
  const eps = episodeList(d, full);
  if (!eps.length) return '';
  const can = playable(d);
  const r = resumePoint(d);
  const len = d.duration ? `${d.duration}m` : '';
  // Show a window of six around where the viewer is, not always 1–6.
  const from = Math.max(0, Math.min(eps.length - 6, r.ep - 2));
  const row = (e, i) => {
    const st = episodeState(d.id, e.n);
    const pct = st ? (st.done ? 100 : Math.round((st.p / (st.d || 1)) * 100)) : 0;
    const cur = can && e.n === r.ep && (r.resume || r.ep > 1);
    const note = st?.done ? `${icon('check')} Watched` : pct ? `${Math.max(1, Math.round((st.d - st.p) / 60))}m left` : cur ? 'Up next' : '';
    const attrs = can ? `href="${watchHref(d.id, e.n)}" data-play="${d.id}" data-ep="${e.n}"` : `href="${esc(e.url || '#')}" target="_blank" rel="noopener"`;
    return `<li class="${i < from || i >= from + 6 ? 'off' : ''}"><a class="ep ${cur ? 'current' : ''} ${st?.done ? 'done' : ''}" ${attrs}>
      <span class="ep-n">${e.n}</span>
      <span class="ep-thumb"><img alt="" loading="lazy" ${e.thumb ? `src="${esc(e.thumb)}"` : `data-still="${d.id}"`}><span class="ep-play">${icon('play')}</span>${pct ? `<span class="ep-prog"><i style="width:${pct}%"></i></span>` : ''}</span>
      <span class="ep-text"><strong>${esc(e.title)}</strong><small>${note}</small></span>
      <span class="ep-len">${len}</span>
    </a></li>`;
  };
  return `<section class="md-sec">
    <header class="md-sec-head"><h3>Episodes</h3><span class="muted">${eps.length} episode${eps.length === 1 ? '' : 's'}${d.status === 'RELEASING' ? ' · new episodes weekly' : ''}</span></header>
    <ol class="eps">${eps.map(row).join('')}</ol>
    ${eps.length > 6 ? `<button class="eps-toggle" data-eps-toggle>Show all ${eps.length} episodes ${icon('chevron-down')}</button>` : ''}
  </section>`;
}

const REL = { PREQUEL: 'Prequel', SEQUEL: 'Sequel', PARENT: 'Main Story', SIDE_STORY: 'Side Story', SPIN_OFF: 'Spin-off', ALTERNATIVE: 'Alternative', SUMMARY: 'Recap' };
const REL_ORDER = Object.keys(REL);

function related(full) {
  const edges = (full.relations?.edges || [])
    .filter((e) => REL[e.relationType] && e.node.type === 'ANIME' && !e.node.isAdult)
    .sort((a, b) => REL_ORDER.indexOf(a.relationType) - REL_ORDER.indexOf(b.relationType));
  if (!edges.length) return '';
  return `<section class="md-sec">
    <h3>Seasons &amp; related</h3>
    <div class="rel">${edges
      .map(
        ({ relationType, node: n }) => `<a class="rel-item" href="#/?t=${n.id}" data-open="${n.id}" style="--c:${tint(n)}">
        <span class="rel-img"><img src="${esc(n.coverImage?.large || '')}" alt="" loading="lazy"></span>
        <span class="rel-text"><small>${REL[relationType]}</small><strong>${esc(titleOf(n))}</strong><em>${[yearOf(n), formatOf(n), runtime(n)].filter(Boolean).join(' · ')}</em></span>
      </a>`
      )
      .join('')}</div>
  </section>`;
}

function moreLikeThis(full) {
  const recs = (full.recommendations?.nodes || []).map((n) => n.mediaRecommendation).filter((r) => r && !r.isAdult);
  if (!recs.length) return '';
  return `<section class="md-sec">
    <h3>More like this</h3>
    <div class="mlt">${recs
      .slice(0, 12)
      .map((r) => {
        const sc = score(r);
        const img = r.bannerImage || r.coverImage?.extraLarge || r.coverImage?.large;
        return `<div class="mlt-card" style="--c:${tint(r)}">
          <a class="mlt-media" href="#/?t=${r.id}" data-open="${r.id}" aria-label="${esc(titleOf(r))}">
            <img src="${esc(img)}" alt="" loading="lazy" class="${r.bannerImage ? '' : 'portrait'}">
            ${runtime(r) ? `<span class="mlt-run">${runtime(r)}</span>` : ''}
            <span class="mlt-name">${esc(titleOf(r))}</span>
            <span class="mlt-play">${icon('chevron-right')}</span>
          </a>
          <div class="mlt-body">
            <div class="mlt-top">
              <div class="meta">${sc ? `<span class="score">${icon('star')} ${sc}</span>` : ''}${yearOf(r) ? `<span>${yearOf(r)}</span>` : ''}${formatOf(r) ? `<span class="chip">${formatOf(r)}</span>` : ''}</div>
              ${listButton(r)}
            </div>
            <p>${esc(cleanDesc(r.description || '').split('\n\n')[0] || '')}</p>
          </div>
        </div>`;
      })
      .join('')}</div>
  </section>`;
}

function characters(full) {
  const edges = (full.characters?.edges || []).slice(0, 10);
  if (!edges.length) return '';
  return `<section class="md-sec">
    <h3>Characters</h3>
    <div class="chars">${edges
      .map(
        (e) => `<figure class="char">
        <img src="${esc(e.node.image?.large || '')}" alt="" loading="lazy">
        <figcaption><strong>${esc(e.node.name.full)}</strong><small>${esc(e.voiceActors[0]?.name.full || (e.role === 'MAIN' ? 'Main' : 'Supporting'))}</small></figcaption>
      </figure>`
      )
      .join('')}</div>
  </section>`;
}

function about(d, full) {
  const SOURCE = { ORIGINAL: 'Original', MANGA: 'Manga', LIGHT_NOVEL: 'Light novel', VISUAL_NOVEL: 'Visual novel', VIDEO_GAME: 'Video game', NOVEL: 'Novel', WEB_NOVEL: 'Web novel', OTHER: 'Other', LIVE_ACTION: 'Live action', GAME: 'Game', MULTIMEDIA_PROJECT: 'Multimedia project', COMIC: 'Comic', DOUJINSHI: 'Doujinshi', ANIME: 'Anime', PICTURE_BOOK: 'Picture book' };
  const aired = [fmtDate(d.startDate), full.endDate?.year && d.status === 'FINISHED' ? fmtDate(full.endDate) : d.status === 'RELEASING' ? 'now' : '']
    .filter(Boolean)
    .join(' – ');
  const tags = (full.tags || []).filter((t) => !t.isMediaSpoiler).slice(0, 8).map((t) => t.name);
  const vas = [...new Set((full.characters?.edges || []).flatMap((e) => e.voiceActors.map((v) => v.name.full)))].slice(0, 10);
  const rows = [
    ['Original title', nativeOf(d) && `<span lang="ja" class="jp">${esc(nativeOf(d))}</span>`],
    ['Romaji', d.title?.romaji !== titleOf(d) && esc(d.title?.romaji || '')],
    ['Studio', full.studios?.nodes?.map((n) => esc(n.name)).join(', ')],
    ['Source', SOURCE[full.source] || ''],
    ['Aired', esc(aired)],
    ['Status', statusOf(d) || (d.status === 'FINISHED' ? 'Finished' : '')],
    ['Voice cast', vas.map(esc).join(', ')],
    ['Genres', d.genres?.map((g) => `<a href="#/genre/${encodeURIComponent(g)}">${esc(g)}</a>`).join(', ')],
    ['Themes', tags.map(esc).join(', ')],
  ].filter(([, v]) => v);
  return `<section class="md-sec md-about" id="md-about">
    <h3>About <b>${esc(titleOf(d))}</b></h3>
    <dl>${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
  </section>`;
}

/* ---------- Ambient trailer in the header ---------- */

function armTrailer(m) {
  const id = ytId(m);
  if (!id || !ambientVideo()) return;
  const s = st;
  const hero = s.dlg.querySelector('.md-hero');
  const btn = s.dlg.querySelector('[data-md-mute]');
  const paint = () => {
    btn.dataset.state = s.ended ? 'replay' : prefs.muted ? 'off' : 'on';
  };
  const start = () => {
    if (st !== s || s.ctl) return;
    s.ended = false;
    s.ctl = trailer(s.dlg.querySelector('.md-video'), id, {
      muted: prefs.muted,
      endEarly: 1.2,
      waitHD: true,
      onPlaying: () => {
        if (overlay.depth > s.layer) return s.ctl?.pause();
        setTimeout(() => st === s && hero.classList.add('playing'), 1500);
        btn.hidden = false;
        paint();
      },
      onEnded: () => {
        s.ended = true;
        hero.classList.remove('playing');
        paint();
        setTimeout(() => {
          if (s.ended) {
            s.ctl?.destroy();
            s.ctl = null;
          }
        }, 900);
      },
      onError: () => {
        s.ctl?.destroy();
        s.ctl = null;
        btn.hidden = true;
      },
    });
  };
  btn.onclick = () => (s.ended ? start() : (prefs.muted = !prefs.muted));
  s.onMuted = () => {
    s.ctl?.setMuted(prefs.muted);
    paint();
  };
  removeEventListener('yoru:muted', mutedProxy);
  addEventListener('yoru:muted', mutedProxy);
  addEventListener('yoru:overlay', syncVideo);
  s.timer = setTimeout(start, 1100);
}

function mutedProxy() {
  st?.onMuted?.();
}
function syncVideo() {
  if (!st?.ctl) return;
  if (overlay.depth > st.layer) st.ctl.pause();
  else st.ctl.play();
}

function onDialogClick(e) {
  if (e.target.closest('[data-close]')) return closeTitle();
  const jump = e.target.closest('[data-jump]');
  if (jump) {
    e.preventDefault();
    st?.dlg.querySelector('#md-about')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
