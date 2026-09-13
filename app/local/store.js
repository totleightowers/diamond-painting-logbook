/**
 * The whole server, reimplemented in the browser.
 *
 * Same routes, same shapes, same core logic — only the storage differs. The
 * catalogue lives in IndexedDB but is held in memory while the app runs (about
 * 7,700 rows, a few MB) so matching and search stay simple and instant.
 * Everything the shops serve goes through the native proxy, which is what lets
 * a page fetch another origin at all.
 */
import * as idb from './idb.js';
import { SHOPS, shopById, toRow } from '../core/shops.js';
import { norm } from '../core/match.js';
import { buildPreview } from '../core/import.js';
import { parseHolds, applyStatus } from '../core/status.js';
import { estimateDrills } from '../core/estimate.js';

export const PROXY = '/__net/?url=';
const via = (url) => PROXY + encodeURIComponent(url);
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------ catalogue in memory */
let cache = null;                       // { rows, byNorm: Map }
async function catalogue() {
  if (cache) return cache;
  const rows = await idb.all('catalogue');
  const byNorm = new Map();
  for (const r of rows) {
    const k = r.title_norm;
    if (!byNorm.has(k)) byNorm.set(k, []);
    byNorm.get(k).push(r);
  }
  cache = { rows, byNorm };
  return cache;
}
const invalidate = () => { cache = null; };

function catFor(shopId) {
  return {
    byHandle: (h) => cache.rows.find(r => r.handle === h && (!shopId || r.shop === shopId)) || null,
    byTitle: (n) => {
      const hits = (cache.byNorm.get(n) || []);
      return shopId ? hits.filter(r => r.shop === shopId) : hits;
    },
    byPrefix: (n) => {
      const p = n + ' ';
      const hits = cache.rows.filter(r => (!shopId || r.shop === shopId) && r.title_norm.startsWith(p));
      hits.sort((a, b) => a.title_norm.length - b.title_norm.length || a.title.localeCompare(b.title));
      return hits.slice(0, 80);
    }
  };
}

/* A cover taken from your own photo is named so the rest of the app can tell
   it from one fetched off a listing: backfill leaves it alone, and relinking
   to another product does not throw it away. */
export const isOwnCover = (f) => !!f && /^own-/.test(String(f));

const onDisk = (f) => !!f && !!Native()?.exists('covers/' + f);
const gallery = (row) => { try { return JSON.parse(row.covers || '[]'); } catch { return []; } };

/** Pull a project's cover gallery off its listing. Returns [] if it has none. */
const asList = (v) => Array.isArray(v) ? v
  : (() => { try { return JSON.parse(v || '[]'); } catch { return []; } })();

/* A catalogue row can carry no picture: a shop that has changed its feed since
   the last sync, or a listing added after it. Rather than leave the kit blank
   everywhere it appears, ask the shop for that one product. The answer is
   written back onto the row, so this costs one request per kit, once. */
