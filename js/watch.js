// The YORU player: full-screen adaptive (HLS) playback with the controls you'd expect from a premium
// streaming service — quality, audio and subtitle tracks, seek previews, Skip Intro, next-episode
// countdown, an episode browser, resume, keyboard + touch gestures, picture-in-picture, Media Session.
import { esc, icon, titleOf, tint, wideStill, overlay, toast, cleanDesc, poster } from './util.js';
import { media, remember, rateBox } from './components.js';
import { detail } from './api.js';
import { sourceFor, episodeList, airedCount, playable } from './sources.js';
import { saveProgress, episodeState, titleState, resumePoint, DONE_AT } from './history.js';
import { recommend } from './recs.js';
import { leaveWatch, watchHref, takeWatchOrigin } from './nav.js';
import { prefetchStream, startEstimate, rememberBandwidth, warmedBitrate, fastStartIndex, codecReady, playbackUrl, ensureBandwidth } from './prefetch.js';

/* ---------- hls.js (loaded on demand, pinned + integrity-checked) ---------- */

const HLS_SRC = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js';
const HLS_SRI = 'sha384-V5ruNBgmYcC3SJRUQeNykAAAgde5gOFq/Hu0CZj7bygDP0yRIhkvX8+w0u/7mRvr';
let hlsLoading = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  return (hlsLoading ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = HLS_SRC;
    s.integrity = HLS_SRI;
    s.crossOrigin = 'anonymous';
    s.onload = () => res(window.Hls);
    s.onerror = () => {
      hlsLoading = null;
      s.remove();
      rej(new Error('Player engine failed to load'));
    };
    document.head.append(s);
  }));
}
export const preloadPlayer = () => loadHls().catch(() => {});

/* ---------- Preferences ---------- */

const PKEY = 'yoru:player:v1';
const prefs = (() => {
  const p = { vol: 1, muted: false, subs: 'en', audio: 'ja', size: 'm', ambient: true, edition: 'sub', clarity: !matchMedia('(pointer: coarse)').matches, motion: false };
  try {
    Object.assign(p, JSON.parse(localStorage.getItem(PKEY)));
  } catch {}
  return {
    get: (k) => p[k],
    set(k, v) {
      p[k] = v;
      try {
        localStorage.setItem(PKEY, JSON.stringify(p));
      } catch {}
    },
  };
})();

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SIZES = [
  ['s', 'Small'],
  ['m', 'Medium'],
  ['l', 'Large'],
];
const NEXT_COUNTDOWN = 10;
const STILL_WATCHING_AFTER = 3; // consecutive auto-played episodes

const clock = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = (s / 3600) | 0;
  const m = ((s % 3600) / 60) | 0;
  const x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};
const lang2 = (l) => String(l || '').slice(0, 2).toLowerCase();
const isTouch = () => matchMedia('(hover: none)').matches;

/* ---------- Markup ---------- */

const SHELL = `<div class="wp" data-state="loading" tabindex="-1">
  <canvas class="wp-ambient" width="32" height="18" aria-hidden="true"></canvas>
  <video class="wp-video" playsinline preload="auto" crossorigin="anonymous"></video>
  <canvas class="wp-clarity" aria-hidden="true"></canvas>
  <div class="wp-poster" aria-hidden="true"><img alt=""></div>
  <div class="wp-card" aria-hidden="true"><span class="seal seal-xs">夜</span><strong class="wp-card-title"></strong><span class="wp-card-ep"></span></div>
  <canvas class="wp-seekframe" aria-hidden="true"></canvas>
  <div class="wp-subs" aria-hidden="true"></div>
  <div class="wp-shade" aria-hidden="true"></div>
  <div class="wp-spin" aria-hidden="true"><i></i></div>
  <div class="wp-flash" aria-hidden="true"></div>
  <div class="wp-taps" aria-hidden="true"><i data-tap="-1"></i><i data-tap="0"></i><i data-tap="1"></i></div>

  <header class="wp-top">
    <button class="wp-iconbtn wp-back" data-act="back" aria-label="Back to browse">${icon('back')}</button>
    <div class="wp-heading"><strong class="wp-title"></strong><span class="wp-sub"></span></div>
  </header>

  <section class="wp-nap" aria-hidden="true">
    <p class="wp-nap-k">You’re watching</p>
    <h2 class="wp-nap-title"></h2>
    <p class="wp-nap-ep"></p>
    <p class="wp-nap-desc"></p>
  </section>

  <button class="wp-skip" data-act="skip" hidden></button>
  <div class="wp-pill" hidden></div>

  <aside class="wp-next" hidden aria-live="polite">
    <div class="wp-next-media"><img alt=""></div>
    <div class="wp-next-body">
      <small class="wp-next-k"></small>
      <strong class="wp-next-title"></strong>
      <div class="wp-next-actions">
        <button class="wp-next-go" data-act="next"><span class="wp-next-fill"></span><span class="wp-next-label">${icon('play')}Next Episode</span></button>
        <button class="wp-next-stay" data-act="credits">Watch credits</button>
      </div>
    </div>
  </aside>

  <div class="wp-controls">
    <div class="wp-scrub" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0">
      <div class="wp-rail"><i class="wp-buf"></i><i class="wp-hov"></i><i class="wp-played"></i><span class="wp-marks"></span></div>
      <span class="wp-knob"></span>
      <div class="wp-tip"><div class="wp-tip-frame"><video muted playsinline crossorigin="anonymous"></video></div><span class="wp-tip-chap"></span><span class="wp-tip-time"></span></div>
    </div>
    <div class="wp-bar">
      <div class="wp-l">
        <button class="wp-iconbtn" data-act="toggle" aria-label="Play">${icon('play', 'ic-play')}${icon('pause', 'ic-pause')}</button>
        <button class="wp-iconbtn" data-act="rew" aria-label="Back 10 seconds">${icon('back10')}</button>
        <button class="wp-iconbtn" data-act="fwd" aria-label="Forward 10 seconds">${icon('fwd10')}</button>
        <div class="wp-vol">
          <button class="wp-iconbtn" data-act="mute" aria-label="Mute">${icon('vol-on', 'ic-vol')}${icon('vol-low', 'ic-low')}${icon('vol-off', 'ic-mute')}</button>
          <input class="wp-vol-range" type="range" min="0" max="1" step="0.01" aria-label="Volume">
        </div>
        <button class="wp-time" data-act="time" aria-label="Toggle remaining time"></button>
      </div>
      <div class="wp-c"><strong class="wp-c-title"></strong><span class="wp-c-ep"></span></div>
      <div class="wp-r">
        <button class="wp-iconbtn" data-act="next" data-has-next aria-label="Next episode" hidden>${icon('next')}</button>
        <button class="wp-iconbtn" data-panel="episodes" aria-label="Episodes" hidden>${icon('episodes')}</button>
        <button class="wp-iconbtn" data-panel="audio" aria-label="Audio &amp; subtitles">${icon('subtitles')}</button>
        <button class="wp-iconbtn" data-panel="settings" aria-label="Playback settings">${icon('gauge')}</button>
        <button class="wp-iconbtn" data-act="pip" aria-label="Picture in picture" hidden>${icon('pip')}</button>
        <button class="wp-iconbtn" data-act="fs" aria-label="Full screen">${icon('fullscreen', 'ic-fs')}${icon('fullscreen-exit', 'ic-fsx')}</button>
      </div>
    </div>
  </div>

  <div class="wp-panel" hidden></div>
  <div class="wp-sheet" hidden></div>
</div>`;

/* =========================================================================================
   Page
   ========================================================================================= */

