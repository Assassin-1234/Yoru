// Desktop hover preview: a card expands into a floating panel that autoplays the trailer.
import { esc, icon, titleOf, ytId, wideStill, tint, prefs, ambientVideo, overlay } from './util.js';
import { media, metaLine, listButton, rateBox } from './components.js';
import { playable } from './sources.js';
import { resumePoint, signal } from './history.js';
import { reasonOf } from './recs.js';
import { detail } from './api.js';
import { trailer } from './yt.js';
import { openTitle } from './nav.js';

const canHover = matchMedia('(hover: hover) and (pointer: fine)');
let showTimer = 0;
let leaveTimer = 0;
let pv = null; // { el, src, m, ctl, vt, y }

export function initPreview() {
  document.addEventListener('pointerover', (e) => {
    if (!canHover.matches || overlay.depth) return;
    const src = e.target.closest?.('[data-pv]');
    if (!src) return;
    if (pv?.src === src) {
      clearTimeout(leaveTimer);
      return;
    }
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(src), pv ? 160 : 520);
  });

  document.addEventListener('pointerout', (e) => {
    const src = e.target.closest?.('[data-pv]');
    if (!src || src.contains(e.relatedTarget)) return;
    clearTimeout(showTimer);
    if (pv?.src === src && !pv.el.contains(e.relatedTarget)) leaveTimer = setTimeout(() => hidePreview(), 90);
  });

  addEventListener(
    'scroll',
    () => {
      clearTimeout(showTimer);
      if (pv && Math.abs(scrollY - pv.y) > 24) hidePreview(true);
    },
    { passive: true }
  );
  addEventListener('resize', () => hidePreview(true));
  addEventListener('yoru:overlay', () => overlay.depth && hidePreview(true));
  addEventListener('yoru:muted', () => {
    pv?.ctl?.setMuted(prefs.muted);
    pv?.el.querySelector('[data-pv-mute]')?.setAttribute('data-state', prefs.muted ? 'off' : 'on');
  });
}

export const cancelPreview = () => {
  clearTimeout(showTimer);
  hidePreview(true);
};

function show(src) {
  const m = media.get(Number(src.dataset.pv));
  if (!m || !src.isConnected) return;
  const r = src.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  if (r.width === 0 || r.right < 8 || r.left > vw - 8) return;
  hidePreview(true);

  const W = Math.round(Math.min(Math.max(r.width * 1.8, 330), 410));
  const mediaH = (W * 9) / 16;
  const left = Math.max(12, Math.min(vw - W - 12, r.left + r.width / 2 - W / 2));
  const top = Math.max(80, r.top + r.height / 2 - mediaH / 2 - 36);

  const el = document.createElement('div');
  el.className = 'pv';
  el.style.cssText = `left:${left + scrollX}px;top:${top + scrollY}px;width:${W}px;--c:${tint(m)}`;
  el.innerHTML = `
    <div class="pv-media">
      <img alt="">
      <div class="pv-video" aria-hidden="true"></div>
      <div class="pv-title">${esc(titleOf(m))}</div>
      <button class="round-btn round-sm pv-mute" data-pv-mute data-state="${prefs.muted ? 'off' : 'on'}" aria-label="Toggle sound">${icon('vol-off', 'ic-off')}${icon('vol-on', 'ic-on')}</button>
    </div>
    <div class="pv-body">
      <div class="pv-actions">
        <button class="cbtn solid" data-play="${m.id}" aria-label="${playable(m) ? esc(resumePoint(m).label) : 'Play trailer'}" ${playable(m) || ytId(m) ? '' : 'disabled'}>${icon('play')}</button>
        ${listButton(m)}
        ${rateBox(m)}
        <button class="cbtn push" data-pv-info aria-label="More info">${icon('chevron-down')}</button>
      </div>
      ${metaLine(m, { genres: true })}
      ${progressLine(m)}
      ${reasonOf(m.id) ? `<p class="pv-why">${esc(reasonOf(m.id))}</p>` : ''}
    </div>`;
  document.body.append(el);
  wideStill(el.querySelector('img'), m, { preferBanner: true });

  const sx = r.width / W;
  const dx = r.left + r.width / 2 - (left + W / 2);
  const dy = r.top + r.height / 2 - (top + el.offsetHeight / 2);
  el.animate(
    [
      { transform: `translate(${dx}px,${dy}px) scale(${sx})`, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' }
  );

  const state = { el, src, m, ctl: null, vt: 0, y: scrollY };
  pv = state;
  // Lingering on a preview is strong intent: fetch full details so "More info" opens fully populated.
  state.pf = setTimeout(() => pv === state && detail(m.id).catch(() => {}), 1200);

  el.addEventListener('pointerenter', () => clearTimeout(leaveTimer));
  el.addEventListener('pointerleave', (e) => {
    if (src.contains(e.relatedTarget)) return;
    leaveTimer = setTimeout(() => hidePreview(), 90);
  });
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-pv-mute]')) {
      prefs.muted = !prefs.muted;
      return;
    }
    if (e.target.closest('[data-list],[data-play],.rate')) return; // handled globally
    openTitle(m.id, el);
  });

  const id = ytId(m);
  if (id && ambientVideo()) {
    state.vt = setTimeout(() => {
      if (pv !== state) return;
      state.ctl = trailer(el.querySelector('.pv-video'), id, {
        muted: prefs.muted,
        endEarly: 1.2,
        waitHD: true,
        // YouTube flashes its title bar & play glyph for the first moments — reveal after they clear.
        onPlaying: () => {
          setTimeout(() => pv === state && el.classList.add('playing'), 1700);
          // Only one soundtrack at a time: the billboard pauses while a preview plays.
          if (!state.live) {
            state.live = true;
            dispatchEvent(new CustomEvent('yoru:preview', { detail: true }));
          }
          // Watching a preview for a few seconds is a (weak) interest signal for the recommender.
          clearTimeout(state.sig);
          state.sig = setTimeout(() => pv === state && signal(m, 'p'), 4000);
        },
        onEnded: () => el.classList.remove('playing'),
        onError: () => el.classList.remove('playing'),
      });
    }, 1100);
  }
}

export function hidePreview(instant = false) {
  if (!pv) return;
  const { el, ctl, vt, sig, pf, live } = pv;
  pv = null;
  if (live) dispatchEvent(new CustomEvent('yoru:preview', { detail: false }));
  clearTimeout(vt);
  clearTimeout(sig);
  clearTimeout(pf);
  clearTimeout(leaveTimer);
  ctl?.destroy();
  if (instant) return el.remove();
  el.style.pointerEvents = 'none';
  el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94)' }], {
    duration: 180,
    easing: 'cubic-bezier(.4,0,1,1)',
    fill: 'forwards',
  }).onfinish = () => el.remove();
}

function progressLine(m) {
  if (!playable(m)) return '';
  const r = resumePoint(m);
  if (!r.resume) return '';
  return `<div class="pv-prog"><span class="pv-bar"><i style="width:${Math.round(r.pct * 100)}%"></i></span><small>${m.format === 'MOVIE' ? '' : `E${r.ep} · `}${Math.max(1, Math.round(r.left / 60))}m left</small></div>`;
}
