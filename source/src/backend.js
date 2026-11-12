// KittyMart backend adapter.
//
// KittyMart NEVER talks to PuppyMart's Supabase. Put your own KittyMart Supabase
// project URL + publishable (anon) key below to switch on online mode. While they
// are empty the game runs fully OFFLINE: every "table" lives in this device's
// localStorage and the same sb(...) calls the screens already use are answered by
// a small PostgREST-compatible engine below.
import { createClient } from '@supabase/supabase-js';
import { catArtUrl, isGeneratedArt } from './catData';

export const KM_SUPABASE_URL = '';
export const KM_SUPABASE_KEY = '';
export const ONLINE = !!(KM_SUPABASE_URL && KM_SUPABASE_KEY);
if (typeof window !== 'undefined') window.KM_OFFLINE = !ONLINE;

// ───────────────────────── online (real Supabase) ─────────────────────────
async function sbOnline(path, method = 'GET', body = null, timeoutMs = 8000) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: KM_SUPABASE_KEY,
      Authorization: `Bearer ${KM_SUPABASE_KEY}`,
      Prefer: method === 'POST' ? 'return=representation'
        : method === 'PATCH' ? (path.includes('select=') ? 'return=representation' : 'return=minimal')
        : '',
      'Range-Unit': 'items',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${KM_SUPABASE_URL}/rest/v1/${path}`, { ...opts, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out — check your connection.');
    throw e;
  } finally { clearTimeout(timeout); }
  if (!res.ok) { const err = await res.json(); throw new Error(err.message || 'Supabase error'); }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

let _auth = null;
const authOnline = new Proxy({}, {
  get(_, method) {
    return (...args) => {
      if (!_auth) _auth = createClient(KM_SUPABASE_URL, KM_SUPABASE_KEY, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
      return _auth.auth[method](...args);
    };
  },
});

// ───────────────────────── offline (localStorage) ─────────────────────────
const LS = 'km_db_';
const tables = {};
const uuid = () => (typeof crypto !== 'undefined' && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });

// Cats used to be saved with their whole cartoon portrait (a ~10KB SVG data URL) in photo_url, which filled the
// phone's saved-data space after a few dozen cats. Now the cartoon is NOT stored: it is stripped on save and
// regenerated from the breed on load, so rows look the same to the rest of the app.
// Offline, the "cloud backup" (player_data) used to be saved INTO km_db_players, and the backup itself contains every
// km_ key including km_db_players, so each save nested the previous one and it grew until the phone's saved-data space
// was full. The data already lives in this phone's storage, so offline we never keep player_data.
const slim = (t, rows) => t === 'cats'
  ? rows.map(r => (isGeneratedArt(r.photo_url) ? { ...r, photo_url: null } : r))
  : t === 'players'
    ? rows.map(r => { if (!r || r.player_data === undefined) return r; const { player_data, ...rest } = r; return rest; })
    : rows;
function load(t) {
  if (!tables[t]) {
    try { tables[t] = JSON.parse(localStorage.getItem(LS + t) || '[]'); } catch { tables[t] = []; }
    if (t === 'players' && tables[t].some(r => r && r.player_data !== undefined)) {
      try { localStorage.removeItem(LS + t); } catch {} // free the bloated copy first so the slim one fits
      persist(t);
      tables[t] = tables[t].map(r => { if (!r) return r; const { player_data, ...rest } = r; return rest; });
    }
    if (t === 'cats') {
      let changed = false;
      tables[t].forEach(r => { if (!r.photo_url && r.breed) { r.photo_url = catArtUrl(r.breed) || null; } else if (isGeneratedArt(r.photo_url)) changed = true; });
      if (changed) persist(t); // compact old saves right away
    }
  }
  return tables[t];
}
function persist(t) {
  const write = () => localStorage.setItem(LS + t, JSON.stringify(slim(t, tables[t])));
  try { write(); } catch (e) {
    // Storage full: drop re-downloadable caches (photo lists) and try once more.
    try { ['km_catapi_pool_v1'].forEach(k => localStorage.removeItem(k)); write(); }
    catch (e2) { console.warn('KittyMart offline storage is full', e2); }
  }
}

const dec = v => { try { return decodeURIComponent(v); } catch { return v; } };
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function cmp(a, b) {
  if (a === null || a === undefined) return -1;
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && !isNaN(na) && !isNaN(nb) && typeof a !== 'object') return na < nb ? -1 : na > nb ? 1 : 0;
  const sa = String(a), sb2 = String(b);
  return sa < sb2 ? -1 : sa > sb2 ? 1 : 0;
}
function matchOp(val, expr) {
  if (expr.startsWith('not.')) return !matchOp(val, expr.slice(4));
  const i = expr.indexOf('.');
  const op = expr.slice(0, i), arg = expr.slice(i + 1);
  switch (op) {
    case 'eq': return val !== null && val !== undefined && String(val) === arg;
    case 'neq': return String(val) !== arg;
    case 'ilike': {
      if (val === null || val === undefined) return false;
      const re = new RegExp('^' + arg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/\*/g, '.*') + '$', 'i');
      return re.test(String(val));
    }
    case 'like': return matchOp(val, 'ilike.' + arg);
    case 'gte': return val !== null && val !== undefined && cmp(val, arg) >= 0;
    case 'lte': return val !== null && val !== undefined && cmp(val, arg) <= 0;
    case 'gt': return val !== null && val !== undefined && cmp(val, arg) > 0;
    case 'lt': return val !== null && val !== undefined && cmp(val, arg) < 0;
    case 'in': return splitTop(arg.replace(/^\(|\)$/g, '')).map(s => s.replace(/^"|"$/g, '')).includes(String(val));
    case 'is': return arg === 'null' ? (val === null || val === undefined) : String(val) === arg;
    default: return true;
  }
}
function matchOr(row, group) {
  return splitTop(group.replace(/^\(|\)$/g, '')).some(c => {
    const m = c.match(/^([^.]+)\.(.*)$/);
    return m ? matchOp(row[m[1]], m[2]) : false;
  });
}
const NUMERIC_DEFAULTS = { players: ['total_pts', 'race_wins', 'training_pts', 'bonus_pts', 'kitty_coins'] };

function sbOffline(path, method = 'GET', body = null) {
  const [head, qs = ''] = path.split('?');
  if (head.startsWith('rpc/')) {
    if (head === 'rpc/cat_counts_by_owner') {
      const counts = {};
      load('cats').forEach(c => { counts[c.owner_id] = (counts[c.owner_id] || 0) + 1; });
      return Object.keys(counts).map(owner_id => ({ owner_id, cat_count: counts[owner_id] }));
    }
    return [];
  }
  const rows = load(head);
  const params = qs.split('&').filter(Boolean).map(p => { const i = p.indexOf('='); return [dec(p.slice(0, i)), dec(p.slice(i + 1))]; });
  const get = k => (params.find(p => p[0] === k) || [])[1];
  const filters = params.filter(([k]) => !['select', 'limit', 'offset', 'order'].includes(k));
  const test = r => filters.every(([k, v]) => (k === 'or' ? matchOr(r, v) : matchOp(r[k], v)));

  if (method === 'POST') {
    const items = Array.isArray(body) ? body : [body];
    const now = new Date().toISOString();
    const created = items.map(it => {
      const r = { id: uuid(), created_at: now, ...it };
      if (head === 'cats' && !r.caught_at) r.caught_at = now;
      (NUMERIC_DEFAULTS[head] || []).forEach(k => { if (r[k] === undefined) r[k] = 0; });
      return r;
    });
    rows.push(...created); persist(head);
    return created;
  }
  if (method === 'PATCH') {
    const hit = rows.filter(test);
    hit.forEach(r => Object.assign(r, body));
    persist(head);
    return get('select') ? hit.map(r => ({ ...r })) : [];
  }
  if (method === 'DELETE') {
    tables[head] = rows.filter(r => !test(r)); persist(head);
    return [];
  }
  let out = rows.filter(test);
  const order = get('order');
  if (order) {
    const specs = order.split(',').map(s => s.split('.'));
    out = [...out].sort((a, b) => { for (const [col, dir] of specs) { const c = cmp(a[col], b[col]); if (c) return dir === 'desc' ? -c : c; } return 0; });
  }
  const off = parseInt(get('offset') || '0', 10), lim = parseInt(get('limit') || '0', 10);
  if (off) out = out.slice(off);
  if (lim) out = out.slice(0, lim);
  const sel = get('select');
  if (sel && sel !== '*') {
    const cols = sel.split(',').filter(c => !c.includes('('));
    out = out.map(r => { const o = {}; cols.forEach(c => { o[c] = r[c]; }); return o; });
  } else out = out.map(r => ({ ...r }));
  return out;
}

const AUTH_KEY = 'km_auth';
const readAuth = () => { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || '{}'); } catch { return {}; } };
const writeAuth = a => { try { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); } catch {} };
async function hash(s) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('km:' + s));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return 'p:' + s; }
}
const authOffline = {
  async signUp({ email, password }) {
    const a = readAuth(); const k = String(email).toLowerCase();
    if (a[k]) return { data: {}, error: { message: 'That email already has an account on this device.' } };
    const id = uuid(); a[k] = { id, pw: await hash(password) }; writeAuth(a);
    return { data: { user: { id, email } }, error: null };
  },
  async signInWithPassword({ email, password }) {
    const a = readAuth(); const e = a[String(email).toLowerCase()];
    if (!e || e.pw !== await hash(password)) return { data: {}, error: { message: 'Invalid login credentials' } };
    return { data: { user: { id: e.id, email } }, error: null };
  },
  async resetPasswordForEmail() { return { data: {}, error: { message: 'Password reset needs the online KittyMart server, which is not set up yet.' } }; },
  async updateUser() { return { data: {}, error: { message: 'Changing this needs the online KittyMart server, which is not set up yet.' } }; },
};

export const sb = async (path, method = 'GET', body = null, timeoutMs = 8000) =>
  ONLINE ? sbOnline(path, method, body, timeoutMs) : sbOffline(path, method, body);
export const supabaseAuth = { auth: ONLINE ? authOnline : authOffline };