async function liveImages(shopId, handle) {
  const shop = shopById(shopId);
  if (!shop || !handle) return [];
  const abs = (u) => String(u || '').replace(/^\/\//, 'https://');
  try {
    if (shop.platform === 'woo') {
      const j = await fetchJson(`https://${shop.domain}/wp-json/wc/store/v1/products?slug=${encodeURIComponent(handle)}`);
      return ((j[0] || {}).images || []).map(i => abs(i.src)).filter(Boolean).slice(0, 6);
    }
    const j = await fetchJson(`https://${shop.domain}/products/${encodeURIComponent(handle)}.js`);
    const list = (j.images || []).map(abs).filter(Boolean);
    return (list.length ? list : [abs(j.featured_image)].filter(Boolean)).slice(0, 6);
  } catch { return []; }
}

/* Some shops publish the canvas size, the diamond count and the colour count on
   the product page and nowhere in the feed. The page is far too heavy to fetch
   for every kit at sync time — Munimade's is over 100KB and it has 133 kits —
   so it is fetched only for a kit you actually own, once, and the answer is
   written onto the catalogue row so it is never asked for twice. */
async function liveSpec(shopId, handle) {
  const shop = shopById(shopId);
  if (!shop || !shop.spec || !handle) return null;
  try {
    const res = await fetch(via(`https://${shop.domain}/products/${encodeURIComponent(handle)}`));
    if (!res.ok) return null;
    const found = shop.spec(await res.text()) || {};
    return Object.keys(found).length ? found : {};
  } catch { return null; }
}

const SPEC_FIELDS = ['width_in', 'height_in', 'drills', 'colors', 'special'];
/* An estimated diamond count is a guess standing in for a fact, so it does not
   count as filled: without this the estimate blocked the shop's real number
   from ever being fetched, and a guess would have outlived the truth. */
const blank = (r, f) => r[f] == null || (f === 'drills' && !!r.drills_estimated);
const needsSpec = (r) => !!r && SPEC_FIELDS.some(f => blank(r, f));

/** Fill a catalogue row's spec from the shop's own page. Returns the row. */
async function specForRow(row) {
  if (!row || row.spec_checked || !needsSpec(row)) return row;
  const shop = shopById(row.shop);
  if (!shop || !shop.spec) return row;
  const found = await liveSpec(row.shop, row.handle);
  if (!found) return row;                 // offline: ask again next time
  for (const f of SPEC_FIELDS) if (row[f] == null && found[f] != null) row[f] = found[f];
  row.spec_checked = 1;                   // a page with nothing on it is not re-read
  try { await idb.put('catalogue', row); } catch { /* memory is enough for now */ }
  return row;
}

/** The row's pictures, going to the shop if the row itself has none. */
async function listingImages(shopId, handle) {
  await catalogue();
  const c = (cache && cache.rows || []).find(r => r.shop === shopId && r.handle === handle);
  const known = c ? (asList(c.images).length ? asList(c.images) : (c.image ? [c.image] : [])) : [];
  if (known.length) return known;
  const live = await liveImages(shopId, handle);
  if (live.length && c) {
    c.image = live[0];
    c.images = JSON.stringify(live);
    try { await idb.put('catalogue', c); } catch { /* the in-memory row is enough for now */ }
  }
  return live;
}

/* Shopify serves a picture at whatever width you ask for, and asking for one at
   all was the only thing making these soft. These are canvases you zoom into to
   count drills, so the answer is the original: null means send no width and take
   the picture as published. A whole logbook of them is about 0.4 GB, which is
   less than a phone spends on a weekend of photographs.

   COVER_FIDELITY is the level a project's pictures were fetched at, not a flag,
   so that raising it catches up everything fetched under the old one. 1 was the
   1600px pass; 2 is the original. */
const COVER_WIDTH = null;
const COVER_FIDELITY = 2;

async function listingCovers(row, force = false) {
  if (!row.dac_handle) return [];
  const urls = await listingImages(row.shop || 'dac', row.dac_handle);
  if (!urls.length) return [];
  return cacheGallery(`${row.shop || 'dac'}-${row.dac_handle}`, urls, COVER_WIDTH, force);
}

/* Re-fetch one project's listing pictures at full width, over the top of
   whatever is already there. Filenames do not change, so nothing that points at
   them has to be rewritten. Returns true if the pictures were replaced. */
async function hifiCovers(row) {
  if (!needsHifi(row)) return false;
  const g = await listingCovers(row, true);
  if (!g.length) return false;
  const own = isOwnCover(row.cover) ? [row.cover] : [];
  const all = [...own, ...g];
  row.cover = all[0];
  row.covers = all.length > 1 ? JSON.stringify(all) : null;
  row.cover_hifi = COVER_FIDELITY;
  return true;
}

/* Everything added before covers were fetched at full width is still carrying
   the thumbnail. Catch them up, once each. */
export async function upgradeCovers(onProgress) {
  await catalogue();
  const rows = await idb.all('projects');
  let done = 0;
  for (const row of rows) {
    if (!needsHifi(row)) continue;
    if (!await hifiCovers(row)) continue;
    row.updated_at = nowIso();
    await idb.put('projects', row); done++; onProgress?.(done, row.title);
  }
  return done;
}

const needsHifi = (r) => !!r && !!r.dac_handle && (Number(r.cover_hifi) || 0) < COVER_FIDELITY;

/* Fill in the blanks on projects you own, from the shops that publish more on
   their product page than in their feed. One request per project that is still
   missing something, once — a kit whose page turns out to say nothing is marked
   so it is never asked about again. Anything you typed yourself is left alone:
   only fields that are still empty get filled. */
export async function backfillSpec(onProgress) {
  await catalogue();
  const rows = await idb.all('projects');
  let done = 0;
  for (const row of rows) {
    if (!row.dac_handle || !needsSpec(row)) continue;
    const shop = shopById(row.shop || 'dac');
    if (!shop || !shop.spec) continue;
    const listing = (cache && cache.rows || []).find(r => r.shop === shop.id && r.handle === row.dac_handle);
    const found = listing ? await specForRow(listing) : null;
    if (!found) continue;
    let changed = false;
    for (const f of SPEC_FIELDS) {
      if (blank(row, f) && found[f] != null) { row[f] = found[f]; changed = true; }
    }
    // a counted number is not an estimate any more
    if (changed && row.drills && row.drills_estimated) row.drills_estimated = 0;
    if (changed) {
      row.updated_at = nowIso();
      await idb.put('projects', row); done++; onProgress?.(done);
    }
  }
  return done;
}

/** Fetch covers for any project still missing one. Safe to call repeatedly. */
export async function backfillCovers(onProgress) {
  await catalogue();
  const rows = await idb.all('projects');
  let done = 0;
  for (const row of rows) {
    if (!row.dac_handle) continue;
    /* A main cover on disk is not enough: the carousel is driven by `covers`,
       and a row can have six filenames listed with only the first present —
       which is what a restore used to leave behind. Check the whole list. */
    const own = isOwnCover(row.cover) ? [row.cover] : [];
    const listed = gallery(row).filter(f => !isOwnCover(f));
    const haveCover = !!row.cover && onDisk(row.cover);
    const haveAll = listed.length ? listed.every(onDisk) : haveCover;
    if (haveCover && haveAll) continue;
    const g = await listingCovers(row);
    if (g.length) {
      const all = [...own, ...g];
      row.cover = all[0];
      row.covers = all.length > 1 ? JSON.stringify(all) : null;
      await idb.put('projects', row); done++; onProgress?.(done);
    }
  }
  return done;
}

/* -------------------------------------------------------------------- jobs */
const jobs = new Map();
const newJob = (id) => {
  const j = { id, state: 'running', done: 0, total: 0, message: '', result: null, error: null };
  jobs.set(id, j);
  return j;
};

/* ------------------------------------------------------------------- sync */
async function fetchJson(url) {
  const res = await fetch(via(url), { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    /* The shell puts the real reason in the body — "host not allowed:
       munimade.com" is a fixable thing to be told, and "HTTP 500" is not. */
    let why = '';
    try { why = (await res.text()).trim().slice(0, 120); } catch { /* no body to read */ }
    throw new Error(why && !/^\s*</.test(why) ? `${why} (HTTP ${res.status})` : `HTTP ${res.status}`);
  }
  return res.json();
}

async function syncOne(shop, job, want) {
  const products = [];
  let page = 1;
  while (page <= 60) {
    const url = shop.platform === 'woo'
      ? `https://${shop.domain}/wp-json/wc/store/v1/products?per_page=100&page=${page}`
      : `https://${shop.domain}/products.json?limit=250&page=${page}${want ? '&currency=' + encodeURIComponent(want) : ''}`;
    const perPage = shop.platform === 'woo' ? 100 : 250;
    let json;
    try { json = await fetchJson(url); }
    catch (e) { if (page > 1) break; throw e; }
    const batch = Array.isArray(json) ? json : (json.products || []);
    if (!batch.length) break;
    products.push(...batch);
    if (job) job.message = `${shop.name} · ${products.length.toLocaleString()} products`;
    if (batch.length < perPage) break;
    page++;
    await sleep(400);
  }
  const ctx = shop.context ? await shop.context((path) => fetchJson(`https://${shop.domain}${path}`)) : null;
  const rows = products.map(p => toRow(shop, p, ctx)).filter(Boolean)
                       .map(r => ({ ...r, title_norm: norm(r.title),
                                    currency: (shop.platform !== 'woo' && want) ? want : r.currency }));
  await idb.replaceShop(shop.id, rows);
  invalidate();
  const kits = rows.filter(r => r.kind === 'kit').length;
  return { shop: shop.id, name: shop.name, seen: products.length, kits, other: rows.length - kits };
}

/* ------------------------------------------------------------- projects */
const PROJECT_FIELDS = ['title','artist','status','shape','coverage','width_in','height_in','colors','drills',
  'special','drills_estimated','brand','source','price','price_source','shipping','tax','currency','sold_price','hours','progress',
  'date_ordered','date_received','date_started','date_completed','order_ref','order_total','order_items',
  'order_flag','dac_handle','shop','cover','covers','cover_hifi','notes','holds','rating'];

const projects = () => idb.all('projects');

async function withPhotos(p) {
  if (!p) return p;
  p.photos = (await idb.byIndex('photos', 'project_id', p.id))
    .map(({ id, file, caption, taken_at }) => ({ id, file, caption, taken_at }));
  p.progress_history = (await idb.byIndex('progress', 'project_id', p.id))
    .map(({ id, on, at, from, to, drills }) => ({ id, on, at, from, to, drills }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  p.sessions = (await idb.byIndex('sessions', 'project_id', p.id))
    .map(({ id, on, minutes, note }) => ({ id, on, minutes, note }))
    .sort((a, b) => String(b.on).localeCompare(String(a.on)) || b.id - a.id);
  return p;
}

/* `hours` is no longer typed in: it is the sum of the sessions, kept on the
   row so the stats, the CSV and the cards can go on reading one number. */
async function recountHours(projectId) {
  const mins = (await idb.byIndex('sessions', 'project_id', projectId))
    .reduce((n, x) => n + (Number(x.minutes) || 0), 0);
  const row = await idb.get('projects', projectId);
  if (!row) return 0;
  const hours = Math.round(mins / 60 * 100) / 100;
  if (row.hours !== hours) { row.hours = hours; row.updated_at = nowIso(); await idb.put('projects', row); }
  return hours;
}

/* What an order line can tell a project it already has a record for. Blanks
   only: an order history is evidence about what you bought, never a reason to
   overwrite what you have written down yourself. */
function importFills(row, k) {
  if (!row || !k) return {};
  const out = {};
  const put = (f, v) => { if (v != null && v !== '' && blank(row, f)) out[f] = v; };

  put('date_ordered', k.orderDate);
  if (k.status === 'received') put('date_received', k.orderDate);
  put('order_ref', k.orderRef);
  put('order_total', k.orderTotal);
  put('order_items', k.orderItems);
  put('order_flag', k.flag);
  put('artist', k.artist);
  put('shape', k.shape);
  put('coverage', k.coverage);
  put('width_in', k.width_in);
  put('height_in', k.height_in);
  put('colors', k.colors);
  put('special', k.special);
  // a counted number replaces a guess; an estimate does not replace a guess
  if (k.drills != null && blank(row, 'drills') && !k.drillsEstimated) out.drills = k.drills;
  if (out.drills != null) out.drills_estimated = 0;
  if (row.price == null && k.price != null) { out.price = k.price; out.price_source = k.priceSource || 'order'; }
  if (!row.dac_handle && k.handle) { out.dac_handle = k.handle; out.shop = k.shop || 'dac'; }
  return out;
}

/* What a listing can tell a project, for the fields the project has nothing in.
   Relinking used to move the pointer and refresh the covers and no more, so a
   project linked to a listing full of detail sat there with its own blanks. It
   fills only: everything you typed is yours, and relinking is not a reason to
   lose it. */
const FROM_LISTING = ['artist', 'shape', 'coverage', 'width_in', 'height_in',
                      'colors', 'drills', 'special'];

async function fillFromListing(row) {
  if (!row.dac_handle || !row.shop) return 0;
  await catalogue();
  let listing = (cache && cache.rows || []).find(r => r.shop === row.shop && r.handle === row.dac_handle);
  // the page carries what the feed leaves out for some shops
  if (listing && needsSpec(listing)) listing = await specForRow(listing);
  if (!listing) return 0;
  let filled = 0;
  for (const f of FROM_LISTING) {
    if (blank(row, f) && listing[f] != null) { row[f] = listing[f]; filled++; }
  }
  if (row.price == null && listing.price != null) {
    row.price = listing.price;
    row.price_source = 'catalogue';
    if (!row.currency && listing.currency) row.currency = listing.currency;
    filled++;
  }
  if (row.drills != null) row.drills_estimated = 0;
  return filled;
}

/* A canvas size implies roughly how many diamonds cover it, and that estimate
   was only ever applied by the order importer — so a kit added from the
   catalogue, or by hand, from a shop that publishes no count had nothing at
   all. It is marked as an estimate, and a real count replaces it. */
function estimateIfEmpty(row) {
  if (row.drills != null) return false;
  const n = estimateDrills(row.width_in, row.height_in, row.shape);
  if (n == null) return false;
  row.drills = n;
  row.drills_estimated = 1;
  return true;
}

/* Only the current percentage was ever kept, which says where a canvas is but
   nothing about when the work happened — so "diamonds placed in March" had no
   answer. Every change is recorded from now on: the percentage before and
   after, and the drill count at the time, since that can be filled in later and
   would otherwise rewrite history. Nothing can be reconstructed for work done
   before this existed. */
async function recordProgress(projectId, before, after, drills) {
  const from = Math.max(0, Math.min(100, Number(before) || 0));
  const to = Math.max(0, Math.min(100, Number(after) || 0));
  if (from === to) return;
  await idb.put('progress', {
    project_id: projectId, on: nowIso().slice(0, 10), at: nowIso(),
    from, to, drills: Number(drills) || 0
  });
}

/* Time logged against a project is the plainest possible statement that it has
   been started, so the status follows — from the wish list, the post, or a
   shelf. A project already on hold, finished or abandoned is left alone: those
   are things you have said about it, and an hour's work does not unsay them. */
async function startedByWorkingOnIt(projectId) {
  const row = await idb.get('projects', projectId);
  if (!row) return;
  if (!['wishlist', 'notReceived', 'received'].includes(row.status)) return;
  const today = nowIso().slice(0, 10);
  row.status = 'started';
  if (!row.date_started) row.date_started = today;
  if (!row.date_received) row.date_received = today;
  if (!row.date_ordered) row.date_ordered = today;
  row.updated_at = nowIso();
  await idb.put('projects', row);
}

/* Hours logged before sessions existed are not thrown away: each becomes one
   session, dated as best we can, so the total survives the change. */
async function migrateHours() {
  if (await idb.get('meta', 'sessionsMigrated')) return 0;
  let made = 0;
  for (const row of await idb.all('projects')) {
    const mins = Math.round((Number(row.hours) || 0) * 60);
    if (mins <= 0) continue;
    if ((await idb.byIndex('sessions', 'project_id', row.id)).length) continue;
    await idb.put('sessions', {
      project_id: row.id, minutes: mins, note: 'Logged before sessions',
      on: row.date_completed || row.date_started || (row.created_at || nowIso()).slice(0, 10),
      created_at: nowIso()
    });
    made++;
  }
  await idb.put('meta', { at: nowIso(), made }, 'sessionsMigrated');
  return made;
}

/* Covers and progress photos are written to the app's own storage through the
 * native bridge, and served back by the shell at /covers/ and /photos/. Keeping
 * them as real files (rather than blobs in IndexedDB) means the rest of the app
 * uses ordinary <img src="/covers/x.jpg"> and needs no special casing. */
const Native = () => (typeof window !== 'undefined' ? window.LogbookNative : null);

const toBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export async function saveFile(path, blobOrBuffer) {
  const n = Native();
  if (!n) return false;
  const buf = blobOrBuffer instanceof Blob ? await blobOrBuffer.arrayBuffer() : blobOrBuffer;
  return n.save(path, toBase64(buf));
}

/** Download a whole listing gallery; returns the local filenames. */
async function cacheGallery(key, urls, width = COVER_WIDTH, force = false) {
  const out = [];
  for (let i = 0; i < (urls || []).length; i++) {
    const f = await cacheCover(i === 0 ? key : `${key}-${i}`, urls[i], width, force);
    if (f) out.push(f);
  }
  return out;
}

async function cacheCover(key, url, width = COVER_WIDTH, force = false) {
  if (!url) return null;
  let src = url;
  try {
    const u = new URL(url);
    // no width at all means the original, which is the point
    if (width && u.hostname.includes('shopify')) { u.searchParams.set('width', String(width)); src = u.toString(); }
  } catch {}
  const ext = (String(url).match(/\.(png|webp|gif|jpe?g)/i) || ['.jpg'])[0].toLowerCase();
  const name = key + (ext === '.jpeg' ? '.jpg' : ext);
  const n = Native();
  /* The filename carries no width, so a picture already on disk is indistinguishable
     from a sharp one. Without this, upgrading an old kit silently kept the blur. */
  if (!force && n && n.exists('covers/' + name)) return name;
  try {
    const res = await fetch(via(src));
    if (!res.ok) return null;
    return (await saveFile('covers/' + name, await res.arrayBuffer())) ? name : null;
  } catch { return null; }
}

/* --------------------------------------------------------------- routing */
const q = (u, k) => u.searchParams.get(k);

let migrated = null;
export async function localApi(path, opts = {}) {
  if (!migrated) migrated = migrateHours().catch(() => 0);
  await migrated;
  const url = new URL(path, 'http://local');
  const p = url.pathname;
  const m = (opts.method || 'GET').toUpperCase();
  // NOT every body is JSON — the import posts raw CSV text. Parse only where
  // a route actually expects an object.
  const json = () => {
    if (!opts.body) return {};
    if (typeof opts.body !== 'string') return opts.body;
    try { return JSON.parse(opts.body); } catch { return {}; }
  };
  await catalogue();

  if (p === '/state') {
    const rows = await projects();
    const counts = {};
    rows.forEach(r => counts[r.status] = (counts[r.status] || 0) + 1);
    const per = {};
    cache.rows.forEach(r => { if (r.kind === 'kit') per[r.shop] = (per[r.shop] || 0) + 1; });
    const meta = await idb.get('meta', 'synced') || {};
    return {
      catalogue: {
        kits: Object.values(per).reduce((a, b) => a + b, 0),
        total: cache.rows.length,
        syncedAt: meta.all || null,
        shops: SHOPS.map(s => ({ id: s.id, name: s.name, domain: s.domain, kits: per[s.id] || 0, syncedAt: meta[s.id] || null }))
      },
      counts, total: rows.length
    };
  }

  if (p === '/shops') return (await localApi('/state')).catalogue.shops;

  if (p === '/prefs' && m === 'GET') {
    const pr = (await idb.get('meta', 'prefs')) || {};
    return { currency: pr.currency || 'GBP', excluded: pr.excluded || [], hints: pr.hints || {} };
  }

  if (p === '/prefs' && m === 'PATCH') {
    const prefs = (await idb.get('meta', 'prefs')) || {};
    const b = json();
    if (b.currency) prefs.currency = String(b.currency).slice(0, 3).toUpperCase();
    if (Array.isArray(b.excluded)) prefs.excluded = b.excluded;
    // a hint is shown until it has been read; the flag has to outlive the session
    if (b.hints && typeof b.hints === 'object')
      prefs.hints = { ...(prefs.hints || {}), ...b.hints };
    await idb.put('meta', prefs, 'prefs');
    return { currency: prefs.currency || 'GBP', excluded: prefs.excluded || [], hints: prefs.hints || {} };
  }

  if (p === '/catalogue/sync' && m === 'POST') {
    const want = q(url, 'shop');
    const off = ((await idb.get('meta', 'prefs')) || {}).excluded || [];
    const list = want ? [shopById(want)].filter(Boolean) : SHOPS.filter(sh => !off.includes(sh.id));
    const job = newJob('sync-' + Date.now());
    job.total = list.length;
    job.message = `Contacting ${list[0].name}…`;
    (async () => {
      const results = [], failed = [];
      const meta = (await idb.get('meta', 'synced')) || {};
      for (const shop of list) {
        try {
          const want = ((await idb.get('meta', 'prefs')) || {}).currency || 'GBP';
          results.push(await syncOne(shop, job, want));
          meta[shop.id] = nowIso();
        }
        catch (e) { failed.push({ shop: shop.name, error: e.message }); }
        job.done++;
      }
      meta.all = nowIso();
      await idb.put('meta', meta, 'synced');
      // anything restored before the catalogue existed can get its cover now
      try {
        const filled = await backfillCovers((n) => { job.message = `Fetching covers · ${n}`; });
        if (filled) job.coversFilled = filled;
      } catch { /* covers are cosmetic; never fail a sync over them */ }
      // and the sizes and diamond counts the feeds do not carry
      try {
        const spec = await backfillSpec((n) => { job.message = `Filling in details · ${n}`; });
        if (spec) job.specFilled = spec;
      } catch { /* same: a sync is not a failure for want of a drill count */ }
      job.result = { shops: results, failed };
      job.state = results.length ? 'done' : 'error';
      if (!results.length) job.error = failed.map(f => `${f.shop}: ${f.error}`).join('; ');
      const kits = results.reduce((n, r) => n + r.kits, 0);
      job.message = `${kits.toLocaleString()} kits from ${results.length} shop${results.length === 1 ? '' : 's'}`
        + (failed.length ? ` · ${failed.length} could not be reached` : '');
    })();
    return { job: job.id };
  }

  if (p.startsWith('/jobs/')) {
    const j = jobs.get(p.slice(6));
    if (!j) throw Object.assign(new Error('No such job'), { status: 404 });
    return j;
  }

  if (p === '/catalogue/facets') {
    const shop = q(url, 'shop');
    const rows = cache.rows.filter(r => r.kind === 'kit' && (!shop || r.shop === shop));
    const priced = rows.filter(r => r.price != null).map(r => r.price);
    const edges = rows.filter(r => r.width_in && r.height_in)
                      .map(r => Math.max(r.width_in, r.height_in) * 2.54);
    const shapes = [...new Set(rows.map(r => r.shape).filter(Boolean))];
    return {
      minPrice: priced.length ? Math.floor(Math.min(...priced)) : 0,
      maxPrice: priced.length ? Math.ceil(Math.max(...priced)) : 200,
      minCm: edges.length ? Math.floor(Math.min(...edges)) : 0,
      maxCm: edges.length ? Math.ceil(Math.max(...edges)) : 200,
      shapes
    };
  }

  /* One catalogue row, for a project that has no cached cover: the picture can
     still be shown straight from the shop while the cache catches up. */
  if (p === '/catalogue/product' && m === 'GET') {
    const shop = q(url, 'shop'), handle = q(url, 'handle');
    if (!shop || !handle) return null;
    /* Every sync empties the in-memory catalogue, so reading it without building
       it first found nothing and fell through to fetching from the shop — no
       cover, no spec, and a row of the right shape with nothing in it. Rare,
       intermittent, and exactly the kind of thing that looks like the shop
       being slow. */
    await catalogue();
    const row = (cache && cache.rows || []).find(r => r.shop === shop && r.handle === handle);
    if (row && !row.image) await listingImages(shop, handle);   // fills the row in place
    if (row) return specForRow(row);
    /* Not in the catalogue at all — the pictures are still worth having. Same
       shape as a real row: callers read these fields straight off whatever this
       returns, and a missing key is not the same as an empty one. */
    const live = await liveImages(shop, handle);
    if (!live.length) return null;
    return {
      kind: 'kit', shop, handle, image: live[0], images: JSON.stringify(live),
      title: null, artist: null, price: null, currency: null, available: null,
      width_in: null, height_in: null, shape: null, coverage: null,
      colors: null, drills: null, special: null, variant_title: null, type: null
    };
  }

  if (p === '/catalogue/search' || p === '/catalogue/browse') {
    const shop = q(url, 'shop');
    const limit = Math.min(60, Number(q(url, 'limit')) || 30);
    const offset = Number(q(url, 'offset')) || 0;
    const shape = q(url, 'shape');
    const minCm = Number(q(url, 'minCm')) || null;
    const maxCm = Number(q(url, 'maxCm')) || null;
    const maxPrice = Number(q(url, 'maxPrice')) || null;
    const inStock = q(url, 'inStock') === '1';
    const sort = q(url, 'sort') || 'relevance';
    const edge = (r) => (r.width_in && r.height_in) ? Math.max(r.width_in, r.height_in) * 2.54 : null;

    const off = ((await idb.get('meta', 'prefs')) || {}).excluded || [];
    let rows = cache.rows.filter(r => r.kind === 'kit'
      && (shop ? r.shop === shop : !off.includes(r.shop)));
    if (shape) rows = rows.filter(r => r.shape === shape);
    if (inStock) rows = rows.filter(r => r.available);
    if (maxPrice) rows = rows.filter(r => r.price != null && r.price <= maxPrice);
    if (minCm) rows = rows.filter(r => edge(r) != null && edge(r) >= minCm);
    if (maxCm) rows = rows.filter(r => edge(r) != null && edge(r) <= maxCm);

    const bySort = {
      name: (a, b) => a.title.localeCompare(b.title),
      price: (a, b) => (a.price ?? 1e9) - (b.price ?? 1e9),
      priceDesc: (a, b) => (b.price ?? -1) - (a.price ?? -1),
      size: (a, b) => ((b.width_in||0)*(b.height_in||0)) - ((a.width_in||0)*(a.height_in||0)),
      drills: (a, b) => (b.drills ?? -1) - (a.drills ?? -1)
    };

    if (p === '/catalogue/search') {
      const n = norm(q(url, 'q') || '');
      if (n.length < 2) return [];
      rows = rows.filter(r => r.title_norm.includes(n) || (r.artist || '').toLowerCase().includes(n));
      const rank = (r) => r.title_norm === n ? 0 : r.title_norm.startsWith(n) ? 1 : r.title_norm.includes(n) ? 2 : 3;
      rows.sort(bySort[sort] || ((a, b) => rank(a) - rank(b) || (b.available - a.available)
                       || a.title.length - b.title.length || a.title.localeCompare(b.title)));
    } else {
      rows = rows.filter(r => r.image);
      rows.sort(bySort[sort] || ((a, b) => (b.available - a.available) || a.title.localeCompare(b.title)));
    }
    return rows.slice(offset, offset + limit);
  }

  if (p === '/import/preview' && m === 'POST') {
    const shop = q(url, 'shop') || 'dac';
    if (!cache.rows.some(r => r.shop === shop))
      throw Object.assign(new Error('Sync the catalogue first so orders can be matched.'), { status: 409 });
    const rows = await projects();
    const existing = new Map(rows.map(r => [norm(r.title), r.id]));
    const known = new Map();
    for (const r of rows) if (r.dac_handle) known.set(norm(r.title), r.dac_handle);
    const s = shopById(shop);
    const pref = ((await idb.get('meta', 'prefs')) || {}).currency || 'GBP';
    const preview = buildPreview(catFor(shop), existing, String(opts.body), s ? s.name : 'Diamond Art Club', known, pref);

    /* An order history knows things about projects you already have — when you
       ordered them above all. The import only ever created what was missing and
       skipped the rest as duplicates, so a second import could not answer the
       one question the logbook could not: when did I buy this. Every duplicate
       now says what it could fill in, and fills nothing that is not empty. */
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const k of preview.kits || []) {
      if (!k.duplicate || k.duplicateId == null) continue;
      k.fills = importFills(byId.get(k.duplicateId), k);
      k.fillCount = Object.keys(k.fills || {}).length;
    }
    /* A line the catalogue cannot match is not necessarily a line you do not
       own: shops retire listings, and a kit bought last May may simply not be
       sold any more. The order still knows when it was bought, and the logbook
       still has the project — so match those against the logbook by title and
       let them fill dates too. Without this an order history could not date the
       oldest kits in a collection, which are exactly the undated ones. */
    const byTitle = new Map(rows.map(r => [norm(r.title || ''), r]));
    for (const sk of preview.skipped || []) {
      const row = byTitle.get(norm(sk.title || '')) || byTitle.get(norm(sk.rawTitle || ''));
      if (!row) continue;
      sk.duplicateId = row.id;
      sk.owned = true;
      sk.fills = importFills(row, sk);
      sk.fillCount = Object.keys(sk.fills).length;
    }
    preview.summary.fillable = [...(preview.kits || []), ...(preview.skipped || [])]
      .filter(k => k.fillCount > 0).length;
    return preview;
  }

  if (p === '/import/fill' && m === 'POST') {
    const kits = json().kits || [];
    let filled = 0, fields = 0;
    for (const k of kits) {
      const row = await idb.get('projects', Number(k.duplicateId));
      if (!row) continue;
      const patch = importFills(row, k);
      const keys = Object.keys(patch);
      if (!keys.length) continue;
      Object.assign(row, patch);
      estimateIfEmpty(row);
      row.updated_at = nowIso();
      await idb.put('projects', row);
      filled++; fields += keys.length;
    }
    return { filled, fields };
  }

  if (p === '/import/commit' && m === 'POST') {
    const kits = json().kits || [];
    const job = newJob('import-' + Date.now());
    job.total = kits.length;
    (async () => {
      try {
        let i = 0, inserted = 0;
        for (const k of kits) {
          const g = await cacheGallery(`${k.shop || 'dac'}-${k.handle || 'kit-' + i}`,
            (k.images && k.images.length) ? k.images : [k.cover]);
          k.coverFile = g[0] || null;
          k.coverFiles = g;
          job.done = ++i;
          job.message = `Fetching covers · ${i} of ${kits.length}`;
        }
        const seen = new Set((await projects()).map(r => (r.title || '').toLowerCase() + '::' + (r.order_ref || '')));
        const ts = nowIso();
        for (const k of kits) {
          const key = k.title.toLowerCase() + '::' + (k.orderRef || '');
          if (seen.has(key)) continue;
          seen.add(key);
          await idb.put('projects', {
            title: k.title, artist: k.artist ?? null, status: k.status || 'notReceived',
            shape: k.shape ?? null, coverage: k.coverage ?? null,
            width_in: k.width_in ?? null, height_in: k.height_in ?? null,
            colors: k.colors ?? null, drills: k.drills ?? null,
            drills_estimated: k.drillsEstimated ?? 0, special: k.special ?? null,
            brand: k.shopName || null, source: k.shopName || null, currency: k.currency || 'GBP',
            date_ordered: k.orderDate ?? null,
            date_received: k.status === 'received' ? k.orderDate ?? null : null,
            date_started: null, date_completed: null,
            order_ref: k.orderRef ?? null, order_total: k.orderTotal ?? null,
            order_items: k.orderItems ?? null, order_flag: k.flag ?? null,
            dac_handle: k.handle ?? null, shop: k.shop ?? 'dac', cover: k.coverFile ?? null,
            covers: (k.coverFiles && k.coverFiles.length > 1) ? JSON.stringify(k.coverFiles) : null,
            price: k.price ?? null, price_source: k.priceSource ?? null,
            shipping: null, tax: null, sold_price: null, hours: 0, progress: 0, notes: null,
            created_at: ts, updated_at: ts
          });
          inserted++;
        }
        job.result = { inserted, skipped: kits.length - inserted };
        job.state = 'done';
        job.message = `${inserted} projects added`;
      } catch (e) { job.state = 'error'; job.error = e.message; }
    })();
    return { job: job.id };
  }

  if (p === '/projects' && m === 'GET') {
    let rows = await projects();
    const status = q(url, 'status'), qq = (q(url, 'q') || '').toLowerCase();
    if (status && status !== 'all') rows = rows.filter(r => r.status === status);
    if (qq) rows = rows.filter(r => r.title.toLowerCase().includes(qq) || (r.artist || '').toLowerCase().includes(qq));
    const sort = q(url, 'sort') || 'added';
    const cmp = {
      added: (a, b) => b.id - a.id,
      name: (a, b) => a.title.localeCompare(b.title),
      drills: (a, b) => (b.drills || 0) - (a.drills || 0),
      size: (a, b) => ((b.width_in || 0) * (b.height_in || 0)) - ((a.width_in || 0) * (a.height_in || 0)),
      progress: (a, b) => (b.progress || 0) - (a.progress || 0)
    }[sort] || ((a, b) => b.id - a.id);
    /* Whether a kit's pictures are the small ones is a storage question, and the
       answer rather than the fidelity number is what the logbook needs — so it
       travels with the row and nothing outside has to know what level we are on. */
    return rows.sort(cmp).map(r => ({ ...r, pics_small: needsHifi(r) }));
  }

  if (p === '/projects' && m === 'POST') {
    const body = json();
    if (!body.title || !String(body.title).trim()) throw Object.assign(new Error('A project name is required.'), { status: 400 });
    if (body.dac_handle && body.shop && !body.cover) {
      await catalogue();
      const c = cache.rows.find(r => r.shop === body.shop && r.handle === body.dac_handle);
      if (c && c.image) {
        const urls = Array.isArray(c.images) ? c.images
          : (() => { try { return JSON.parse(c.images || '[]'); } catch { return []; } })();
        const g = await cacheGallery(`${body.shop}-${body.dac_handle}`, urls.length ? urls : [c.image]);
        body.cover = g[0] || null;
        if (g.length > 1) body.covers = JSON.stringify(g);
        if (g.length) body.cover_hifi = COVER_FIDELITY;
      }
    }
    const ts = nowIso();
    const row = { created_at: ts, updated_at: ts, hours: 0, progress: 0 };
    for (const f of PROJECT_FIELDS) if (body[f] !== undefined) row[f] = body[f];
    /* The rule that a status implies its earlier dates ran when a status was
       CHANGED and not when a project was created, so anything added from the
       catalogue kept the default status and arrived with no dates at all. Those
       projects then belonged to no month, and the year never added up to All
       time. Dates you supplied yourself are left exactly as they are. */
    if (row.status) {
      const implied = applyStatus(row, row.status, ts.slice(0, 10));
      // fill only. applyStatus also CLEARS the dates a status has moved back
      // past, which is right when you change one and wrong when you state one:
      // a completion date given at creation is a fact, not a leftover.
      for (const [k, v] of Object.entries(implied))
        if (k.startsWith('date_') && v && !row[k]) row[k] = v;
    }
    if (Number(row.progress) >= 100 && row.status !== 'completed' && row.status !== 'abandoned') {
      row.status = 'completed';
      if (!row.date_completed) row.date_completed = ts.slice(0, 10);
    }
    try { await catalogue(); await fillFromListing(row); } catch { /* offline: what was typed still saves */ }
    estimateIfEmpty(row);
    const id = await idb.put('projects', row);
    if (Number(row.progress) > 0) await recordProgress(id, 0, row.progress, row.drills);
    return withPhotos(await idb.get('projects', id));
  }

  const pm = p.match(/^\/projects\/(\d+)$/);
  if (pm) {
    const id = Number(pm[1]);
    const row = await idb.get('projects', id);
    if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
    if (m === 'GET') return withPhotos(row);
    if (m === 'PATCH') {
      const body = json();
      const was = Number(row.progress) || 0;
      const wasStatus = row.status;
      // pointing a project at a different listing makes the old pictures wrong;
      // a cover you chose yourself is yours and survives the relink
      const relinked = 'dac_handle' in body && (body.dac_handle || null) !== (row.dac_handle || null);
      for (const f of PROJECT_FIELDS) if (f in body) row[f] = body[f];
      if (relinked && !isOwnCover(row.cover)) { row.cover = null; row.covers = null; }
      if (relinked) {
        try {
          await catalogue();
          const g = await listingCovers(row);
          if (g.length) {
            const own = isOwnCover(row.cover) ? [row.cover] : [];
            row.cover = own[0] || g[0];
            row.covers = JSON.stringify([...own, ...g]);
            row.cover_hifi = COVER_FIDELITY;
          }
          await fillFromListing(row);
        } catch { /* covers are cosmetic; never fail a save over them */ }
      }
      /* Moving a kit along — onto the board, off it, finished — is when you
         actually look at the picture, so that is the moment to go and get a
         sharp one for anything still carrying a thumbnail. */
      if (!relinked && row.status !== wasStatus && needsHifi(row)) {
        try { await catalogue(); await hifiCovers(row); }
        catch { /* covers are cosmetic; never fail a save over them */ }
      }
      // a size with no count is still worth an estimate, however it got here
      estimateIfEmpty(row);
      /* Finishing a canvas means the same thing wherever it is said. The slider
         on the project page enforced it and the form did not, so the form could
         leave a project at 100% and still Started with no completion date. The
         rule belongs here, where every route passes through. */
      if (Number(row.progress) >= 100 && row.status !== 'completed' && row.status !== 'abandoned') {
        row.status = 'completed';
        if (!row.date_completed) row.date_completed = nowIso().slice(0, 10);
      }
      row.updated_at = nowIso();
      await idb.put('projects', row);
      if ('progress' in body || row.progress !== was) await recordProgress(id, was, row.progress, row.drills);
      return withPhotos(row);
    }
    if (m === 'DELETE') {
      for (const ph of await idb.byIndex('photos', 'project_id', id)) {
        Native()?.remove('photos/' + ph.file);
        await idb.del('photos', ph.id);
      }
      /* Sessions went with the photos from here on. They used to be left
         behind, which nothing noticed while hours were only ever read off one
         project at a time — but the summary adds them all up, and hours worked
         on a canvas you deleted are not hours you worked. */
      for (const x of await idb.byIndex('sessions', 'project_id', id)) await idb.del('sessions', x.id);
      for (const x of await idb.byIndex('progress', 'project_id', id)) await idb.del('progress', x.id);
      await idb.del('projects', id);
      return { ok: true };
    }
  }

  const cv = p.match(/^\/projects\/(\d+)\/cover$/);
  if (cv) {
    const id = Number(cv[1]);
    const row = await idb.get('projects', id);
    if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
    const previous = row.cover;
    const gallery = (() => { try { return JSON.parse(row.covers || '[]'); } catch { return []; } })();

    if (m === 'POST') {
      const file = json().photo;
      const mine = await idb.byIndex('photos', 'project_id', id);
      if (!file || !mine.some(x => x.file === file))
        throw Object.assign(new Error('That photo is not on this project.'), { status: 400 });
      const res = await fetch('/photos/' + encodeURIComponent(file));
      if (!res.ok) throw Object.assign(new Error('Could not read that photo.'), { status: 500 });
      const ext = (String(file).match(/\.[a-z0-9]+$/i) || ['.jpg'])[0];
      const name = `own-${id}-${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`;
      if (!await saveFile('covers/' + name, await res.arrayBuffer()))
        throw Object.assign(new Error('Could not save that cover.'), { status: 500 });
      // the listing's pictures stay in the carousel behind your own
      const rest = gallery.filter(f => !isOwnCover(f));
      row.cover = name;
      row.covers = JSON.stringify([name, ...rest]);
      if (isOwnCover(previous) && previous !== name) Native()?.remove('covers/' + previous);
      row.updated_at = nowIso();
      await idb.put('projects', row);
      return withPhotos(row);
    }

    if (m === 'DELETE') {
      for (const f of gallery.filter(isOwnCover)) Native()?.remove('covers/' + f);
      if (isOwnCover(previous)) Native()?.remove('covers/' + previous);
      row.cover = null; row.covers = null;
      try {
        await catalogue();
        const g = await listingCovers(row);
        if (g.length) { row.cover = g[0]; row.covers = g.length > 1 ? JSON.stringify(g) : null; }
      } catch { /* leaving it blank is recoverable; the next sync backfills it */ }
      row.updated_at = nowIso();
      await idb.put('projects', row);
      return withPhotos(row);
    }
  }

  const ph = p.match(/^\/projects\/(\d+)\/photos$/);
  if (ph && m === 'POST') {
    const id = Number(ph[1]);
    const ts = nowIso();
    const type = (opts.headers && opts.headers['Content-Type']) || 'image/jpeg';
    const ext = { 'image/png': '.png', 'image/webp': '.webp' }[type] || '.jpg';
    const file = `p${id}-${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`;
    if (!await saveFile('photos/' + file, opts.body))
      throw Object.assign(new Error('Could not save that photo.'), { status: 500 });
    const pid = await idb.put('photos', { project_id: id, file, taken_at: ts.slice(0, 10), created_at: ts });
    return { id: pid, file };
  }

  /* Holds are opened and closed by the status moving, but they are also just
     facts about the past, and the past sometimes needs correcting by hand. */
  const holdAdd = p.match(/^\/projects\/(\d+)\/holds$/);
  if (holdAdd && m === 'POST') {
    const id = Number(holdAdd[1]);
    const row = await idb.get('projects', id);
    if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
    const b = json();
    const held = String(b.held || '').slice(0, 10);
    const restarted = b.restarted ? String(b.restarted).slice(0, 10) : null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(held))
      throw Object.assign(new Error('When did you put it down?'), { status: 400 });
    if (restarted && restarted < held)
      throw Object.assign(new Error('It cannot be picked up before it was put down.'), { status: 400 });
    const list = parseHolds(row);
    if (!restarted && list.some(x => !x.restarted))
      throw Object.assign(new Error('It is already on hold.'), { status: 400 });
    list.push({ held, restarted });
    list.sort((a, b2) => String(a.held).localeCompare(String(b2.held)));
    row.holds = JSON.stringify(list);
    if (!restarted) row.status = 'onHold';       // an open period is what being on hold means
    row.updated_at = nowIso();
    await idb.put('projects', row);
    return withPhotos(row);
  }

  const holdDel = p.match(/^\/projects\/(\d+)\/holds\/(\d+)$/);
  if (holdDel && m === 'DELETE') {
    const id = Number(holdDel[1]);
    const row = await idb.get('projects', id);
    if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
    const list = parseHolds(row);
    const i = Number(holdDel[2]);
    if (i < 0 || i >= list.length) throw Object.assign(new Error('No such hold.'), { status: 404 });
    const wasOpen = !list[i].restarted;
    list.splice(i, 1);
    row.holds = list.length ? JSON.stringify(list) : null;
    // deleting the hold it is on leaves it on hold with nothing to show for it
    if (wasOpen && row.status === 'onHold') row.status = row.date_started ? 'started' : 'received';
    row.updated_at = nowIso();
    await idb.put('projects', row);
    return withPhotos(row);
  }

  const sess = p.match(/^\/projects\/(\d+)\/sessions$/);
  if (sess && m === 'POST') {
    const id = Number(sess[1]);
    if (!await idb.get('projects', id)) throw Object.assign(new Error('Not found'), { status: 404 });
    const b = json();
    const minutes = Math.round(Number(b.minutes) || 0);
    if (minutes <= 0) throw Object.assign(new Error('How long was the session?'), { status: 400 });
    if (minutes > 24 * 60) throw Object.assign(new Error('That is more than a day.'), { status: 400 });
    const sid = await idb.put('sessions', {
      project_id: id, minutes,
      on: (b.on || nowIso().slice(0, 10)).slice(0, 10),
      note: b.note ? String(b.note).slice(0, 200) : null,
      created_at: nowIso()
    });
    await recountHours(id);
    await startedByWorkingOnIt(id);
    return { id: sid, hours: (await idb.get('projects', id)).hours };
  }

  const ds = p.match(/^\/sessions\/(\d+)$/);
  if (ds && m === 'DELETE') {
    const row = await idb.get('sessions', Number(ds[1]));
    if (row) { await idb.del('sessions', row.id); await recountHours(row.project_id); }
    return { ok: true };
  }

  /* One timer at a time, kept in meta rather than on the project: it is a thing
     the app is doing, not a fact about the painting, and it has to survive the
     app being closed mid-session. */
  if (p === '/timer') {
    if (m === 'GET') return (await idb.get('meta', 'timer')) || null;
    if (m === 'POST') {
      const b = json();
      const id = Number(b.project_id);
      const row = await idb.get('projects', id);
      if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
      const timer = { project_id: id, title: row.title, started_at: nowIso() };
      await idb.put('meta', timer, 'timer');
      return timer;
    }
    if (m === 'DELETE') { await idb.del('meta', 'timer'); return { ok: true }; }
  }

  if (p === '/timer/stop' && m === 'POST') {
    const timer = await idb.get('meta', 'timer');
    if (!timer) throw Object.assign(new Error('No timer is running.'), { status: 400 });
    await idb.del('meta', 'timer');
    const minutes = Math.max(1, Math.round((Date.now() - Date.parse(timer.started_at)) / 60000));
    const sid = await idb.put('sessions', {
      project_id: timer.project_id, minutes, note: null,
      on: nowIso().slice(0, 10), created_at: nowIso()
    });
    await recountHours(timer.project_id);
    await startedByWorkingOnIt(timer.project_id);
    return { id: sid, minutes, project_id: timer.project_id };
  }

  const dp = p.match(/^\/photos\/(\d+)$/);
  if (dp && m === 'DELETE') {
    const row = await idb.get('photos', Number(dp[1]));
    if (row) { Native()?.remove('photos/' + row.file); await idb.del('photos', row.id); }
    return { ok: true };
  }

  if (p === '/restore' && m === 'POST') {
    const data = json();
    if (!data || !Array.isArray(data.projects))
      throw Object.assign(new Error('That is not a logbook backup.'), { status: 400 });

    const existing = await projects();
    const keyOf = (r) => (r.title || '').toLowerCase() + '::' + (r.order_ref || '');
    const here = new Map(existing.map(r => [keyOf(r), r.id]));

    // Map EVERY backed-up project to a local id — including ones already here.
    // Only mapping the newly added ones silently dropped their photos.
    const idMap = new Map();
    let added = 0;
    /* A restore is also how corrections travel from the other build into this
       one, so a project that is already here gets UPDATED rather than skipped.
       Only fields the backup actually has a value for are touched, and your own
       progress, hours and notes are never overwritten. */
    // `hours` is derived from sessions now, so a backup's copy must not win
    const KEEP_MINE = new Set(['progress', 'hours', 'notes', 'sold_price', 'id', 'created_at']);
    let updated = 0, fieldsChanged = 0;
    for (const row of data.projects) {
      const key = keyOf(row);
      if (here.has(key)) {
        const id = here.get(key);
        idMap.set(row.id, id);
        const mine = await idb.get('projects', id);
        if (mine) {
          let touched = false;
          for (const [f, v] of Object.entries(row)) {
            // `cover` and `covers` name files on the machine the backup came
            // from. Taking them produces a carousel of broken images — six
            // dots, one picture — so they are re-fetched here instead.
            if (KEEP_MINE.has(f) || f === 'cover' || f === 'covers') continue;
            if (v == null || v === '') continue;
            if (mine[f] === v) continue;
            mine[f] = v; touched = true; fieldsChanged++;
          }
          if (touched) { mine.updated_at = nowIso(); await idb.put('projects', mine); updated++; }
        }
        continue;
      }
      const copy = { ...row };
      delete copy.id;
      // The filenames in the backup belong to the machine it came from; this
      // app stores covers under its own name. Keeping them produced broken
      // images, so drop both and re-fetch below.
      delete copy.cover;
      delete copy.covers;
      const newId = await idb.put('projects', copy);
      here.set(key, newId);
      idMap.set(row.id, newId);
      added++;
    }

    /* Sessions: like photos, nothing else can reproduce them. Matched on the
       day and the length, so restoring the same backup twice does not double
       the hours. */
    let sessionsAdded = 0;
    for (const se of (data.sessions || [])) {
      const pid = idMap.get(se.project_id);
      if (!pid || !se.minutes) continue;
      const here = await idb.byIndex('sessions', 'project_id', pid);
      if (here.some(x => x.on === se.on && x.minutes === se.minutes)) continue;
      await idb.put('sessions', { project_id: pid, minutes: Number(se.minutes) || 0,
                                  on: se.on || null, note: se.note ?? null,
                                  created_at: se.created_at || nowIso() });
      sessionsAdded++;
    }
    for (const [, pid] of idMap) await recountHours(pid);

    /* Progress history: like sessions and photos, nothing can reproduce it —
       the current percentage says where a canvas is, never when the work
       happened. Matched on the moment and the two percentages, so restoring the
       same backup twice does not count the same diamonds twice. */
    let progressAdded = 0;
    for (const h of (data.progress || [])) {
      const pid = idMap.get(h.project_id);
      if (!pid || h.from == null || h.to == null) continue;
      const here = await idb.byIndex('progress', 'project_id', pid);
      if (here.some(x => x.at === h.at && x.from === h.from && x.to === h.to)) continue;
      await idb.put('progress', { project_id: pid, on: h.on || null, at: h.at || nowIso(),
                                  from: Number(h.from) || 0, to: Number(h.to) || 0,
                                  drills: Number(h.drills) || 0 });
      progressAdded++;
    }

    // progress photos: the only part of a logbook that cannot be re-downloaded
    let photos = 0, photosFailed = 0;
    const seenPhotos = new Set();
    for (const ph of (await idb.all('photos'))) seenPhotos.add(ph.project_id + '::' + ph.file);
    for (const ph of (data.photos || [])) {
      const pid = idMap.get(ph.project_id);
      if (!pid || !ph.data) { photosFailed++; continue; }
      if (seenPhotos.has(pid + '::' + ph.file)) continue;      // restoring twice is safe
      try {
        const bytes = Uint8Array.from(atob(ph.data), (c) => c.charCodeAt(0));
        if (!await saveFile('photos/' + ph.file, bytes.buffer)) { photosFailed++; continue; }
        await idb.put('photos', { project_id: pid, file: ph.file, caption: ph.caption ?? null,
                                  taken_at: ph.taken_at ?? null, created_at: ph.created_at || nowIso() });
        seenPhotos.add(pid + '::' + ph.file);
        photos++;
      } catch { photosFailed++; }
    }

    /* Covers are not carried in the backup — they would treble its size — so
       they come from the catalogue, which is why it has to be synced first.
       This is backfillCovers rather than a fetch of its own: restore used to
       pull only the single main image, leaving the carousel listing pictures
       that had never been downloaded. One implementation, one behaviour. */
    let covers = 0, coversMissing = 0;
    try { covers = await backfillCovers(); } catch { /* recoverable: the next sync retries */ }
    for (const [, pid] of idMap) {
      const row = await idb.get('projects', pid);
      if (row && !onDisk(row.cover)) coversMissing++;
    }

    return {
      added, updated, fieldsChanged, sessions: sessionsAdded, progress: progressAdded,
      skipped: data.projects.length - added - updated,
      photos, photosFailed,
      covers, coversMissing,
      catalogueEmpty: cache.rows.length === 0
    };
  }

  /* Everything the summary page shows, for all time or for one year or month.
     Three different questions live here and they key off three different dates,
     which is stated on each tile rather than hidden: what you FINISHED keys off
     date_completed, what you BOUGHT off the order or delivery date, and time
     spent off the dates of the sessions themselves. Mixing them into one number
     would make a tidier page and a dishonest one. */
  if (p === '/summary') {
    const year = q(url, 'year'), month = q(url, 'month');
    const period = !year ? null : (month ? `${year}-${month}` : String(year));
    const inPeriod = (d) => !period || (typeof d === 'string' && d.startsWith(period));

    const rows = await projects();
    // sessions left behind by projects deleted before they were cleaned up
    const live = new Set(rows.map(r => r.id));
    const sessions = (await idb.all('sessions')).filter(x => live.has(x.project_id));
    const history = (await idb.all('progress')).filter(x => live.has(x.project_id));
    const today = nowIso().slice(0, 10);
    const owned = rows.filter(r => r.status !== 'wishlist');
    const acquired = (r) => r.date_ordered || r.date_received || null;

    /* Each record carries its own scope rather than the page carrying one for
       all of them. "The dearest kit I finished" is not a question anybody asks;
       "the dearest kit I own" is. So money and canvas size are about the stash,
       duration and pace are about what you finished, and the few that are worth
       both ways say so in their own name. */
    const finished = rows.filter(r => r.status === 'completed' && inPeriod(r.date_completed));
    const acquiredInPeriod = owned.filter(r => inPeriod(acquired(r)));
    const scope = period ? acquiredInPeriod : owned;

    const mins = sessions.filter(x => inPeriod(x.on))
                         .reduce((n, x) => n + (Number(x.minutes) || 0), 0);
    const dayset = new Set(sessions.filter(x => inPeriod(x.on) && Number(x.minutes) > 0).map(x => x.on));

    /* The longest run of consecutive days with a session in it. */
    const sorted = [...dayset].sort();
    let streak = 0, run = 0, prev = null;
    for (const d of sorted) {
      const gap = prev ? Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse(prev + 'T00:00:00Z')) / 86400000) : null;
      run = gap === 1 ? run + 1 : 1;
      if (run > streak) streak = run;
      prev = d;
    }

    const span = (a, b) => {
      if (!a || !b) return null;
      const x = Date.parse(a + 'T00:00:00Z'), y = Date.parse(b + 'T00:00:00Z');
      if (!Number.isFinite(x) || !Number.isFinite(y) || y < x) return null;
      return Math.round((y - x) / 86400000);
    };
    const held = (r) => parseHolds(r).reduce((n, hh) =>
      n + (hh && hh.held ? (span(hh.held, hh.restarted || today) || 0) : 0), 0);

    /* A period has to be applied with the date that belongs to the fact. Time
       put down is measured by when it was put down, and time at the board by
       when you sat at it — neither has anything to do with when the kit was
       bought. Scoping those by the order date is how "longest put down" came to
       name one canvas for 2026 and a different one for all time: the real
       record was on a kit bought the year before. */
    const from = !period ? '0000-01-01' : (period.length === 4 ? `${period}-01-01` : `${period}-01`);
    const to = !period ? '9999-12-31' : (period.length === 4 ? `${period}-12-31`
      : new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0))
          .toISOString().slice(0, 10));
    const overlap = (a, b) => {
      const start = a > from ? a : from, end = b < to ? b : to;
      return end < start ? 0 : (span(start, end) || 0);
    };
    /** Days this project spent put down inside the period. */
    const heldIn = (r) => parseHolds(r).reduce((n, hh) =>
      n + (hh && hh.held ? overlap(hh.held, hh.restarted || today) : 0), 0);

    const sessionsIn = sessions.filter(x => inPeriod(x.on));
    const byProjectIn = new Map();
    for (const x of sessionsIn) {
      const e = byProjectIn.get(x.project_id) || { mins: 0, n: 0, longest: 0 };
      e.mins += Number(x.minutes) || 0; e.n++;
      e.longest = Math.max(e.longest, Number(x.minutes) || 0);
      byProjectIn.set(x.project_id, e);
    }
    const timed = rows.filter(r => byProjectIn.has(r.id));
    const worked = (r) => byProjectIn.get(r.id) || { mins: 0, n: 0, longest: 0 };
    const putDown = rows.filter(r => heldIn(r) > 0);

    const area = (r) => (r.width_in && r.height_in) ? r.width_in * r.height_in : null;
    const one = (list, value, pick) => {
      const cand = list.map(r => ({ r, v: value(r) })).filter(x => x.v != null && Number.isFinite(x.v));
      if (!cand.length) return null;
      const best = cand.reduce((a, b) => pick(a.v, b.v) ? a : b);
      return { id: best.r.id, title: best.r.title, value: best.v, shop: best.r.shop || null,
               width_in: best.r.width_in ?? null, height_in: best.r.height_in ?? null,
               currency: best.r.currency || null };
    };
    const most = (list, f) => one(list, f, (a, b) => a >= b);
    const least = (list, f) => one(list, f, (a, b) => a <= b);

    const takenIncl = (r) => span(r.date_started, r.date_completed);
    const takenExcl = (r) => { const t = takenIncl(r); return t == null ? null : Math.max(0, t - held(r)); };
    const everHeld = putDown.length;
    const byProject = (id) => sessions.filter(x => x.project_id === id);

    // diamonds placed: finished canvases, plus part-done ones when nothing is
    // filtering — partial progress carries no date, so it belongs to no month
    const placedAll = Math.round(owned.filter(r => r.status !== 'abandoned').reduce((n, r) =>
      n + (r.status === 'completed' ? (Number(r.drills) || 0)
                                    : (Number(r.drills) || 0) * (Number(r.progress) || 0) / 100), 0));
    /* Diamonds placed inside a period, from the recorded changes: each one
       carries the percentage before and after and the drill count at the time.
       Only work done since progress history existed can be counted, so the page
       says when the record starts rather than quietly reporting a small number
       as though it were the whole story. */
    const changedIn = history.filter(x => inPeriod(x.on));
    const hasHistoryIn = new Set(changedIn.map(x => x.project_id));
    /* A canvas finished in the period counts in full unless its own progress
       was recorded during it, in which case the record is the better answer and
       counting both would count the same diamonds twice. This is what makes the
       figure right for work done before any history existed. */
    const placedIn = Math.round(
      changedIn.reduce((n, x) => n + (Number(x.drills) || 0) * ((x.to - x.from) / 100), 0)
      + finished.filter(r => !hasHistoryIn.has(r.id))
                .reduce((n, r) => n + (Number(r.drills) || 0), 0));
    const historyFrom = history.length
      ? history.map(x => x.on).sort()[0] : null;
    const placed = period ? placedIn : placedAll;
    // everything still waiting to be placed, which is a fact about the stash as
    // it stands rather than about any month, so it is only ever the whole thing
    const remaining = Math.max(0, owned.filter(r => r.status !== 'abandoned')
      .reduce((n, r) => n + (Number(r.drills) || 0), 0) - placedAll);
    /* A project with no order or delivery date belongs to no year, so the years
       never add up to All time. That is honest but invisible, and looks like an
       error — the page says how many are unaccounted for. */
    const undated = owned.filter(r => !acquired(r)).length;

    const allDates = [
      ...rows.flatMap(r => [r.date_completed, r.date_started, acquired(r)]),
      ...sessions.map(x => x.on)
    ].filter(d => typeof d === 'string' && /^\d{4}-\d{2}/.test(d));
    const years = [...new Set(allDates.map(d => d.slice(0, 4)))].sort().reverse();
    // only the months that have something in them — twelve chips where nine are
    // empty is just noise to scroll past
    const months = year
      ? [...new Set(allDates.filter(d => d.startsWith(year + '-')).map(d => d.slice(5, 7)))].sort()
      : [];

    const counted = (list, key) => Object.entries(list.reduce((a, r) => {
      const k = key(r); if (k) a[k] = (a[k] || 0) + 1; return a;
    }, {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || null;

    const bought = acquiredInPeriod;
    const spentPer = bought.filter(r => r.price != null).reduce((a, r) => {
      const c = r.currency || 'GBP';
      a[c] = (a[c] || 0) + (Number(r.price) || 0);
      return a;
    }, {});
    const mainCurrency = Object.entries(spentPer).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const inMainCurrency = (r) => !mainCurrency || (r.currency || 'GBP') === mainCurrency;

    return {
      period: period || null, years, months, mainCurrency,
      currencies: Object.keys(spentPer).length,
      totals: {
        done: period ? finished.length : rows.filter(r => r.status === 'completed').length,
        bought: period ? bought.length : owned.length,
        placed, partial: !period,
        days: dayset.size,
        hours: Math.round(mins / 60 * 10) / 10,
        streak, remaining, undated, historyFrom,
        /* Adding dollars to pounds gives a number that is not money. Grouped by
           currency, the way the figures in Settings already are. */
        // same shape as the figure in Settings, so the two cannot drift apart
        spendBy: Object.values(bought.filter(r => r.price != null).reduce((a, r) => {
          const c = r.currency || 'GBP';
          const e = (a[c] = a[c] || { currency: c, total: 0, n: 0 });
          e.total += Number(r.price) || 0; e.n++;
          return a;
        }, {})).map(v => ({ ...v, total: Math.round(v.total * 100) / 100 }))
          .sort((a, b) => b.total - a.total),
        sessions: sessions.filter(x => inPeriod(x.on)).length,
        everHeld
      },
      // whether the "not counting time put down" figures can differ at all
      heldAmongFinished: finished.filter(r => held(r) > 0).length,
      records: {
        biggestSize: most(scope, area), smallestSize: least(scope, area),
        mostDiamonds: most(scope, r => Number(r.drills) || null),
        fewestDiamonds: least(scope, r => Number(r.drills) || null),
        // the same four again, about the ones you actually finished
        biggestFinished: most(finished, area), smallestFinished: least(finished, area),
        mostDiamondsFinished: most(finished, r => Number(r.drills) || null),
        fewestDiamondsFinished: least(finished, r => Number(r.drills) || null),
        longestDays: most(finished, takenIncl), shortestDays: least(finished, takenIncl),
        longestDaysNet: most(finished, takenExcl), shortestDaysNet: least(finished, takenExcl),
        mostHours: most(timed, r => worked(r).mins / 60 || null),
        fewestHours: least(timed, r => worked(r).mins / 60 || null),
        // diamonds an hour, over canvases you actually finished and timed
        fastest: most(finished, r => (r.hours > 0 && r.drills) ? Math.round(r.drills / r.hours) : null),
        slowest: least(finished, r => (r.hours > 0 && r.drills) ? Math.round(r.drills / r.hours) : null),
        mostSessions: most(timed, r => worked(r).n || null),
        longestSession: most(timed, r => worked(r).longest || null),
        /* Ranked within one currency, because the app has no exchange rates and
           never will offline — comparing a $90 kit with an £80 one would be a
           guess dressed as a fact. The currency chosen is the one you have
           spent the most in; anything bought in another is left out of these
           two, and the page says so. */
        dearest: most(bought.filter(inMainCurrency), r => Number(r.price) || null),
        // what a canvas cost per thousand diamonds — the only honest way to
        // compare a small dear kit with a big cheap one
        bestValue: least(bought.filter(inMainCurrency), r => (r.price > 0 && r.drills > 0)
          ? Math.round(r.price / (r.drills / 1000) * 100) / 100 : null),
        longestHeld: most(putDown, r => heldIn(r) || null)
      },
      favourites: {
        artist: counted(scope, r => r.artist),
        shop: counted(scope, r => r.shop)
      }
    };
  }

  /* Projects added before the app filled in a status's implied dates have no
     order date at all, so they belong to no month and the years never add up.
     Their real order dates are gone; the day each was added to the logbook is
     the closest honest thing left, and it is at least a date you were holding
     the kit in mind. Only ever run deliberately, and only on projects that have
     neither an order nor a delivery date — nothing you typed is touched. */
  if (p === '/projects/backfill-dates' && m === 'POST') {
    const rows = await projects();
    let filled = 0;
    for (const row of rows) {
      if (row.status === 'wishlist') continue;
      if (row.date_ordered || row.date_received) continue;
      const added = String(row.created_at || row.updated_at || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(added)) continue;
      row.date_ordered = added;
      row.updated_at = nowIso();
      await idb.put('projects', row);
      filled++;
    }
    return { filled };
  }

  if (p === '/projects/backfill-dates' && m === 'GET') {
    const rows = await projects();
    return { candidates: rows.filter(r => r.status !== 'wishlist'
      && !r.date_ordered && !r.date_received
      && /^\d{4}-\d{2}-\d{2}$/.test(String(r.created_at || r.updated_at || '').slice(0, 10))).length };
  }

  /* Is this listing already in the logbook? Answered the way the order import
     answers it, so the two agree: the same listing, or failing that the same
     name — a kit typed in by hand has no listing behind it and is still the
     same canvas. A wish list entry counts: that is the row you meant to find. */
  if (p === '/projects/find' && m === 'GET') {
    const shop = q(url, 'shop');
    const handle = q(url, 'handle');
    const title = norm(q(url, 'title') || '');
    const rows = await projects();
    const hit = (handle && rows.find(r => r.dac_handle === handle && (r.shop || 'dac') === (shop || 'dac')))
             || (title && rows.find(r => norm(r.title) === title));
    return hit ? { id: hit.id, title: hit.title, status: hit.status } : { id: null };
  }

  /* Pictures fetched before covers went full width. Offered as a count first so
     Settings can stay quiet when there is nothing to catch up on. */
  /* Worked out from the projects themselves rather than from a box on one
     screen, so it is the same answer on any screen and after any reload — and
     it can say which kits are still waiting, not just how many. */
  if (p === '/projects/upgrade-covers' && m === 'GET') {
    const rows = (await projects()).filter(r => !!r.dac_handle);
    const pending = rows.filter(needsHifi);
    return {
      total: rows.length,
      done: rows.length - pending.length,
      candidates: pending.length,
      pending: pending.map(r => ({ id: r.id, title: r.title })),
      running: [...jobs.values()].find(j => j.kind === 'covers' && j.state === 'running')?.id || null
    };
  }

  if (p === '/projects/upgrade-covers' && m === 'POST') {
    /* Two runs at once would fetch everything twice, so a second ask joins the
       one already going rather than starting another. */
    const live = [...jobs.values()].find(j => j.kind === 'covers' && j.state === 'running');
    if (live) return { job: live.id };
    if (!q(url, 'job')) return { upgraded: await upgradeCovers() };

    const job = newJob('covers-' + Date.now());
    job.kind = 'covers';
    const rows = (await projects()).filter(needsHifi);
    job.total = rows.length;
    (async () => {
      try {
        await upgradeCovers((n, title) => { job.done = n; job.message = title || ''; });
        job.result = { upgraded: job.done };
        job.state = 'done';
      } catch (e) { job.error = e.message; job.state = 'error'; }
    })();
    return { job: job.id };
  }

  if (p === '/stats') {
    const rows = await projects();
    const byArtist = {};
    /* A wish list kit has not been bought, so nothing about it is a fact yet:
       not its price, not its diamonds, not the shop you would have bought it
       from. It stays out of every total. An abandoned one is different — you
       did pay for it, and you did own those diamonds — so it counts towards
       what you have spent, and only out of what is left to place. */
    const bought = rows.filter(r => r.status !== 'wishlist');
    const owned = bought.filter(r => r.status !== 'abandoned');
    const placed = Math.round(owned.reduce((n, r) => n + (r.status === 'completed'
      ? (Number(r.drills) || 0)
      : (Number(r.drills) || 0) * (Number(r.progress) || 0) / 100), 0));
    const sum = (f, list = bought) => list.reduce((n, r) => n + (Number(r[f]) || 0), 0);
    bought.forEach(r => { if (r.artist) byArtist[r.artist] = (byArtist[r.artist] || 0) + 1; });
    return {
      projects: rows.length, wishlist: rows.length - bought.length,
      drills: sum('drills'), hours: sum('hours'), spend: sum('price'),
      completed: rows.filter(r => r.status === 'completed').length,
      placed,
      remaining: Math.max(0, owned.reduce((n, r) => n + (Number(r.drills) || 0), 0) - placed),
      estimatedCounts: rows.filter(r => r.drills_estimated).length,
      byStatus: Object.entries(rows.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {}))
                      .map(([status, n]) => ({ status, n })),
      topArtists: Object.entries(byArtist).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                        .slice(0, 8).map(([artist, n]) => ({ artist, n })),
      topShops: Object.values(bought.reduce((a, r) => {
        const k = r.brand || r.source || r.shop || 'Unknown';
        a[k] = a[k] || { shop: k, n: 0, spend: 0 };
        a[k].n++; a[k].spend += Number(r.price) || 0;
        return a;
      }, {})).map(v => ({ ...v, spend: Math.round(v.spend * 100) / 100 }))
        .sort((a, b) => b.n - a.n || b.spend - a.spend).slice(0, 8),
      spendBy: Object.entries(bought.filter(r => r.price != null).reduce((a, r) => {
        const c = r.currency || 'GBP';
        a[c] = a[c] || { currency: c, total: 0, n: 0 };
        a[c].total += Number(r.price) || 0; a[c].n++;
        return a;
      }, {})).map(([, v]) => ({ ...v, total: Math.round(v.total * 100) / 100 }))
        .sort((a, b) => b.total - a.total)
    };
  }

  if (p === '/export') {
    const rows = await projects();
    const cols = Object.keys(rows[0] || { id: 1 });
    const esc = (v) => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
    return { __csv: [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') };
  }

  throw Object.assign(new Error('Unknown endpoint ' + p), { status: 404 });
}


