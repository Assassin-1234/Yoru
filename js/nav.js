// Hash routing helpers. Routes look like  #/series  or  #/search?q=frieren ;
// an open title is expressed as  ?t=<id>  on top of whatever page is underneath.

export function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  return {
    path: '/' + parts.join('/'),
    name: parts[0] || '',
    arg: decodeURIComponent(parts[1] || ''),
    params: new URLSearchParams(qs),
  };
}

const build = (path, params) => {
  const qs = params.toString();
  return '#' + path + (qs ? '?' + qs : '');
};

let source = null;
let pushedTitle = false;

export function openTitle(id, src) {
  source = src || null;
  const { path, params } = parseRoute();
  const alreadyOpen = params.has('t');
  params.set('t', id);
  if (alreadyOpen) location.replace(build(path, params));
  else {
    pushedTitle = true;
    location.hash = build(path, params);
  }
}

export function closeTitle() {
  const { path, params } = parseRoute();
  if (!params.has('t')) return;
  if (pushedTitle) {
    pushedTitle = false;
    history.back();
  } else {
    params.delete('t');
    location.replace(build(path, params));
  }
}

// Called by the router when the hash loses ?t= (e.g. browser back).
export const titleClosedExternally = () => (pushedTitle = false);

export function takeSource() {
  const s = source;
  source = null;
  return s;
}

/* ---------- Player route:  #/watch/<id>?ep=<n> ---------- */

export const watchHref = (id, ep) => `#/watch/${id}${ep ? `?ep=${ep}` : ''}`;
let watchFromApp = false;

// The element the viewer clicked, so the player can zoom out of it.
let origin = null;
export const takeWatchOrigin = () => {
  const o = origin;
  origin = null;
  return o;
};

export function watch(id, ep, from = null) {
  watchFromApp = true;
  origin = from?.isConnected ? from.getBoundingClientRect() : null;
  location.hash = watchHref(id, ep);
}

// Leaving the player returns to wherever the viewer came from (title modal, row, …).
export function leaveWatch(id) {
  if (watchFromApp && history.length > 1) {
    watchFromApp = false;
    history.back();
  } else location.replace(id ? `#/?t=${id}` : '#/');
}

export function go(path, { replace = false, keepParams = false } = {}) {
  const { params } = parseRoute();
  const target = keepParams ? build(path, params) : '#' + path;
  if (replace) location.replace(target);
  else location.hash = target;
}
