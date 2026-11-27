// ZokoAnime delivery layer.
//
// Zoko's embed page carries the resolved stream in an XOR-obfuscated `window.__P` blob. Its playlists,
// subtitles and media segments reject a browser `Origin` header, and the playlists/subtitles require a
// `Referer` of https://zokoanime.video/. A custom player cannot control either header, so this service makes
// every request same-origin and fetches upstream itself with the referer Zoko wants and no Origin. Bytes are
// passed through untouched — no transcode, no re-encode, no bitrate cap.
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unb64, mediaUrl, refererFor, hlsProxy, assetProxy, segProxy, subtitleProxy } from './stream-urls.mjs';
import { resolveAnizone, assToVtt, prewarmAnizone } from './anizone.mjs';

const href = (u, base) => {
  try {
    return new URL(u, base).href;
  } catch {
    return null;
  }
};

const ZOKO = 'https://zokoanime.video';
const EMBED_ORIGIN = `${ZOKO}/`;
const OBF_KEY = 'otaku-embed-v1';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 YORU/1.0';
const RESOLVE_TTL = 5 * 60 * 1000;
const RESOLVE_LIMIT = 2000;
const UPSTREAM_TIMEOUT = 20_000;
const PROBE_BYTES = Buffer.alloc(262144);
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const execFileAsync = promisify(execFile);

async function upstream(url, { range, accept } = {}) {
  const headers = {
    Referer: refererFor(url),
    'User-Agent': USER_AGENT,
    Accept: accept || '*/*',
  };
  if (range) headers.Range = range;
  // AniZone's CDN wants its origin named; Zoko's rejects an Origin header outright.
  let anizone = false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    anizone = host.endsWith('.vid-cdn.xyz');
    if (anizone) headers.Origin = 'https://anizone.to';
    // Cloudflare challenges Node's undici fingerprint on AniZone's key endpoint but not on segments. Curl's
    // TLS fingerprint passes, and a key is one tiny request per rendition, so use it only for keys.
    if (anizone && (u.pathname.includes('/keys/') || u.pathname.includes('/subtitles/'))) {
      try {
        const { stdout } = await execFileAsync('curl', ['-sS', '--fail-with-body', '--max-time', '20', '-A', CHROME_UA, '-H', 'Referer: https://anizone.to/', '-H', 'Origin: https://anizone.to', url], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
        const type = /\.ass(\?|$)/i.test(u.pathname) ? 'text/x-ssa' : 'application/octet-stream';
        return new Response(stdout, { status: 200, headers: { 'content-type': type } });
      } catch (err) {
        return new Response(err.stdout || '', { status: 403, headers: { 'content-type': 'text/html' } });
      }
    }
  } catch {}
  return fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
  });
}

function json(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extra,
  });
  res.end(text);
}

/* ---------- Zoko payload ---------- */

function decodePayload(blob) {
  const bytes = Buffer.from(blob, 'base64');
  const plain = Buffer.allocUnsafe(bytes.length);
  for (let i = 0; i < bytes.length; i++) plain[i] = bytes[i] ^ OBF_KEY.charCodeAt(i % OBF_KEY.length);
  let value = JSON.parse(plain.toString('utf8'));
  // A few responses double-wrap the JSON in a string.
  if (typeof value === 'string') value = JSON.parse(value);
  return value;
}

const LANGUAGES = {
  arabic: 'ar',
  bengali: 'bn',
  bulgarian: 'bg',
  chinese: 'zh',
  croatian: 'hr',
  czech: 'cs',
  danish: 'da',
  dutch: 'nl',
  english: 'en',
  estonian: 'et',
  filipino: 'tl',
  finnish: 'fi',
  french: 'fr',
  german: 'de',
  greek: 'el',
  hebrew: 'he',
  hindi: 'hi',
  hungarian: 'hu',
  indonesian: 'id',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  latvian: 'lv',
  lithuanian: 'lt',
  malay: 'ms',
  norwegian: 'no',
  persian: 'fa',
  polish: 'pl',
  portuguese: 'pt',
  romanian: 'ro',
  russian: 'ru',
  serbian: 'sr',
  slovak: 'sk',
  slovenian: 'sl',
  spanish: 'es',
  swedish: 'sv',
  tamil: 'ta',
  telugu: 'te',
  thai: 'th',
  turkish: 'tr',
  ukrainian: 'uk',
  urdu: 'ur',
  vietnamese: 'vi',
};

function languageOf(label, fallback) {
  const text = String(label || '').toLowerCase();
  for (const [name, code] of Object.entries(LANGUAGES)) if (text.includes(name)) return code;
  return /^[a-z]{2,3}(-[a-z0-9]+)?$/i.test(fallback || '') ? fallback : 'en';
}

