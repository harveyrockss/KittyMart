// Real cat photos from The Cat API (https://thecatapi.com), the same idea PuppyMart uses with
// dog.ceo: look up a photo for a breed, remember it, and always fall back to the cartoon
// portrait (catArtUrl) if the photo can't be fetched or loaded. No broken images, ever.
//
// Source 1 (real breeds): GET https://api.thecatapi.com/v1/images/search?breed_ids=<id>&limit=10
//          images are served from https://cdn2.thecatapi.com/...
//          Works without a key at low volume. Optional free key: put it in CATAPI_KEY below.
// Source 2 (colour/pattern "breeds" such as Calico, Tuxedo, Ginger Tabby): CATAAS (https://cataas.com),
//          matched by coat tag. GET /api/cats?tags=<tag>&limit=N lists photos; if that listing is not
//          reachable we use the documented random-by-tag image URL GET /cat/<tag> instead.
//          Tags used (confirmed in CATAAS's /api/tags list): calico tortoiseshell tuxedo orange ginger
//          cream black white blackandwhite gray tabby.
import { BREEDS_LOOKUP, catArtUrl } from './catData';

const CATAPI_KEY = '';
const API = 'https://api.thecatapi.com/v1/images/search';
const TAG_API = 'https://cataas.com/api/cats';
const TAG_IMG = 'https://cataas.com/cat';
const LSK = 'km_catapi_pool_v1';
const POOL_TTL = 14 * 24 * 3600 * 1000; // refresh a breed's photo list every two weeks

let pool = {};
try { pool = JSON.parse(localStorage.getItem(LSK) || '{}') || {}; } catch { pool = {}; }
const savePool = () => { try { localStorage.setItem(LSK, JSON.stringify(pool)); } catch {} };

const inflight = {};
const failUntil = {};
let globalBackoff = 0;
const okUrls = new Set();
const lastPicked = {};
const fallbackByUrl = {}; // real photo url -> cartoon to show if it ever fails to load
const breedByUrl = {}; // real photo url -> breed name (so a failed photo can try another real source first)

export const isRealPhoto = u => typeof u === 'string' && /^https?:\/\/([a-z0-9-]+\.)?(thecatapi|cataas)\.com\//i.test(u);

// Pool keys: 'tag:<tag>' for CATAAS coat tags, otherwise a Cat API breed id.
const keysFor = b => {
  const k = [];
  if (b && b.photoTag) k.push('tag:' + b.photoTag);
  if (b && b.catApiId) k.push(b.catApiId);
  return k;
};
const notify = () => { try { window.dispatchEvent(new Event('km_photos')); } catch {} };

function probe(url, ms = 8000) {
  if (okUrls.has(url)) return Promise.resolve(true);
  return new Promise(resolve => {
    const img = new Image();
    const t = setTimeout(() => { img.onload = img.onerror = null; resolve(false); }, ms);
    img.onload = () => { clearTimeout(t); okUrls.add(url); resolve(true); };
    img.onerror = () => { clearTimeout(t); resolve(false); };
    img.src = url;
  });
}

async function loadTagPool(id) {
  const tag = id.slice(4);
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 8000);
  let urls = [];
  try {
    const res = await fetch(`${TAG_API}?tags=${encodeURIComponent(tag)}&limit=20`, { signal: ctrl.signal });
    if (res.ok) {
      const data = await res.json();
      urls = (Array.isArray(data) ? data : [])
        .map(d => d && (d.id || d._id))
        .filter(Boolean)
        .map(cid => `${TAG_IMG}/${encodeURIComponent(cid)}?width=500`);
    }
  } catch { /* listing not reachable (CORS / offline): use the random-by-tag image URL below */ }
  finally { clearTimeout(tid); }
  if (!urls.length) {
    // each distinct ?r= gives a different random photo carrying this tag
    const base = Math.floor(Math.random() * 1e6);
    urls = Array.from({ length: 8 }, (_, i) => `${TAG_IMG}/${encodeURIComponent(tag)}?width=500&r=${base + i}`);
  }
  pool[id] = { urls: urls.slice(0, 20), ts: Date.now() };
  savePool();
  return pool[id].urls;
}

