import { esc, icon, titleOf, nativeOf, ytId, cleanDesc, wideStill, tint, prefs, ambientVideo, overlay } from './util.js';
import { metaLine, listButton, remember } from './components.js';
// (remember() keeps the billboard title addressable by id for Play / More Info / My List.)
import { trailer } from './yt.js';
import { playable } from './sources.js';
import { resumePoint } from './history.js';
import { detail } from './api.js';

// Pick a billboard title: needs a trailer, art and a synopsis. Varies per visit.
export function pickHero(list) {
  const good = list.filter((m) => ytId(m) && m.bannerImage && m.description).slice(0, 8);
  const pool = good.length ? good : list;
  return pool[Math.floor(Math.random() * Math.min(pool.length, 6))];
}

export function heroHTML(m, kicker) {
  const t = titleOf(m);
  const size = t.length > 38 ? 'xl' : t.length > 22 ? 'l' : t.length > 12 ? 'm' : 's';
  const desc = cleanDesc(m.description).split('\n\n')[0];
  const studio = m.studios?.nodes?.[0]?.name;
  return `<section class="hero" style="--c:${tint(m)}" data-hero>
    <div class="hero-media" aria-hidden="true">
      <img class="hero-still" alt="" fetchpriority="high">
      <div class="hero-video"></div>
    </div>
    <div class="hero-shade" aria-hidden="true"></div>
    <div class="hero-content">
      <div class="hero-kicker"><span class="seal seal-xs">夜</span>${kicker}</div>
      <h1 class="hero-title t-${size}">${esc(t)}</h1>
      ${nativeOf(m) ? `<p class="hero-native" lang="ja">${esc(nativeOf(m))}</p>` : ''}
      <div class="hero-fold">
        ${metaLine(m, { genres: true })}
        <p class="hero-desc" ${desc ? '' : 'data-fill'}>${esc(desc)}</p>
        ${studio ? `<p class="hero-studio">Studio <b>${esc(studio)}</b></p>` : ''}
      </div>
      <div class="hero-actions">
        <button class="btn btn-play" data-play="${m.id}">${icon('play')}<span>${playable(m) ? resumePoint(m).label : ytId(m) ? 'Play Trailer' : 'Play'}</span></button>
        <button class="btn btn-ghost" data-open="${m.id}">${icon('info')}<span>More Info</span></button>
        ${listButton(m, 'cbtn cbtn-lg')}
      </div>
    </div>
    <div class="hero-side">
      <button class="round-btn" data-mute hidden aria-label="Toggle sound">${icon('vol-off', 'ic-off')}${icon('vol-on', 'ic-on')}${icon('replay', 'ic-replay')}</button>
      <span class="hero-plate">${esc(m.season ? `${m.season[0]}${m.season.slice(1).toLowerCase()} ${m.seasonYear}` : m.seasonYear || '')}</span>
    </div>
  </section>`;
}

export function mountHero(root, m) {
  remember([m]);
  const el = root.querySelector('[data-hero]');
  if (!el) return () => {};
  wideStill(el.querySelector('.hero-still'), m);
  // Personalised billboards come from the recommender without a synopsis; fetch it quietly.
  const fill = el.querySelector('[data-fill]');
  if (fill)
    detail(m.id)
      .then((full) => {
        const d = cleanDesc(full.description).split('\n\n')[0];
        if (!d || !fill.isConnected) return;
        fill.textContent = d;
        fill.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, easing: 'ease-out' });
      })
      .catch(() => {});

  const id = ytId(m);
  const muteBtn = el.querySelector('[data-mute]');
  let ctl = null;
  let ended = false;
  let inView = true;
  let timer = 0;
  let reveal = 0;

  const paintMute = () => {
    muteBtn.dataset.state = ended ? 'replay' : prefs.muted ? 'off' : 'on';
    muteBtn.setAttribute('aria-label', ended ? 'Replay trailer' : prefs.muted ? 'Unmute' : 'Mute');
  };

  let previewing = false;
  const shouldPlay = () => inView && overlay.depth === 0 && !document.hidden && !previewing;
  const onPreview = (e) => {
    previewing = e.detail;
    sync();
  };

  function start() {
    if (!id || ctl || !ambientVideo()) return;
    ended = false;
    ctl = trailer(el.querySelector('.hero-video'), id, {
      muted: prefs.muted,
      endEarly: 1.2,
      waitHD: true,
      onPlaying() {
        if (!shouldPlay()) return ctl?.pause();
        clearTimeout(reveal);
        reveal = setTimeout(() => {
          if (!ctl) return;
          el.classList.add('playing');
          muteBtn.hidden = false;
          paintMute();
        }, el.classList.contains('playing') ? 0 : 1400);
      },
      onEnded() {
        ended = true;
        el.classList.remove('playing');
        paintMute();
        setTimeout(() => {
          if (ended) {
            ctl?.destroy();
            ctl = null;
          }
        }, 900);
      },
      onError() {
        ctl?.destroy();
        ctl = null;
        el.classList.remove('playing');
        muteBtn.hidden = true;
      },
    });
  }

  const sync = () => {
    if (!ctl) return;
    if (shouldPlay()) ctl.play();
    else ctl.pause();
  };

  muteBtn.addEventListener('click', () => {
    if (ended) {
      start();
      return;
    }
    prefs.muted = !prefs.muted;
  });
  const onMuted = () => {
    ctl?.setMuted(prefs.muted);
    paintMute();
  };

  const io = new IntersectionObserver(
    ([e]) => {
      inView = e.intersectionRatio > 0.45;
      sync();
    },
    { threshold: [0, 0.45, 1] }
  );
  io.observe(el);

  addEventListener('yoru:muted', onMuted);
  addEventListener('yoru:overlay', sync);
  addEventListener('yoru:preview', onPreview);
  document.addEventListener('visibilitychange', sync);
  timer = setTimeout(start, 1200); // the reveal still waits for an HD frame, so loading early costs nothing visible

  return () => {
    clearTimeout(timer);
    clearTimeout(reveal);
    io.disconnect();
    removeEventListener('yoru:muted', onMuted);
    removeEventListener('yoru:overlay', sync);
    removeEventListener('yoru:preview', onPreview);
    document.removeEventListener('visibilitychange', sync);
    ctl?.destroy();
  };
}