export function watchPage(view, ctx, route) {
  const baseTitle = document.title.includes(' — YORU') && !document.documentElement.classList.contains('watching') ? document.title : 'YORU — Anime, after dark';
  document.documentElement.classList.add('watching');
  view.innerHTML = SHELL;
  const el = view.querySelector('.wp');
  const v = el.querySelector('.wp-video');
  const q = (s) => el.querySelector(s);
  const scrub = q('.wp-scrub');
  const tip = q('.wp-tip');
  const subsEl = q('.wp-subs');

  const S = {
    token: 0,
    id: 0,
    ep: 1,
    m: null,
    full: null,
    src: null,
    eps: [],
    hls: null,
    next: null,
    panel: null,
    remain: true,
    nextDismissed: false,
    countdown: null,
    chain: 0,
    lastSave: 0,
    idleT: 0,
    napT: 0,
    pillT: 0,
    flashT: 0,
    scrubbing: false,
    hoverT: null,
    preview: null,
    subsKey: null,
    ended: false,
  };

  /* ---------- YORU Clarity: GPU upscale + adaptive sharpen + optional Motion 60 ---------- */
  // A 3.5 Mbps 1080p source scaled by the browser is soft. This renders the decoded frame through a WebGL2
  // shader at the display's real resolution with bicubic reconstruction, adaptive sharpening and a deband
  // dither. Motion 60 is opt-in, off by default, and labelled interpolated: it trades some ghosting on fast
  // motion for smoother camera movement. Native 23.976 remains the reference picture.
  const clarity = (() => {
    const canvas = q('.wp-clarity');
    let gl = null, prog = null, tex = [], cur = 0, uTexel = null, uSharp = null, uCubic = null;
    let uPrev = null, uCur = null, uMix = null;
    let running = false, raf = 0, rvfc = 0, motion = false, lastMedia = -1, lastFrameAt = 0;
    let lastW = 0, lastH = 0;
    const FRAME_MS = 1000 / 23.976;

    const VS = `#version 300 es
in vec2 a; out vec2 uv;
void main(){ uv=a*0.5+0.5; gl_Position=vec4(a,0.0,1.0); }`;
    const FS = `#version 300 es
precision highp float;
uniform sampler2D u_prev; uniform sampler2D u_cur;
uniform vec2 u_texel; uniform float u_sharp; uniform float u_cubic; uniform float u_mix;
in vec2 uv; out vec4 outColor;
vec3 tap(vec2 o){ return texture(u_cur, uv + o*u_texel).rgb; }
vec4 cr(float t){
  float t2=t*t, t3=t2*t;
  return vec4(-0.5*t3+t2-0.5*t, 1.5*t3-2.5*t2+1.0, -1.5*t3+2.0*t2+0.5*t, 0.5*t3-0.5*t2);
}
vec3 cubic(vec2 p){
  vec2 size = 1.0/u_texel;
  vec2 coord = p*size - 0.5;
  vec2 f = fract(coord);
  vec2 base = floor(coord);
  vec4 wx = cr(f.x), wy = cr(f.y);
  vec3 sum = vec3(0.0);
  for (int y=-1; y<=2; y++) {
    for (int x=-1; x<=2; x++) {
      vec2 q = clamp((base + vec2(float(x),float(y)) + 0.5) * u_texel, u_texel*0.5, 1.0-u_texel*0.5);
      sum += texture(u_cur, q).rgb * wx[x+1] * wy[y+1];
    }
  }
  return sum;
}
void main(){
  vec3 now = u_cubic > 0.5 ? cubic(uv) : tap(vec2(0.0));
  vec3 c = u_mix < 0.999 ? mix(texture(u_prev, uv).rgb, now, u_mix) : now;
  vec3 n = tap(vec2(0.0,-1.0)), s = tap(vec2(0.0,1.0));
  vec3 w = tap(vec2(-1.0,0.0)), e = tap(vec2(1.0,0.0));
  vec3 blur = (n+s+w+e)*0.25;
  vec3 sharp = c + (now-blur)*u_sharp;
  // Keep the sharpener inside the local neighbourhood so line art does not grow halos.
  vec3 mx = max(max(n,s),max(w,e)), mn = min(min(n,s),min(w,e));
  sharp = clamp(sharp, mn-0.035, mx+0.035);
  float d = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233)))*43758.5453)-0.5)/255.0;
  outColor = vec4(clamp(sharp+d,0.0,1.0),1.0);
}`;

    const shader = (type, src) => {
      const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const mkTex = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const init = () => {
      if (gl) return true;
      try {
        gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
        if (!gl) return false;
        prog = gl.createProgram();
        gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
        const a = gl.getAttribLocation(prog, 'a');
        gl.enableVertexAttribArray(a);
        gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
        tex = [mkTex(), mkTex()];
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        uTexel = gl.getUniformLocation(prog, 'u_texel');
        uSharp = gl.getUniformLocation(prog, 'u_sharp');
        uCubic = gl.getUniformLocation(prog, 'u_cubic');
        uPrev = gl.getUniformLocation(prog, 'u_prev');
        uCur = gl.getUniformLocation(prog, 'u_cur');
        uMix = gl.getUniformLocation(prog, 'u_mix');
        gl.uniform1f(uSharp, 0.45);
        gl.uniform1f(uCubic, 1);
        gl.uniform1f(uMix, 1);
        gl.uniform1i(uPrev, 0);
        gl.uniform1i(uCur, 1);
        return true;
      } catch (err) {
        console.warn('YORU Clarity unavailable:', err?.message || err);
        gl = null;
        return false;
      }
    };

    const upload = (i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    };

    const draw = () => {
      if (!running || !gl || v.readyState < 2) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = Math.max(2, Math.round(v.clientWidth * dpr));
      const ch = Math.max(2, Math.round(v.clientHeight * dpr));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw; canvas.height = ch;
        lastW = lastH = 0;
      }
      if (!lastW || !lastH) {
        gl.viewport(0, 0, cw, ch);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const ar = (v.videoWidth || 16) / (v.videoHeight || 9);
        let w = cw, h = ch;
        if (cw / ch > ar) w = Math.round(ch * ar); else h = Math.round(cw / ar);
        gl.viewport(Math.round((cw - w) / 2), Math.round((ch - h) / 2), w, h);
        lastW = cw; lastH = ch;
      }
      const now = performance.now();
      let mix = 1;
      if (motion && !v.paused && !v.ended) {
        if (lastMedia < 0) {
          upload(cur); upload(1 - cur);
          lastMedia = v.currentTime; lastFrameAt = now;
        } else if (v.currentTime !== lastMedia) {
          cur = 1 - cur;
          upload(cur);
          lastMedia = v.currentTime; lastFrameAt = now;
        }
        mix = Math.min(1, Math.max(0, (now - lastFrameAt) / FRAME_MS));
      } else {
        upload(cur);
      }
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[1 - cur]);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
      gl.uniform2f(uTexel, 1 / (v.videoWidth || 1920), 1 / (v.videoHeight || 1080));
      // 16-tap bicubic is cheap at 1080p/1440p; a 4K canvas falls back to the 4-tap path to protect frame pacing.
      gl.uniform1f(uCubic, cw * ch <= 4.2e6 ? 1 : 0);
      gl.uniform1f(uMix, mix);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    const cancel = () => {
      if (rvfc && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(rvfc);
      cancelAnimationFrame(raf);
      rvfc = raf = 0;
    };
    const loop = () => {
      if (!running) return;
      draw();
      if (motion) raf = requestAnimationFrame(loop);
      else if (v.requestVideoFrameCallback) rvfc = v.requestVideoFrameCallback(loop);
      else raf = requestAnimationFrame(loop);
    };
    const once = () => { if (running) { lastW = lastH = 0; draw(); } };

    return {
      get supported() { return !!canvas && !!canvas.getContext; },
      set(on) {
        const want = !!on && this.supported && init();
        el.classList.toggle('clarity', want);
        if (want && !running) {
          running = true;
          v.addEventListener('seeked', once);
          loop();
        } else if (!want && running) {
          running = false;
          cancel();
          v.removeEventListener('seeked', once);
          canvas.width = canvas.height = 0;
        }
        return want;
      },
      setMotion(on) {
        const want = !!on;
        if (motion === want) return;
        motion = want;
        lastMedia = -1;
        if (running) { cancel(); loop(); }
      },
      resize() { if (running) { lastW = lastH = 0; once(); } },
      stop() { this.set(false); },
    };
  })();

  /* ---------- Lifecycle ---------- */

  const popLayer = overlay.push(() => (S.panel ? closePanel() : back()));
  const back = () => {
    persist(true);
    leaveWatch(S.id);
  };

  ctx.update = (r) => {
    const id = Number(r.arg);
    const ep = Number(r.params.get('ep')) || 0;
    if (id === S.id && ep === S.ep) return;
    load(id, ep, Number(r.params.get('at')) || 0);
  };

  ctx.cleanups.push(() => {
    persist(true); // never drop the final position to the save throttle
    S.token++;
    teardown();
    destroyPreview();
    popLayer();
    removeEventListener('keydown', onKey, true);
    document.removeEventListener('fullscreenchange', paintFs);
    document.removeEventListener('visibilitychange', onVisibility);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    try {
      screen.orientation?.unlock?.();
    } catch {}
    clearMediaSession();
    document.title = baseTitle;
    document.documentElement.classList.remove('watching');
  });

  load(Number(route.arg), Number(route.params.get('ep')) || 0, Number(route.params.get('at')) || 0);

  async function load(id, ep, at) {
    const tok = ++S.token;
    persist(true);
    teardown();
    Object.assign(S, { id, ep: ep || 1, nextDismissed: false, ended: false, src: null, next: null });
    el.dataset.state = 'loading';
    closePanel();
    closeSheet();

    let m = media.get(id) || titleState(id)?.m || null;
    if (m) paintMeta(m, ep || resumePoint(m).ep);

    let full = null;
    try {
      full = await detail(id);
    } catch {
      if (!m) return fail('We couldn’t load this title. Check your connection and try again.', true);
    }
    if (tok !== S.token) return;
    if (full) {
      if (full.isAdult) return back();
      remember([full]);
      m = media.get(id);
    }
    if (!ep) {
      ep = resumePoint(m).ep;
      history.replaceState(history.state, '', watchHref(id, ep));
    }
    Object.assign(S, { m, full, ep, eps: episodeList(m, full) });
    S.edition = prefs.get('edition') === 'dub' ? 'dub' : 'sub';
    // Measure the path while the stream resolves, so the very first episode opens on the right rung.
    const measured = ensureBandwidth();
    S.src = await sourceFor(m, ep, S.edition);
    if (tok !== S.token) return;
    if (!S.src && S.edition === 'dub') {
      // The viewer prefers dubs, but this episode has none: keep them watching rather than bounce them.
      S.edition = 'sub';
      prefs.set('edition', 'sub');
      S.src = await sourceFor(m, ep, 'sub');
      if (tok !== S.token) return;
      if (S.src) pill('English dub isn’t available — playing subtitled.');
    }
    if (!S.src) return fail(airedCount(m) ? 'This episode isn’t available to stream yet.' : 'This title hasn’t premiered yet.', false);
    await measured;
    if (tok !== S.token) return;
    S.next = nextTarget();
    // Warm the next episode's first segment while this one plays. Auto-advance then starts from cache;
    // one segment is a few MB, and Save-Data users are left alone.
    if (S.next && !navigator.connection?.saveData) {
      const warm = () => {
        sourceFor(S.next.m, S.next.ep, S.edition)
          .then((src) => src && prefetchStream(playbackUrl(src), { segments: 1 }))
          .catch(() => {});
      };
      if (window.requestIdleCallback) requestIdleCallback(warm, { timeout: 8000 });
      else setTimeout(warm, 8000);
    }
    paintMeta(m, ep);
    setMediaSession();

    const st = episodeState(id, ep);
    let start = at;
    let resumed = false;
    if (!at && st && !st.done && st.p > 15 && (!st.d || st.p < st.d - 25)) {
      start = st.p;
      resumed = true;
    }
    await attach(S.src, start, tok);
    if (tok !== S.token) return;
    if (resumed) pill(`Resumed from ${clock(start)}`, { label: 'Start over', act: () => seek(0) });
  }

  // Best picture for *this* screen: allow one rung above the physical pixels the picture occupies (a downscaled
  // 1440p looks crisper than native 1080p), but never pull 4K into a phone. Re-evaluated on resize/full screen.
  function capForScreen() {
    const hls = S.hls;
    if (!hls?.levels?.length) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const top = hls.levels.reduce((a, b) => (b.height > a.height ? b : a));
    const ar = top.width / top.height || 16 / 9;
    const box = v.getBoundingClientRect();
    const pictureH = Math.min(box.height, box.width / ar) * dpr;
    const order = hls.levels.map((l, i) => ({ i, h: l.height })).sort((a, b) => a.h - b.h);
    let k = order.findIndex((l) => l.h >= pictureH * 0.95);
    if (k < 0) k = order.length - 1;
    k = Math.min(order.length - 1, k + 1);
    while (k > 0 && order[k].h > (S.decodeCap ?? Infinity)) k--;
    const cap = order[k].i;
    if (hls.autoLevelCapping !== cap) hls.autoLevelCapping = cap;
    clarity.resize();
  }
  addEventListener('resize', capForScreen);
  document.addEventListener('fullscreenchange', capForScreen);
  ctx.cleanups.push(() => {
    removeEventListener('resize', capForScreen);
    document.removeEventListener('fullscreenchange', capForScreen);
  });

  // Ambient light: the picture's colours glow into the letterbox/pillarbox space around the frame (cinema bias
  // lighting). Sampled 4×/s into a 32×18 canvas that CSS blurs and scales — negligible cost, never touches decode.
  const amb = q('.wp-ambient');
  const ambCtx = amb.getContext('2d', { willReadFrequently: false, alpha: false });
  let ambTimer = 0;
  function ambient() {
    clearInterval(ambTimer);
    const on = prefs.get('ambient') && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.classList.toggle('ambient', on);
    if (!on) return;
    const draw = () => {
      if (v.readyState < 2 || document.hidden) return;
      try {
        ambCtx.drawImage(v, 0, 0, 32, 18);
      } catch {}
    };
    draw();
    ambTimer = setInterval(draw, 250);
  }
  v.addEventListener('loadeddata', ambient);
  ctx.cleanups.push(() => clearInterval(ambTimer));

  function teardown() {
    S.decodeCap = Infinity;
    clearInterval(S.countdown);
    S.countdown = null;
    // Only trust the player's estimate if no real measurement exists (cache hits inflate it).
    try {
      if (!localStorage.getItem('yoru:bw:v1')) rememberBandwidth(S.hls?.bandwidthEstimate);
    } catch {}
    S.hls?.destroy();
    S.hls = null;
    v.removeAttribute('src');
    v.querySelectorAll('track').forEach((t) => t.remove());
    try {
      v.load();
    } catch {}
    subsEl.textContent = '';
    q('.wp-next').hidden = true;
    q('.wp-skip').hidden = true;
    q('.wp-marks').innerHTML = '';
    el.classList.remove('nap', 'has-subs');
    resetPreview();
  }

  function fail(msg, retry) {
    el.dataset.state = 'error';
    sheet(`<div class="wp-sheet-card">
      <span class="wp-sheet-k" aria-hidden="true">夜</span>
      <h2>${esc(msg)}</h2>
      <div class="wp-sheet-actions">
        ${retry ? `<button class="btn btn-play" data-act="retry">${icon('replay')}<span>Try again</span></button>` : ''}
        <button class="btn btn-ghost" data-act="back">${icon('back')}<span>Back to browse</span></button>
      </div></div>`);
  }

  /* ---------- Media attach ---------- */

  // Codec choice is made once per device (prefetch.js) so the head-start warms the same ladder we'll play.
  async function chooseVariant(src) {
    await codecReady;
    return playbackUrl(src);
  }

  // Highest rendition this device can decode: an upper bound for ABR. `smooth` is advisory and reports false
  // for 1080p on many desktop GPUs, which would otherwise pin the player to 720p forever.
  async function capForDecoder(hls) {
    if (!navigator.mediaCapabilities?.decodingInfo || !hls.levels?.length) return;
    const checks = await Promise.all(
      hls.levels.map((l) =>
        navigator.mediaCapabilities
          .decodingInfo({
            type: 'media-source',
            video: {
              contentType: `video/mp4; codecs="${(l.videoCodec || l.codecSet || 'avc1.640028').split(',')[0]}"`,
              width: l.width || 1920,
              height: l.height || 1080,
              framerate: Number(l.frameRate) || 30,
              bitrate: l.bitrate || 5e6,
            },
          })
          .then((r) => r.supported)
          .catch(() => true)
      )
    );
    let best = -1;
    hls.levels.forEach((l, i) => checks[i] && (best < 0 || l.height > hls.levels[best].height) && (best = i));
    // 1080p H.264 is table stakes; never let an advisory capability probe pin the player to 720p.
    S.decodeCap = Math.max(1080, best >= 0 ? hls.levels[best].height : 0);
    capForScreen();
  }

  async function attach(src, start, tok) {
    if (S.hevcFailed && src.hevc) src = { ...src, hevc: null }; // this device had trouble with HEVC: stay on H.264
    v.volume = prefs.get('vol');
    v.muted = prefs.get('muted');
    v.playbackRate = 1;
    for (const s of src.subtitles || []) {
      const t = document.createElement('track');
      Object.assign(t, { kind: 'subtitles', src: s.src, srclang: s.lang, label: s.label || s.lang });
      v.append(t);
    }
    const nativeOnly = !window.MediaSource && v.canPlayType('application/vnd.apple.mpegurl');
    if (src.type === 'hls' && !nativeOnly) {
      let Hls;
      try {
        Hls = await loadHls();
      } catch {
        if (tok === S.token) fail('The player couldn’t start. Check your connection and try again.', true);
        return;
      }
      if (tok !== S.token) return;
      if (Hls.isSupported()) {
        const hls = new Hls({
          startPosition: start || -1,
          // Start on the right rung: seed ABR with last session's measured bandwidth (or the browser's hint),
          // instead of hls.js's conservative 500 kbps default that opens every episode soft.
          abrEwmaDefaultEstimate: startEstimate(),
          // hls.js silently clamps the default estimate to 5 Mbps; honour our measured figure instead.
          abrEwmaDefaultEstimateMax: 200e6,
          startLevel: -1,
          // React to throughput quickly so a conservative fast start climbs to full quality within seconds.
          abrEwmaFastVoD: 2,
          abrEwmaSlowVoD: 6,
          // No size cap — stream the best rendition the connection sustains; downscaling looks sharper than upscaling.
          capLevelToPlayerSize: false,
          // If the device starts dropping frames at a rendition, step down instead of stuttering.
          capLevelOnFPSDrop: true,
          fpsDroppedMonitoringThreshold: 0.12,
          fpsDroppedMonitoringPeriod: 4000,
          maxBufferLength: 40,
          backBufferLength: 90,
          enableWorker: true,
          startFragPrefetch: true,
        });
        S.hls = hls;
        v._hls = hls; // diagnostics handle
        let recovered = 0;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (tok !== S.token) return;
          // A previous rendition failed mid-episode (a missing segment on a lower rung). Recover on the top
          // rendition — the same one Zoko masters as 1080p — instead of losing the episode.
          if (src.forceTop && hls.levels.length) {
            const top = hls.levels.reduce((a, b, i) => (b.height > hls.levels[a].height ? i : a), 0);
            hls.startLevel = top;
            hls.currentLevel = top;
            S.startLevel = top;
            capForDecoder(hls);
            paintTracks();
            play();
            return;
          }
          // Start sharp *and* fast: at the rendition a prefetch already cached, otherwise at the best one whose first
          // segment arrives in ~1 s; ABR climbs from there.
          const rates = hls.levels.map((l) => l.bitrate);
          const cached = warmedBitrate(url, start || 0);
          let idx = cached ? rates.findIndex((b) => b === cached) : -1;
          if (idx < 0 && rates.length > 1) idx = fastStartIndex(rates, src.segment || 6);
          // Never start above what this screen will be capped to (the first segment is the latency-critical one).
          capForScreen();
          const capH = hls.autoLevelCapping >= 0 ? hls.levels[hls.autoLevelCapping]?.height : Infinity;
          if (idx >= 0 && hls.levels[idx].height > capH) idx = hls.autoLevelCapping;
          // On a fast desktop, skip the soft opening rung entirely: 1080p is the point. The estimate has to
          // clear the top bitrate with headroom, and ABR stays enabled, so a bad estimate still steps down.
          const topIdx = hls.autoLevelCapping >= 0 ? hls.autoLevelCapping : hls.levels.reduce((a, b, i) => (b.height > hls.levels[a].height ? i : a), 0);
          if (!matchMedia('(pointer: coarse)').matches && hls.levels[topIdx].height <= 1080 && startEstimate() >= hls.levels[topIdx].bitrate * 1.3) idx = topIdx;
          if (idx >= 0) hls.startLevel = idx;
          S.startLevel = idx;
          capForDecoder(hls);
          paintTracks();
          play();
        });
        v.addEventListener('loadedmetadata', () => tok === S.token && S.subsKey && applySubModes(), { once: true });
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => tok === S.token && pickDefaultSubs());
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => tok === S.token && pickDefaultAudio());
        hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, () => tok === S.token && bindTextTracks());
        hls.on(Hls.Events.LEVEL_SWITCHED, () => S.panel === 'settings' && renderPanel());
        hls.on(Hls.Events.ERROR, (_, d) => {
          if (tok !== S.token) return;
          // The HEVC ladder is an optimisation: any fatal problem with it (missing playlist, a decoder that
          // over-promised) silently restarts on the universal H.264 ladder at the same position.
          const codecTrouble = d.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR || d.details === Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR;
          if (S.variant === 'hevc' && (d.fatal || codecTrouble) && !S.hevcFailed) {
            S.hevcFailed = true;
            const at = v.currentTime > 1 ? v.currentTime : start;
            hls.destroy();
            S.hls = null;
            return attach({ ...src, hevc: null }, at, tok);
          }
          if (!d.fatal) return;
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR && recovered++ < 3) hls.startLoad();
          else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && recovered++ < 3) hls.recoverMediaError();
          else if (d.type === Hls.ErrorTypes.NETWORK_ERROR && !src.forceTop && hls.levels.length > 1) {
            // Zoko's lower rungs occasionally point at a segment its CDN no longer has. Pin the top rung.
            const at = v.currentTime > 1 ? v.currentTime : start;
            hls.destroy();
            S.hls = null;
            return attach({ ...src, forceTop: true }, at, tok);
          } else fail('This episode can’t play right now.', true);
        });
        const url = src.hevc ? await chooseVariant(src) : src.src;
        if (tok !== S.token) return hls.destroy();
        S.variant = url === src.hevc ? 'hevc' : 'avc';
        hls.loadSource(url);
        hls.attachMedia(v);
        return;
      }
    }
    // Native playback (Safari / iOS, or progressive files).
    v.src = src.src;
    v.addEventListener(
      'loadedmetadata',
      () => {
        if (tok !== S.token) return;
        if (start) v.currentTime = start;
        paintTracks();
        pickDefaultSubs();
        play();
      },
      { once: true }
    );
  }

  function play() {
    const p = v.play();
    p?.catch(() => {
      if (v.muted) return paintPlay();
      v.muted = true;
      v.play()
        .then(() => pill('Playing muted', { label: 'Turn sound on', act: () => setMuted(false), stay: true }))
        .catch(() => paintPlay());
    });
  }

  /* ---------- What's next ---------- */

  function nextTarget() {
    const { m, full, ep } = S;
    if (ep < airedCount(m)) {
      const e = S.eps.find((x) => x.n === ep + 1);
      return { id: m.id, ep: ep + 1, kind: 'Next Episode', title: e?.title || `Episode ${ep + 1}`, thumb: e?.thumb, m };
    }
    const seq = (full?.relations?.edges || []).find((e) => e.relationType === 'SEQUEL' && e.node.type === 'ANIME' && ['TV', 'ONA', 'MOVIE'].includes(e.node.format) && playable(e.node));
    if (seq) {
      remember([seq.node]);
      return { id: seq.node.id, ep: 1, kind: 'Next Season', title: titleOf(seq.node), m: seq.node };
    }
    return null;
  }

  function goTo(target, { auto = false } = {}) {
    if (!target) return;
    if (auto) {
      S.chain++;
      if (S.chain >= STILL_WATCHING_AFTER) return stillWatching(target);
    } else S.chain = 0;
    persist();
    location.replace(watchHref(target.id, target.ep));
  }

  /* ---------- Painting ---------- */

  function paintMeta(m, ep) {
    const movie = m.format === 'MOVIE';
    const e = S.eps.find((x) => x.n === ep);
    const epLine = movie ? '' : `E${ep}${e && !/^Episode \d+$/.test(e.title) ? ` · ${e.title}` : ''}`;
    el.style.setProperty('--c', tint(m));
    q('.wp-title').textContent = titleOf(m);
    q('.wp-sub').textContent = epLine;
    q('.wp-c-title').textContent = titleOf(m);
    q('.wp-c-ep').textContent = movie ? '' : `E${ep}${e && !/^Episode \d+$/.test(e.title) ? ` “${e.title}”` : ''}`;
    q('.wp-nap-title').textContent = titleOf(m);
    q('.wp-nap-ep').textContent = movie ? '' : `Episode ${ep}${e && !/^Episode \d+$/.test(e.title) ? ` · ${e.title}` : ''}`;
    const desc = cleanDesc(S.full?.description || m.description || '').split('\n\n')[0] || '';
    q('.wp-nap-desc').textContent = desc.length > 260 ? desc.slice(0, 257).replace(/\s+\S*$/, '') + '…' : desc;
    // Loading frame: this episode's own thumbnail when we have one, otherwise the title's still.
    q('.wp-card-title').textContent = titleOf(m);
    q('.wp-card-ep').textContent = movie ? '' : `Episode ${ep}${e && !/^Episode \d+$/.test(e.title) ? ` · ${e.title}` : ''}`;
    const img = q('.wp-poster img');
    const key = `${m.id}:${e?.thumb ? ep : 0}`;
    if (img.dataset.for !== key) {
      img.dataset.for = key;
      img.classList.remove('ok');
      if (e?.thumb) {
        img.onload = () => img.classList.add('ok');
        img.onerror = () => wideStill(img, m);
        img.src = e.thumb;
      } else wideStill(img, m);
    }
    q('[data-panel="episodes"]').hidden = movie || S.eps.length < 2;
    q('[data-has-next]').hidden = !S.next;
    q('[data-act="pip"]').hidden = !document.pictureInPictureEnabled;
    document.title = `${titleOf(m)}${movie ? '' : ` · E${ep}`} — YORU`;
  }

  function paintPlay() {
    const playing = !v.paused && !v.ended;
    el.classList.toggle('playing', playing);
    q('[data-act="toggle"]').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  function paintTime() {
    const d = v.duration || 0;
    const t = v.currentTime || 0;
    if (!S.scrubbing) {
      const pct = d ? (t / d) * 100 : 0;
      el.style.setProperty('--played', pct + '%');
      scrub.setAttribute('aria-valuenow', String(Math.floor(t)));
      scrub.setAttribute('aria-valuemax', String(Math.floor(d)));
      scrub.setAttribute('aria-valuetext', `${clock(t)} of ${clock(d)}`);
    }
    q('.wp-time').textContent = d ? (S.remain ? `-${clock(d - t)}` : `${clock(t)} / ${clock(d)}`) : '';
  }

  function paintBuffer() {
    const d = v.duration || 0;
    let end = 0;
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i));
    el.style.setProperty('--buffered', d ? (end / d) * 100 + '%' : '0%');
  }

  function paintVolume() {
    const vol = v.muted ? 0 : v.volume;
    q('.wp-vol-range').value = String(vol);
    q('.wp-vol').style.setProperty('--vol', vol * 100 + '%');
    q('.wp-vol').dataset.level = vol === 0 ? 'mute' : vol < 0.5 ? 'low' : 'high';
    q('[data-act="mute"]').setAttribute('aria-label', v.muted ? 'Unmute' : 'Mute');
  }

  function paintMarks() {
    const d = v.duration;
    if (!d) return;
    const marks = [];
    const span = (a, b, cls) => marks.push(`<i class="${cls}" style="left:${(a / d) * 100}%;width:${((b - a) / d) * 100}%"></i>`);
    if (S.src?.recap) span(S.src.recap[0], S.src.recap[1], 'mk-recap');
    if (S.src?.intro) span(S.src.intro[0], S.src.intro[1], 'mk-intro');
    if (S.src?.credits) span(S.src.credits, d, 'mk-credits');
    q('.wp-marks').innerHTML = marks.join('');
  }

  function paintFs() {
    el.classList.toggle('fs', !!document.fullscreenElement);
    q('[data-act="fs"]').setAttribute('aria-label', document.fullscreenElement ? 'Exit full screen' : 'Full screen');
  }

  /* ---------- Chapter logic: skip intro / recap, next-episode card ---------- */

  function chapters() {
    const t = v.currentTime;
    const d = v.duration || 0;
    const src = S.src || {};
    const skip = q('.wp-skip');
    const inRange = (r) => r && t >= r[0] && t < r[1] - 1;
    const which = inRange(src.recap) ? ['Skip Recap', src.recap[1]] : inRange(src.intro) ? ['Skip Intro', src.intro[1]] : null;
    if (which) {
      if (skip.hidden || skip.dataset.to !== String(which[1])) {
        skip.innerHTML = `${esc(which[0])}${icon('next')}`;
        skip.dataset.to = which[1];
        skip.hidden = false;
      }
    } else if (!skip.hidden) skip.hidden = true;

    const creditsAt = src.credits || (d ? d - 30 : Infinity);
    if (S.next && !S.nextDismissed && d && t >= creditsAt && t < d - 0.5 && !v.paused) showNext();
    else if (S.countdown && (t < creditsAt || S.nextDismissed)) hideNext();
  }

  function showNext() {
    if (S.countdown) return;
    const n = S.next;
    // While the credits roll, warm the next episode so auto-advance starts from cache.
    sourceFor(n.m, n.ep, S.edition)
      .then((src) => src && prefetchStream(playbackUrl(src)))
      .catch(() => {});
    const card = q('.wp-next');
    q('.wp-next-k').textContent = n.kind;
    q('.wp-next-title').textContent = n.kind === 'Next Season' ? n.title : `E${n.ep} · ${n.title}`;
    q('.wp-next-label').innerHTML = `${icon('play')}${n.kind}`;
    const img = q('.wp-next-media img');
    img.onload = img.onerror = null;
    img.classList.remove('ok');
    if (n.thumb) {
      img.onload = () => img.classList.add('ok');
      img.onerror = () => wideStill(img, n.m);
      img.src = n.thumb;
    } else wideStill(img, n.m);
    card.hidden = false;
    card.style.setProperty('--secs', NEXT_COUNTDOWN + 's');
    card.classList.remove('run');
    void card.offsetWidth;
    card.classList.add('run');
    let left = NEXT_COUNTDOWN;
    S.countdown = setInterval(() => {
      if (v.paused) return;
      if (--left <= 0) {
        clearInterval(S.countdown);
        goTo(S.next, { auto: true });
      }
    }, 1000);
  }

  function hideNext() {
    clearInterval(S.countdown);
    S.countdown = null;
    q('.wp-next').hidden = true;
  }

  /* ---------- End of title ---------- */

  async function ended() {
    S.ended = true;
    persist(true);
    if (S.next) return goTo(S.next, { auto: true });
    hideNext();
    const m = S.m;
    const releasing = m.status === 'RELEASING';
    sheet(`<div class="wp-end">
      <div class="wp-end-head">
        <p class="wp-end-k">${releasing ? 'You’re all caught up' : 'You’ve finished'}</p>
        <h2>${esc(titleOf(m))}</h2>
        ${releasing && m.nextAiringEpisode ? `<p class="wp-end-sub">Episode ${m.nextAiringEpisode.episode} arrives in ${Math.ceil(m.nextAiringEpisode.timeUntilAiring / 86400)} day${m.nextAiringEpisode.timeUntilAiring > 86400 ? 's' : ''}.</p>` : ''}
        <div class="wp-end-rate"><span>How was it?</span>${rateBox(m, 'rate-open')}</div>
      </div>
      <div class="wp-end-more"><p class="wp-end-k">Watch next</p><div class="wp-end-grid"><span class="sk sk-wide"></span><span class="sk sk-wide"></span><span class="sk sk-wide"></span></div></div>
      <div class="wp-sheet-actions">
        <button class="btn btn-ghost" data-act="back">${icon('back')}<span>Back to browse</span></button>
        <button class="btn btn-ghost" data-act="again">${icon('replay')}<span>Watch again</span></button>
      </div>
    </div>`);
    const grid = q('.wp-end-grid');
    const picks = await watchNext(m).catch(() => []);
    if (!grid.isConnected) return;
    grid.innerHTML = picks.length
      ? picks
          .map(
            (r) => `<button class="wp-end-card" data-go="${r.id}" style="--c:${tint(r)}">
          <span class="wp-end-media"><img alt="" data-still="${r.id}"><span class="wp-end-play">${icon('play')}</span></span>
          <strong>${esc(titleOf(r))}</strong></button>`
          )
          .join('')
      : `<p class="muted">Explore more from the home page.</p>`;
    grid.querySelectorAll('[data-still]').forEach((img) => wideStill(img, media.get(Number(img.dataset.still))));
  }

  // The recommender's picks first (personal), then this title's own community recommendations.
  async function watchNext(m) {
    const own = (S.full?.recommendations?.nodes || []).map((n) => n.mediaRecommendation).filter((r) => r && !r.isAdult && playable(r));
    let picks = [];
    try {
      const r = await Promise.race([recommend(), new Promise((res) => setTimeout(() => res(null), 2500))]);
      if (r?.ready) {
        const ownIds = new Set(own.map((x) => x.id));
        picks = [...r.picks.filter((x) => ownIds.has(x.id)), ...r.picks];
      }
    } catch {}
    const seen = new Set([m.id]);
    const out = [];
    for (const x of [...picks, ...own]) {
      if (out.length >= 3) break;
      if (seen.has(x.id) || !playable(x) || (titleState(x.id)?.t && resumePoint(x).rewatch)) continue;
      seen.add(x.id);
      out.push(x);
    }
    remember(out);
    return out;
  }

  function stillWatching(target) {
    v.pause();
    hideNext();
    sheet(`<div class="wp-sheet-card">
      <h2>Are you still watching <em>${esc(titleOf(S.m))}</em>?</h2>
      <div class="wp-sheet-actions">
        <button class="btn btn-play" data-act="continue">${icon('play')}<span>Continue watching</span></button>
        <button class="btn btn-ghost" data-act="back">${icon('back')}<span>Back to browse</span></button>
      </div></div>`);
    S.pendingNext = target;
  }

  function sheet(html) {
    const s = q('.wp-sheet');
    s.innerHTML = html;
    s.hidden = false;
    el.classList.add('sheet-open');
    s.querySelector('button')?.focus({ preventScroll: true });
  }
  function closeSheet() {
    const s = q('.wp-sheet');
    s.hidden = true;
    s.innerHTML = '';
    el.classList.remove('sheet-open');
  }

  /* ---------- Tracks: subtitles, audio, quality ---------- */

  // Subtitle options: sidecar <track> files (s*), plus tracks carried in the HLS manifest (h*),
  // or every native text track when the browser plays HLS itself (n*).
  const sidecars = () => [...v.querySelectorAll('track')].map((t) => t.track);
  function subOptions() {
    const side = [...v.querySelectorAll('track')].map((t, i) => ({ key: 's' + i, label: t.label, lang: t.srclang, track: t.track }));
    if (S.hls) {
      const names = S.src?.tracks || {};
      const inHls = (S.hls.subtitleTracks || [])
        .map((t, i) => {
          const fix = names[t.name];
          if (fix === null) return null;
          return { key: 'h' + i, label: fix?.[0] || t.name || t.lang, lang: fix?.[1] || t.lang };
        })
        .filter(Boolean);
      return [...side, ...inHls];
    }
    const own = new Set(sidecars());
    const native = [...v.textTracks]
      .filter((t) => (t.kind === 'subtitles' || t.kind === 'captions') && !own.has(t))
      .map((t, i) => ({ key: 'n' + i, label: t.label || t.language, lang: t.language, track: t }));
    return [...side, ...native];
  }

  function applySubModes() {
    const opts = subOptions();
    for (const o of opts) if (o.track) o.track.mode = o.key === S.subsKey ? 'hidden' : 'disabled';
  }

  function setSubs(key, remember = true) {
    S.subsKey = key;
    if (S.hls) {
      S.hls.subtitleDisplay = false; // we render cues ourselves
      S.hls.subtitleTrack = key && key[0] === 'h' ? Number(key.slice(1)) : -1;
    }
    applySubModes();
    const chosen = subOptions().find((o) => o.key === key);
    if (remember) prefs.set('subs', chosen ? lang2(chosen.lang) : 'off');
    el.classList.toggle('has-subs', !!chosen);
    subsEl.textContent = '';
    bindTextTracks();
  }

  function pickDefaultSubs() {
    const want = prefs.get('subs');
    const opts = subOptions();
    if (!opts.length) return;
    const pick = want === 'off' ? null : opts.find((o) => lang2(o.lang) === want) || opts.find((o) => lang2(o.lang) === 'en');
    setSubs(pick?.key || null, false);
  }

  // Render cues ourselves (consistent styling everywhere, and positioned clear of the controls).
  function bindTextTracks() {
    for (const t of v.textTracks) {
      if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
      if (t.mode === 'showing') t.mode = 'hidden';
      if (!t._yoru) {
        t._yoru = true;
        t.addEventListener('cuechange', renderCues);
      }
    }
    renderCues();
  }

  function renderCues() {
    const chosen = S.subsKey?.[0] === 'h' ? null : subOptions().find((o) => o.key === S.subsKey);
    const track = chosen?.track || [...v.textTracks].find((t) => (t.kind === 'subtitles' || t.kind === 'captions') && t.mode === 'hidden');
    if (!track || !S.subsKey) return (subsEl.textContent = '');
    const cues = [...(track.activeCues || [])];
    subsEl.replaceChildren(
      ...cues.map((c) => {
        const line = document.createElement('span');
        line.className = 'wp-cue';
        if (typeof c.getCueAsHTML === 'function') line.append(c.getCueAsHTML());
        else line.textContent = c.text;
        return line;
      })
    );
  }

  function audioOptions() {
    if (S.hls?.audioTracks?.length) {
      const seen = new Set();
      return S.hls.audioTracks
        .map((t, i) => ({ i, label: t.name || t.lang, lang: t.lang, on: S.hls.audioTrack === i }))
        .filter((o) => {
          const k = `${o.label}|${o.lang}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
    }
    if (v.audioTracks?.length) return [...v.audioTracks].map((t, i) => ({ i, label: t.label || t.language, lang: t.language, on: t.enabled }));
    return [];
  }

  function setAudio(i, remember = true) {
    if (S.hls) S.hls.audioTrack = i;
    else if (v.audioTracks) [...v.audioTracks].forEach((t, k) => (t.enabled = k === i));
    const o = audioOptions().find((x) => x.i === i);
    if (remember && o) {
      const lang = lang2(o.lang);
      prefs.set('audio', lang);
      if (S.src?.provider === 'anizone') {
        const edition = lang === 'en' ? 'dub' : 'sub';
        S.edition = edition;
        prefs.set('edition', edition);
      }
    }
  }

  // Zoko serves dub and sub as separate streams, not alternate audio renditions: switching editions means
  // resolving the other track and re-attaching at the same position.
  async function setEdition(edition) {
    if (!S.src?.zoko || (edition !== 'sub' && edition !== 'dub') || edition === S.edition) return;
    const tok = S.token;
    const wasPlaying = !v.paused;
    const wasState = el.dataset.state;
    el.dataset.state = 'loading';
    const next = await sourceFor(S.m, S.ep, edition);
    if (tok !== S.token) return;
    if (!next) {
      el.dataset.state = wasState || 'ready';
      pill(edition === 'dub' ? 'English dub isn’t available for this episode.' : 'Japanese audio isn’t available for this episode.');
      return;
    }
    const at = v.currentTime || 0;
    S.edition = edition;
    prefs.set('edition', edition);
    S.src = next;
    S.hevcFailed = false;
    teardown();
    await attach(next, at, tok);
    if (tok !== S.token) return;
    if (wasPlaying) v.play().catch(() => {});
    if (S.panel === 'audio') renderPanel();
  }

  function pickDefaultAudio() {
    const opts = audioOptions();
    // Zoko exposes one audio rendition per stream, so its edition decides the language. AniZone carries every
    // language in the same manifest; the viewer's audio choice is the edition.
    const want = S.edition === 'dub' ? 'en' : prefs.get('audio');
    const o = opts.find((x) => lang2(x.lang) === want);
    if (o && !o.on) setAudio(o.i, false);
  }

  function qualityOptions() {
    if (!S.hls?.levels?.length) return [];
    const label = (l) => (l.height >= 1000 || l.width >= 1900 ? '1080p' : l.width >= 1200 || l.height >= 700 ? '720p' : l.width >= 800 || l.height >= 450 ? '480p' : l.height >= 330 || l.width >= 500 ? '360p' : '240p');
    const by = new Map();
    S.hls.levels.forEach((l, i) => {
      const k = label(l);
      if (!by.has(k) || l.bitrate > S.hls.levels[by.get(k)].bitrate) by.set(k, i);
    });
    return [...by].map(([k, i]) => ({ i, label: k, bitrate: S.hls.levels[i].bitrate, hd: k === '1080p' || k === '720p' })).sort((a, b) => parseInt(b.label) - parseInt(a.label));
  }

  function paintTracks() {
    pickDefaultAudio();
    pickDefaultSubs();
    if (S.panel) renderPanel();
  }

  /* ---------- Panels (episodes, audio & subtitles, settings) ---------- */

  function openPanel(name) {
    if (S.panel === name) return closePanel();
    S.panel = name;
    renderPanel();
    el.classList.add('panel-open');
    el.querySelectorAll('[data-panel]').forEach((b) => b.classList.toggle('on', b.dataset.panel === name));
  }

  function closePanel() {
    if (!S.panel) return;
    S.panel = null;
    const p = q('.wp-panel');
    p.hidden = true;
    p.innerHTML = '';
    el.classList.remove('panel-open');
    el.querySelectorAll('[data-panel]').forEach((b) => b.classList.remove('on'));
    poke();
  }

  function renderPanel() {
    const p = q('.wp-panel');
    p.hidden = false;
    p.dataset.kind = S.panel;
    if (S.panel === 'episodes') {
      const list = S.eps;
      p.innerHTML = `<header class="wp-panel-head"><h3>${esc(titleOf(S.m))}</h3><span>${list.length} episode${list.length === 1 ? '' : 's'}</span></header>
        <ol class="wp-eps">${list
          .map((e) => {
            const st = episodeState(S.id, e.n);
            const pct = st ? (st.done ? 100 : Math.round((st.p / (st.d || 1)) * 100)) : 0;
            return `<li><button class="wp-ep ${e.n === S.ep ? 'on' : ''}" data-ep="${e.n}">
              <span class="wp-ep-n">${e.n}</span>
              <span class="wp-ep-media"><img alt="" loading="lazy" ${e.thumb ? `src="${esc(e.thumb)}"` : `data-still="1"`}>${pct ? `<i class="wp-ep-prog" style="--p:${pct}%"></i>` : ''}${e.n === S.ep ? `<span class="wp-ep-now">Playing</span>` : ''}</span>
              <span class="wp-ep-text"><strong>${esc(e.title)}</strong><small>${st?.done ? `${icon('check')} Watched` : pct ? `${Math.max(1, Math.round((st.d - st.p) / 60))}m left` : S.m.duration ? `${S.m.duration}m` : ''}</small></span>
            </button></li>`;
          })
          .join('')}</ol>`;
      p.querySelectorAll('img[data-still]').forEach((img) => wideStill(img, S.m));
      p.querySelectorAll('img:not([data-still])').forEach((img) => (img.onerror = () => wideStill(img, S.m)));
      requestAnimationFrame(() => p.querySelector('.wp-ep.on')?.scrollIntoView({ block: 'center' }));
    } else if (S.panel === 'audio') {
      const subs = subOptions();
      const auds = audioOptions();
      const size = prefs.get('size');
      p.innerHTML = `<div class="wp-cols">
        <section><h3>Audio</h3><ul>${
          S.src?.zoko
            ? `<li><button class="wp-opt ${S.edition !== 'dub' ? 'on' : ''}" data-edition="sub">${icon('check')}Japanese · Subtitled</button></li>
               <li><button class="wp-opt ${S.edition === 'dub' ? 'on' : ''}" data-edition="dub">${icon('check')}English · Dub</button></li>`
            : auds.length
              ? auds.map((o) => `<li><button class="wp-opt ${o.on ? 'on' : ''}" data-audio="${o.i}">${icon('check')}${esc(o.label)}</button></li>`).join('')
              : `<li><span class="wp-opt on">${icon('check')}Original</span></li>`
        }</ul></section>
        <section><h3>Subtitles</h3><ul>
          <li><button class="wp-opt ${S.subsKey ? '' : 'on'}" data-subs="">${icon('check')}Off</button></li>
          ${subs.map((o) => `<li><button class="wp-opt ${o.key === S.subsKey ? 'on' : ''}" data-subs="${o.key}">${icon('check')}${esc(o.label)}</button></li>`).join('')}
        </ul>
        <div class="wp-sizes" role="group" aria-label="Subtitle size">${SIZES.map(([k, l]) => `<button class="${size === k ? 'on' : ''}" data-size="${k}" aria-label="${l} subtitles"><span class="sz-${k}">Aa</span></button>`).join('')}</div>
        </section></div>`;
    } else if (S.panel === 'settings') {
      const qs = qualityOptions();
      const auto = S.hls?.autoLevelEnabled;
      const cur = S.hls?.levels?.[S.hls.currentLevel];
      const curLabel = cur ? qs.find((x) => S.hls.levels[x.i].height === cur.height)?.label : '';
      p.innerHTML = `<div class="wp-cols">
        <section><h3>Playback speed</h3><ul>${SPEEDS.map((s) => `<li><button class="wp-opt ${v.playbackRate === s ? 'on' : ''}" data-speed="${s}">${icon('check')}${s === 1 ? 'Normal' : s + '×'}</button></li>`).join('')}</ul>
          <h3 class="wp-sub-h">Picture</h3><ul><li><button class="wp-opt ${prefs.get('ambient') ? 'on' : ''}" data-ambient>${icon('check')}Ambient light</button></li><li><button class="wp-opt ${prefs.get('clarity') ? 'on' : ''}" data-clarity>${icon('check')}YORU Clarity</button></li><li><button class="wp-opt ${prefs.get('motion') ? 'on' : ''}" data-motion>${icon('check')}Motion 60 <small>interpolated</small></button></li></ul></section>
        ${
          qs.length
            ? `<section><h3>Quality</h3><ul>
          <li><button class="wp-opt ${auto ? 'on' : ''}" data-q="-1">${icon('check')}Auto${auto && curLabel ? ` <small>${curLabel}${S.hls.levels[S.hls.currentLevel]?.bitrate ? ` · ${(S.hls.levels[S.hls.currentLevel].bitrate / 1e6).toFixed(1)} Mbps` : ''}</small>` : ''}</button></li>
          ${qs.map((o) => `<li><button class="wp-opt ${!auto && S.hls.currentLevel === o.i ? 'on' : ''}" data-q="${o.i}">${icon('check')}${o.label}${o.bitrate ? ` <small>${(o.bitrate / 1e6).toFixed(1)} Mbps</small>` : ''}${o.hd ? ' <b class="hd">HD</b>' : ''}</button></li>`).join('')}
        </ul></section>`
            : ''
        }</div>`;
    }
  }

  /* ---------- Seek preview (a second, low-bitrate decoder on the same stream) ---------- */

  function ensurePreview() {
    if (S.preview || !S.src || isTouch()) return S.preview;
    const pv = tip.querySelector('video');
    S.preview = { v: pv, want: null, busy: false };
    if (S.hls && window.Hls) {
      const h = new window.Hls({ startLevel: 0, capLevelToPlayerSize: false, maxBufferLength: 2, maxMaxBufferLength: 4, backBufferLength: 0, enableWorker: true });
      h.on(window.Hls.Events.MANIFEST_PARSED, () => {
        h.currentLevel = 0;
        h.autoLevelCapping = 0;
      });
      h.loadSource(S.src.src);
      h.attachMedia(pv);
      S.preview.hls = h;
    } else pv.src = S.src.src;
    return S.preview;
  }

  // Bound once: the preview <video> element outlives each episode's decoder.
  {
    const pv = tip.querySelector('video');
    // A hover that arrived before the preview stream was ready is replayed once it can seek.
    pv.addEventListener('loadedmetadata', () => S.preview?.want != null && previewAt(S.preview.want));
    pv.addEventListener('seeked', () => {
      if (!S.preview) return;
      S.preview.busy = false;
      tip.classList.add('framed');
      if (S.preview.want != null && Math.abs(S.preview.want - pv.currentTime) > 1.5) previewAt(S.preview.want);
    });
  }

  function previewAt(t) {
    const p = ensurePreview();
    if (!p) return;
    // Already showing (nearly) this frame: re-seeking would only blank it for a moment.
    if (!p.busy && p.v.readyState >= 2 && Math.abs(p.v.currentTime - t) < 0.5) return void (p.want = null);
    p.want = t;
    if (p.busy || p.v.readyState < 1) return;
    p.busy = true;
    p.want = null;
    try {
      p.v.currentTime = t;
    } catch {
      p.busy = false;
    }
  }

  // Seeking far ahead can't be prefetched. If the preview decoder already shows the target frame, hold it
  // full-screen while the real segment downloads, so a big seek looks instant instead of freezing.
  const seekCanvas = q('.wp-seekframe');
  function holdFrame(t) {
    const pv = S.preview?.v;
    if (!pv || pv.readyState < 2 || Math.abs(pv.currentTime - t) > 2.5) return;
    if (v.buffered.length && [...Array(v.buffered.length).keys()].some((i) => t >= v.buffered.start(i) && t < v.buffered.end(i) - 1)) return;
    try {
      seekCanvas.width = pv.videoWidth;
      seekCanvas.height = pv.videoHeight;
      seekCanvas.getContext('2d').drawImage(pv, 0, 0);
      el.classList.add('holding');
    } catch {}
  }
  function releaseFrame() {
    if (!el.classList.contains('holding') || v.readyState < 3) return;
    el.classList.remove('holding');
  }

  function resetPreview() {
    destroyPreview();
    tip.classList.remove('framed');
  }
  function destroyPreview() {
    if (!S.preview) return;
    S.preview.hls?.destroy();
    S.preview.v.removeAttribute('src');
    try {
      S.preview.v.load();
    } catch {}
    S.preview = null;
  }

  /* ---------- Scrubbing ---------- */

  const timeAt = (x) => {
    const r = scrub.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (x - r.left) / r.width));
    return { f, t: f * (v.duration || 0), r };
  };

  function hover(x) {
    if (!v.duration) return;
    const { f, t, r } = timeAt(x);
    el.style.setProperty('--hover', f * 100 + '%');
    const w = tip.offsetWidth || 180;
    tip.style.left = Math.min(r.width - w / 2, Math.max(w / 2, f * r.width)) + 'px';
    tip.querySelector('.wp-tip-time').textContent = clock(t);
    const src = S.src || {};
    const chap = src.recap && t >= src.recap[0] && t < src.recap[1] ? 'Recap' : src.intro && t >= src.intro[0] && t < src.intro[1] ? 'Intro' : src.credits && t >= src.credits ? 'Credits' : '';
    tip.querySelector('.wp-tip-chap').textContent = chap;
    if (!isTouch()) previewAt(t);
    return t;
  }

  scrub.addEventListener('pointermove', (e) => {
    if (!S.scrubbing) hover(e.clientX);
  });
  scrub.addEventListener('pointerenter', () => el.classList.add('scrub-hover'));
  scrub.addEventListener('pointerleave', () => !S.scrubbing && el.classList.remove('scrub-hover'));
  scrub.addEventListener('pointerdown', (e) => {
    if (e.button || !v.duration) return;
    S.scrubbing = true;
    S.wasPlaying = !v.paused;
    scrub.setPointerCapture(e.pointerId);
    el.classList.add('scrubbing', 'scrub-hover');
    const move = (ev) => {
      const t = hover(ev.clientX);
      el.style.setProperty('--played', (t / v.duration) * 100 + '%');
      q('.wp-time').textContent = S.remain ? `-${clock(v.duration - t)}` : `${clock(t)} / ${clock(v.duration)}`;
    };
    move(e);
    const up = (ev) => {
      scrub.removeEventListener('pointermove', move);
      scrub.removeEventListener('pointerup', up);
      scrub.removeEventListener('pointercancel', up);
      S.scrubbing = false;
      el.classList.remove('scrubbing');
      if (ev.type !== 'pointercancel') {
        const t = timeAt(ev.clientX).t;
        holdFrame(t);
        seek(t);
      }
      if (!scrub.matches(':hover')) el.classList.remove('scrub-hover');
    };
    scrub.addEventListener('pointermove', move);
    scrub.addEventListener('pointerup', up);
    scrub.addEventListener('pointercancel', up);
  });
  scrub.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -5, ArrowRight: 5, PageDown: -60, PageUp: 60 }[e.key];
    if (step) {
      e.preventDefault();
      e.stopPropagation();
      seek(v.currentTime + step);
    }
  });

  /* ---------- Actions ---------- */

  function seek(t) {
    if (!v.duration) return;
    v.currentTime = Math.max(0, Math.min(v.duration - 0.2, t));
    if (v.currentTime < (S.src?.credits || v.duration - 30)) S.nextDismissed = false;
    paintTime();
    chapters();
    persist(true);
  }

  function toggle() {
    if (v.ended) {
      seek(0);
      return play();
    }
    if (v.paused) play();
    else v.pause();
  }

  function setMuted(m) {
    v.muted = m;
    if (!m && v.volume === 0) v.volume = 0.5;
    prefs.set('muted', m);
    hidePill();
  }

  function setVolume(x) {
    v.volume = Math.max(0, Math.min(1, x));
    v.muted = v.volume === 0;
    prefs.set('vol', v.volume || prefs.get('vol'));
    prefs.set('muted', v.muted);
  }

  function flash(name, text = '') {
    const f = q('.wp-flash');
    f.innerHTML = `<span>${icon(name)}${text ? `<b>${esc(text)}</b>` : ''}</span>`;
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }

  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        if (isTouch()) screen.orientation?.lock?.('landscape').catch(() => {});
      }
    } catch {
      // iOS Safari: only the <video> element itself can go full screen.
      v.webkitEnterFullscreen?.();
    }
  }

  async function pip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {}
  }

  function pill(text, { label, act, stay = false } = {}) {
    const p = q('.wp-pill');
    p.innerHTML = `<span>${esc(text)}</span>${label ? `<button>${esc(label)}</button>` : ''}`;
    p.hidden = false;
    p.classList.remove('out');
    if (act) p.querySelector('button').onclick = () => (act(), hidePill());
    clearTimeout(S.pillT);
    if (!stay) S.pillT = setTimeout(hidePill, 6000);
  }
  function hidePill() {
    const p = q('.wp-pill');
    p.classList.add('out');
    clearTimeout(S.pillT);
    S.pillT = setTimeout(() => (p.hidden = true), 300);
  }

  /* ---------- Progress persistence ---------- */

  function persist(force = false) {
    if (!S.m || !v.duration || !isFinite(v.duration) || v.currentTime < 1) return;
    const now = Date.now();
    if (!force && now - S.lastSave < 4000) return;
    S.lastSave = now;
    const credits = S.src?.credits;
    // Reaching the credits counts as finishing the episode.
    saveProgress(S.m, S.ep, v.currentTime, v.duration, { credits: credits && credits < v.duration ? credits : v.duration * DONE_AT, thumb: S.eps.find((e) => e.n === S.ep)?.thumb });
  }

  /* ---------- Idle / nap ---------- */

  function poke() {
    el.classList.remove('idle', 'nap');
    clearTimeout(S.idleT);
    clearTimeout(S.napT);
    if (!v.paused && !S.panel && !el.querySelector('.wp-controls:hover, .wp-top:hover')) S.idleT = setTimeout(() => !S.panel && !S.scrubbing && el.classList.add('idle'), 3000);
    if (v.paused && !v.ended && el.dataset.state === 'ready') S.napT = setTimeout(() => !S.panel && !el.classList.contains('sheet-open') && el.classList.add('nap'), 6000);
  }

  /* ---------- Media Session ---------- */

  function setMediaSession() {
    if (!('mediaSession' in navigator) || !S.m) return;
    const movie = S.m.format === 'MOVIE';
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: movie ? titleOf(S.m) : `E${S.ep} · ${S.eps.find((e) => e.n === S.ep)?.title || ''}`,
        artist: movie ? 'YORU' : titleOf(S.m),
        album: 'YORU',
        artwork: [{ src: poster(S.m), sizes: '460x650', type: 'image/jpeg' }],
      });
      const h = (a, fn) => {
        try {
          navigator.mediaSession.setActionHandler(a, fn);
        } catch {}
      };
      h('play', () => play());
      h('pause', () => v.pause());
      h('seekbackward', () => seek(v.currentTime - 10));
      h('seekforward', () => seek(v.currentTime + 10));
      h('seekto', (d) => seek(d.seekTime));
      h('nexttrack', S.next ? () => goTo(S.next) : null);
      h('previoustrack', S.ep > 1 ? () => location.replace(watchHref(S.id, S.ep - 1)) : null);
    } catch {}
  }
  function clearMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = null;
    for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'nexttrack', 'previoustrack'])
      try {
        navigator.mediaSession.setActionHandler(a, null);
      } catch {}
  }

  /* ---------- Video events ---------- */

  v.addEventListener('playing', releaseFrame);
  v.addEventListener('canplay', releaseFrame);
  v.addEventListener('loadeddata', () => { clarity.set(prefs.get('clarity')); clarity.setMotion(prefs.get('motion')); });
  v.addEventListener('playing', () => { clarity.set(prefs.get('clarity')); clarity.setMotion(prefs.get('motion')); });
  v.addEventListener('playing', () => {
    el.dataset.state = 'ready';
    el.classList.remove('buffering');
    paintPlay();
    poke();
  });
  v.addEventListener('play', () => {
    paintPlay();
    poke();
  });
  v.addEventListener('pause', () => {
    paintPlay();
    persist(true);
    poke();
  });
  v.addEventListener('waiting', () => el.classList.add('buffering'));
  v.addEventListener('canplay', () => el.classList.remove('buffering'));
  v.addEventListener('loadeddata', () => el.classList.add('has-frame'));
  v.addEventListener('emptied', () => el.classList.remove('has-frame'));
  v.addEventListener('loadedmetadata', () => {
    paintTime();
    paintMarks();
  });
  v.addEventListener('durationchange', paintMarks);
  v.addEventListener('timeupdate', () => {
    paintTime();
    chapters();
    persist();
  });
  v.addEventListener('progress', paintBuffer);
  v.addEventListener('seeked', paintBuffer);
  v.addEventListener('volumechange', paintVolume);
  v.addEventListener('ratechange', () => S.panel === 'settings' && renderPanel());
  v.addEventListener('ended', () => {
    paintPlay();
    ended();
  });
  v.addEventListener('error', () => {
    if (!S.hls && S.src) fail('This episode can’t play right now.', true);
  });
  v.addEventListener('enterpictureinpicture', () => { el.classList.add('pip'); clarity.set(false); });
  v.addEventListener('leavepictureinpicture', () => { el.classList.remove('pip'); clarity.set(prefs.get('clarity')); });

  /* ---------- Pointer / touch ---------- */

  el.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') poke();
  });
  el.addEventListener('pointerleave', () => !v.paused && !S.panel && el.classList.add('idle'));

  // Taps on the video surface: mouse click toggles play; touch tap toggles the controls; double-tap sides seek.
  let lastTap = { t: 0, zone: null };
  let tapTimer = 0;
  q('.wp-taps').addEventListener('click', (e) => {
    const zone = Number(e.target.dataset.tap ?? 0);
    if (S.panel) return closePanel();
    if (e.pointerType === 'mouse' || (!e.pointerType && !isTouch())) {
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => {
        toggle();
        flash(v.paused ? 'pause' : 'play');
      }, 220);
      return;
    }
    const now = Date.now();
    if (now - lastTap.t < 300 && zone !== 0 && zone === lastTap.zone) {
      clearTimeout(tapTimer);
      seek(v.currentTime + zone * 10);
      ripple(zone);
      lastTap = { t: now, zone };
      return;
    }
    lastTap = { t: now, zone };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => (el.classList.contains('idle') ? poke() : el.classList.add('idle')), 260);
  });
  q('.wp-taps').addEventListener('dblclick', (e) => {
    if (isTouch()) return;
    clearTimeout(tapTimer);
    fullscreen();
  });

  function ripple(zone) {
    const t = q(`[data-tap="${zone}"]`);
    t.dataset.label = zone < 0 ? '−10s' : '+10s';
    t.classList.remove('rip');
    void t.offsetWidth;
    t.classList.add('rip');
  }

  q('.wp-vol-range').addEventListener('input', (e) => setVolume(Number(e.target.value)));

  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !el.contains(b)) return;
    poke();
    const act = b.dataset.act;
    if (b.dataset.panel) return openPanel(b.dataset.panel);
    if (b.dataset.ep) {
      closePanel();
      S.chain = 0;
      return Number(b.dataset.ep) === S.ep ? null : location.replace(watchHref(S.id, Number(b.dataset.ep)));
    }
    if (b.dataset.subs !== undefined) return setSubs(b.dataset.subs || null), renderPanel();
    if (b.dataset.edition) return setEdition(b.dataset.edition);
    if (b.dataset.audio !== undefined) return setAudio(Number(b.dataset.audio)), setTimeout(renderPanel, 50);
    if (b.dataset.size) {
      prefs.set('size', b.dataset.size);
      el.dataset.subsize = b.dataset.size;
      return renderPanel();
    }
    if (b.dataset.ambient !== undefined) {
      prefs.set('ambient', !prefs.get('ambient'));
      ambient();
      return renderPanel();
    }
    if (b.dataset.clarity !== undefined) {
      prefs.set('clarity', !prefs.get('clarity'));
      clarity.set(prefs.get('clarity'));
      return renderPanel();
    }
    if (b.dataset.motion !== undefined) {
      prefs.set('motion', !prefs.get('motion'));
      if (prefs.get('motion') && !prefs.get('clarity')) {
        prefs.set('clarity', true);
        clarity.set(true);
      }
      clarity.setMotion(prefs.get('motion'));
      return renderPanel();
    }
    if (b.dataset.speed) {
      v.playbackRate = Number(b.dataset.speed);
      return renderPanel();
    }
    if (b.dataset.q !== undefined) {
      S.hls.currentLevel = Number(b.dataset.q);
      return renderPanel();
    }
    if (b.dataset.go) {
      const id = Number(b.dataset.go);
      closeSheet();
      return location.replace(watchHref(id, resumePoint(media.get(id)).ep));
    }
    switch (act) {
      case 'back':
        return back();
      case 'toggle':
        return toggle();
      case 'rew':
        flash('back10');
        return seek(v.currentTime - 10);
      case 'fwd':
        flash('fwd10');
        return seek(v.currentTime + 10);
      case 'mute':
        return setMuted(!v.muted);
      case 'time':
        S.remain = !S.remain;
        return paintTime();
      case 'skip':
        S.chain = 0;
        return seek(Number(b.dataset.to));
      case 'next':
        hideNext();
        return goTo(S.next);
      case 'credits':
        S.nextDismissed = true;
        return hideNext();
      case 'fs':
        return fullscreen();
      case 'pip':
        return pip();
      case 'close-sheet':
        closeSheet();
        return play();
      case 'retry':
        closeSheet();
        return load(S.id, S.ep, 0);
      case 'continue':
        closeSheet();
        S.chain = 0;
        if (S.pendingNext) return goTo(S.pendingNext);
        return play();
      case 'again':
        closeSheet();
        return location.replace(watchHref(S.id, 1));
    }
  });

  /* ---------- Keyboard ---------- */

  function onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/input|textarea|select/i.test(e.target.tagName) && e.target.type !== 'range') return;
    if (e.key === 'Escape') return; // handled by the overlay stack
    if (el.classList.contains('sheet-open')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
      S.chain = 0;
      poke();
    };
    switch (k) {
      case ' ':
      case 'k':
        if (k === ' ' && e.target.closest?.('.wp-panel, .wp-next, .wp-pill, .wp-skip')) return;
        handled();
        toggle();
        return flash(v.paused ? 'pause' : 'play');
      case 'ArrowLeft':
      case 'j':
        if (e.target === scrub) return;
        handled();
        flash('back10');
        return seek(v.currentTime - 10);
      case 'ArrowRight':
      case 'l':
        if (e.target === scrub) return;
        handled();
        flash('fwd10');
        return seek(v.currentTime + 10);
      case 'ArrowUp':
        if (e.target.type === 'range') return;
        handled();
        setVolume((v.muted ? 0 : v.volume) + 0.05);
        return flash('vol-on', Math.round(v.volume * 100) + '%');
      case 'ArrowDown':
        if (e.target.type === 'range') return;
        handled();
        setVolume(v.volume - 0.05);
        return flash(v.volume ? 'vol-low' : 'vol-off', Math.round(v.volume * 100) + '%');
      case 'm':
        handled();
        setMuted(!v.muted);
        return flash(v.muted ? 'vol-off' : 'vol-on');
      case 'f':
        handled();
        return fullscreen();
      case 'c': {
        handled();
        const opts = subOptions();
        const i = opts.findIndex((o) => o.key === S.subsKey);
        const nxt = i + 1 < opts.length ? opts[i + 1] : null;
        setSubs(nxt?.key || null);
        if (S.panel === 'audio') renderPanel();
        return flash('subtitles', nxt ? nxt.label : 'Off');
      }
      case 's':
        if (!q('.wp-skip').hidden) {
          handled();
          return seek(Number(q('.wp-skip').dataset.to));
        }
        return;
      case 'n':
        if (S.next) {
          handled();
          return goTo(S.next);
        }
        return;
      case 'p':
        handled();
        return pip();
      case '<':
      case ',':
      case '>':
      case '.': {
        handled();
        const i = SPEEDS.indexOf(v.playbackRate);
        const j = Math.max(0, Math.min(SPEEDS.length - 1, (i === -1 ? 2 : i) + (k === '<' || k === ',' ? -1 : 1)));
        v.playbackRate = SPEEDS[j];
        return flash('gauge', SPEEDS[j] + '×');
      }
      case 'Home':
        handled();
        return seek(0);
      case 'End':
        handled();
        return seek(v.duration - 1);
      default:
        if (/^[0-9]$/.test(k) && v.duration) {
          handled();
          return seek((Number(k) / 10) * v.duration);
        }
    }
  }
  addEventListener('keydown', onKey, true);

  function onVisibility() {
    if (document.hidden) persist(true);
  }
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('fullscreenchange', paintFs);
  v.textTracks.addEventListener?.('addtrack', () => S.subsKey && bindTextTracks());
  v.textTracks.addEventListener?.('change', () => {
    const chosen = S.subsKey?.[0] === 's' ? subOptions().find((o) => o.key === S.subsKey) : null;
    if (chosen && chosen.track.mode !== 'hidden') chosen.track.mode = 'hidden';
  });

  // Zoom out of whatever the viewer clicked (a card, the billboard, an episode row).
  const from = takeWatchOrigin();
  if (from && from.width > 40 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const W = innerWidth;
    const H = innerHeight;
    const inset = `inset(${Math.max(0, from.top)}px ${Math.max(0, W - from.right)}px ${Math.max(0, H - from.bottom)}px ${Math.max(0, from.left)}px round 10px)`;
    el.animate([{ clipPath: inset }, { clipPath: 'inset(0px 0px 0px 0px round 0px)' }], { duration: 520, easing: 'cubic-bezier(.2,.85,.25,1)' });
    q('.wp-poster img').animate([{ transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 900, easing: 'cubic-bezier(.16,1,.3,1)' });
  } else el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, easing: 'ease-out' });

  el.dataset.subsize = prefs.get('size');
  paintVolume();
  paintFs();
  el.focus({ preventScroll: true });
}