function subtitles(list) {
  const seen = new Set();
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s?.src) continue;
    const label = String(s.label || s.lang || 'Subtitles').replace(/\s+/g, ' ').trim();
    const lang = languageOf(label, s.lang);
    const key = `${lang}|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lang, label, src: assetProxy(s.src), default: !!s.default });
  }
  // English first, then alphabetically: the menu should open on the track almost everyone wants.
  out.sort((a, b) => (a.lang === 'en' ? -1 : b.lang === 'en' ? 1 : a.lang.localeCompare(b.lang) || a.label.localeCompare(b.label)));
  if (!out.some((s) => s.default) && out[0]) out[0].default = true;
  return out;
}

/* ---------- Resolve ---------- */

const resolved = new Map();

function cached(key) {
  const hit = resolved.get(key);
  if (!hit) return null;
  if (hit.promise) return hit.promise;
  if (Date.now() - hit.at < RESOLVE_TTL) return hit.data;
  resolved.delete(key);
  return null;
}

function remember(key, data) {
  if (resolved.size >= RESOLVE_LIMIT) resolved.delete(resolved.keys().next().value);
  resolved.set(key, { at: Date.now(), data });
}

/**
 * Resolve one episode through Zoko and return the client-facing source object.
 * `source` is "mal", "ani" (AniList) or "anilist".
 */
export async function resolveZoko({ source = 'mal', id, episode = 1, track = 'sub' } = {}) {
  const src = source === 'anilist' ? 'ani' : source;
  if (!/^\d{1,10}$/.test(String(id)) || !/^\d{1,6}$/.test(String(episode))) return { unavailable: true, reason: 'bad-id' };
  if (!['mal', 'ani'].includes(src)) return { unavailable: true, reason: 'bad-source' };
  if (!['sub', 'hsub', 'dub'].includes(track)) track = 'sub';

  const key = `${src}:${id}:${episode}:${track}`;
  const hit = cached(key);
  if (hit) return hit;

  const p = (async () => {
    const url = `${ZOKO}/stream/${src}/${id}/${episode}/${track}`;
    let res;
    try {
      res = await fetch(url, {
        headers: { Referer: EMBED_ORIGIN, 'User-Agent': USER_AGENT, Accept: 'text/html' },
        redirect: 'follow',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      });
    } catch (err) {
      return { unavailable: true, reason: 'network', error: err?.message };
    }
    if (!res.ok) return { unavailable: true, reason: `http-${res.status}` };
    const html = await res.text();
    const blob = /window\.__P="([^"]+)"/.exec(html)?.[1];
    if (!blob) {
      const message = /class="msg">([^<]*)/.exec(html)?.[1]?.trim();
      return { unavailable: true, reason: message || 'not-found' };
    }
    let data;
    try {
      data = decodePayload(blob);
    } catch (err) {
      return { unavailable: true, reason: 'bad-payload', error: err?.message };
    }
    if (!data?.src) return { unavailable: true, reason: 'no-source' };

    const intro = data.skip?.intro;
    const outro = data.skip?.outro;
    return {
      available: true,
      src: hlsProxy(data.src),
      subtitles: subtitles(data.subtitles),
      intro: intro && Number.isFinite(intro.start) && Number.isFinite(intro.end) ? [intro.start, intro.end] : null,
      credits: outro && Number.isFinite(outro.start) ? outro.start : null,
      videoId: data.video_id || null,
      track,
      download: data.download_url || null,
    };
  })();

  resolved.set(key, { at: Date.now(), promise: p });
  const data = await p;
  remember(key, data);
  return data;
}

/**
 * Pick the best available provider for an episode. AniZone is preferred when it has the title: 23.976 fps,
 * separate Japanese/dub audio renditions, and higher measured bitrate than Zoko on most titles. Zoko supplies
 * the skip markers and English VTT sidecars when available.
 */
async function resolveBest({ title, titleEn, source, id, episode = 1, track = 'sub', anilist, year, format } = {}) {
  const [a, z] = await Promise.allSettled([
    resolveAnizone({ title, titleEn, episode, year }),
    resolveZoko({ source, id, episode, track }),
  ]);
  const az = a.status === 'fulfilled' ? a.value : null;
  let zk = z.status === 'fulfilled' ? z.value : null;
  if ((!zk || !zk.available) && source === 'mal' && anilist && String(anilist) !== String(id)) {
    try {
      const alt = await resolveZoko({ source: 'ani', id: anilist, episode, track });
      if (alt.available) zk = alt;
    } catch {}
  }
  const subs = zk?.available && zk.subtitles?.length ? zk.subtitles : az?.subtitles || [];
  const meta = { subtitles: subs, intro: zk?.intro || null, credits: zk?.credits || null, track };
  if (az?.available) {
    return { available: true, provider: 'anizone', src: az.src, ...meta, slug: az.slug, sourceTitle: az.title };
  }
  if (zk?.available) return { ...zk, provider: 'zoko' };
  return { available: false, reason: 'no-provider' };
}

/* ---------- Playlist rewriting ---------- */

function rewritePlaylist(text, base) {
  const master = text.includes('#EXT-X-STREAM-INF') || text.includes('#EXT-X-I-FRAME-STREAM-INF');
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      if (line.startsWith('#EXT-X-') && line.includes('URI="')) {
        const tag = line.slice(0, line.indexOf(':') > 0 ? line.indexOf(':') : undefined);
        return line.replace(/URI="([^"]*)"/g, (_m, uri) => {
          const abs = href(uri, base);
          if (!abs) return `URI="${uri}"`;
          if (tag === 'EXT-X-MAP' || tag === 'EXT-X-KEY' || tag === 'EXT-X-SESSION-KEY') return `URI="${segProxy(abs)}"`;
          if (tag === 'EXT-X-PART' || tag === 'EXT-X-PRELOAD-HINT') return `URI="${segProxy(abs)}"`;
          if (/\.m3u8(\?|$)/i.test(abs) || tag === 'EXT-X-MEDIA' || tag === 'EXT-X-I-FRAME-STREAM-INF') return `URI="${hlsProxy(abs)}"`;
          if (/\.vtt(\?|$)/i.test(abs)) return `URI="${assetProxy(abs)}"`;
          return `URI="${segProxy(abs)}"`;
        });
      }
      if (line.startsWith('#')) return line;
      const abs = href(line, base);
      if (!abs) return line;
      // Variant playlists still need the Referer; media segments are proxied without the browser's Origin.
      return master ? hlsProxy(abs) : segProxy(abs);
    })
    .join('\n');
}

function streamBinary(res, upstreamRes, headers) {
  res.writeHead(upstreamRes.status, headers);
  if (!upstreamRes.body) return res.end();
  Readable.fromWeb(upstreamRes.body)
    .on('error', () => res.destroy())
    .pipe(res);
}

/* ---------- HTTP ---------- */

const hits = new Map();
function throttled(req, max = 90, windowMs = 60_000) {
  const ip =
    String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .split(',')[0]
      .trim();
  const now = Date.now();
  const bucket = hits.get(ip);
  if (!bucket || now - bucket.start > windowMs) {
    hits.set(ip, { start: now, n: 1 });
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    return false;
  }
  bucket.n++;
  return bucket.n > max;
}

export async function handleZoko(req, res, urlIn) {
  let url;
  try {
    url = urlIn || new URL(req.url, 'http://x');
  } catch {
    return false;
  }
  if (!url.pathname.startsWith('/zoko/')) return false;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  try {
    if (url.pathname === '/zoko/health') {
      return json(res, 200, { ok: true, service: 'yoru-zoko', upstream: ZOKO }), true;
    }

    // One-shot throughput probe: same path (and same edge cache) as the media the player will stream.
    if (url.pathname === '/zoko/probe') {
      if (throttled(req, 10)) return json(res, 429, { error: 'rate-limited' }, { 'Retry-After': '60' }), true;
      const body = PROBE_BYTES;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(body), true;
    }

    if (url.pathname === '/zoko/prewarm') {
      await prewarmAnizone().catch(() => {});
      return json(res, 200, { ok: true }), true;
    }

    if (url.pathname === '/zoko/best') {
      if (throttled(req)) return json(res, 429, { error: 'rate-limited' }, { 'Retry-After': '60' }), true;
      const title = (url.searchParams.get('title') || '').slice(0, 200);
      const titleEn = (url.searchParams.get('titleEn') || '').slice(0, 200);
      const source = (url.searchParams.get('source') || 'mal').toLowerCase();
      const id = url.searchParams.get('id') || '';
      const anilist = url.searchParams.get('anilist') || '';
      const episode = url.searchParams.get('ep') || '1';
      const track = (url.searchParams.get('track') || 'sub').toLowerCase();
      const year = url.searchParams.get('year') || '';
      const format = url.searchParams.get('format') || '';
      if (!/^\d{1,10}$/.test(id) || !/^\d{1,6}$/.test(episode)) return json(res, 400, { error: 'bad-id' }), true;
      const data = await resolveBest({ title, titleEn, source, id, episode, track, anilist, year, format });
      return json(res, data.available ? 200 : 404, data), true;
    }

    if (url.pathname === '/zoko/resolve') {
      if (throttled(req)) return json(res, 429, { error: 'rate-limited' }, { 'Retry-After': '60' }), true;
      const source = (url.searchParams.get('source') || 'mal').toLowerCase();
      const id = url.searchParams.get('id') || '';
      const episode = url.searchParams.get('ep') || url.searchParams.get('episode') || '1';
      const track = (url.searchParams.get('track') || 'sub').toLowerCase();
      if (source !== 'mal' && source !== 'ani' && source !== 'anilist') return json(res, 400, { error: 'bad-source' }), true;
      if (!/^\d{1,10}$/.test(id)) return json(res, 400, { error: 'bad-id' }), true;
      if (!/^\d{1,6}$/.test(episode)) return json(res, 400, { error: 'bad-episode' }), true;
      const data = await resolveZoko({ source, id, episode, track });
      return json(res, data.available ? 200 : 404, data), true;
    }

    if (url.pathname === '/zoko/hls') {
      const raw = safeDecode(url.searchParams.get('u'));
      const target = raw && mediaUrl(raw);
      if (!target || !/\.m3u8(\?|$)/i.test(target.pathname + target.search)) return json(res, 400, { error: 'bad-url' }), true;
      const r = await upstream(target.href, { accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*' });
      if (!r.ok) return json(res, r.status === 403 ? 502 : r.status, { error: `upstream-${r.status}` }), true;
      const text = await r.text();
      if (!text.startsWith('#EXTM3U')) return json(res, 502, { error: 'not-a-playlist' }), true;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'public, max-age=5',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(rewritePlaylist(text, r.url || target.href));
      return true;
    }

    if (url.pathname.startsWith('/zoko/seg/')) {
      const token = url.pathname.slice('/zoko/seg/'.length).replace(/\.jpg$/i, '');
      const raw = safeDecode(token);
      const target = raw && mediaUrl(raw);
      if (!target) return json(res, 400, { error: 'bad-url' }), true;
      const r = await upstream(target.href, { range: req.headers.range });
      const type = r.headers.get('content-type') || 'video/mp2t';
      const ok = r.status === 200 || r.status === 206;
      const headers = {
        'Content-Type': type,
        'Cache-Control': ok ? 'public, max-age=1209600, immutable' : 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      };
      for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const v = r.headers.get(h);
        if (v) headers[h.replace(/(^|-)([a-z])/g, (_m, a, b) => a + b.toUpperCase())] = v;
      }
      if (req.method === 'HEAD') {
        res.writeHead(r.status, headers);
        return res.end(), true;
      }
      streamBinary(res, r, headers);
      return true;
    }

    if (url.pathname === '/zoko/anizone-sub') {
      const raw = safeDecode(url.searchParams.get('u'));
      const target = raw && mediaUrl(raw);
      if (!target) return json(res, 400, { error: 'bad-url' }), true;
      const r = await upstream(target.href, { accept: 'text/plain,text/x-ssa,text/vtt,*/*' });
      if (!r.ok) return json(res, r.status === 403 ? 502 : r.status, { error: `upstream-${r.status}` }), true;
      const text = await r.text();
      const vtt = /\.ass(\?|$)/i.test(target.pathname + target.search) ? assToVtt(text) : text;
      res.writeHead(200, {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Cache-Control': 'public, max-age=604800, immutable',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(vtt);
      return true;
    }

    if (url.pathname === '/zoko/asset' || url.pathname.startsWith('/zoko/asset/')) {
      const token = url.pathname.startsWith('/zoko/asset/') ? url.pathname.slice('/zoko/asset/'.length).replace(/\.vtt$/i, '') : url.searchParams.get('u');
      const raw = safeDecode(token);
      const target = raw && mediaUrl(raw);
      if (!target) return json(res, 400, { error: 'bad-url' }), true;
      const r = await upstream(target.href, { range: req.headers.range, accept: 'text/vtt,*/*' });
      const type = r.headers.get('content-type') || (/\.vtt(\?|$)/i.test(target.pathname + target.search) ? 'text/vtt' : 'application/octet-stream');
      const ok = r.status === 200 || r.status === 206;
      const headers = {
        'Content-Type': type,
        'Cache-Control': ok ? 'public, max-age=604800, immutable' : 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      };
      for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const v = r.headers.get(h);
        if (v) headers[h.replace(/(^|-)([a-z])/g, (_m, a, b) => a + b.toUpperCase())] = v;
      }
      streamBinary(res, r, headers);
      return true;
    }

    return json(res, 404, { error: 'not-found' }), true;
  } catch (err) {
    if (!res.headersSent) json(res, 502, { error: 'upstream', detail: String(err?.message || err) });
    else res.destroy();
    return true;
  }
}

function safeDecode(v) {
  if (!v) return null;
  try {
    return unb64(v);
  } catch {
    return null;
  }
}

export function createZokoServer(port = Number(process.env.PORT) || 5174) {
  return import('node:http').then(({ createServer }) =>
    createServer(async (req, res) => {
      if (await handleZoko(req, res)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }).listen(port, '127.0.0.1', () => console.log(`YORU streams → http://127.0.0.1:${port}/zoko/health`))
  );
}
