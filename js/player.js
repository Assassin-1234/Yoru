// Full-screen theatre for official trailers, with a hand-off to the licensed streaming service.
import { esc, icon, titleOf, ytId, streams, toast, overlay, lockScroll } from './util.js';
import { media } from './components.js';
import { detail } from './api.js';
import { trailer } from './yt.js';
import { signal } from './history.js';

let active = null;
export const closePlayer = () => active?.close();

export function openPlayer(m) {
  m = media.get(m.id) || m;
  const id = ytId(m);
  if (!id) return toast('No official trailer for this title yet');
  if (active) active.close();
  signal(m, 'tr');

  const el = document.createElement('div');
  el.className = 'player';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', `${titleOf(m)} trailer`);
  el.innerHTML = `
    <div class="player-stage"><div class="player-video"></div><div class="player-spin" aria-hidden="true"></div></div>
    <div class="player-chrome">
      <button class="player-back" aria-label="Back to browsing">${icon('back')}</button>
      <div class="player-title"><small>Official Trailer</small><strong>${esc(titleOf(m))}</strong></div>
      <a class="player-cta" target="_blank" rel="noopener" hidden></a>
    </div>
    <div class="player-end" hidden>
      <p class="player-end-k">Up next</p>
      <h2>${esc(titleOf(m))}</h2>
      <div class="player-end-actions"><button class="btn btn-ghost" data-close>${icon('back')}<span>Back to browse</span></button></div>
    </div>`;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('in'));

  const unlock = lockScroll();
  const pop = overlay.push(() => close());
  const ctl = trailer(el.querySelector('.player-video'), id, {
    muted: false,
    controls: true,
    onReady: () => el.classList.add('ready'),
    onMutedFallback: () => toast('Playing muted — use the volume control to turn sound on'),
    onPlaying: () => {
      el.classList.add('ready', 'playing');
      el.querySelector('.player-end').hidden = true;
    },
    onEnded: () => (el.querySelector('.player-end').hidden = false),
    onError: () => {
      toast('This trailer can’t be played here');
      close();
    },
  });

  el.querySelector('.player-back').addEventListener('click', () => close());
  el.addEventListener('click', (e) => e.target.closest('[data-close]') && close());

  detail(m.id)
    .then((full) => {
      const s = streams(full)[0];
      if (!s || !el.isConnected) return;
      const label = `Watch on ${esc(s.site)}`;
      const cta = el.querySelector('.player-cta');
      cta.href = s.url;
      cta.innerHTML = `${label} ${icon('external')}`;
      cta.hidden = false;
      el.querySelector('.player-end-actions').innerHTML = `
        <a class="btn btn-play" href="${esc(s.url)}" target="_blank" rel="noopener">${icon('play')}<span>${label}</span></a>
        <button class="btn btn-ghost" data-close>${icon('back')}<span>Back to browse</span></button>`;
    })
    .catch(() => {});

  function close() {
    if (!el.isConnected) return;
    active = null;
    ctl.destroy();
    pop();
    unlock();
    el.classList.remove('in');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 500);
  }
  active = { close };
}
