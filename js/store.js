// "My List" — persisted locally in the browser.
import { $$, titleOf, toast } from './util.js';

const KEY = 'yoru:list:v1';
const FIELDS = ['id', 'title', 'coverImage', 'bannerImage', 'format', 'episodes', 'duration', 'status', 'seasonYear', 'startDate', 'averageScore', 'genres', 'trailer', 'nextAiringEpisode'];

let list = [];
try {
  list = JSON.parse(localStorage.getItem(KEY)) || [];
} catch {}

const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {}
};

export const getList = () => list.slice();
export const inList = (id) => list.some((m) => m.id === id);

export function toggleList(m) {
  if (!m?.id) return;
  const had = inList(m.id);
  if (had) list = list.filter((x) => x.id !== m.id);
  else list.unshift(Object.fromEntries(FIELDS.filter((k) => k in m).map((k) => [k, m[k]])));
  save();
  $$(`[data-list="${m.id}"]`).forEach((b) => {
    b.classList.toggle('on', !had);
    b.setAttribute('aria-pressed', String(!had));
    b.setAttribute('aria-label', had ? 'Add to My List' : 'Remove from My List');
    b.animate([{ transform: 'scale(.82)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
  });
  toast(had ? `Removed “${titleOf(m)}” from My List` : `Added “${titleOf(m)}” to My List`);
  dispatchEvent(new CustomEvent('yoru:list'));
}
