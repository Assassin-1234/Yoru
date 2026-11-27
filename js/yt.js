// Thin controller around the YouTube IFrame API.
// Returns synchronously so callers can destroy a player that hasn't finished loading yet.

let apiPromise;
function loadAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => {
      apiPromise = null;
      reject(new Error('YouTube API failed to load'));
    };
    document.head.append(s);
  });
  return apiPromise;
}

export const warmYouTube = () => loadAPI().catch(() => {});

const HD = ['hd720', 'hd1080', 'hd1440', 'hd2160', 'highres'];

/**
 * @param {HTMLElement} host
 * @param {string} id YouTube video id
 * @param {{muted?:boolean, controls?:boolean, onPlaying?:Function, onEnded?:Function, onError?:Function, endEarly?:number}} o
 */
export function trailer(host, id, o = {}) {
  let poll = 0;
  let ended = false;
  const ctl = {
    dead: false,
    p: null,
    quality: () => {
      try {
        return ctl.p.getPlaybackQuality();
      } catch {
        return null;
      }
    },
    destroy() {
      this.dead = true;
      clearInterval(poll);
      try {
        this.p?.destroy();
      } catch {}
      host.replaceChildren();
    },
    setMuted(v) {
      try {
        v ? this.p.mute() : this.p.unMute();
      } catch {}
    },
    pause() {
      try {
        this.p.pauseVideo();
      } catch {}
    },
    play() {
      if (ended) return;
      try {
        this.p.playVideo();
      } catch {}
    },
  };

  // YouTube starts on a low rung and climbs; ambient players stay hidden (behind the still) until the stream is HD,
  // so nobody sees the soft first seconds. Gives up waiting after a few seconds on slow connections.
  let sharp = !o.waitHD;
  const revealWhenSharp = () => {
    if (sharp) return o.onPlaying?.();
    const t0 = Date.now();
    const check = () => {
      if (ctl.dead || sharp) return;
      const q = ctl.quality();
      if (HD.includes(q) || Date.now() - t0 > 4500) {
        sharp = true;
        o.onPlaying?.();
      } else setTimeout(check, 200);
    };
    check();
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    clearInterval(poll);
    o.onEnded?.();
  };

  loadAPI()
    .then((YT) => {
      if (ctl.dead) return;
      const mount = document.createElement('div');
      host.append(mount);
      // Smallest render scale that makes YouTube serve 1080p: aim for ~1100 physical pixels of player height.
      if (o.waitHD) {
        const baseH = Math.max(host.clientHeight, host.clientWidth * 0.5625) || 1;
        const up = Math.min(6, Math.max(1, 1100 / (baseH * (window.devicePixelRatio || 1))));
        host.style.setProperty('--up', up.toFixed(3));
      }
      host._yt = ctl; // handle for debugging quality in devtools
      ctl.p = new YT.Player(mount, {
        videoId: id,
        host: 'https://www.youtube-nocookie.com',
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 1,
          mute: o.muted === false ? 0 : 1,
          controls: o.controls ? 1 : 0,
          rel: 0,
          playsinline: 1,
          modestbranding: 1,
          iv_load_policy: 3,
          disablekb: o.controls ? 0 : 1,
          fs: o.controls ? 1 : 0,
          cc_load_policy: 0,
          origin: location.origin,
        },
        events: {
          onReady: (e) => {
            if (ctl.dead) return;
            o.muted === false ? e.target.unMute() : e.target.mute();
            e.target.playVideo();
            o.onReady?.();
            // Browsers may block autoplay-with-sound; fall back to muted playback rather than stalling.
            if (o.muted === false)
              setTimeout(() => {
                try {
                  if (!ctl.dead && e.target.getPlayerState() !== YT.PlayerState.PLAYING) {
                    e.target.mute();
                    e.target.playVideo();
                    o.onMutedFallback?.();
                  }
                } catch {}
              }, 1800);
          },
          onStateChange: (e) => {
            if (ctl.dead) return;
            if (e.data === YT.PlayerState.PLAYING) {
              revealWhenSharp();
              // Leave a little before the end so YouTube's end-screen never shows on ambient players.
              if (o.endEarly && !poll) {
                poll = setInterval(() => {
                  try {
                    const d = ctl.p.getDuration();
                    if (d && ctl.p.getCurrentTime() >= d - o.endEarly) finish();
                  } catch {}
                }, 400);
              }
            } else if (e.data === YT.PlayerState.ENDED) finish();
          },
          onError: (e) => !ctl.dead && o.onError?.(e.data),
        },
      });
    })
    .catch(() => o.onError?.('api'));

  return ctl;
}