async function loadPool(id) {
  if (inflight[id]) return inflight[id];
  const run = async () => {
    if (id.startsWith('tag:')) {
      try { return await loadTagPool(id); }
      catch { failUntil[id] = Date.now() + 60 * 1000; return null; }
      finally { delete inflight[id]; }
    }
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${API}?breed_ids=${encodeURIComponent(id)}&limit=10&size=med&mime_types=jpg,png`, {
        signal: ctrl.signal,
        headers: CATAPI_KEY ? { 'x-api-key': CATAPI_KEY } : undefined,
      });
      if (res.status === 429) { globalBackoff = Date.now() + 5 * 60 * 1000; return null; }
      if (!res.ok) { failUntil[id] = Date.now() + 60 * 1000; return null; }
      const data = await res.json();
      const urls = (Array.isArray(data) ? data : []).map(d => d && d.url).filter(isRealPhoto);
      if (!urls.length) { failUntil[id] = Date.now() + 10 * 60 * 1000; return null; }
      pool[id] = { urls: urls.slice(0, 10), ts: Date.now() };
      savePool();
      return pool[id].urls;
    } catch {
      // network down / blocked: stop asking for a minute so the game never waits on it
      failUntil[id] = Date.now() + 60 * 1000;
      globalBackoff = Date.now() + 60 * 1000;
      return null;
    } finally { clearTimeout(tid); delete inflight[id]; }
  };
  inflight[id] = run();
  return inflight[id];
}

const poolUrls = id => (pool[id] && pool[id].urls) || null;

// Photo URL for a breed: a real photo if possible, otherwise the cartoon portrait.
// Different calls return different photos from the breed's pool (never the same twice in a row).
export async function fetchBreedPhoto(breed) {
  if (!breed) return null;
  const art = breed.api || catArtUrl(breed.name);
  for (const id of keysFor(breed)) {
    const isTag = id.startsWith('tag:');
    let urls = poolUrls(id);
    const stale = !urls || (Date.now() - (pool[id].ts || 0) > POOL_TTL);
    if (stale && (isTag || Date.now() >= globalBackoff) && Date.now() >= (failUntil[id] || 0)) {
      const fresh = await loadPool(id);
      if (fresh) urls = fresh;
    }
    if (!urls || !urls.length) continue;
    const choices = urls.length > 1 ? urls.filter(u => u !== lastPicked[id]) : urls;
    for (let i = 0; i < 2; i++) {
      const url = choices[Math.floor(Math.random() * choices.length)];
      if (await probe(url)) { lastPicked[id] = url; fallbackByUrl[url] = art; breedByUrl[url] = breed.name; notify(); return url; }
    }
    failUntil[id] = Date.now() + 5 * 60 * 1000; // this source isn't loading right now: try the next one
    if (isTag) delete pool[id]; // drop a pool whose photos don't load so it is rebuilt next time
  }
  return art;
}

// Synchronous: best photo for a cat row right now (custom upload > its own real photo >
// a cached real photo for its breed > null so callers can use the cartoon).
export function catPhotoFor(dog) {
  if (!dog) return null;
  const pu = dog.photo_url;
  if (pu && pu.startsWith('data:image/') && !pu.startsWith('data:image/svg+xml')) return pu; // user's own photo
  if (isRealPhoto(pu)) { fallbackByUrl[pu] = fallbackByUrl[pu] || (dog.breed && catArtUrl(dog.breed)); if (!breedByUrl[pu]) breedByUrl[pu] = dog.breed; return pu; }
  // older cats were saved with the cartoon: give them a stable real photo from the breed pool
  const b = BREEDS_LOOKUP[dog.breed];
  const urls = b && keysFor(b).map(poolUrls).find(u => u && u.length);
  if (urls && urls.length) {
    let h = 0; const key = String(dog.id || dog.name || '');
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    const url = urls[h % urls.length];
    fallbackByUrl[url] = catArtUrl(dog.breed); breedByUrl[url] = dog.breed;
    return url;
  }
  return null;
}

// Fetch photo pools for a few breeds in the background (e.g. the breeds the player owns).
export function warmBreedPhotos(names, max = 40) {
  let n = 0;
  (names || []).forEach(name => {
    const b = BREEDS_LOOKUP[name];
    if (!b) return;
    keysFor(b).filter(k => !poolUrls(k)).forEach(key => {
      if (n >= max) return;
      const delay = 300 * n++;
      setTimeout(() => { loadPool(key).then(u => { if (u) notify(); }); }, delay);
    });
  });
}

// Any <img> showing a thecatapi.com / cataas.com photo that fails to load swaps itself to the cartoon.
export function installPhotoFallback() {
  if (typeof document === 'undefined' || window.__kmPhotoFallback) return;
  window.__kmPhotoFallback = true;
  document.addEventListener('error', e => {
    const t = e.target;
    if (!t || t.tagName !== 'IMG' || !isRealPhoto(t.src) || t.dataset.kmfb) return;
    const tries = +(t.dataset.kmtry || 0);
    const failed = t.src;
    const fb = fallbackByUrl[failed] || catArtUrl(t.alt) || catArtUrl('Domestic Shorthair');
    t.dataset.kmfb = '1';
    e.stopImmediatePropagation(); e.stopPropagation();
    // First try a real photo from the breed's *other* source (e.g. its Cat API pool when the CATAAS tag
    // photos won't load); only if that fails too do we show the cartoon.
    const b = BREEDS_LOOKUP[breedByUrl[failed] || t.alt];
    const failedKey = Object.keys(pool).find(k => (pool[k].urls || []).includes(failed));
    if (failedKey && failedKey.startsWith('tag:')) { delete pool[failedKey]; savePool(); failUntil[failedKey] = Date.now() + 10 * 60 * 1000; }
    const alt = b && keysFor(b).filter(k => k !== failedKey).map(poolUrls).find(u => u && u.length);
    if (alt && tries < 1) {
      t.dataset.kmtry = String(tries + 1);
      let h = 0; const key = String(t.alt || '') + failed.length;
      for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
      const url = alt[h % alt.length];
      fallbackByUrl[url] = fb; breedByUrl[url] = b.name;
      delete t.dataset.kmfb; t.style.display = ''; t.src = url;
      return;
    }
    t.style.display = '';
    t.src = fb;
  }, true);
}
