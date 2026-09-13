import { api, isStandalone } from './api.js';
import { statusFromDates, applyStatus, parseHolds, openHold, heldDays,
         ALL_STATUSES } from './core/status.js';
import { productUrl, shopById, displayCurrency, SHOPS, CURRENCIES } from './core/shops.js';
const SHOP_BY_NAME = Object.fromEntries(SHOPS.map((s) => [s.name, s]));
/* Dazzle Diary — the whole client. Vanilla; no build step. */

const $app = document.getElementById('app');

/* Tablet mode is two panes, not a wider column: the logbook stays on the left
   while a project, a form or the settings open beside it. Everything still
   renders through the same routes — they just paint into $out, which is the
   whole shell on a phone and the right-hand pane on a tablet. $list is where
   the logbook goes, which on a tablet is the left pane and never moves. */
const TWO_PANE = '(min-width: 900px)';
const twoPane = () => !!(window.matchMedia && window.matchMedia(TWO_PANE).matches);
let $list = $app, $out = $app;

function setupPanes() {
  const two = twoPane();
  const already = !!document.getElementById('side');
  if (two && !already) $app.innerHTML = '<aside id="side"></aside><main id="main"></main>';
  if (!two && already) $app.innerHTML = '';
  if (two) $app.classList.add('two-pane'); else $app.classList.remove('two-pane');
  $list = two ? document.getElementById('side') : $app;
  $out = two ? document.getElementById('main') : $app;
  return two;
}
window.__logbookReady = true;

/* --------------------------------------------------------------- theme */
const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
function applyTheme(mode) {
  const root = document.documentElement;
  if (!root) return;
  // resolve "system" ourselves rather than trusting the media query
  root.setAttribute('data-theme', mode === 'system' ? (systemIsDark() ? 'dark' : 'light') : mode);
  const dark = mode === 'dark' || (mode === 'system' && systemIsDark());
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#2a2320' : '#fbf9f5');
  // the phone's own status and navigation bars are part of the app surface
  try { window.LogbookNative?.setBarColor?.(dark); } catch {}
}
/* Android's WebView does not follow the system theme on its own —
 * prefers-color-scheme stays "light" however the phone is set — so the shell
 * tells us, and matchMedia is the fallback for a normal browser. */
function systemIsDark() {
  try {
    const n = window.LogbookNative;
    if (n && typeof n.isSystemDark === 'function') return !!n.isSystemDark();
  } catch {}
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
const themeMode = () => localStorage.getItem('theme') || 'system';
applyTheme(themeMode());
window.__logbookThemeChanged = () => { if (themeMode() === 'system') applyTheme('system'); };
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', window.__logbookThemeChanged);
}

/* ------------------------------------------------------------------ utils */
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sized = (url, w) => {
  try { const u = new URL(url); u.searchParams.set('width', String(w)); return u.toString(); }
  catch { return url; }
};
const bigNum = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 1 : 2) + 'M';
  if (v >= 10000) return Math.round(v / 1000) + 'k';
  return v.toLocaleString('en-GB');
};
const num = (n) => n == null || n === '' ? '—' : Number(n).toLocaleString('en-GB');
const SYMBOL = { GBP: '£', USD: '$', EUR: '€', CAD: 'CA$', AUD: 'A$', NZD: 'NZ$' };
const money = (n, c) => n == null || n === '' ? '—'
  : (SYMBOL[c || S.prefs.currency] || ((c || '') + ' ')) + Number(n).toFixed(2);
const cm = (inches) => inches == null ? null : Math.round(inches * 2.54 * 100) / 100;
const sizeText = (p) => p.width_in == null || p.height_in == null ? '—'
  : `${cm(p.width_in)} × ${cm(p.height_in)} cm`;
const dateText = (s) => {
  if (!s) return null;
  const d = new Date(s + (s.length === 10 ? 'T12:00:00' : ''));
  return isNaN(d) ? s : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const today = () => new Date().toISOString().slice(0, 10);

const PRICE_SOURCE = {
  order:     ['what you paid',        'the only kit in its order'],
  allocated: ['share of the order',   'order total split across its kits by list price'],
  catalogue: ['list price today',     'the order also held accessories, so the split is unknowable'],
  receipt:   ['from the receipt',   'the exact figure from the shop’s emailed receipt'],
  you:       ['your figure',          null]
};

const STATUS = {
  wishlist:    { label: 'Wish list', short: 'Wish list' },
  notReceived: { label: 'Not received', short: 'Not received' },
  received:    { label: 'Received, not started', short: 'Received' },
  started:     { label: 'Started', short: 'Started' },
  onHold:      { label: 'On hold', short: 'On hold' },
  completed:   { label: 'Completed', short: 'Completed' },
  abandoned:   { label: 'Abandoned', short: 'Abandoned' }
};
// what you are working on first, what you are not going to finish last
const ORDER = ['started', 'onHold', 'received', 'notReceived', 'wishlist', 'completed', 'abandoned'];
/* A status that is not one of the seven — an import that went wrong, a restore
   from an older file — used to take the whole project page down with
   "cannot read properties of undefined". A missing status is worth showing
   badly, not worth a blank screen. */
const statusOf = (k) => STATUS[k] || { label: k ? String(k) : 'No status', short: k ? String(k) : 'No status' };
const stVar = (s) => `var(--st-${STATUS[s] ? s : 'notReceived'})`;
const stDot = (s) => `var(--st-${STATUS[s] ? s : 'notReceived'}-dot)`;

const ICON = {
  back: '<path d="M15 5l-7 7 7 7"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  star: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/>',
  sync: '<path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01"/><path d="M20.5 4.2v4.6h-4.6"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  list: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  edit: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z"/>',
  camera: '<path d="M4 8.5h3l1.5-2.5h7L17 8.5h3v11H4z"/><circle cx="12" cy="14" r="3.4"/>',
  date: '<rect x="3.5" y="5.5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/>',
  imp: '<path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5"/><path d="M4 14v4.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V14"/>',
  // a toothed gear. the old one was a circle with eight rays, which is the
  // universal icon for "light mode" — no wonder it read as the wrong control
  cog: '<circle cx="12" cy="12" r="3"/><path d="M19.1 14.4a1.5 1.5 0 0 0 .3 1.65l.05.05a1.8 1.8 0 1 1-2.55 2.55l-.05-.05a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.9 1.37V20a1.8 1.8 0 1 1-3.6 0v-.1a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.05.05A1.8 1.8 0 1 1 4.47 16.1l.05-.05a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.9H3.3a1.8 1.8 0 1 1 0-3.6h.1a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65l-.05-.05A1.8 1.8 0 1 1 7 4.67l.05.05a1.5 1.5 0 0 0 1.65.3h.07a1.5 1.5 0 0 0 .9-1.37V3.5a1.8 1.8 0 1 1 3.6 0v.1a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.65-.3l.05-.05a1.8 1.8 0 1 1 2.55 2.55l-.05.05a1.5 1.5 0 0 0-.3 1.65v.07a1.5 1.5 0 0 0 1.37.9h.1a1.8 1.8 0 1 1 0 3.6h-.1a1.5 1.5 0 0 0-1.37.9z"/>',
  tick: '<path d="M4 12.5l5.5 5.5L20 7"/>', info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.2v.1"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  filter: '<path d="M4 6.5h6M14 6.5h6M4 17.5h10M18 17.5h2M4 12h2M10 12h10"/>'
         + '<circle cx="12" cy="6.5" r="2.2"/><circle cx="8" cy="12" r="2.2"/><circle cx="16" cy="17.5" r="2.2"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
  link: '<path d="M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.7 1.7"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.7-1.7"/>',
  gem: '<path d="M6 3h12l4 6-10 12L2 9l4-6z"/><path d="M2 9h20M9 3l-3 6 6 12M15 3l3 6-6 12"/>'
};
/* Every icon is drawn as an outline, which is right for all of them except a
   star: an unfilled star does not read as "chosen". This one takes its fill
   from the colour it is given, so CSS decides. */
const star = (size = 24) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="var(--star-fill, none)"
     stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">${ICON.star}</svg>`;

const svg = (name, size = 20, sw = 1.7) => {
  // an unknown name used to render a silently empty box — a blank gap in the UI
  if (!ICON[name]) console.warn('missing icon:', name);
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICON[name] || ''}</svg>`;
};


/* A progress photo shown at the size of a fingernail is not much use, so a tap
   opens it over the page. Escape, the phone's Back button and a tap anywhere
   all close it — Back because that is what closing a full-screen thing means
   on Android, and it must not also pop the route underneath. */
/* One viewer for every picture a project has: the listing's photographs and
   your own progress shots in one strip. Tapping any of them opens here, and
   swiping moves through the lot — which is what anyone who has used a phone
   expects, and what having two separate half-viewers did not do.

   The swipe is CSS scroll-snap rather than a gesture handler: the platform
   already knows how to fling a strip of images with momentum, and every
   hand-written version of that is worse. */
function lightbox(items, startIndex = 0) {
  const list = (Array.isArray(items) ? items : [{ src: items }]).filter((x) => x && x.src);
  if (!list.length) return;
  let index = Math.min(Math.max(0, startIndex), list.length - 1);

  const el = document.createElement('div');
  el.className = 'lightbox';
  el.innerHTML = `
    <div class="lb-strip" id="lbstrip">
      ${list.map((it) => `<div class="lb-slide"><img src="${h(it.src)}" alt=""
         referrerpolicy="no-referrer" draggable="false"></div>`).join('')}
    </div>
    <button class="x" aria-label="Close">${svg('close', 18, 2.4)}</button>
    ${list.length > 1 ? `<div class="lb-count" id="lbcount"></div>` : ''}
    <div class="lightbox-bar" id="lbbar"></div>`;

  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    el.remove();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('popstate', onPop);
    if (history.state && history.state.lightbox) history.back();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') return close();
    if (e.key === 'ArrowRight') return goTo(index + 1);
    if (e.key === 'ArrowLeft') return goTo(index - 1);
  };
  const onPop = () => { open = false; el.remove(); document.removeEventListener('keydown', onKey); };

  const strip = () => el.querySelector('#lbstrip');
  const goTo = (i) => {
    const n = Math.min(Math.max(0, i), list.length - 1);
    const s = strip();
    if (s) s.scrollTo({ left: s.clientWidth * n, behavior: 'smooth' });
    paint(n);
  };
  function paint(i) {
    index = i;
    const count = el.querySelector('#lbcount');
    if (count) count.textContent = `${i + 1} / ${list.length}`;
    const bar = el.querySelector('#lbbar');
    if (!bar) return;
    const it = list[i];
    // only your own photograph can become the cover; the shop's already is one
    const canShare = typeof window.LogbookNative?.sharePhoto === 'function';
    bar.innerHTML = (it && it.kind === 'photo' && it.projectId)
      ? `<button class="btn primary" data-act="setcover" data-id="${it.projectId}"
           data-file="${h(it.file)}">Use as cover</button>${
         canShare ? `<button class="btn ghost" data-act="sharephoto"
           data-file="${h(it.file)}" data-title="${h(it.title || '')}">Share</button>` : ''}` : '';
  }

  // a tap on the backdrop closes; a tap on a picture does not, or a swipe that
  // ends on one would shut the viewer instead of moving it
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-act]')) return;
    if (e.target.closest('.lb-slide') && (list.length > 1 || el.classList.contains('has-zoom'))) return;
    close();
  });
  el._close = close;
  document.addEventListener('keydown', onKey);
  window.addEventListener('popstate', onPop);
  history.pushState({ lightbox: true }, '');
  document.body.appendChild(el);

  /* Double tap zooms, which is the gesture everyone already has. The zoomed
     slide simply becomes scrollable and the image larger than it, so panning is
     the platform's own scrolling rather than arithmetic on touch points. */
  /* Pinch. The WebView's own page zoom is off — the app is a fixed layout, not
     a document — so two fingers on a picture have to be handled here: track the
     distance between them, scale the image by how much it changes, and let a
     one-finger drag move it while it is bigger than the frame. Anything under a
     small movement is ignored, or a slightly uneven two-finger tap jumps. */
  let pinch = null, panFrom = null;
  const slideAt = (i) => el.querySelectorAll('.lb-slide')[i];
  const scaleOf = (slide) => Number(slide?.dataset.scale || 1);
  const applyScale = (slide, scale, ox, oy) => {
    const img = slide.querySelector('img');
    if (!img) return;
    const clamped = Math.min(6, Math.max(1, scale));
    slide.dataset.scale = String(clamped);
    const x = clamped === 1 ? 0 : (ox ?? Number(slide.dataset.ox || 0));
    const y = clamped === 1 ? 0 : (oy ?? Number(slide.dataset.oy || 0));
    slide.dataset.ox = String(x); slide.dataset.oy = String(y);
    img.style.transform = `translate(${x}px, ${y}px) scale(${clamped})`;
    if (clamped > 1) { slide.classList.add('zoomed'); el.classList.add('has-zoom'); }
    else { slide.classList.remove('zoomed'); if (!el.querySelector('.lb-slide.zoomed')) el.classList.remove('has-zoom'); }
  };
  const gap = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  el.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches.length === 2) {
      pinch = { from: gap(e.touches), scale: scaleOf(slideAt(index)) };
      panFrom = null;
    } else if (e.touches && e.touches.length === 1 && scaleOf(slideAt(index)) > 1) {
      const t = e.touches[0];
      const slide = slideAt(index);
      panFrom = { x: t.clientX, y: t.clientY,
                  ox: Number(slide.dataset.ox || 0), oy: Number(slide.dataset.oy || 0) };
    }
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    const slide = slideAt(index);
    if (!slide) return;
    if (pinch && e.touches && e.touches.length === 2) {
      e.preventDefault();
      applyScale(slide, pinch.scale * (gap(e.touches) / (pinch.from || 1)));
    } else if (panFrom && e.touches && e.touches.length === 1) {
      e.preventDefault();
      const t = e.touches[0];
      applyScale(slide, scaleOf(slide),
                 panFrom.ox + (t.clientX - panFrom.x), panFrom.oy + (t.clientY - panFrom.y));
    }
  }, { passive: false });

  el.addEventListener('touchend', (e) => {
    if (!e.touches || e.touches.length === 0) { pinch = null; panFrom = null; }
    const slide = slideAt(index);
    // a nudge below a tenth is a wobble, not a pinch: settle back to fitting
    if (slide && scaleOf(slide) < 1.1) applyScale(slide, 1);
  }, { passive: true });

  let lastTap = 0;
  el.addEventListener('click', (e) => {
    const slide = e.target.closest && e.target.closest('.lb-slide');
    if (!slide || e.target.closest('[data-act]')) return;
    const now = Date.now();
    const quick = now - lastTap < 320;
    // a completed double tap ends the sequence: without this a third tap pairs
    // with the second and toggles straight back
    lastTap = quick ? 0 : now;
    if (!quick) return;
    applyScale(slide, scaleOf(slide) > 1 ? 1 : 2.5, 0, 0);
  });

  const s = strip();
  if (s) {
    s.scrollLeft = s.clientWidth * index;
    s.addEventListener('scroll', () => {
      const i = Math.round(s.scrollLeft / Math.max(1, s.clientWidth));
      if (i !== index) paint(i);
    }, { passive: true });
  }
  paint(index);
}


/* Phone cameras produce 7–12 MB frames. A progress photo is looked at on a
 * phone screen, so 1600px at q0.82 is indistinguishable and ~40x smaller —
 * which is the difference between a 12 MB backup and a 500 MB one. */
async function downscale(file, maxEdge = 1600, quality = 0.82) {
  if (!file || !/^image\//.test(file.type || '')) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 900 * 1024) { bitmap.close?.(); return file; }
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', quality));
    return blob && blob.size < file.size ? blob : file;
  } catch { return file; }        // unreadable image: send it as-is
}

/* Android's WebView ignores downloads entirely unless the app installs a
 * DownloadListener — and it cannot handle blob: URLs even then. So hand the
 * bytes to the shell, which writes them to the real Downloads folder. A plain
 * browser still gets the <a download> path. */
async function saveToPhone(filename, blob) {
  const n = window.LogbookNative;
  if (n && typeof n.saveDownload === 'function') {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    const where = n.saveDownload(filename, btoa(bin), blob.type || 'application/octet-stream');
    if (where) return where;
    throw new Error('Could not write to Downloads');
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  return 'your Downloads folder';
}

let toastTimer;
function toast(msg, action = null) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast' + (action ? ' with-action' : '');
  t.innerHTML = `<span>${h(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => { t.remove(); clearTimeout(toastTimer); action.run(); };
    t.appendChild(b);
  }
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), action ? (action.ms || 6000) : 2600);
  return t;
}

/* Android asks afterwards, not before: the thing happens and an Undo sits in
   the corner for a few seconds. A modal "are you sure?" on every deletion is
   both more interruption and less safety, because the answer becomes reflex.
   Nothing is actually deleted until the offer expires. */
const pendingDeletes = new Set();
function deleteLater(key, seconds, commit) {
  pendingDeletes.add(key);
  const timer = setTimeout(async () => {
    if (!pendingDeletes.has(key)) return;
    pendingDeletes.delete(key);
    try { await commit(); } catch (e) { toast(e.message); }
    render();
  }, seconds * 1000);
  return () => { clearTimeout(timer); pendingDeletes.delete(key); render(); };
}

/* ------------------------------------------------------------------ state */
const S = {
  view: localStorage.getItem('view') || 'grid',
  filter: 'all',
  q: '',
  // the logbook's own filters, beside the status chips and the search box
  lb: { shop: null, shape: null, size: null, rating: 0, sort: 'recent', open: false, gaps: null },
  projects: [],
  meta: null,
  importPreview: null,
  fromCatalogue: null,
  chooserFor: null,
  chooserHits: [],
  prefs: { currency: 'GBP', excluded: [], hints: {} },
  timer: null,                       // a running session, if there is one
  statusFor: null,                   // the project whose status menu is open
  gallery: null,                     // every picture the open project has
  browse: { q: '', shop: null, items: [], offset: 0, more: true, loading: false,
             shape: null, size: null, maxPrice: null, inStock: false, sort: 'relevance',
             scroll: 0, open: false, loaded: false },
  facets: null,
  importSel: new Set(),
  importTab: 'new',
  importShop: 'dac'
};

/* --------------------------------------------------------------- fragments */
const thumb = (p, cls = '') => {
  const src = p.cover ? `/covers/${encodeURIComponent(p.cover)}` : null;
  return `<div class="thumb ${cls}" style="background:${stVar(p.status)}">${
    src ? `<img src="${h(src)}" alt="" loading="lazy">` : ''}</div>`;
};

const card = (p) => `
  <button class="card" data-go="#/p/${p.id}" data-id="${p.id}" data-status="${p.status}"${
    p.shop ? ` data-shop="${h(p.shop)}"` : ''}>
    ${thumb(p)}
    <div class="body">
      <span class="name">${h(p.title)}</span>
      <span class="who" style="display:flex;align-items:center;gap:6px">
        ${p.shop ? `<span class="pip" data-shop="${h(p.shop)}"></span>` : ''}
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${
          h(p.artist || (shopById(p.shop) || {}).name || '')}</span>
      </span>
      <div class="tags">
        ${p.shop && shopById(p.shop) ? `<span class="tag shop-tag" data-shop="${h(p.shop)}">${
          h(shopById(p.shop).name)}</span>` : ''}
        <span class="tag tnum">${h(sizeText(p))}</span>
        ${p.shape ? `<span class="tag">${h(p.shape)}</span>` : ''}
      </div>
      <div class="facts tnum">
        ${p.drills ? `<span>${p.drills_estimated ? '≈' : ''}${num(p.drills)} drills</span>` : ''}
        ${p.colors ? `<span>${num(p.colors)} colours</span>` : ''}
      </div>
      ${p.status === 'started' ? `<div class="bar"><i style="width:${p.progress || 0}%"></i></div>` : ''}
    </div>
  </button>`;

/* `back` unwinds a history entry; `backAct` runs an action instead, for the
   screens that live at the same hash as the one behind them. */
const topbar = (title, { back = null, backAct = null, right = '', sub = false } = {}) => `
  <div class="titlerow${sub ? ' sub' : ''}">
    ${back || backAct
      ? `<button class="iconbtn flush-l" ${backAct ? `data-act="${backAct}"` : `data-back="${back}"`} aria-label="Back">${svg('back', 20, 2)}</button>`
      : ''}
    <h1>${h(title)}</h1>${right}
  </div>`;

/* ------------------------------------------------------------------ router */
const routes = [];
const route = (re, fn) => routes.push([re, fn]);

/* Navigation behaves like an app, not a browser.
 *   go()      goes deeper and adds a history entry
 *   back()    returns to where you came from, unwinding that entry
 *   swap()    replaces the current screen without adding one, so a form you
 *             have finished with never sits in the back stack
 * Without this, saving pushed ANOTHER copy of the project screen on top of the
 * one you started from, and back walked through the duplicates. */
let depth = 0;
const go = (hash) => { depth++; location.hash = hash; };
const swap = (hash) => {
  if (('#' + String(hash).replace(/^#/, '')) === location.hash) { render(); return; }
  history.replaceState(null, '', hash);
  render();
};
const back = (fallback = '#/') => {
  if (depth > 0) { depth--; history.back(); }
  else swap(fallback);
};

/* Where you were on each screen. Opening a project and coming back put you at
   the top of the logbook every time, which on a list of 76 is the difference
   between glancing at something and losing your place. Keyed by route, so a
   project you return to also opens where you left it, and one you have never
   opened still starts at the top. The logbook keeps its own place under "#/"
   whichever pane it is in. */
const scrollMem = new Map();
let painted = null;
const scrollerOf = (root) => root && root.querySelector ? root.querySelector('.scroll') : null;

function rememberScroll() {
  if ($list && $list !== $out) {
    const s = scrollerOf($list);
    if (s) scrollMem.set('#/', s.scrollTop);
  }
  if (painted) {
    const s = scrollerOf($out);
    if (s) scrollMem.set(painted, s.scrollTop);
  }
}

function restoreScroll(hash) {
  const put = () => {
    if ($list && $list !== $out) {
      const s = scrollerOf($list);
      if (s) s.scrollTop = scrollMem.get('#/') || 0;
    }
    const s = scrollerOf($out);
    if (s) s.scrollTop = scrollMem.get(hash) || 0;
  };
  /* Twice: once now, and once after the frame in which lazily-sized things —
     pictures, a grid that has just been handed its rows — settle, or the list
     is still short when the position is set and it lands at the bottom. */
  put();
  requestAnimationFrame(() => { put(); requestAnimationFrame(put); });
}

/** Start this screen at the top next time — filters changed, so the old place means nothing. */
const forgetScroll = (hash) => scrollMem.delete(hash);

async function render() {
  const hash = location.hash || '#/';
  rememberScroll();

  // a catalogue pick belongs to the form it was picked for, and to nothing else
  if (!/^#\/new/.test(hash)) S.fromCatalogue = null;

  /* A file you have chosen but not imported belongs to the import screen. Left
     behind, it meant Import reopened onto a review of a file you had already
     walked away from, with no way back to the picker. */
  if (!/^#\/import$/.test(hash)) forgetImport();

  /* Leaving the form — by the back arrow, Cancel, or the phone's own Back —
     asks first if anything was typed. Saying "keep editing" puts the form back
     with what was typed still in it, which is the only version of this that is
     any use. */
  if (editing && hash !== editing.hash) {
    if (formIsDirty() && !confirm('Discard your changes?')) {
      restoreForm = readForm();
      location.hash = editing.hash;
      return;
    }
    editing = null;
  }

  const two = setupPanes();

  /* On a tablet the logbook is always there on the left, whatever is open on
     the right — that is the whole point of the mode. */
  if (two) {
    try { await loadLogbook(); } catch { /* the right pane still works */ }
    if (hash === '#/' || hash === '') {
      $out.innerHTML = `<div class="screen reading"><div class="scroll pad"><div class="empty">
        ${svg('gem', 40, 1.3)}<h2>Pick a project</h2>
        <p>Or add one from the catalogue.</p>
        <button class="btn primary" data-go="#/browse">${svg('search', 18)} Add from catalogue</button>
      </div></div></div>`;
      window.scrollTo(0, 0);
      painted = hash;
      restoreScroll(hash);
      return;
    }
  }

  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try { await fn(...m.slice(1)); }
      catch (e) { $out.innerHTML = `<div class="screen reading"><div class="scroll pad"><div class="empty">
        <h2>Something went wrong</h2><p>${h(e.message)}</p>
        <button class="btn ghost" data-go="#/">Back to the logbook</button></div></div></div>`; }
      window.scrollTo(0, 0);
      painted = hash;
      restoreScroll(hash);
      return;
    }
  }
  go('#/');
}

/* ==================================================================== #/ */
async function loadLogbook() {
  const [projects, meta] = await Promise.all([api('/projects'), api('/state')]);
  S.projects = projects; S.meta = meta;
  paintLogbook();
}
route(/^#\/$/, loadLogbook);

/* Hold periods and sessions are different things — one is when you were not
   working, kept in step with the status; the other is when you were, and is
   typed in. On screen they are the same shape, so they are drawn by one
   function: a list of spans, each with a length and a way to remove it. */
function spanList(rows, { total, empty, act, id }) {
  if (!rows.length) return `<div class="panel pad-in"><div class="row"><span class="k">${h(empty)}</span></div></div>`;
  return `<div class="panel pad-in">
    ${rows.map((r) => `<div class="row">
      <span class="k">${h(r.left)}</span>
      <span class="v tnum" style="display:flex;align-items:center;gap:10px">${h(r.right)}
        <button class="iconbtn" style="width:28px;height:28px;color:var(--ink-mute)"
                data-act="${act}" data-id="${id}" data-k="${h(r.key)}"
                aria-label="Remove">${svg('trash', 15)}</button></span></div>`).join('')}
    ${total ? `<div class="row"><span class="k" style="font-weight:700;color:var(--ink)">${h(total[0])}</span>
      <span class="v tnum">${h(total[1])}</span></div>` : ''}
  </div>`;
}

/** "45m", "2h 30m" — the way anyone says how long they sat at a canvas. */
function minsText(m) {
  const n = Math.max(0, Math.round(Number(m) || 0));
  if (n < 60) return `${n}m`;
  const hrs = Math.floor(n / 60), rest = n % 60;
  return rest ? `${hrs}h ${rest}m` : `${hrs}h`;
}

/** "9 days", "3 weeks", "2 months" — a hold is read at a glance, not audited. */
function daysText(from, to, precomputed) {
  const n = precomputed != null ? precomputed
    : Math.max(0, Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000));
  if (!Number.isFinite(n)) return '—';
  if (n < 1) return 'same day';
  if (n < 14) return `${n} day${n === 1 ? '' : 's'}`;
  if (n < 60) return `${Math.round(n / 7)} weeks`;
  return `${Math.round(n / 30.4)} months`;
}

/* Leaving a long form by accident loses everything typed into it, so the form
   remembers what it looked like when it opened and compares before it goes.
   Every value the save would send is included, or a change to one of them
   would slip past unnoticed. */
const FORM_FIELDS = ['title', 'artist', 'special', 'brand', 'source', 'width_in', 'height_in',
  'colors', 'drills', 'price', 'shipping', 'tax', 'sold_price', 'progress', 'notes', 'shop',
  'date_ordered', 'date_received', 'date_started', 'date_completed'];
const FORM_SEGS = ['status', 'shape', 'coverage', 'currency'];

function readForm() {
  const out = {};
  for (const id of FORM_FIELDS) {
    const el = document.getElementById(id);
    if (el) out[id] = String(el.value ?? '');
  }
  for (const g of FORM_SEGS) {
    const b = document.querySelector(`#${g} .opt[aria-pressed="true"]`);
    out[g] = b ? b.dataset.k : '';
  }
  out.rating = document.getElementById('rating')?.dataset.v ?? '';
  const t = document.getElementById('title');
  out.__handle = t?.dataset.handle ?? '';
  out.__holds = t?.dataset.holds ?? '';
  return out;
}

function applyForm(vals) {
  if (!vals) return;
  for (const id of FORM_FIELDS) {
    const el = document.getElementById(id);
    if (el && vals[id] !== undefined) el.value = vals[id];
  }
  for (const g of FORM_SEGS) {
    document.querySelectorAll(`#${g} .opt`).forEach((o) =>
      o.setAttribute('aria-pressed', o.dataset.k === vals[g]));
  }
  const stars = document.getElementById('rating');
  if (stars && vals.rating !== undefined) {
    stars.dataset.v = vals.rating;
    stars.querySelectorAll('button[data-k]').forEach((x) =>
      x.setAttribute('aria-pressed', Number(x.dataset.k) > 0 && Number(x.dataset.k) <= Number(vals.rating || 0)));
  }
  const t = document.getElementById('title');
  if (t) { t.dataset.handle = vals.__handle ?? ''; t.dataset.holds = vals.__holds ?? ''; }
}

/* The form being edited, if any: where it lives, what it looked like when it
   opened, and anything typed into it that has to survive "keep editing". */
let editing = null;
let restoreForm = null;

const formIsDirty = () => {
  if (!editing) return false;
  const now = readForm();
  return Object.keys(now).some((k) => now[k] !== editing.opened[k]);
};

/* Pulling a list down to refresh it is the one gesture everybody has, and the
   catalogues were only refreshable from a button in Settings. The pull only
   starts at the top of the list, so it never fights with scrolling, and the
   touchmove is non-passive because preventing the overscroll is the whole
   point — the same lesson as the drag. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The gesture is watched on the whole screen, not just on the list. On the
   catalogue the search box, six shop chips and the filter button fill the top
   of the screen, so the most natural place to start a pull is not inside the
   scroller at all — which is why pulling the catalogue down appeared to do
   nothing. What is scrolled is still the list, and the pull still only starts
   when the list is at its top. */
function wirePull(surface, scroller = surface) {
  if (!surface || surface._pullWired) return;
  surface._pullWired = true;
  const scroll = scroller;
  const THRESHOLD = 110;
  let startY = null, pulled = 0, busy = false;

  const box = () => document.getElementById('pull');
  const label = () => document.getElementById('pulltext');
  const show = (px, text) => {
    const b = box(), t = label();
    if (b) b.style.height = Math.round(px) + 'px';
    if (t) t.textContent = text;
  };

  surface.addEventListener('touchstart', (e) => {
    if (busy || scroll.scrollTop > 0 || !e.touches || e.touches.length !== 1) { startY = null; return; }
    // dragging a slider or a text field is not a pull
    if (e.target.closest && e.target.closest('input, textarea, select')) { startY = null; return; }
    startY = e.touches[0].clientY;
    pulled = 0;
  }, { passive: true });

  surface.addEventListener('touchmove', (e) => {
    if (startY == null || busy) return;
    pulled = e.touches[0].clientY - startY;
    if (pulled <= 0) { show(0, ''); return; }
    e.preventDefault();
    show(Math.min(72, pulled * 0.5), pulled > THRESHOLD ? 'Release to update' : 'Pull to update');
  }, { passive: false });

  const finish = async () => {
    const enough = pulled > THRESHOLD;
    startY = null; pulled = 0;
    if (!enough || busy) { show(0, ''); return; }
    busy = true;
    show(44, 'Updating\u2026');
    try {
      const { job } = await api('/catalogue/sync', { method: 'POST' });
      for (let i = 0; i < 6000; i++) {
        const j = await api('/jobs/' + job);
        if (j.state !== 'running') break;
        if (j.message) show(44, j.message);
        await sleep(250);
      }
      S.meta = await api('/state');
      toast('Catalogues updated');
    } catch (err) {
      toast(err.message);
    } finally {
      busy = false;
      show(0, '');
      render();
    }
  };
  surface.addEventListener('touchend', finish, { passive: true });
  surface.addEventListener('touchcancel', () => { startY = null; pulled = 0; show(0, ''); }, { passive: true });
}

/* One swipeable strip, used by the project page and by the form. The dots were
   painted but never wired: nothing moved them as the strip scrolled, and the
   project page had no handler for tapping one at all — so a gallery that did
   swipe still looked frozen, and one that did not looked the same as one that
   did. */
function wireShots(strip) {
  if (!strip || strip._shotsWired) return;
  strip._shotsWired = true;
  const owner = strip.parentElement;
  const mark = () => {
    const i = Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth));
    const d = owner?.querySelector('.dots');
    if (d) [...d.children].forEach((b, n) => b.setAttribute('aria-current', String(n === i)));
    // the blurred backdrop follows the picture that is showing, or a portrait
    // canvas ends up sitting on the wrong colour
    const wash = owner?.querySelector('.wash'), img = strip.children[i];
    if (wash && img) wash.style.backgroundImage = `url('${img.getAttribute('src')}')`;
  };
  strip.addEventListener('scroll', mark, { passive: true });
  mark();
}

/** Tapping a dot moves the strip it belongs to, whichever strip that is. */
function goToShot(button) {
  const strip = button.closest('.hero, .formshot')?.querySelector('.shots');
  if (!strip) return;
  strip.scrollTo({ left: strip.clientWidth * Number(button.dataset.i || 0), behavior: 'smooth' });
}

async function seenHint(k) {
  S.prefs.hints = { ...(S.prefs.hints || {}), [k]: true };
  try {
    await api('/prefs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ hints: { [k]: true } }) });
  } catch { /* it is a hint; showing it once more is not worth an error */ }
}

/* What the logbook is showing, worked out once. Both paints used to compute
   this for themselves and had already drifted apart — the full paint kept empty
   sections and the body-only paint did not. */
const LB_SORTS = [
  { k: 'recent', label: 'Recently added' }, { k: 'name', label: 'A\u2013Z' },
  { k: 'progress', label: 'Furthest on' }, { k: 'rating', label: 'Best rated' },
  { k: 'size', label: 'Biggest' }, { k: 'drills', label: 'Most drills' }
];
const LB_SORT = {
  recent: (a, b) => b.id - a.id,
  name: (a, b) => a.title.localeCompare(b.title),
  progress: (a, b) => (b.progress || 0) - (a.progress || 0),
  rating: (a, b) => (b.rating || 0) - (a.rating || 0) || a.title.localeCompare(b.title),
  size: (a, b) => ((b.width_in || 0) * (b.height_in || 0)) - ((a.width_in || 0) * (a.height_in || 0)),
  drills: (a, b) => (b.drills || 0) - (a.drills || 0)
};
const RATINGS = [{ k: 0, label: 'Any' }, { k: 3, label: '3+' }, { k: 4, label: '4+' }, { k: 5, label: '5' }];

/** How many of the extra filters are on — for the badge, and for "Clear all". */
const lbActive = () => {
  const f = S.lb;
  return (f.shop ? 1 : 0) + (f.shape ? 1 : 0) + (f.size ? 1 : 0)
       + (f.rating ? 1 : 0) + (f.gaps ? 1 : 0) + (f.sort !== 'recent' ? 1 : 0);
};

/* What a project is missing. A logbook built over months has gaps in it, and
   until now the only way to find them was to open everything: a project with no
   order date belongs to no month and quietly falls out of every year. */
const GAPS = [
  { k: 'dates', label: 'No dates',
    has: (p) => p.status !== 'wishlist' && !p.date_ordered && !p.date_received },
  { k: 'price', label: 'No price', has: (p) => p.status !== 'wishlist' && p.price == null },
  { k: 'drills', label: 'No diamond count', has: (p) => !p.drills },
  { k: 'size', label: 'No canvas size', has: (p) => !p.width_in || !p.height_in },
  { k: 'pics', label: 'Small pictures', has: (p) => !!p.pics_small }
];

/** The shops she actually owns kits from — not every shop the app knows. */
const lbShops = () => [...new Set(S.projects.map((p) => p.shop).filter(Boolean))]
  .map((id) => shopById(id)).filter(Boolean);

function logbookGroups() {
  const q = S.q.trim().toLowerCase();
  const f = S.lb;
  const bucket = SIZE_BUCKETS.find((x) => x.k === f.size);
  const edge = (p) => (p.width_in && p.height_in) ? Math.max(p.width_in, p.height_in) * 2.54 : null;
  const match = (p) =>
    (S.filter === 'all' || p.status === S.filter) &&
    (!q || p.title.toLowerCase().includes(q) || (p.artist || '').toLowerCase().includes(q)) &&
    (!f.shop || p.shop === f.shop) &&
    (!f.shape || p.shape === f.shape) &&
    (!f.rating || Number(p.rating || 0) >= f.rating) &&
    (!f.gaps || (GAPS.find((g) => g.k === f.gaps) || { has: () => true }).has(p)) &&
    (!bucket || (edge(p) != null
                 && (!bucket.minCm || edge(p) >= bucket.minCm)
                 && (!bucket.maxCm || edge(p) <= bucket.maxCm)));

  /* Seven sections, most of them empty most of the time, is a lot of nothing to
     scroll past. They are rendered all the same and hidden in CSS, so a drag
     still has somewhere to drop — the body gets a class while one is live. */
  const showEmpty = S.filter === 'all' && !q && !lbActive();
  const sort = LB_SORT[f.sort] || LB_SORT.recent;
  return ORDER
    .map((k) => ({ k, items: S.projects.filter((p) => p.status === k).filter(match).sort(sort) }))
    .filter((g) => g.items.length || showEmpty);
}

/* The same panel the catalogue has, over what a logbook actually holds. The
   status chips above already answer "where is it up to"; this answers "which
   one", on a list that is 76 long and growing. Sorting applies inside each
   section, because the sections are the point of this screen. */
function logbookFilters() {
  const f = S.lb;
  const shops = lbShops();
  const row = (label, inner) => inner ? `
    <div style="margin-top:12px">
      <span class="label" style="margin-bottom:6px">${label}</span>
      <div class="chiprow" style="margin:0;padding:0;flex-wrap:wrap;gap:6px">${inner}</div>
    </div>` : '';
  const chip = (act, k, label, on, shop) =>
    `<button class="chip" style="height:36px;padding:0 12px" data-act="${act}" data-k="${k}"${
      shop ? ` data-shop="${h(shop)}"` : ''} aria-pressed="${on}">${h(label)}</button>`;
  return `
  <div class="panel" style="padding:12px 14px 16px;margin-top:2px">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <span class="label" style="margin:0">Filters${lbActive() ? ` \u00b7 ${lbActive()} on` : ''}</span>
      <button class="btn ghost" style="height:32px;font-size:12px;font-weight:700;padding:0 12px"
              data-act="lbclear" ${lbActive() ? '' : 'disabled'}>Clear all</button>
    </div>
    ${row('Shop', shops.length > 1
      ? shops.map((sh) => chip('lbshop', sh.id, sh.name, f.shop === sh.id, sh.id)).join('') : '')}
    ${row('Drill shape', ['Round', 'Square'].map((sh) => chip('lbshape', sh, sh, f.shape === sh)).join(''))}
    ${row('Canvas size (longest edge)', SIZE_BUCKETS.map((b) => chip('lbsize', b.k, b.label, f.size === b.k)).join(''))}
    ${row('Rating', RATINGS.map((r) => chip('lbrating', r.k, r.label, f.rating === r.k)).join(''))}
    ${row('Needs filling in', GAPS.map((g) => {
      const n = S.projects.filter(g.has).length;
      return n ? chip('lbgaps', g.k, `${g.label} · ${n}`, f.gaps === g.k) : '';
    }).join(''))}
    ${row('Sort each section by', LB_SORTS.map((o) => chip('lbsort', o.k, o.label, f.sort === o.k)).join(''))}
  </div>`;
}

function paintLogbook() {
  const groups = logbookGroups();
  const showEmpty = S.filter === 'all' && !S.q.trim() && !lbActive();
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  const counts = S.meta?.counts || {};
  const chips = [{ k: 'all', label: 'All', n: S.projects.length }]
    .concat(ORDER.map((k) => ({ k, label: STATUS[k].short, n: counts[k] || 0 })));

  const needsCatalogue = !S.meta?.catalogue?.kits;
  const empty = !S.projects.length;

  $list.innerHTML = `
  <div class="screen wide ${S.view}-view">
    <div class="topbar plain">
      ${topbar('My Logbook', { right: `
        <button class="iconbtn" data-go="#/settings" aria-label="Settings">${svg('cog')}</button>
        <span class="avatar">JL</span>` })}
      <div class="search">
        ${svg('search', 18)}
        <input id="q" value="${h(S.q)}" placeholder="Search by title or artist" autocomplete="off">
        ${S.q ? `<button class="iconbtn" data-act="clearq" aria-label="Clear"><span class="clear">${svg('close', 12, 2.6)}</span></button>` : ''}
      </div>
      <div class="chiprow">${chips.map((c) => `
        <button class="chip" data-act="filter" data-k="${c.k}" aria-pressed="${S.filter === c.k}">
          <span>${h(c.label)}</span><span class="n tnum">${c.n}</span></button>`).join('')}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <button class="chip" data-act="lbfilters" aria-pressed="${S.lb.open || lbActive() > 0}" style="flex:0 0 auto">
          ${svg('filter', 15)}<span>Filters</span>${lbActive() ? `<span class="n tnum">${lbActive()}</span>` : ''}
        </button>
        <span id="lbcount" style="margin:0 auto 0 4px;font-size:13px;font-weight:600;color:var(--ink-mid)">
          ${shown} project${shown === 1 ? '' : 's'}</span>
        <div class="seg tight compact">
          <button data-act="view" data-k="grid" aria-pressed="${S.view === 'grid'}" aria-label="Grid view">${svg('grid', 16)}</button>
          <button data-act="view" data-k="list" aria-pressed="${S.view === 'list'}" aria-label="List view">${svg('list', 16)}</button>
        </div>
      </div>
      ${S.lb.open ? logbookFilters() : ''}
    </div>

    <div class="scroll pad" style="padding-bottom:24px">
      ${needsCatalogue ? firstRunSync() : ''}
      ${!needsCatalogue && !empty && S.projects.length > 1 && !S.prefs.hints?.drag ? dragHint() : ''}
      ${empty ? emptyLogbook() : groups.map((g) => `
        <section class="group${g.items.length ? '' : ' empty-sect'}" data-status="${g.k}">
          <header><span class="dot" style="background:${stDot(g.k)}"></span>
            <h2>${h(statusOf(g.k).label)}</h2><span class="n tnum">${g.items.length}</span></header>
          <div class="group-body">${g.items.map(card).join('')}</div>
        </section>`).join('')}
      ${!empty && !groups.length ? `<div class="empty">${svg('gem', 40, 1.3)}
        <h2>Nothing matches that</h2><p>Try a different title or artist, or clear the filters.</p></div>` : ''}
    </div>

    <div class="actionbar">
      <button class="btn primary" data-go="#/browse">${svg('search', 18)} Add from catalogue</button>
      <button class="btn ghost square" data-go="#/new" aria-label="Add by hand">${svg('add', 20, 2)}</button>
      <button class="btn ghost square" data-go="#/import" aria-label="Import orders">${svg('imp')}</button>
    </div>
  </div>`;

  const input = document.getElementById('q');
  if (input) {
    input.oninput = (e) => { S.q = e.target.value; paintLogbookBody(); syncClear(); };
  }
  syncClear();
}

/* Changing what the list holds puts you back at its top: keeping a scroll
   position from a set of 76 while looking at a set of 4 lands you at the
   bottom of nothing. */
function repaintLogbook() {
  forgetScroll('#/');
  paintLogbook();
  const scroll = $list.querySelector('.scroll');
  if (scroll) scroll.scrollTop = 0;
}

// keep the clear button in step with the field without repainting the input itself
function syncClear() {
  const wrap = $list.querySelector('.search');
  if (!wrap) return;
  const has = !!S.q;
  const btn = wrap.querySelector('[data-act="clearq"]');
  if (has && !btn) {
    const b = document.createElement('button');
    b.className = 'iconbtn'; b.dataset.act = 'clearq'; b.setAttribute('aria-label', 'Clear');
    b.innerHTML = `<span class="clear">${svg('close', 12, 2.6)}</span>`;
    wrap.appendChild(b);
  } else if (!has && btn) btn.remove();
}

// re-render only the list while typing, so the field keeps focus and caret
function paintLogbookBody() {
  const groups = logbookGroups().filter((g) => g.items.length);
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  const scroll = $list.querySelector('.scroll');
  // a different set of projects, so the old place in the list means nothing
  if (scroll) scroll.scrollTop = 0;
  forgetScroll('#/');
  scroll.innerHTML = groups.length ? groups.map((g) => `
    <section class="group" data-status="${g.k}">
      <header><span class="dot" style="background:${stDot(g.k)}"></span>
        <h2>${h(statusOf(g.k).label)}</h2><span class="n tnum">${g.items.length}</span></header>
      <div class="group-body">${g.items.map(card).join('')}</div>
    </section>`).join('')
    : `<div class="empty">${svg('gem', 40, 1.3)}<h2>Nothing matches that</h2>
       <p>Try a different title or artist, or clear the filters.</p></div>`;
  // by id, not "the first .label on screen": the filter panel has labels of its own
  const count = document.getElementById('lbcount');
  if (count) count.textContent = `${shown} project${shown === 1 ? '' : 's'}`;
}

/* Nothing works properly until the catalogues are on the phone: no covers, no
   sizes, no drill counts, and importing an order history has nothing to match
   against. On a fresh install that is the one thing to do first, so it says so
   on the front page rather than waiting to be found in Settings. */
/* Long-press to move a project between sections is the nicest thing the app
   does and the least visible — there is nothing on screen to suggest it. Say
   so once, then never again. Dismissing is recorded in prefs rather than in
   memory, so it does not come back tomorrow. */
const dragHint = () => `
  <div class="notice" style="margin-top:16px;align-items:flex-start">
    ${svg('info', 18)}
    <span style="flex:1 1 auto">Hold a project for a moment, then drag it into another
      section to change its status. The dates fill themselves in.</span>
    <button class="btn ghost" style="height:30px;font-size:12px;padding:0 12px;flex:0 0 auto"
            data-act="hintdone" data-k="drag">Got it</button>
  </div>`;

const firstRunSync = () => `
  <div class="panel pad-in" style="margin-top:16px">
    <div style="display:flex;gap:11px;align-items:flex-start">
      ${svg('sync', 20)}
      <div style="min-width:0">
        <h2 style="margin:0;font-family:var(--serif);font-size:17px;font-weight:600">Start by downloading the catalogues</h2>
        <p style="margin:6px 0 0;font-size:13px;line-height:1.5;color:var(--ink-mid)">
          A one-off download of about a minute. After it, your kits arrive with their cover,
          artist, canvas size and drill count filled in, and browsing works with no connection.</p>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn primary" style="flex:1 1 auto" data-act="sync">Download catalogues</button>
      <button class="btn ghost" style="flex:0 0 auto" data-go="#/settings">Choose shops</button>
    </div>
    <div id="syncbox"></div>
  </div>`;

const emptyLogbook = () => `
  <div class="empty">${svg('gem', 44, 1.2)}
    <h2>Your logbook is empty</h2>
    <p>Import an order history and every kit you have bought becomes a project — cover, size, colours and drill count included. Or add them one at a time from the catalogues.</p>
    <button class="btn primary wide" style="margin-top:8px" data-go="#/import">${svg('imp', 18)} Import order history</button>
    <button class="btn ghost wide" data-go="#/new">Add one by hand instead</button>
  </div>`;

/* =============================================================== #/p/:id */
route(/^#\/p\/(\d+)$/, async (id) => {
  const p = await api('/projects/' + id);
  /* A cover is cached the first time a project uses one, and that can fail —
     no connection, a shop that has moved its pictures. Rather than show a
     blank hero, borrow the listing's own image until the cache catches up. */
  if (!p.cover && p.dac_handle && p.shop) {
    try {
      const row = await api(`/catalogue/product?shop=${encodeURIComponent(p.shop)}&handle=${encodeURIComponent(p.dac_handle)}`);
      if (row && row.image) p._remote = row.image;
      if (row && row.images) {
        try { const a = Array.isArray(row.images) ? row.images : JSON.parse(row.images || '[]');
              if (a.length) p._remotes = a; } catch { /* the one shot will do */ }
      }
    } catch { /* offline: the hero simply stays empty */ }
  }
  const spec = [
    ['Canvas size', sizeText(p) + (p.width_in ? ` · ${p.width_in}" × ${p.height_in}"` : '')],
    ['Drill shape', p.shape], ['Coverage', p.coverage],
    ['Diamonds', p.drills ? (p.drills_estimated ? '\u2248 ' + num(p.drills) : num(p.drills)) : null], ['Colours', p.colors ? num(p.colors) : null],
    ['Special diamonds', p.special], ['Brand', p.brand], ['Obtained from', p.source]
  ].filter(([, v]) => v);

  /* Everything this project has a picture of, in the order it is shown: the
     listing's photographs first, then your own. The viewer works from this, so
     swiping runs through the lot rather than stopping at the end of whichever
     half was tapped. Computed here rather than inside the markup, so the photo
     grid further down can number its own entries against the same list. */
  const coverShots = (() => {
    try { const a = JSON.parse(p.covers || '[]'); if (a.length) return a; } catch {}
    const one = p.cover ? [p.cover] : [];
    if (one.length) return one;
    return p._remotes && p._remotes.length ? p._remotes : (p._remote ? [p._remote] : []);
  })();
  const gallerySrc = (f) => f.startsWith('http') ? sized(f, 900) : '/covers/' + encodeURIComponent(f);
  const coverCount = coverShots.length;
  /* One list of photos, used by the grid and by the viewer. Filtering in one
     place and not the other would have the viewer open the wrong picture as
     soon as anything was removed. */
  const photos = (p.photos || []).filter((ph) => !pendingDeletes.has('photo:' + ph.id));
  S.gallery = {
    id: p.id,
    items: [
      ...coverShots.map((f) => ({ src: gallerySrc(f), kind: 'cover' })),
      ...photos.map((ph) => ({ src: '/photos/' + encodeURIComponent(ph.file),
                               kind: 'photo', file: ph.file, projectId: p.id, title: p.title }))
    ]
  };

  const dates = [['Ordered', p.date_ordered], ['Received', p.date_received],
                 ['Started', p.date_started], ['Completed', p.date_completed]];
  const costs = [['Price', p.price], ['Shipping', p.shipping], ['Tax', p.tax]].filter(([, v]) => v != null);
  const total = costs.reduce((n, [, v]) => n + Number(v || 0), 0);

  $out.innerHTML = `
  <div class="screen reading">
    <div class="scroll">
      ${(() => {
        const shots = coverShots;
        const src = (f) => f.startsWith('http') ? sized(f, 900) : '/covers/' + encodeURIComponent(f);
        return `<div class="hero" style="background:${stVar(p.status)}">
        ${shots.length ? `<span class="wash" id="herowash" style="background-image:url('${
          h(src(shots[0]))}')"></span>
        <div class="shots" id="shots">${shots.map((f, i) =>
          `<img src="${h(src(f))}" alt="" loading="lazy" referrerpolicy="no-referrer"
                data-act="opengallery" data-i="${i}">`).join('')}</div>` : ''}
        <div class="overlay"></div>
        <div class="controls">
          <button class="iconbtn" data-back="#/" aria-label="Back">${svg('back', 20, 2)}</button>
          <button class="btn hero-btn" style="height:44px;flex:0 0 auto"
                  data-go="#/p/${p.id}/edit">${svg('edit', 16)} Details</button>
        </div>
        ${shots.length > 1 ? `<div class="dots" id="dots">${shots.map((_, i) =>
          `<button data-act="shot" data-i="${i}" aria-current="${i === 0}" aria-label="Photo ${i + 1}"><i></i></button>`).join('')}</div>` : ''}
      </div>`;
      })()}

      <div class="pad" style="padding-top:18px">
        <button class="statuspill" style="background:${stVar(p.status)}"
                data-act="statusmenu" data-id="${p.id}" aria-haspopup="menu">
          <span class="dot" style="background:${stDot(p.status)}"></span>${h(statusOf(p.status).label)}
          ${svg('chev', 14, 2.2)}</button>
        <span class="stars shown live" aria-label="Rating">${
          [1, 2, 3, 4, 5].map((n) => `<button data-act="setrating" data-id="${p.id}" data-k="${n}"
            aria-label="${n} star${n === 1 ? '' : 's'}"${n <= Number(p.rating || 0) ? ' class="on"' : ''}
            >${star(19)}</button>`).join('')}${
          Number(p.rating) ? `<button class="clearstars" data-act="setrating" data-id="${p.id}" data-k="0"
            aria-label="No rating">Clear</button>` : ''}</span>
        <h1 style="font-size:27px;line-height:1.15;margin:10px 0 2px">${h(p.title)}</h1>
        ${p.artist ? `<p style="margin:0;color:var(--ink-mute);font-size:14px">By ${h(p.artist)}${p.brand ? ' · ' + h(p.brand) : ''}</p>` : ''}
        ${(() => {
          const url = productUrl(p.shop, p.dac_handle);
          if (!url) return '';
          const shop = shopById(p.shop);
          return `<a href="${h(url)}" target="_blank" rel="noopener noreferrer"
             style="display:inline-flex;align-items:center;gap:7px;margin-top:10px;height:36px;padding:0 13px;
                    border-radius:999px;background:var(--shop-${h(p.shop)}-bg);
                    border:1px solid var(--shop-${h(p.shop)});
                    font-size:13px;font-weight:600;color:var(--ink-mid)">
            <span class="pip" data-shop="${h(p.shop)}"></span>
            ${svg('link', 15)}<span>View on ${h(shop ? shop.name : 'the shop')}</span></a>`;
        })()}
      </div>

      <div class="pad stack" style="padding-top:16px;padding-bottom:26px">
        ${p.status === 'started' || p.progress ? `
        <div class="panel" style="padding:18px">
          <div style="display:flex;align-items:baseline;justify-content:space-between">
            <span style="font-family:var(--serif);font-size:40px;font-weight:600;line-height:1" class="tnum" id="pctv">${p.progress || 0}%</span>
            <span class="tnum" style="font-size:13px;color:var(--ink-mute)" id="placed">${
              p.drills ? num(Math.round(p.drills * (p.progress || 0) / 100)) + ' of ' + num(p.drills) + ' placed' : 'placed'}</span>
          </div>
          <input type="range" min="0" max="100" value="${p.progress || 0}" id="pct" class="progress"
                 aria-label="Progress" style="--fill:${p.progress || 0}%;margin-top:14px">
          <p style="margin:2px 0 0;font-size:12px;color:var(--ink-mute)">Drag to log where you are today. Saved automatically.</p>
        </div>` : ''}

        <div class="panel pad-in">${spec.map(([k, v]) =>
          `<div class="row"><span class="k">${h(k)}</span><span class="v tnum">${h(v)}</span></div>`).join('')}</div>

        <div>
          <h3 class="label">Timeline</h3>
          <!-- Each row IS the control. Correcting a date used to mean opening a
               disclosure, finding one of four fields, and pressing Save; the
               date was always a real picker, it was just three taps away. -->
          <div class="panel pad-in">${[['date_ordered', 'Ordered'], ['date_received', 'Received'],
                                       ['date_started', 'Started'], ['date_completed', 'Completed']].map(([k, l]) => `
            <!-- a div, not a label. A label forwards a second, synthetic click to
                 the control it names, and the input already covers the whole row —
                 so the tap opened the picker and the forwarded click shut it again. -->
            <div class="row daterow">
              <span class="k">${l}</span>
              <span class="v tnum" style="${p[k] ? '' : 'color:var(--ink-faint);font-weight:400'}">${
                h(dateText(p[k]) || 'Tap to set')}</span>
              <input type="date" value="${h(p[k] || '')}" aria-label="${l} date"
                     data-act="setdate" data-k="${k}" data-id="${p.id}">
            </div>`).join('')}</div>
          <p style="margin:6px 2px 0;font-size:12px;color:var(--ink-mute)">Tap a date to change it.
            The status follows the dates, the same as it does everywhere else.</p>
        </div>

        ${(() => {
          const holds = parseHolds(p);
          const open = openHold(p);
          return `<div>
          <h3 class="label">Put down${holds.length > 1 ? ` · ${holds.length} times` : ''}</h3>
          ${spanList(holds.map((hold, i) => ({
              key: i,
              left: holds.length > 1 ? `Hold ${i + 1}` : 'Held',
              right: `${dateText(hold.held) || '—'} → ${hold.restarted ? dateText(hold.restarted)
                : 'still down'} · ${daysText(hold.held, hold.restarted || today())}`
            })), {
              empty: 'Never put down',
              total: holds.length > 1 || open
                ? [open ? 'On hold so far' : 'Put down for', daysText(null, null, heldDays(p, today()))]
                : null,
              act: 'delhold', id: p.id })}
          <details class="sect" style="margin-top:8px">
            <summary><span class="label" style="margin:0">Record a hold</span></summary>
            <div class="grid2" style="margin-top:8px">
              <div><span class="minilabel">Put down</span>
                <input class="fld" type="date" id="holdfrom" value="${today()}"></div>
              <div><span class="minilabel">Picked up</span>
                <input class="fld" type="date" id="holdto"></div>
            </div>
            <button class="btn ghost wide" style="margin-top:8px" data-act="savehold" data-id="${p.id}">
              Save this hold</button>
            <p style="margin:6px 2px 0;font-size:12px;color:var(--ink-mute)">Leave "picked up" blank if it
              is still down — that puts the project on hold.</p>
          </details></div>`;
        })()}

        ${(() => {
          const list = p.sessions || [];
          const mins = list.reduce((n, x) => n + (Number(x.minutes) || 0), 0);
          /* A kit on the wish list or still in the post cannot be worked on, so
             offering to time a session on it is noise. */
          if (p.status === 'wishlist' || p.status === 'notReceived') return '';
          return `<div>
          <h3 class="label">Time</h3>
          ${spanList(list.map((se) => ({
              key: se.id,
              left: dateText(se.on) || 'Undated',
              right: `${minsText(se.minutes)}${se.note ? ' · ' + se.note : ''}`
            })), {
              empty: 'No time logged yet',
              total: list.length ? ['Total', minsText(mins)] : null,
              act: 'delsession', id: p.id })}
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn ${S.timer && S.timer.project_id === p.id ? 'danger' : 'ghost'}"
                    style="flex:1 1 auto" data-act="${S.timer && S.timer.project_id === p.id ? 'stoptimer' : 'starttimer'}"
                    data-id="${p.id}">${S.timer && S.timer.project_id === p.id
                      ? `Stop · ${minsText(Math.max(1, Math.round((Date.now() - Date.parse(S.timer.started_at)) / 60000)))}`
                      : 'Start a session'}</button>
          </div>
          <details class="sect" style="margin-top:8px">
            <summary><span class="label" style="margin:0">Add past time</span></summary>
            <div class="grid2" style="margin-top:8px">
              <div><span class="minilabel">On</span>
                <input class="fld" type="date" id="sesson" value="${today()}"></div>
              <div><span class="minilabel">Minutes</span>
                <input class="fld tnum" id="sessmins" inputmode="numeric" placeholder="60"></div>
            </div>
            <input class="fld" id="sessnote" placeholder="Note (optional)" style="margin-top:8px">
            <button class="btn ghost wide" style="margin-top:8px" data-act="savesession" data-id="${p.id}">
              Add it</button>
          </details></div>`;
        })()}

        ${p.order_ref ? `<div>
          <h3 class="label">Order</h3>
          <div class="panel pad-in">
            <div class="row"><span class="k">Reference</span><span class="v tnum">${h(p.order_ref)}</span></div>
            <div class="row"><span class="k">Order total</span><span class="v tnum">${money(p.order_total, p.currency)}${
              p.order_items > 1 ? ` <span style="color:var(--ink-mute);font-weight:400">· ${p.order_items} items</span>` : ''}</span></div>
            ${p.order_flag ? `<div class="row"><span class="k">Flag</span><span class="v" style="color:var(--danger)">${h(p.order_flag.replace(/_/g, ' '))}</span></div>` : ''}
          </div></div>` : ''}

        <div>
          <h3 class="label">Cost</h3>
          <div class="panel pad-in">
            ${costs.length ? costs.map(([k, v]) => {
              const src = k === 'Price' && p.price_source ? PRICE_SOURCE[p.price_source] : null;
              return `<div class="row"><span class="k">${h(k)}${
                src ? `<br><span style="font-size:11px;color:var(--ink-faint)">${h(src[0])}</span>` : ''}</span>
                <span class="v tnum">${money(v, p.currency)}</span></div>`; }).join('')
              + `<div class="row"><span class="k" style="font-weight:700;color:var(--ink)">Total</span>
                 <span class="v tnum" style="font-size:16px">${money(total, p.currency)}</span></div>`
              : `<div class="row"><span class="k">Not recorded yet</span>
                 <span class="v"><a href="#/p/${p.id}/edit">Add</a></span></div>`}
          </div>
          <details class="sect" style="margin-top:8px">
            <summary><span class="label" style="margin:0">Correct the cost</span></summary>
            <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:8px">
              ${[['price', 'Price'], ['shipping', 'Shipping'], ['tax', 'Tax']].map(([k, l]) => `
                <div><span class="minilabel">${l}</span>
                <input class="fld tnum" id="cost_${k}" inputmode="decimal" value="${h(p[k] ?? '')}"></div>`).join('')}
            </div>
            <div style="margin-top:10px"><span class="minilabel">Currency</span>
              <div class="opts" id="cost_currency">${
                [...new Set([...CURRENCIES, ...(p.currency ? [p.currency] : [])])].map((c) => `
                <button type="button" class="opt" data-k="${c}" style="padding:0 8px"
                        aria-pressed="${(p.currency || 'GBP') === c}">${c}</button>`).join('')}</div></div>
            <button class="btn ghost wide" style="margin-top:8px" data-act="savecost" data-id="${p.id}">
              Save the cost</button>
          </details>
          ${p.price_source && PRICE_SOURCE[p.price_source] && PRICE_SOURCE[p.price_source][1]
            ? `<p style="margin:8px 2px 0;font-size:11px;line-height:1.45;color:var(--ink-mute)">Price is ${
                h(PRICE_SOURCE[p.price_source][0])} — ${h(PRICE_SOURCE[p.price_source][1])}. Edit it to set what you actually paid.</p>`
            : ''}
        </div>

        <div>
          <h3 class="label">Progress photos</h3>
          <div class="photos">
            ${photos.map((ph, i) => `
              <div class="shot">
                <img src="/photos/${encodeURIComponent(ph.file)}" alt="" loading="lazy">
                <button class="open" data-act="opengallery" data-i="${coverCount + i}"
                        aria-label="View this photo full size"></button>
                <button class="x" data-act="delphoto" data-id="${ph.id}" aria-label="Remove photo">${svg('close', 12, 2.6)}</button>
              </div>`).join('')}
            <label class="btn dashed add">
              ${svg('camera', 20)}<span>Add</span>
              <input type="file" accept="image/*" multiple id="photo" hidden>
            </label>
          </div>
          ${/^own-/.test(p.cover || '') ? `
          <button class="btn ghost wide" style="margin-top:10px" data-act="resetcover" data-id="${p.id}">
            Use the shop\u2019s image as the cover</button>` : ''}
        </div>

        <div>
          <h3 class="label">Notes</h3>
          <textarea class="fld" id="notes" placeholder="Colour matches, missing drills, where you got to…">${h(p.notes || '')}</textarea>
        </div>

        <button class="btn danger wide" data-act="delete" data-id="${p.id}">Delete project</button>
      </div>
    </div>
  </div>`;

  wireShots(document.getElementById('shots'));

  // the currency chips in the inline cost editor behave like every other group
  const cur = document.getElementById('cost_currency');
  if (cur) cur.onclick = (e) => {
    const b = e.target.closest('.opt'); if (!b) return;
    [...cur.children].forEach((c) => c.setAttribute('aria-pressed', c === b));
  };

  const pct = document.getElementById('pct');
  if (pct) {
    let t;
    pct.oninput = (e) => {
      const v = Number(e.target.value);
      document.getElementById('pctv').textContent = v + '%';
      e.target.style.setProperty('--fill', v + '%');
      if (p.drills) document.getElementById('placed').textContent =
        num(Math.round(p.drills * v / 100)) + ' of ' + num(p.drills) + ' placed';
      clearTimeout(t);
      t = setTimeout(() => api('/projects/' + p.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ progress: v, ...(v >= 100 ? { status: 'completed', date_completed: p.date_completed || today() } : {}) })
      }), 400);
    };
  }
  const notes = document.getElementById('notes');
  if (notes) {
    let t;
    notes.oninput = () => { clearTimeout(t); t = setTimeout(() => api('/projects/' + p.id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: notes.value }) }).then(() => toast('Notes saved')), 700); };
  }
  const photo = document.getElementById('photo');
  if (photo) {
    photo.onchange = async () => {
      const files = Array.from(photo.files || []);
      if (!files.length) return;
      let done = 0, failed = 0;
      const say = () => toast(files.length === 1 ? 'Saving photo…' : `Saving ${done + 1} of ${files.length}…`);
      say();
      for (const f of files) {
        try {
          const small = await downscale(f);
          await api(`/projects/${p.id}/photos`, {
            method: 'POST',
            headers: { 'Content-Type': small.type || 'image/jpeg' },
            body: isStandalone() ? await small.arrayBuffer() : small
          });
        } catch { failed++; }
        done++;
        if (done < files.length) say();
      }
      toast(failed ? `${done - failed} added, ${failed} failed` :
            done === 1 ? 'Photo added' : `${done} photos added`);
      render();
    };
  }
});

/* ================================================= #/new and #/p/:id/edit */
const FORM_STATUS = ALL_STATUSES;
route(/^#\/(new|p\/(\d+)\/edit)$/, async (_all, id) => {
  let p = id ? await api('/projects/' + id) : {
    status: 'notReceived', currency: 'GBP', coverage: 'Full drill', shape: 'Square', brand: '', hours: 0
  };
  if (!id && S.fromCatalogue) {
    const c = S.fromCatalogue;
    const shopName = (browseShops.find(s => s.id === c.shop) || {}).name || null;
    p = { ...p, title: c.title, artist: c.artist, shape: c.shape || p.shape,
          coverage: c.coverage || p.coverage, width_in: c.width_in, height_in: c.height_in,
          colors: c.colors, drills: c.drills, special: c.special,
          brand: shopName, source: shopName, price: c.price,
          currency: displayCurrency(c.shop, c.currency, S.prefs.currency),
          dac_handle: c.handle, shop: c.shop, _preview: c.image || null,
          _images: (() => { try { return Array.isArray(c.images) ? c.images : JSON.parse(c.images || '[]'); }
                            catch { return []; } })() };
    /* Kept until the form is actually left. Clearing it here meant a second
       render of the same form — a fold, a rotation, anything that re-runs the
       route — produced a blank New project with no picture and none of the
       details that had just been picked. */
  }
  const isNew = !id;
  /* Show the dates the status is going to imply, rather than saving them
     silently. The rule ran when a status was TAPPED, and a new project already
     has one selected — so the commonest path of all, add from the catalogue and
     save, went through the form with every date box empty. The store fills them
     in on the way past; this is what makes the form agree with what it saves. */
  if (isNew && p.status) {
    const implied = applyStatus(p, p.status, today());
    for (const [k, v] of Object.entries(implied))
      if (k.startsWith('date_') && v && !p[k]) p[k] = v;
  }
  const f = (name, label, value, extra = '', cls = '') =>
    `<div class="${cls}"><label class="label" for="${name}">${h(label)}</label>
     <input class="fld" id="${name}" name="${name}" value="${h(value ?? '')}" ${extra}></div>`;

  /* Picking a kit out of the catalogue used to land on a form with no picture
     on it, so there was nothing to confirm you had picked the right one. The
     catalogue's own image is used before the project exists; afterwards it is
     the cover that was cached for it. */
  /* The picture came only from a browse pick before, so arriving any other way
     — a title suggestion, a relink, editing later — showed a form with no
     picture on it. Take it from whatever listing the project is linked to. */
  if (!p._preview && !p.cover && p.dac_handle && p.shop) {
    try {
      const row = await api(`/catalogue/product?shop=${encodeURIComponent(p.shop)}&handle=${encodeURIComponent(p.dac_handle)}`);
      if (row && row.image) p._preview = row.image;
      // the whole strip, not just the first shot: arriving by relink, by a
      // title suggestion or by editing later showed one picture where the
      // catalogue pick showed six
      if (row && row.images) {
        try { const a = Array.isArray(row.images) ? row.images : JSON.parse(row.images || '[]');
              if (a.length) p._images = a; } catch { /* keep the single preview */ }
      }
    } catch { /* offline: the form simply has no picture */ }
  }
  /* The same set the project page shows, so a kit looks the same before it is
     added as after: every picture the listing has, or the covers already
     cached for it. */
  const formShots = (() => {
    const cached = (() => {
      try { const a = JSON.parse(p.covers || '[]'); if (a.length) return a; } catch {}
      return p.cover ? [p.cover] : [];
    })();
    if (cached.length) return cached.map((f) => '/covers/' + encodeURIComponent(f));
    const remote = p._preview ? (Array.isArray(p._images) && p._images.length ? p._images : [p._preview]) : [];
    return remote.map((u) => sized(u, 900));
  })();
  S.gallery = { id: p.id || null, items: formShots.map((src) => ({ src, kind: 'cover' })) };

  $out.innerHTML = `
  <div class="screen reading form">
    <div class="topbar">
      ${topbar(isNew ? 'New project' : 'Project details', { back: isNew ? '#/' : '#/p/' + id, sub: true })}
    </div>
    <div class="scroll pad stack" style="padding-top:18px;padding-bottom:26px">
      <div class="formshot" id="formshot"${formShots.length ? '' : ' hidden'}>
        <div class="shots" id="formshots">${formShots.map((src, i) => `
          <img id="${i ? '' : 'formshotimg'}" src="${h(src)}" alt="" loading="lazy"
               referrerpolicy="no-referrer" data-act="opengallery" data-i="${i}">`).join('')}</div>
        ${formShots.length > 1 ? `<div class="dots" id="formdots">${formShots.map((_, i) =>
          `<button data-act="formshot" data-i="${i}" aria-current="${i === 0}"
                   aria-label="Picture ${i + 1}"><i></i></button>`).join('')}</div>` : ''}
      </div>
      ${(() => {
        const url = productUrl(p.shop, p.dac_handle);
        if (!url) return '';
        const shop = shopById(p.shop);
        return `<a class="shoplink" href="${h(url)}" target="_blank" rel="noopener noreferrer"
                   ${shop ? `data-shop="${h(shop.id)}"` : ''}>${svg('link', 15)} View on ${
                   h(shop ? shop.name : 'the shop')}</a>`;
      })()}
      <div><label class="label" for="title">Project name</label>
        <input class="fld" id="title" name="title" value="${h(p.title || '')}" placeholder="Start typing to search the catalogue" autocomplete="off"
               data-handle="${h(p.dac_handle || '')}" data-shop="${h(p.shop || '')}"
               data-holds="${h(p.holds || '')}">
        <div id="sugg" class="stack" style="gap:6px;margin-top:6px"></div></div>

      <div><span class="label">Catalogue listing</span>
        <div class="panel pad-in">
          <div class="row"><span class="k" id="linkstate"></span>
            <span style="display:flex;gap:8px;flex:0 0 auto">
              <button type="button" class="btn ghost" style="height:32px;font-size:12px;padding:0 11px"
                      id="linkbtn">Relink</button>
              <button type="button" class="btn ghost" style="height:32px;font-size:12px;padding:0 11px"
                      id="unlinkbtn">Unlink</button>
            </span></div>
          <div id="linkbox" hidden style="margin-top:10px">
            <input class="fld" id="linkq" placeholder="Search the catalogue" autocomplete="off">
            <div id="linkres" class="stack" style="gap:6px;margin-top:6px"></div>
          </div>
        </div>
        <p style="margin:6px 2px 0;font-size:12px;color:var(--ink-mute)">What the cover, the gallery and the
          product link are taken from. Relinking does not overwrite anything you have typed.</p></div>

      ${f('artist', 'Artist', p.artist)}

      <div><label class="label" for="shop">Shop</label>
        <select class="fld" id="shop" name="shop">
          ${[{ id: '', name: 'Not from a listed shop' }, ...SHOPS].map((sh) =>
            `<option value="${sh.id}"${(p.shop || '') === sh.id ? ' selected' : ''}>${h(sh.name)}</option>`).join('')}
        </select>
        <p style="margin:6px 2px 0;font-size:12px;color:var(--ink-mute)">Sets the colour it carries through the logbook, and the link to its product page.</p></div>

      <div><span class="label">Project status</span>
        <div class="opts" id="status">${FORM_STATUS.map((k) => `
          <button type="button" class="opt" data-k="${k}" aria-pressed="${p.status === k}"
            style="flex:1 1 46%"><span class="dot" style="background:${stDot(k)}"></span>${h(STATUS[k].short)}</button>`).join('')}</div></div>

      <div><span class="label">Drill shape</span>
        <div class="opts" id="shape">${['Round', 'Square'].map((k) =>
          `<button type="button" class="opt" data-k="${k}" aria-pressed="${p.shape === k}">${k}</button>`).join('')}</div></div>

      <div><span class="label">Coverage</span>
        <div class="opts" id="coverage">${['Full drill', 'Partial drill'].map((k) =>
          `<button type="button" class="opt" data-k="${k}" aria-pressed="${p.coverage === k}">${k}</button>`).join('')}</div></div>

      <div><span class="label">Canvas size (inches)</span>
        <div class="grid2">
          <input class="fld tnum" id="width_in" placeholder="W" inputmode="decimal" value="${h(p.width_in ?? '')}">
          <input class="fld tnum" id="height_in" placeholder="H" inputmode="decimal" value="${h(p.height_in ?? '')}">
        </div>
        <p class="tnum" id="cmhint" style="margin:6px 2px 0;font-size:12px;color:var(--ink-mute)"></p></div>

      <div class="grid2">
        ${f('colors', 'Colours', p.colors, 'inputmode="numeric"')}
        ${f('drills', 'Diamonds', p.drills, `inputmode="numeric" data-orig="${h(p.drills ?? '')}"`)}
        ${f('special', 'Special diamonds', p.special, '', 'span2')}
        ${f('brand', 'Brand', p.brand, '', 'span2')}
        ${f('source', 'Obtained from', p.source, '', 'span2')}
      </div>

      <details class="sect" open>
        <summary><span class="label" style="margin:0">Dates</span>
          <span class="sub tnum">${(() => {
            const set = [['Ordered', p.date_ordered], ['Received', p.date_received],
                         ['Started', p.date_started], ['Completed', p.date_completed]]
              .filter(([, v]) => v);
            const holds = parseHolds(p);
            const bits = set.length ? [`${set[set.length - 1][0]} ${h(dateText(set[set.length - 1][1]))}`] : ['Nothing logged'];
            if (holds.length) bits.push(`put down ${holds.length}\u00d7`);
            return bits.join(' · ');
          })()}</span></summary>
        <div class="grid2" style="margin-top:10px">
          ${[['date_ordered', 'Ordered'], ['date_received', 'Received'],
             ['date_started', 'Started'], ['date_completed', 'Completed']].map(([k, l]) => `
            <div><span style="display:block;margin-bottom:5px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-mute)">${l}</span>
            <input class="fld" type="date" id="${k}" value="${h(p[k] || '')}"></div>`).join('')}
        </div>
        <p id="datenote" style="margin:8px 2px 0;font-size:12px;line-height:1.45;color:var(--ink-mute)"></p>
        ${(() => {
          const holds = parseHolds(p);
          if (!holds.length) return '';
          return `<div style="margin-top:12px">
            <span class="label">On hold</span>
            <div class="panel pad-in">${holds.map((hold, i) => `
              <div class="row"><span class="k">${holds.length > 1 ? `Hold ${i + 1}` : 'Held'}</span>
                <span class="v tnum">${h(dateText(hold.held) || '—')}${
                  hold.restarted ? ` → ${h(dateText(hold.restarted))}` : ' → still on hold'}</span></div>`).join('')}
            </div>
            <p style="margin:6px 2px 0;font-size:12px;color:var(--ink-mute)">Kept for you as the status moves
              in and out of On hold. Nothing to fill in.</p></div>`;
        })()}
      </details>

      <div><span class="label">Cost</span>
        <div class="panel" style="padding:14px">
          <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">
            ${[['price', 'Price'], ['shipping', 'Shipping'], ['tax', 'Tax']].map(([k, l]) => `
              <div><span style="display:block;margin-bottom:5px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-mute)">${l}</span>
              <input class="fld tnum money" id="${k}" inputmode="decimal" style="height:44px;padding:0 10px" value="${h(p[k] ?? '')}" data-orig="${h(p[k] ?? '')}"></div>`).join('')}
          </div>
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line-soft);display:flex;align-items:baseline;justify-content:space-between">
            <span style="font-size:13px;font-weight:700">Total</span>
            <span class="tnum" id="total" style="font-family:var(--serif);font-size:24px;font-weight:600">—</span>
          </div>
        </div></div>

      <div class="grid2">
        ${f('progress', 'Progress (%)', p.progress, 'inputmode="numeric"')}
        ${f('hoursShown', 'Time logged', p.hours ? minsText(Math.round(p.hours * 60)) : '—',
             'disabled style="opacity:.6" title="Added as sessions on the project"')}
        <div><span class="label">Currency</span>
          <div class="opts" id="currency" data-was="${h(p.currency || '')}">${
          /* whatever this project is priced in is always offered, even if it is
             not one we normally list, so saving can never silently drop it */
          [...new Set([...CURRENCIES, ...(p.currency ? [p.currency] : [])])].map((k) =>
            `<button type="button" class="opt" data-k="${k}" aria-pressed="${(p.currency || 'GBP') === k}" style="padding:0 6px">${k}</button>`).join('')}</div></div>
        ${f('sold_price', 'If sold, at what price', p.sold_price, 'inputmode="decimal"', 'span2')}
      </div>

      <div><span class="label">Rating</span>
        <div class="stars" id="rating" data-v="${Number(p.rating) || 0}">
          ${[1, 2, 3, 4, 5].map((n) => `
            <button type="button" data-k="${n}" aria-label="${n} star${n === 1 ? '' : 's'}"
              aria-pressed="${(Number(p.rating) || 0) >= n}">${star(26)}</button>`).join('')}
          <button type="button" class="clearstars" data-k="0" aria-label="No rating">Clear</button>
        </div></div>

      <div><label class="label" for="notes">Notes</label>
        <textarea class="fld" id="notes" name="notes"
                  placeholder="Colour matches, missing drills, where you got to…">${h(p.notes || '')}</textarea></div>
    </div>
    <div class="actionbar">
      <button class="btn ghost" style="width:110px" data-back="${isNew ? '#/' : '#/p/' + id}">Cancel</button>
      <button class="btn primary" data-act="save" data-id="${id || ''}">Save project</button>
    </div>
  </div>`;

  // segmented groups
  const stars = document.getElementById('rating');
  if (stars) stars.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const v = Number(b.dataset.k) || 0;
    stars.dataset.v = String(v);
    [...stars.querySelectorAll('button[data-k]')].forEach((x) =>
      x.setAttribute('aria-pressed', Number(x.dataset.k) > 0 && Number(x.dataset.k) <= v));
  };

  for (const g of ['status', 'shape', 'coverage', 'currency']) {
    document.getElementById(g).onclick = (e) => {
      const b = e.target.closest('.opt'); if (!b) return;
      [...e.currentTarget.children].forEach((c) => c.setAttribute('aria-pressed', c === b));
      if (g === 'status') statusChanged(b.dataset.k);
    };
  }

  /* Status and dates describe the same journey, so changing either updates the
     other in front of you rather than silently on save. */
  const DATE_IDS = ['date_ordered', 'date_received', 'date_started', 'date_completed'];
  const seg = (g) => document.querySelector(`#${g} .opt[aria-pressed="true"]`)?.dataset.k ?? null;
  const readDates = () => {
    const o = { status: seg('status') };
    for (const id of DATE_IDS) o[id] = document.getElementById(id).value || null;
    return o;
  };
  const setStatusButtons = (status) => {
    document.querySelectorAll('#status .opt').forEach((b) =>
      b.setAttribute('aria-pressed', b.dataset.k === status));
  };
  function statusChanged(status) {
    const t = document.getElementById('title');
    // holds live on the form as an attribute: there is no field for them, and
    // a status change here has to open and close periods exactly as a drag does
    const changes = applyStatus({ ...readDates(), holds: t.dataset.holds || null }, status, today());
    for (const [k, v] of Object.entries(changes)) {
      if (k === 'status') continue;
      if (k === 'holds') { t.dataset.holds = v || ''; continue; }
      const el = document.getElementById(k);
      if (el) el.value = v || '';
    }
    noteDates();
  }
  function datesChanged() {
    const want = statusFromDates(readDates());
    setStatusButtons(want);
    noteDates();
  }
  function noteDates() {
    const n = document.getElementById('datenote');
    if (!n) return;
    const d = readDates();
    n.textContent = `Status follows these dates — currently ${
      { notReceived: 'not received', received: 'received, not started',
        started: 'started', completed: 'completed' }[statusFromDates(d)]}.`;
  }
  DATE_IDS.forEach((id) => { const el = document.getElementById(id); if (el) el.onchange = datesChanged; });
  noteDates();
  const recalc = () => {
    const v = (id) => parseFloat(document.getElementById(id).value.replace(/[^0-9.\-]/g, '')) || 0;
    const cur = document.querySelector('#currency .opt[aria-pressed="true"]')?.dataset.k || 'GBP';
    document.getElementById('total').textContent = money(v('price') + v('shipping') + v('tax'), cur);
  };
  document.querySelectorAll('.money').forEach((el) => (el.oninput = recalc));
  document.getElementById('currency').addEventListener('click', () => setTimeout(recalc));
  recalc();

  const cmHint = () => {
    const w = parseFloat(document.getElementById('width_in').value);
    const ht = parseFloat(document.getElementById('height_in').value);
    document.getElementById('cmhint').textContent =
      w && ht ? `${cm(w)} × ${cm(ht)} cm` : 'Enter inches — centimetres are worked out for you.';
  };
  ['width_in', 'height_in'].forEach((k) => (document.getElementById(k).oninput = cmHint));
  cmHint();

  /* The listing a project points at, changed on its own. The title box below
     fills the whole form from a catalogue row; this only moves the pointer, so
     corrections you have made by hand survive being relinked. */
  /* A picture that fails to load leaves an empty grey box, which looks exactly
     like having no picture at all — and that ambiguity cost several rounds of
     "there is no image" against code that was demonstrably rendering one. */
  const watchPreview = () => {
    const box = document.getElementById('formshot');
    const img = document.getElementById('formshotimg');
    if (!box || !img) return;
    img.onerror = () => { box.dataset.failed = '1'; };
    img.onload = () => { delete box.dataset.failed; };
  };

  const showPreview = (url, images) => {
    const box = document.getElementById('formshot');
    const strip = document.getElementById('formshots');
    if (!box || !strip || !url) return;
    const list = (Array.isArray(images) && images.length ? images : [url]).map((u) => sized(u, 900));
    strip.innerHTML = list.map((src, i) => `<img id="${i ? '' : 'formshotimg'}" src="${h(src)}" alt=""
        loading="lazy" referrerpolicy="no-referrer" data-act="opengallery" data-i="${i}">`).join('');
    S.gallery = { id: null, items: list.map((src) => ({ src, kind: 'cover' })) };
    /* The dots are not decoration — without them a strip of six pictures looks
       like one picture. They were only painted at first render, so relinking or
       picking a title left a silently swipeable strip with nothing to say so. */
    let dots = box.querySelector('.dots');
    if (list.length > 1) {
      if (!dots) { dots = document.createElement('div'); dots.className = 'dots'; dots.id = 'formdots'; box.appendChild(dots); }
      dots.innerHTML = list.map((_, i) =>
        `<button data-act="formshot" data-i="${i}" aria-current="${i === 0}"
                 aria-label="Picture ${i + 1}"><i></i></button>`).join('');
    } else if (dots) dots.remove();
    box.hidden = false;
    strip.scrollLeft = 0;
    watchPreview();
    wireShots(strip);
  };

  watchPreview();
  wireShots(document.getElementById('formshots'));

  const linkState = document.getElementById('linkstate');
  const linkBox = document.getElementById('linkbox');
  const linkRes = document.getElementById('linkres');
  const linkQ = document.getElementById('linkq');
  const paintLink = () => {
    const t = document.getElementById('title');
    const handle = t.dataset.handle, shopId = t.dataset.shop;
    const shopName = (shopById(shopId) || {}).name;
    linkState.textContent = handle
      ? (shopName ? `${shopName} · ${handle}` : handle)
      : 'Not linked to a listing';
    document.getElementById('unlinkbtn').hidden = !handle;
  };
  document.getElementById('linkbtn').onclick = () => {
    linkBox.hidden = !linkBox.hidden;
    if (!linkBox.hidden) linkQ.focus();
  };
  document.getElementById('unlinkbtn').onclick = () => {
    const t = document.getElementById('title');
    t.dataset.handle = ''; t.dataset.shop = '';
    linkRes.innerHTML = ''; linkBox.hidden = true;
    paintLink();
    toast('Unlinked — its cover stays until you change it');
  };
  let lt;
  linkQ.oninput = () => {
    clearTimeout(lt);
    lt = setTimeout(async () => {
      const q = linkQ.value.trim();
      if (q.length < 2) { linkRes.innerHTML = ''; return; }
      const hits = await api('/catalogue/search?q=' + encodeURIComponent(q)).catch(() => []);
      linkRes._hits = hits;
      linkRes.innerHTML = hits.slice(0, 6).map((c) => `
        <button type="button" class="checkrow" data-h="${h(c.handle)}" data-s="${h(c.shop || '')}" style="min-height:48px">
          <span style="flex:1 1 auto;min-width:0">
            <span style="display:block;font-size:13px;font-weight:600">${h(c.title)}</span>
            <span style="display:block;font-size:11px;color:var(--ink-mute)">${
              h((shopById(c.shop) || {}).name || '')}${c.artist ? ' · ' + h(c.artist) : ''}</span>
          </span></button>`).join('');
    }, 220);
  };
  linkRes.onclick = (e) => {
    const b = e.target.closest('[data-h]'); if (!b) return;
    const t = document.getElementById('title');
    t.dataset.handle = b.dataset.h;
    t.dataset.shop = b.dataset.s;
    const sel = document.getElementById('shop');
    if (sel && b.dataset.s) sel.value = b.dataset.s;
    const picked = (linkRes._hits || []).find((x) => x.handle === b.dataset.h);
    showPreview(picked?.image, (() => { try { return Array.isArray(picked?.images) ? picked.images
                                                : JSON.parse(picked?.images || '[]'); } catch { return []; } })());
    linkRes.innerHTML = ''; linkQ.value = ''; linkBox.hidden = true;
    paintLink();
    toast('Relinked — save to fetch its pictures');
  };
  paintLink();

  // anything typed before a "keep editing" comes back before the snapshot is taken
  if (restoreForm) { applyForm(restoreForm); restoreForm = null; noteDates(); cmHint(); recalc(); }
  editing = { hash: location.hash, opened: readForm() };

  // catalogue autocomplete: fills everything DAC knows
  const titleEl = document.getElementById('title'), sugg = document.getElementById('sugg');
  let st;
  titleEl.oninput = () => {
    clearTimeout(st);
    st = setTimeout(async () => {
      const q = titleEl.value.trim();
      if (q.length < 2) { sugg.innerHTML = ''; return; }
      const hits = await api('/catalogue/search?q=' + encodeURIComponent(q)).catch(() => []);
      sugg.innerHTML = hits.slice(0, 5).map((c) => `
        <button type="button" class="checkrow" data-act="usecat" data-h="${h(c.handle)}" style="min-height:52px">
          <span style="flex:1 1 auto;min-width:0">
            <span style="display:block;font-family:var(--serif);font-weight:600;font-size:14px">${h(c.title)}</span>
            <span style="display:block;font-size:11px;color:var(--ink-mute)" class="tnum">${h(c.artist || '')}${
              c.price != null ? ' · ' + money(c.price, displayCurrency(c.shop, c.currency, S.prefs.currency)) : ''}${
                c.drills ? ' · ' + num(c.drills) + ' drills' : ''}</span>
          </span></button>`).join('');
      sugg._hits = hits;
    }, 220);
  };
  /* Picking a suggestion and relinking look like the same thing — "this project
     is that kit" — but one fills a dozen fields from the catalogue and the
     other only moves the pointer. Anything already typed is worth more than the
     catalogue's version of it, so it says what it is about to replace, and
     declining links without overwriting. */
  sugg.onclick = (e) => {
    const b = e.target.closest('[data-act="usecat"]'); if (!b) return;
    const c = (sugg._hits || []).find((x) => x.handle === b.dataset.h); if (!c) return;
    const shopName = (shopById(c.shop) || {}).name || null;

    const fields = [
      ['title', 'name', c.title], ['artist', 'artist', c.artist],
      ['colors', 'colours', c.colors], ['drills', 'diamonds', c.drills],
      ['special', 'special diamonds', c.special],
      ['width_in', 'width', c.width_in], ['height_in', 'height', c.height_in],
      ['brand', 'brand', shopName], ['source', 'obtained from', shopName],
      ['price', 'price', c.price]
    ];
    const clash = fields.filter(([id, , val]) => {
      const el = document.getElementById(id);
      const have = String(el?.value ?? '').trim();
      return have && val != null && have !== String(val);
    }).map(([, label]) => label);

    const link = () => {
      titleEl.dataset.handle = c.handle;
      titleEl.dataset.shop = c.shop || '';
      const shopSel = document.getElementById('shop');
      if (shopSel && c.shop) shopSel.value = c.shop;
      // the picture followed only the browse route in; now it follows any of them
      showPreview(c.image, (() => { try { return Array.isArray(c.images) ? c.images : JSON.parse(c.images || '[]'); }
                                    catch { return []; } })());
      sugg.innerHTML = ''; paintLink();
    };

    if (clash.length && !confirm(
        `Fill this in from the catalogue?\n\nIt replaces what you have for: ${clash.join(', ')}.`)) {
      link();
      toast('Linked — your details kept');
      return;
    }

    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
    for (const [id, , val] of fields) set(id, val);
    for (const [g, val] of [['shape', c.shape], ['coverage', c.coverage]]) {
      document.querySelectorAll(`#${g} .opt`).forEach((o) => o.setAttribute('aria-pressed', o.dataset.k === val));
    }
    link();
    cmHint(); recalc();
    toast('Filled from the catalogue');
  };
});

/* =========================================================== #/import */
route(/^#\/import$/, async () => {
  const state = await api('/state');
  if (!state.catalogue.kits) return paintNeedsCatalogue();
  if (!S.importPreview) return paintImportPick(state);
  paintImportReview();
});

function paintNeedsCatalogue() {
  $out.innerHTML = `
  <div class="screen reading">
    <div class="topbar">${topbar('Import orders', { back: '#/', sub: true })}</div>
    <div class="scroll pad stack" style="padding-top:20px">
      <div class="notice">${svg('info', 18)}<span>Before your orders can be matched, the app needs a copy of the
        Diamond Art Club catalogue. It is a one-off download of about 20 requests and takes half a minute — after
        that, importing works with no connection at all.</span></div>
      <button class="btn primary wide" data-act="sync">Download the catalogue</button>
      <div id="syncbox"></div>
    </div>
  </div>`;
}

/* Let go of a file chosen but not imported. */
function forgetImport() { S.importPreview = null; S.importSel = new Set(); }

function paintImportPick(state) {
  /* An order history only makes sense against the shop it came from: the titles
     are matched to that shop's catalogue. This always assumed Diamond Art Club,
     silently, so an order history from anywhere else was matched against the
     wrong catalogue and simply found nothing. */
  const shops = ((state && state.catalogue && state.catalogue.shops) || []).filter((sh) => sh.kits);
  if (!shops.some((sh) => sh.id === S.importShop)) S.importShop = (shops[0] || {}).id || 'dac';
  const chosen = shops.find((sh) => sh.id === S.importShop);

  $out.innerHTML = `
  <div class="screen reading">
    <div class="topbar">${topbar('Import orders', { back: '#/', sub: true })}</div>
    <div class="scroll pad stack" style="padding-top:20px;padding-bottom:26px">
      ${shops.length ? `<div>
        <h3 class="label">Which shop is this order history from?</h3>
        <div class="chiprow" style="margin:0;padding:0;flex-wrap:wrap;gap:6px">
          ${shops.map((sh) => `<button class="chip" style="height:36px;padding:0 12px"
            data-act="importshop" data-k="${h(sh.id)}" data-shop="${h(sh.id)}"
            aria-pressed="${S.importShop === sh.id}">${h(sh.name)}</button>`).join('')}
        </div>
      </div>` : ''}
      <label class="dropzone" id="drop">
        ${svg('imp', 34, 1.6)}
        <span style="font-family:var(--serif);font-size:19px;font-weight:600">Choose your order history</span>
        <span style="font-size:13px;line-height:1.5;color:var(--ink-mute)">The CSV you exported from ${
          h(chosen ? chosen.name : 'your shop')}.<br>Nothing leaves your phone.</span>
        <input type="file" accept=".csv,text/csv" id="csv" hidden>
      </label>
      <div class="panel pad-in">
        ${[['Kits become projects', 'Each canvas is matched to the catalogue, so it arrives with its cover, artist, size, colours, drill count and special diamonds.'],
           ['Tools and accessories are skipped', 'Multiplacers, tweezers, wax, trays and coasters are recognised by product type and left out.'],
           ['Status comes from fulfilment', 'Shipped orders arrive as Received, not started. Anything still processing arrives as Not received.'],
           ['Prices are worked out where they can be', 'A kit ordered on its own takes the order total exactly. Several kits with no accessories split the total between them. Otherwise the catalogue list price is used, and every project says which it got.']]
          .map(([t, b], i, a) => `<div class="row" style="align-items:flex-start;${i === a.length - 1 ? 'border-bottom:0' : ''}">
            <span style="flex:1 1 auto"><span style="display:block;font-size:14px;font-weight:700">${h(t)}</span>
            <span style="display:block;margin-top:2px;font-size:13px;line-height:1.5;color:var(--ink-mute)">${h(b)}</span></span></div>`).join('')}
      </div>
    </div>
  </div>`;

  const input = document.getElementById('csv');
  input.onchange = async () => {
    const file = input.files[0]; if (!file) return;
    document.getElementById('drop').classList.add('on');
    try {
      const text = await file.text();
      S.importPreview = await api('/import/preview?shop=' + encodeURIComponent(S.importShop),
        { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text });
      S.importSel = new Set(S.importPreview.kits.filter((k) => !k.duplicate).map((k) => k.key));
      S.importTab = 'new';
      paintImportReview();
    } catch (e) {
      document.getElementById('drop').classList.remove('on');
      toast(e.message || 'Could not read that file');
    }
  };
}

function paintImportReview() {
  const P = S.importPreview, sum = P.summary;
  const kits = P.kits, tab = S.importTab;
  const visible = tab === 'all' ? kits : tab === 'new' ? kits.filter((k) => !k.duplicate)
                : tab === 'dupe' ? kits.filter((k) => k.duplicate) : [];
  const defs = [
    { k: 'received', label: 'Received, not started', test: (r) => !r.duplicate && r.status === 'received' },
    { k: 'notReceived', label: 'Not received', test: (r) => !r.duplicate && r.status === 'notReceived' },
    { k: 'none', label: 'Already in your logbook', test: (r) => r.duplicate }
  ];
  const groups = tab === 'skipped' ? [] : defs
    .map((g) => ({ ...g, items: visible.filter(g.test) })).filter((g) => g.items.length);
  const chosen = kits.filter((k) => S.importSel.has(k.key)).length;
  const allOn = chosen === sum.newKits && sum.newKits > 0;

  const tabs = [['new', 'New ' + sum.newKits], ['all', 'All ' + sum.kits],
                ['dupe', 'Logged ' + sum.duplicates], ['skipped', 'Skipped ' + sum.skipped]];

  $out.innerHTML = `
  <div class="screen reading">
    <div class="topbar">
      ${topbar('Review import', { backAct: 'importback', sub: true, right:
        `<button class="iconbtn" style="width:auto;padding:0 12px;margin-right:-12px;font-size:13px;font-weight:700;color:var(--accent)" data-act="toggleall">${allOn ? 'None' : 'Select all'}</button>` })}
      <div class="chiprow">${tabs.map(([k, l]) =>
        `<button class="chip" data-act="itab" data-k="${k}" aria-pressed="${tab === k}">${h(l)}</button>`).join('')}</div>
    </div>

    <div class="scroll pad" style="padding-bottom:20px">
      ${tab === 'new' ? `
        <div class="tiles" style="margin-top:16px">
          <div class="tile"><div class="big tnum">${sum.orders}</div><div class="cap">orders read</div></div>
          <div class="tile"><div class="big tnum">${sum.kits}</div><div class="cap">canvases found</div></div>
          <div class="tile" style="background:var(--st-received)"><div class="big tnum">${sum.received}</div><div class="cap">received, not started</div></div>
          <div class="tile" style="background:var(--st-notReceived)"><div class="big tnum">${sum.notReceived}</div><div class="cap">not received yet</div></div>
        </div>
        ${sum.pricing ? `<div class="notice" style="margin-top:12px">${svg('info', 18)}
          <span><strong>${sum.pricing.exact + sum.pricing.allocated}</strong> of these get a price worked out from what you actually paid${
            sum.pricing.list ? `; the other <strong>${sum.pricing.list}</strong> fall back to today's list price because their order also held accessories` : ''}.</span></div>` : ''}
        ${sum.flagged.map((f) => `<div class="notice warn" style="margin-top:12px">${svg('info', 18)}
          <span>Order ${h(f.ref)} is marked <strong>${h(f.status.replace(/_/g, ' '))}</strong>, so its ${money(f.total)} total may not be what you paid.</span></div>`).join('')}
        ${P.warnings.map((w) => `<div class="notice warn" style="margin-top:12px">${svg('info', 18)}<span>${h(w)}</span></div>`).join('')}
      ` : ''}

      ${tab === 'dupe' && sum.fillable ? `
        <div class="notice" style="margin-top:16px">${svg('info', 18)}
          <span>These are already in your logbook, so nothing here will be added again.
            <strong>${sum.fillable}</strong> of them have blanks this order history can fill —
            when you ordered them, above all. Nothing you have typed is touched.</span></div>
        <button class="btn primary wide" style="margin-top:10px" data-act="importfill">
          Fill in ${sum.fillable} project${sum.fillable === 1 ? '' : 's'}</button>
      ` : ''}

      ${tab === 'skipped' ? `
        <section class="group" data-status="none" style="margin-top:16px">
          <header><span class="dot" style="background:var(--ink-faint)"></span>
            <h2>Not canvas kits</h2><span class="n tnum">${P.skipped.length}</span></header>
          <div class="group-body">${P.skipped.map((s) => `
            <div class="checkrow" data-locked="true">
              <span style="flex:1 1 auto;min-width:0">
                <span style="display:block;font-family:var(--serif);font-weight:600;font-size:15px">${h(s.title)}</span>
                <span style="display:block;margin-top:2px;font-size:11px;color:var(--ink-mute)" class="tnum">${h(s.orderRef)} · ${h(s.reason)}</span>
              </span></div>`).join('')}</div>
        </section>` : ''}

      ${groups.map((g) => `
        <section class="group${g.items.length ? '' : ' empty-sect'}" data-status="${g.k}">
          <header><span class="dot" style="background:${g.k === 'none' ? 'var(--ink-faint)' : stDot(g.k)}"></span>
            <h2>${h(g.label)}</h2><span class="n tnum">${g.items.length}</span></header>
          <div class="group-body">${g.items.map((r) => importRow(r)).join('')}</div>
        </section>`).join('')}
    </div>

    <div class="actionbar" style="flex-direction:column;gap:8px">
      <button class="btn primary wide" data-act="commit" ${chosen ? '' : 'disabled'}>${
        chosen ? `Import ${chosen} project${chosen === 1 ? '' : 's'}` : 'Nothing selected'}</button>
      <p style="margin:0;font-size:11px;line-height:1.45;text-align:center;color:var(--ink-mute)">
        Covers download as they save. Every project records how its price was worked out.</p>
    </div>
  </div>`;
}

const importRow = (r) => {
  const on = S.importSel.has(r.key);
  const choices = (r.alternatives || []).length;
  // the badge IS the way to change which canvas this line means
  const badge = r.duplicate ? ['In logbook', 'var(--sunken)', 'var(--ink-mute)']
    : r.uncertain ? [`${choices} to pick from`, 'var(--danger-bg)', 'var(--danger)']
    : choices > 1 ? [`${choices} match`, 'var(--sunken)', 'var(--ink-mid)']
    : ['Change', 'var(--sunken)', 'var(--ink-mute)'];
  return `
  <div class="checkrow" role="checkbox" aria-checked="${on}" data-locked="${r.duplicate}">
    <button class="rowmain" ${r.duplicate ? 'disabled' : `data-act="pick" data-k="${h(r.key)}"`}>
      <span class="box">${svg('tick', 13, 3.2).replace('currentColor', '#fff')}</span>
      ${r.cover ? `<span class="thumb" style="width:44px;height:44px;border-radius:8px">
          <img src="${h(sized(r.cover, 120))}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>` : ''}
      <span style="flex:1 1 auto;min-width:0;text-align:left">
        <span style="display:block;font-family:var(--serif);font-weight:600;font-size:15px;line-height:1.25">${h(r.title)}</span>
        <span style="display:block;margin-top:2px;font-size:11px;color:var(--ink-mute)" class="tnum">${
          h(r.status === 'received' ? 'Received' : 'Not received')}${r.artist ? ' · ' + h(r.artist) : ''}${
          r.drills ? ' · ' + num(r.drills) : ''}</span>
      </span>
    </button>
    ${r.duplicate
      ? `<span class="badge" style="background:${badge[1]};color:${badge[2]}">${badge[0]}</span>`
      : `<button class="badge chooser" data-act="choose" data-k="${h(r.key)}"
                 style="background:${badge[1]};color:${badge[2]}"
                 aria-label="Choose which canvas this is">${badge[0]}
          ${svg('chev', 10, 2.6)}</button>`}
  </div>`;
};

/** Sheet listing every product a CSV line could mean. */
function paintStatusMenu() {
  document.querySelector('.status-sheet')?.remove();
  document.querySelector('.status-backdrop')?.remove();
  const id = S.statusFor;
  if (!id) return;
  const project = S.projects.find((x) => String(x.id) === String(id));
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="sheet-backdrop status-backdrop" data-act="closestatus"></div>
    <div class="sheet status-sheet">
      <div class="grab"></div>
      <div class="pad" style="padding-bottom:6px"><h2 style="font-size:19px">Status</h2></div>
      <div class="pad" style="padding-bottom:calc(16px + var(--safe-b))">
        ${ALL_STATUSES.map((k) => `
          <button class="checkrow" data-act="setstatus" data-id="${id}" data-k="${k}"
                  style="min-height:52px"${project && project.status === k ? ' aria-current="true"' : ''}>
            <span class="dot" style="background:${stDot(k)}"></span>
            <span style="flex:1 1 auto;text-align:left">${h(STATUS[k].label)}</span>
            ${project && project.status === k ? svg('tick', 17) : ''}
          </button>`).join('')}
      </div>
    </div>`;
  while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
}

function paintChooser() {
  const r = S.chooserFor;
  if (!r) { document.querySelector('.sheet-backdrop')?.remove(); document.querySelector('.sheet')?.remove(); return; }
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="sheet-backdrop" data-act="closechoose"></div>
    <div class="sheet">
      <div class="grab"></div>
      <div class="pad" style="padding-bottom:12px">
        <h2 style="font-size:20px">Which one did you buy?</h2>
        <p style="margin:6px 0 0;font-size:13px;color:var(--ink-mute)">
          Your order just says &ldquo;${h(r.rawTitle)}&rdquo;, and ${r.alternatives.length} products share that name.</p>
      </div>
      <div class="pad" style="padding-bottom:10px">
        <div class="search">
          ${svg('search', 18)}
          <input id="altq" placeholder="Or search all shops" autocomplete="off">
        </div>
      </div>
      <div class="scroll pad" style="padding-bottom:calc(20px + var(--safe-b))" id="altlist">
        ${(r.alternatives || []).map((a, i) => `
          <button class="checkrow" style="margin-bottom:8px" aria-checked="${a.chosen}"
                  data-act="pickalt" data-k="${h(r.key)}" data-i="${i}">
            <span class="box">${svg('tick', 13, 3.2).replace('currentColor', '#fff')}</span>
            ${a.cover ? `<span class="thumb" style="width:44px;height:44px;border-radius:8px">
              <img src="${h(sized(a.cover, 120))}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>` : ''}
            <span style="flex:1 1 auto;min-width:0">
              <span style="display:block;font-family:var(--serif);font-weight:600;font-size:15px">${h(a.title || r.title)}</span>
              <span style="display:block;margin-top:2px;font-size:11px;color:var(--ink-mute)" class="tnum">${
                h(a.artist || 'no artist listed')}${a.drills ? ' · ' + num(a.drills) + ' drills' : ''}</span>
            </span>
            <span class="badge tnum" style="background:var(--sunken);color:var(--ink-mid)">${money(a.price, displayCurrency(a.shop, a.currency, S.prefs.currency))}</span>
          </button>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(wrap.firstElementChild);
  document.body.appendChild(wrap.firstElementChild);

  const q = document.getElementById('altq');
  if (!q) return;
  let t;
  q.oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const term = q.value.trim();
      const list = document.getElementById('altlist');
      if (term.length < 2) { S.chooserFor = r; paintChooserList(r.alternatives || []); return; }
      list.innerHTML = `<p style="font-size:13px;color:var(--ink-mute)">Searching…</p>`;
      const hits = await api('/catalogue/search?q=' + encodeURIComponent(term) + '&limit=25').catch(() => []);
      S.chooserHits = hits.map(c => ({ handle: c.handle, title: c.title, artist: c.artist,
        price: c.price, currency: c.currency, cover: c.image, drills: c.drills, colors: c.colors,
        shape: c.shape, coverage: c.coverage, width_in: c.width_in, height_in: c.height_in,
        special: c.special, shop: c.shop, chosen: false }));
      paintChooserList(S.chooserHits, true);
    }, 260);
  };
}

function paintChooserList(items, fromSearch) {
  const list = document.getElementById('altlist');
  if (!list) return;
  const r = S.chooserFor;
  list.innerHTML = items.length ? items.map((a, i) => `
    <button class="checkrow" style="margin-bottom:8px" aria-checked="${!!a.chosen}"
            data-act="pickalt" data-k="${h(r.key)}" data-i="${i}" data-src="${fromSearch ? 'search' : 'alt'}">
      <span class="box">${svg('tick', 13, 3.2).replace('currentColor', '#fff')}</span>
      ${a.cover ? `<span class="thumb" style="width:44px;height:44px;border-radius:8px">
        <img src="${h(sized(a.cover, 120))}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>` : ''}
      <span style="flex:1 1 auto;min-width:0">
        <span style="display:block;font-family:var(--serif);font-weight:600;font-size:15px">${h(a.title || r.title)}</span>
        <span style="display:block;margin-top:2px;font-size:11px;color:var(--ink-mute)" class="tnum">${
          h(a.artist || 'no artist listed')}${a.drills ? ' · ' + num(a.drills) + ' drills' : ''}</span>
      </span>
      <span class="badge tnum" style="background:var(--sunken);color:var(--ink-mid)">${money(a.price, displayCurrency(a.shop, a.currency, S.prefs.currency))}</span>
    </button>`).join('')
    : `<p style="font-size:13px;color:var(--ink-mute)">Nothing found.</p>`;
}

/* ============================================================ #/browse */
route(/^#\/browse$/, async () => {
  const shops = await api('/shops');
  if (!S.facets) S.facets = await api('/catalogue/facets').catch(() => null);
  paintBrowse(shops);
  // returning from a project keeps what you had: filters and results. Where you
  // were in them is remembered for every screen alike, by render().
  if (S.browse.loaded && S.browse.items.length) paintBrowseBody();
  else loadBrowse(true);
});

const SIZE_BUCKETS = [
  { k: 'sml', label: 'Up to 40cm', minCm: null, maxCm: 40 },
  { k: 'med', label: '40–60cm',    minCm: 40,   maxCm: 60 },
  { k: 'lrg', label: '60–80cm',    minCm: 60,   maxCm: 80 },
  { k: 'xl',  label: '80cm+',      minCm: 80,   maxCm: null }
];
const SORTS = [
  { k: 'relevance', label: 'Best match' }, { k: 'name', label: 'A–Z' },
  { k: 'price', label: 'Cheapest' }, { k: 'priceDesc', label: 'Dearest' },
  { k: 'size', label: 'Biggest' }, { k: 'drills', label: 'Most drills' }
];
const browseActive = () => {
  const B = S.browse;
  return (B.shape ? 1 : 0) + (B.size ? 1 : 0) + (B.maxPrice ? 1 : 0)
       + (B.inStock ? 1 : 0) + (B.sort !== 'relevance' ? 1 : 0);
};

let browseShops = [];
function paintBrowse(shops) {
  if (shops) browseShops = shops;
  const B = S.browse;
  const chips = [{ id: null, name: 'All shops', kits: browseShops.reduce((n, s) => n + s.kits, 0) }]
    .concat(browseShops.filter(s => s.kits));

  $out.innerHTML = `
  <div class="screen wide">
    <div class="topbar">
      ${topbar('Add from catalogue', { back: '#/', sub: true })}
      <div class="search">
        ${svg('search', 18)}
        <input id="bq" value="${h(B.q)}" placeholder="Search ${chips[0].kits.toLocaleString()} kits by name or artist" autocomplete="off">
      </div>
      <div class="chiprow">${chips.map((c) => `
        <button class="chip" data-act="bshop" data-k="${c.id || ''}"${c.id ? ` data-shop="${h(c.id)}"` : ''}
                aria-pressed="${B.shop === (c.id || null)}">
          <span>${h(c.name)}</span><span class="n tnum">${c.kits.toLocaleString()}</span></button>`).join('')}
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="chip" data-act="bfilters" aria-pressed="${B.open || browseActive() > 0}" style="flex:0 0 auto">
          ${svg('filter', 15)}<span>Filters</span>${browseActive() ? `<span class="n tnum">${browseActive()}</span>` : ''}
        </button>
        <span style="font-size:12px;color:var(--ink-mute);margin-left:auto" id="browsecount"></span>
      </div>
      ${B.open ? browseFilters() : ''}
    </div>
    <div class="scroll pad" id="browsebody" style="padding-bottom:24px"></div>
  </div>`;

  bindPrice();
  const q = document.getElementById('bq');
  let t;
  q.oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => { S.browse.q = q.value; forgetScroll('#/browse'); loadBrowse(true); }, 260);
  };
  paintBrowseBody();
}

function bindPrice() {
  const el = document.getElementById('bprice');
  if (!el) return;
  el.oninput = () => {
    const v = Number(el.value) || 0;
    S.browse.maxPrice = v > 0 ? v : null;
    const label = el.previousElementSibling?.lastElementChild;
    if (label) label.textContent = v > 0 ? money(v) : 'any price';
  };
  el.onchange = () => { S.browse.scroll = 0; loadBrowse(true); paintBrowse(); bindPrice(); };
}

function browseFilters() {
  const B = S.browse, f = S.facets || { maxPrice: 200 };
  const row = (label, inner) => `
    <div style="margin-top:12px">
      <span class="label" style="margin-bottom:6px">${label}</span>
      <div class="chiprow" style="margin:0;padding:0;flex-wrap:wrap;gap:6px">${inner}</div>
    </div>`;
  const chip = (act, k, label, on) =>
    `<button class="chip" style="height:36px;padding:0 12px" data-act="${act}" data-k="${k}" aria-pressed="${on}">${h(label)}</button>`;
  return `
  <div class="panel" style="padding:12px 14px 16px;margin-top:2px">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <span class="label" style="margin:0">Filters${browseActive() ? ` · ${browseActive()} on` : ''}</span>
      <button class="btn ghost" style="height:32px;font-size:12px;font-weight:700;padding:0 12px"
              data-act="bclear" ${browseActive() ? '' : 'disabled'}>Clear all</button>
    </div>
    ${row('Drill shape', ['Round', 'Square'].map((sh) => chip('bshape', sh, sh, B.shape === sh)).join(''))}
    ${row('Canvas size (longest edge)', SIZE_BUCKETS.map((b) => chip('bsize', b.k, b.label, B.size === b.k)).join(''))}
    ${row('Sort by', SORTS.map((o) => chip('bsort', o.k, o.label, B.sort === o.k)).join(''))}
    <div style="margin-top:14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between">
        <span class="label" style="margin:0">Up to</span>
        <span class="tnum" style="font-size:13px;font-weight:700">${
          B.maxPrice ? money(B.maxPrice) : 'any price'}</span>
      </div>
      <input type="range" id="bprice" min="0" max="${f.maxPrice}" step="5" value="${B.maxPrice || 0}">
    </div>
    <button class="chip" style="margin-top:6px;height:40px" data-act="bstock" aria-pressed="${B.inStock}">
      ${svg('tick', 14, 3)}<span>In stock only</span></button>
  </div>`;
}

function paintBrowseBody() {
  const B = S.browse;
  const body = document.getElementById('browsebody');
  if (!body) return;
  wirePull(body.closest('.screen') || body, body);
  // an empty result is exactly when you might want to fetch the shops again,
  // so the indicator belongs on that screen too
  const pull = `<div class="pull" id="pull"><span id="pulltext"></span></div>`;
  if (!B.items.length) {
    body.innerHTML = pull + (B.loading
      ? `<p style="margin:28px 0;text-align:center;color:var(--ink-mute);font-size:13px">Looking…</p>`
      : `<div class="empty">${svg('search', 36, 1.4)}<h2>Nothing found</h2>
         <p>Try a different name, or pick another shop.</p></div>`);
    return;
  }
  const countEl = document.getElementById('browsecount');
  if (countEl) countEl.textContent = B.items.length
    ? `${B.items.length}${B.more ? '+' : ''} kit${B.items.length === 1 ? '' : 's'}` : '';
  body.innerHTML = pull + `
    <div class="group-body" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));padding:16px 0 0">
      ${B.items.map((c, i) => `
        <button class="card cat-card" style="flex-direction:column" data-act="pickcat" data-i="${i}"${
          c.shop ? ` data-shop="${h(c.shop)}"` : ''}>
          <span class="thumb" style="width:100%;height:130px">${
            c.image ? `<img src="${h(sized(c.image, 400))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</span>
          <span class="body">
            <span class="name">${h(c.title)}</span>
            <span class="who" style="display:flex;align-items:center;gap:6px">
              ${c.shop ? `<span class="pip" data-shop="${h(c.shop)}"></span>` : ''}
              <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${
                h(c.artist || (shopById(c.shop) || {}).name || '')}</span>
            </span>
            <span class="tags">
              ${c.width_in ? `<span class="tag tnum">${Math.round(c.width_in*2.54)}×${Math.round(c.height_in*2.54)}cm</span>` : ''}
              ${c.shape ? `<span class="tag">${h(c.shape)}</span>` : ''}
            </span>
            <span class="facts tnum">
              ${c.price != null ? `<span style="font-weight:700;color:var(--ink)">${
                money(c.price, displayCurrency(c.shop, c.currency, S.prefs.currency))}</span>` : ''}
              ${c.drills ? `<span>${num(c.drills)} drills</span>` : ''}
              ${!c.available ? `<span style="color:var(--ink-faint)">sold out</span>` : ''}
            </span>
          </span>
        </button>`).join('')}
    </div>
    ${B.more ? `<button class="btn ghost wide" style="margin-top:14px" data-act="bmore">${
      B.loading ? 'Loading…' : 'Show more'}</button>` : ''}`;
}

async function loadBrowse(reset) {
  const B = S.browse;
  if (B.loading) return;
  if (reset) { B.items = []; B.offset = 0; B.more = true; }
  B.loading = true; paintBrowseBody();
  const params = new URLSearchParams({ limit: '24', offset: String(B.offset) });
  if (B.shop) params.set('shop', B.shop);
  if (B.shape) params.set('shape', B.shape);
  if (B.maxPrice) params.set('maxPrice', String(B.maxPrice));
  if (B.inStock) params.set('inStock', '1');
  if (B.sort && B.sort !== 'relevance') params.set('sort', B.sort);
  const bucket = SIZE_BUCKETS.find((x) => x.k === B.size);
  if (bucket) {
    if (bucket.minCm) params.set('minCm', String(bucket.minCm));
    if (bucket.maxCm) params.set('maxCm', String(bucket.maxCm));
  }
  const path = B.q.trim().length >= 2
    ? `/catalogue/search?q=${encodeURIComponent(B.q.trim())}&${params}`
    : `/catalogue/browse?${params}`;
  try {
    const rows = await api(path);
    B.items = B.items.concat(rows);
    B.offset += rows.length;
    B.more = rows.length >= 24;
  } catch (e) { toast(e.message); B.more = false; }
  B.loading = false;
  B.loaded = true;
  paintBrowseBody();
}

/* ========================================================== #/summary */
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const SUMMARY = { year: null, month: null };

const hoursText = (h) => {
  const n = Number(h) || 0;
  if (n < 1) return Math.round(n * 60) + 'm';
  return (Math.round(n * 10) / 10).toLocaleString('en-GB') + 'h';
};
// the app already reads a span as "9 days", "3 weeks", "2 months" — same voice here
const spanText = (d) => daysText(null, null, d);

route(/^#\/summary$/, async () => {
  const params = new URLSearchParams();
  if (SUMMARY.year) params.set('year', SUMMARY.year);
  if (SUMMARY.year && SUMMARY.month) params.set('month', SUMMARY.month);
  const s = await api('/summary' + (params.toString() ? '?' + params : ''));
  const t = s.totals, r = s.records;
  const held = s.heldAmongFinished > 0;

  const periodName = !SUMMARY.year ? 'All time'
    : SUMMARY.month ? `${MONTHS[Number(SUMMARY.month) - 1]} ${SUMMARY.year}`
    : String(SUMMARY.year);

  /* A tile reading zero is a category you have nothing in yet — noise rather
     than information — so it waits until there is something to say. */
  const tile = (n, value, cap, bg) => !n ? ''
    : `<div class="tile"${bg ? ` style="background:${bg}"` : ''}>
       <div class="big tnum">${value}</div><div class="cap">${cap}</div></div>`;
  const tiles = (...cells) => {
    const on = cells.filter(Boolean);
    return on.length ? `<div class="tiles">${on.join('')}</div>` : '';
  };

  /* A record is worth nothing if you cannot get to the canvas it is about, so
     every row opens the project. */
  /* A canvas is recognised by its dimensions, not by its area in square
     centimetres — the area is only how the biggest and smallest were picked. */
  const sizeOf = (x) => (x.width_in && x.height_in)
    ? `${cm(x.width_in)} \u00d7 ${cm(x.height_in)} cm` : '\u2014';

  const rec = (label, x, fmt) => x ? `
    <button class="row" data-go="#/p/${x.id}" style="width:100%;text-align:left">
      <span class="k" style="color:var(--ink-mute);flex:1 1 auto;min-width:0;display:block">
        <span style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em">${h(label)}</span>
        <span style="display:flex;align-items:center;gap:7px;color:var(--ink);font-size:14px;margin-top:3px">
          ${x.shop ? `<span class="pip" data-shop="${h(x.shop)}"></span>` : ''}
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(x.title)}</span></span>
      </span>
      <span class="v tnum" style="white-space:nowrap;font-weight:700">${fmt(x.value, x)}</span>
    </button>` : '';

  /* A most/least pair that lands on the same canvas is the same fact printed
     twice — which is what one finished project gives you. It collapses to a
     single row, named for the thing rather than for the extreme. */
  const pair = (solo, mostLabel, mostRec, leastLabel, leastRec, fmt) => {
    if (!mostRec && !leastRec) return '';
    if (!mostRec || !leastRec || mostRec.id === leastRec.id)
      return rec(solo, mostRec || leastRec, fmt);
    return rec(mostLabel, mostRec, fmt) + rec(leastLabel, leastRec, fmt);
  };

  const section = (title, rows, note) => {
    const body = rows.filter(Boolean).join('');
    return body ? `<div><h3 class="label">${h(title)}</h3>
      <div class="panel pad-in">${body}</div>
      ${note ? `<p style="margin:8px 2px 0;font-size:12px;line-height:1.5;color:var(--ink-mute)">${note}</p>` : ''}
    </div>` : '';
  };

  const chip = (label, on, act, k) =>
    `<button class="chip" style="height:36px;padding:0 12px" data-act="${act}"${
      k == null ? '' : ` data-k="${h(k)}"`} aria-pressed="${on}">${h(label)}</button>`;

  $out.innerHTML = `
  <div class="screen reading">
    <div class="topbar">${topbar('Summary', { back: '#/settings', sub: true })}</div>
    <div class="scroll pad stack" style="padding-top:18px;padding-bottom:26px">

      <div>
        <div class="chiprow" style="margin:0;padding:0;flex-wrap:wrap;gap:6px">
          ${chip('All time', !SUMMARY.year, 'sumyear', '')}
          ${s.years.map((y) => chip(y, SUMMARY.year === y, 'sumyear', y)).join('')}
        </div>
        ${SUMMARY.year && s.months.length ? `
        <div class="chiprow" style="margin:8px 0 0;padding:0;flex-wrap:wrap;gap:6px">
          ${chip('Whole year', !SUMMARY.month, 'summonth', '')}
          ${s.months.map((mm) => chip(MONTHS[Number(mm) - 1].slice(0, 3), SUMMARY.month === mm, 'summonth', mm)).join('')}
        </div>` : ''}
        <p style="margin:10px 2px 0;font-size:13px;font-weight:600;color:var(--ink-mid)">${h(periodName)}</p>
      </div>

      ${tiles(
        tile(t.done, num(t.done), 'paintings finished', 'var(--st-completed)'),
        tile(t.bought, num(t.bought), SUMMARY.year ? 'paintings bought' : 'paintings owned'),
        tile(t.placed, bigNum(t.placed), t.partial
          ? 'diamonds placed — finished canvases plus how far you are through the rest'
          : 'diamonds placed', 'var(--st-started)'),
        tile(t.days, num(t.days), `day${t.days === 1 ? '' : 's'} at the board`),
        tile(t.hours, hoursText(t.hours), 'hours logged'),
        tile(t.streak, num(t.streak), `day${t.streak === 1 ? '' : 's'} in a row — your longest run`),
        tile(t.sessions, num(t.sessions), `session${t.sessions === 1 ? '' : 's'}`),
        tile((t.spendBy || []).length, (t.spendBy || []).length
          ? money(t.spendBy[0].total, t.spendBy[0].currency) : '',
          `${SUMMARY.year ? 'spent on what you bought' : 'spent'}${(t.spendBy || []).length > 1
            ? ' · plus ' + t.spendBy.slice(1).map((x) => money(x.total, x.currency)).join(', ') : ''}`),
        tile(t.days && t.hours, hoursText(t.hours / (t.days || 1)), 'on an average day at it'),
        tile(t.everHeld, num(t.everHeld), 'put down and picked back up'),
        // the other half of the diamond picture, and only ever a whole-stash one
        tile(!SUMMARY.year && t.remaining, bigNum(t.remaining), 'still to place across the rest of the stash')
      )}
      ${SUMMARY.year && t.historyFrom ? `<p style="margin:-4px 2px 0;font-size:12px;line-height:1.5;color:var(--ink-mute)">
        Diamonds placed is counted from the progress you have recorded since ${h(dateText(t.historyFrom))}. Work done before that is in the totals but not in any month.</p>` : ''}
      ${SUMMARY.year && !t.historyFrom ? `<p style="margin:-4px 2px 0;font-size:12px;line-height:1.5;color:var(--ink-mute)">
        Diamonds placed in a month is counted from progress recorded from now on \u2014 move a project's progress and it will start filling in.</p>` : ''}
      ${t.undated ? `<p style="margin:-4px 2px 0;font-size:12px;line-height:1.5;color:var(--ink-mute)">
        ${num(t.undated)} project${t.undated === 1 ? ' has' : 's have'} no order or delivery date, so
        ${t.undated === 1 ? 'it belongs' : 'they belong'} to no year. That is why the years do not add up to All time.
        <button data-act="shownodates" style="color:var(--ink);font-weight:700;text-decoration:underline;font-size:12px">
          Show ${t.undated === 1 ? 'it' : 'them'}</button>
        <button data-act="backfilldates" style="color:var(--ink);font-weight:700;text-decoration:underline;font-size:12px;margin-left:10px">
          Use the day ${t.undated === 1 ? 'it was' : 'they were'} added</button></p>` : ''}

      ${section('Your stash', [
        pair('Canvas', 'Biggest', r.biggestSize, 'Smallest', r.smallestSize, (_v, x) => sizeOf(x)),
        pair('Diamonds', 'Most diamonds', r.mostDiamonds, 'Fewest diamonds', r.fewestDiamonds, (v) => bigNum(v)),
        rec('Dearest', r.dearest, (v, x) => money(v, x.currency)),
        rec('Best value', r.bestValue, (v, x) => money(v, x.currency) + '/1k')
      ], `Across everything you own. Best value is what a canvas cost per thousand diamonds \u2014 the only fair way to hold a small dear kit against a big cheap one.${
        s.currencies > 1 ? ` Dearest and best value are ranked among the kits you paid for in ${h(s.mainCurrency)}: without exchange rates, holding those against a price in another currency would be a guess.` : ''}`)}

      ${section('What you have finished', [
        pair('Canvas', 'Biggest', r.biggestFinished, 'Smallest', r.smallestFinished, (_v, x) => sizeOf(x)),
        pair('Diamonds', 'Most diamonds', r.mostDiamondsFinished, 'Fewest diamonds', r.fewestDiamondsFinished, (v) => bigNum(v)),
        pair('Start to finish', 'Longest, start to finish', r.longestDays,
             'Quickest, start to finish', r.shortestDays, spanText),
        /* Only worth their own lines when a hold could have made them differ:
           with nothing ever put down they are the same numbers again. */
        held ? pair('Not counting time put down', 'Longest, not counting time put down', r.longestDaysNet,
                    'Quickest, not counting time put down', r.shortestDaysNet, spanText) : '',
        pair('Placing', 'Fastest placing', r.fastest, 'Most unhurried', r.slowest, (v) => bigNum(v) + '/h')
      ], 'Calendar days between starting and finishing, and diamonds an hour across the ones you also timed.')}

      ${section('Time at the board', [
        pair('Hours', 'Most hours', r.mostHours, 'Fewest hours', r.fewestHours, hoursText),
        rec('Most sessions', r.mostSessions, (v) => num(v)),
        rec('Longest single sitting', r.longestSession, (v) => hoursText(v / 60)),
        rec('Longest put down', r.longestHeld, spanText)
      ], 'Hours come from the sessions you logged, so a hold cannot change them \u2014 nothing is logged while a canvas is put down.')}

      ${(s.favourites.artist || s.favourites.shop) ? `<div>
        <h3 class="label">Most of all</h3>
        <div class="panel pad-in">
          ${s.favourites.artist ? `<div class="row"><span class="k">Artist</span>
            <span class="v">${h(s.favourites.artist[0])} <span class="tnum" style="color:var(--ink-mute)">\u00d7${s.favourites.artist[1]}</span></span></div>` : ''}
          ${s.favourites.shop ? `<div class="row"><span class="k">Shop</span>
            <span class="v" style="display:flex;align-items:center;gap:7px">
              <span class="pip" data-shop="${h(s.favourites.shop[0])}"></span>
              ${h((shopById(s.favourites.shop[0]) || {}).name || s.favourites.shop[0])}
              <span class="tnum" style="color:var(--ink-mute)">\u00d7${s.favourites.shop[1]}</span></span></div>` : ''}
        </div>
      </div>` : ''}

      ${!t.done && !t.bought && !t.hours ? `<div class="empty">${svg('gem', 36, 1.4)}
        <h2>Nothing in ${h(periodName.toLowerCase())}</h2>
        <p>Pick another month, or a whole year.</p></div>` : ''}
    </div>
  </div>`;
});

/* ========================================================== #/settings */
route(/^#\/settings$/, async () => {
  const [state, stats, gaps, soft] = await Promise.all([
    api('/state'), api('/stats'), api('/projects/backfill-dates').catch(() => ({ candidates: 0 })),
    api('/projects/upgrade-covers').catch(() => ({ candidates: 0 }))]);
  const synced = state.catalogue.syncedAt ? dateText(state.catalogue.syncedAt.slice(0, 10)) : null;
  /* A fetch already under way when this screen is painted — because it started
     on launch, or because the screen was painted again — is picked back up
     rather than looking like nothing is happening. */
  if (soft.running) setTimeout(() => watchCovers(soft.running), 0);
  setTimeout(() => {
    const r = document.getElementById('restore');
    if (!r) return;
    r.onchange = async () => {
      const f = r.files[0]; if (!f) return;
      const box = document.getElementById('restorebox');
      box.innerHTML = `<p style="margin:10px 2px 0;font-size:12px;color:var(--ink-mute)">Restoring…</p>`;
      try {
        const res = await api('/restore', { method: 'POST', body: await f.text() });
        const bits = [`${res.added} added`];
        if (res.updated) bits.push(`${res.updated} updated (${res.fieldsChanged} fields)`);
        if (res.progress) bits.push(`${res.progress} progress entries`);
        if (res.skipped) bits.push(`${res.skipped} unchanged`);
        bits.push(`${res.photos} photos`);
        if (res.photosFailed) bits.push(`${res.photosFailed} photos could not be read`);
        bits.push(`${res.covers} covers fetched`);
        if (res.catalogueEmpty) bits.push('covers need the catalogue synced first');
        else if (res.coversMissing) bits.push(`${res.coversMissing} without a cover`);
        box.innerHTML = `<p style="margin:10px 2px 0;font-size:12px;line-height:1.5;color:var(--ink-mute)">${h(bits.join(' · '))}</p>`;
        toast(`${res.added} projects restored`);
      } catch (e) { box.innerHTML = ''; toast(e.message); }
    };
  }, 0);
  $out.innerHTML = `
  <div class="screen reading">
    <div class="topbar">${topbar('Settings', { back: '#/', sub: true })}</div>
    <div class="scroll pad stack" style="padding-top:18px;padding-bottom:26px">
      <p id="buildline" style="margin:0;font-size:11px;color:var(--ink-faint);text-align:center"></p>
      <button class="navcard" data-go="#/summary">
        ${svg('gem', 22, 1.3)}
        <span class="t"><b>Summary and records</b>
          <span>Totals and records, for all time or one month</span></span>
        ${svg('chev', 16, 2.2)}</button>

      <div class="tiles">
        <div class="tile"><div class="big tnum">${num(stats.projects)}</div>
          <div class="cap">projects${stats.wishlist ? ` · ${num(stats.wishlist)} wished for` : ''}</div></div>
        <div class="tile"><div class="big tnum">${num(stats.completed)}</div><div class="cap">completed</div></div>
        <div class="tile"><div class="big tnum">${num(Math.round(stats.hours))}</div><div class="cap">hours logged</div></div>
        <div class="tile"><div class="big tnum">${(stats.spendBy && stats.spendBy[0])
          ? money(stats.spendBy[0].total, stats.spendBy[0].currency) : money(stats.spend)}</div>
          <div class="cap">spent${(stats.spendBy || []).length > 1
            ? ' · plus ' + stats.spendBy.slice(1).map(x => money(x.total, x.currency)).join(', ')
            : ''}</div></div>
      </div>

      <div>
        <h3 class="label">Diamonds</h3>
        <div class="tiles">
          <div class="tile" style="background:var(--st-completed)">
            <div class="big tnum">${bigNum(stats.placed)}</div>
            <div class="cap">placed so far — every finished canvas plus how far you are through the ones on the go</div>
          </div>
          <div class="tile" style="background:var(--st-notReceived)">
            <div class="big tnum">${bigNum(stats.remaining)}</div>
            <div class="cap">still to place across the rest of the stash</div>
          </div>
        </div>
        <div class="progressline" style="margin-top:10px"><i style="width:${
          stats.drills ? Math.round(stats.placed / stats.drills * 100) : 0}%"></i></div>
        <p style="margin:8px 2px 0;font-size:12px;line-height:1.5;color:var(--ink-mute)" class="tnum">
          ${stats.drills ? Math.round(stats.placed / stats.drills * 100) : 0}% of ${bigNum(stats.drills)} diamonds${
            stats.estimatedCounts ? ` · ${stats.estimatedCounts} project${stats.estimatedCounts === 1 ? '' : 's'} use a count estimated from canvas size` : ''}</p>
      </div>

      ${stats.topArtists.length ? `<div>
        <h3 class="label">Most collected artists</h3>
        <div class="panel pad-in">${stats.topArtists.map((a) =>
          `<div class="row"><span class="k" style="color:var(--ink)">${h(a.artist)}</span><span class="v tnum">${a.n}</span></div>`).join('')}</div>
      </div>` : ''}

      ${(stats.topShops || []).length ? `<div>
        <h3 class="label">Most bought from</h3>
        <div class="panel pad-in">${stats.topShops.map((sh) => {
          const share = stats.projects ? Math.round(sh.n / stats.projects * 100) : 0;
          const sid = (SHOP_BY_NAME[sh.shop] || {}).id;
          return `<div class="row">
            <span class="k" style="color:var(--ink);flex:1 1 auto;min-width:0;display:block">
              <span style="display:flex;align-items:center;gap:7px">${
                sid ? `<span class="pip" data-shop="${h(sid)}"></span>` : ''}${h(sh.shop)}</span>
              <span style="display:block;margin-top:5px;height:4px;border-radius:999px;background:var(--sunken);overflow:hidden">
                <span style="display:block;height:100%;width:${share}%;background:${
                  sid ? `var(--shop-${sid})` : 'var(--accent)'}"></span></span>
            </span>
            <span class="v tnum" style="white-space:nowrap">${sh.n}
              <span style="color:var(--ink-mute);font-weight:400">${sh.spend ? ' · ' + money(sh.spend) : ''}</span></span>
          </div>`;
        }).join('')}</div>
      </div>` : ''}

      <div>
        <h3 class="label">Shop catalogues</h3>
        <div class="panel pad-in">
          ${(state.catalogue.shops || []).map((sh) => {
            const off = (S.prefs.excluded || []).includes(sh.id);
            return `<div class="row" style="gap:10px">
              <button data-act="shoptoggle" data-k="${sh.id}" aria-pressed="${!off}"
                      style="display:flex;align-items:center;gap:9px;flex:1 1 auto;min-width:0;text-align:left">
                <span class="switch" aria-hidden="true"><i></i></span>
                <span style="min-width:0">
                  <span style="display:flex;align-items:center;gap:7px;color:${off ? 'var(--ink-faint)' : 'var(--ink)'};font-size:13px">
                    <span class="pip" data-shop="${sh.id}"></span>${h(sh.name)}</span>
                  <span style="display:block;font-size:11px;color:var(--ink-mute)" class="tnum">${
                    sh.kits ? num(sh.kits) + ' kits' : 'not synced'}${off ? ' · hidden' : ''}</span>
                </span>
              </button>
              <button class="iconbtn syncone" data-act="syncone" data-k="${sh.id}"
                      title="Sync ${h(sh.name)}" aria-label="Sync ${h(sh.name)}">${svg('sync', 17)}</button>
            </div>`;
          }).join('')}
          <div class="row">
            <span class="k" style="font-weight:700;color:var(--ink)">Total</span>
            <span class="v tnum">${num(state.catalogue.kits)} kits</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:10px">
          <button class="btn ghost" style="height:40px;font-size:13px;padding:0 14px" data-act="sync">${
            synced ? 'Update all shops' : 'Download catalogues'}</button>
          <span style="font-size:12px;color:var(--ink-mute)">${synced ? 'Last checked ' + synced : 'About a minute'}</span>
        </div>
        <div id="syncbox"></div>
        <p style="margin:8px 2px 0;font-size:12px;line-height:1.5;color:var(--ink-mute)">
          Switch a shop off to keep it out of browse, search and "Update all shops" — its sync icon still
          works if you want to refresh it anyway.
          Reads each shop's public product listing so kits can be matched and searched with no connection.
          Covers are cached the first time a project uses one. Artwork stays the copyright of the artists —
          this is for your own logbook.</p>
      </div>

      <div>
        <h3 class="label">You shop in</h3>
        <div class="seg">${CURRENCIES.map((c) =>
          `<button data-act="cur" data-k="${c}" aria-pressed="${S.prefs.currency === c}">${SYMBOL[c]} ${c}</button>`).join('')}</div>
        <p style="margin:8px 2px 0;font-size:12px;line-height:1.5;color:var(--ink-mute)">
          Most of these shops quote the same figure in every market — Diamond Art Club's 62.99 is $62.99
          in the US and £62.99 here, which their receipts confirm. Mystical Dream Diamonds is different:
          it prices in Canadian dollars, so its kits are shown as CA$ and converted by your card, not by us.</p>
      </div>

      <div>
        <h3 class="label">Appearance</h3>
        <div class="seg">${THEMES.map(([k, l]) =>
          `<button data-act="theme" data-k="${k}" aria-pressed="${themeMode() === k}">${l}</button>`).join('')}</div>
      </div>

      <div>
        <h3 class="label">Your data</h3>
        ${gaps.candidates ? `
        <div class="panel pad-in" style="margin-bottom:10px">
          <div class="row" style="align-items:flex-start">
            <span class="k" style="flex:1 1 auto;color:var(--ink)">
              <span style="display:block;font-weight:600">${num(gaps.candidates)} project${
                gaps.candidates === 1 ? ' has' : 's have'} no order date</span>
              <span style="display:block;margin-top:3px;font-size:12px;color:var(--ink-mute)">
                ${gaps.candidates === 1 ? 'It belongs' : 'They belong'} to no month, so the years never add up.
                Their real order dates are not recoverable.</span>
            </span>
          </div>
          <div style="display:flex;gap:8px;padding:4px 0 8px">
            <button class="btn ghost" style="flex:1 1 auto;height:40px;font-size:13px"
                    data-act="shownodates">Show them</button>
            <button class="btn ghost" style="flex:1 1 auto;height:40px;font-size:13px"
                    data-act="backfilldates">Use the day added</button>
          </div>
        </div>` : ''}
        ${soft.total ? `
        <div class="panel pad-in" style="margin-bottom:10px">
          <div class="row" style="align-items:flex-start">
            <span class="k" style="flex:1 1 auto;color:var(--ink)">
              <span style="display:block;font-weight:600" id="hificount">${
                num(soft.done)} of ${num(soft.total)} kit${
                soft.total === 1 ? '' : 's'} have full-size pictures</span>
              <span style="display:block;margin-top:3px;font-size:12px;color:var(--ink-mute)" id="hifiwhy">${
                soft.candidates
                  ? 'The rest were saved when pictures were fetched small. Fetching them again '
                    + 'needs a connection, and replaces them in place — about 1 MB a picture.'
                  : 'Every kit has the pictures the shop published.'}</span>
            </span>
          </div>
          <div class="progressline" style="margin:4px 0 2px"><i id="hifibar" style="width:${
            soft.total ? Math.round(soft.done / soft.total * 100) : 0}%"></i></div>
          ${soft.candidates ? `
          <div style="display:flex;gap:8px;padding:8px 0">
            <button class="btn ghost" style="flex:1 1 auto;height:40px;font-size:13px"
                    data-act="showsmallpics">Show the ${num(soft.candidates)} left</button>
            <button class="btn ghost" style="flex:1 1 auto;height:40px;font-size:13px"
                    data-act="upgradecovers"${soft.running ? ' disabled' : ''}>${
                      soft.running ? 'Fetching…' : 'Get the rest'}</button>
          </div>` : ''}
        </div>` : ''}
        <button class="btn primary wide" data-act="backup">Create a full backup</button>
        <div id="backupbox"></div>
        <p style="margin:8px 2px 0;font-size:12px;line-height:1.5;color:var(--ink-mute)">
          Projects and progress photos, in one file. Lands in your <strong>Downloads</strong> folder as
          <code>dazzle-diary-backup.json</code>. It is the only copy of your logbook that exists
          anywhere else, so take one now and then.</p>
        ${isStandalone() ? `
        <label class="btn ghost wide" style="margin-top:10px">Restore from a backup file
          <input type="file" accept=".json,application/json" id="restore" hidden></label>
        <div id="restorebox"></div>` : ''}
        <button class="btn ghost wide" style="margin-top:10px" data-act="export">Export logbook as CSV</button>
        <p style="margin:8px 2px 0;font-size:12px;line-height:1.5;color:var(--ink-mute)">
          A spreadsheet of the projects — no photos, so it is not a backup.</p>
        <p style="margin:8px 2px 0;font-size:12px;line-height:1.5;color:var(--ink-mute)">
          ${isStandalone()
            ? 'Everything lives inside this app on your phone. Nothing is sent anywhere.'
            : 'Everything lives in <code>data/logbook.db</code> on this phone. Copy that file to back it up.'}</p>

        <button class="btn ghost wide" style="margin-top:18px" data-go="#/licences">Open-source licences</button>

      </div>
    </div>
  </div>`;

  showBuild();
});

/* Which build is this? Without it, "the new thing is missing" and "you are
   running last week's APK" look exactly the same from the outside. */
async function showBuild() {
  const el = document.getElementById('buildline');
  if (!el) return;
  try {
    const res = await fetch('/version.json');
    if (!res.ok) return;
    const v = await res.json();
    el.textContent = `Dazzle Diary ${v.version} (${v.code}) · built ${String(v.built).slice(0, 10)}`;
  } catch { /* the served build has no stamp; say nothing rather than guess */ }
}

/* ========================================================= #/licences
   The two typefaces are under the SIL Open Font License, which allows them to
   be embedded provided the notice and licence travel with them. Each font's
   own licence file is shipped verbatim and shown here, rather than one shared
   copy — nothing then rests on a judgement that the two are interchangeable. */
const FONTS = [
  { name: 'Karla', file: 'karla-OFL.txt',
    copyright: 'Copyright 2019 The Karla Project Authors',
    url: 'https://github.com/googlefonts/karla' },
  { name: 'Newsreader', file: 'newsreader-OFL.txt',
    copyright: 'Copyright 2020 The Newsreader Project Authors',
    url: 'http://github.com/productiontype/Newsreader' }
];

route(/^#\/licences$/, async () => {
  $out.innerHTML = `
  <div class="screen reading">
    <div class="topbar">${topbar('Open-source licences', { back: '#/settings', sub: true })}</div>
    <div class="scroll pad stack" style="padding-top:18px;padding-bottom:26px">
      <p style="margin:0;font-size:13px;line-height:1.55;color:var(--ink-mid)">
        Dazzle Diary has no dependencies, but it sets its type in two open fonts.
        Both are under the SIL Open Font License 1.1, reproduced in full below.</p>
      ${FONTS.map((f) => `
        <div>
          <h3 class="label">${h(f.name)}</h3>
          <div class="panel pad-in">
            <p style="margin:0;font-size:13px;line-height:1.5">${h(f.copyright)}</p>
            <p style="margin:4px 0 0;font-size:12px;color:var(--ink-mute);word-break:break-all">${h(f.url)}</p>
            <p style="margin:8px 0 0;font-size:12px;color:var(--ink-mute)">
              Licensed under the SIL Open Font License, Version 1.1.</p>
            <details style="margin-top:10px">
              <summary style="font-size:13px;font-weight:700;cursor:pointer">Full licence text</summary>
              <pre class="licence" id="ofl-${h(f.file)}">Loading…</pre>
            </details>
          </div>
        </div>`).join('')}
    </div>
  </div>`;

  for (const f of FONTS) {
    const box = document.getElementById('ofl-' + f.file);
    if (!box) continue;
    try {
      const res = await fetch('/fonts/' + f.file);
      box.textContent = res.ok ? await res.text() : 'The licence file is missing from this build.';
    } catch { box.textContent = 'The licence file could not be read.'; }
  }
});

/* -------------------------------------------------------------- job runner */
async function runJob(jobId, box, done) {
  const tick = async () => {
    const j = await api('/jobs/' + jobId);
    const pctv = j.total ? Math.round(j.done / j.total * 100) : 0;
    box.innerHTML = `<div style="margin-top:12px">
      <div class="progressline"><i style="width:${j.state === 'done' ? 100 : pctv}%"></i></div>
      <p style="margin:8px 0 0;font-size:12px;color:var(--ink-mute)">${h(j.error || j.message || '')}</p></div>`;
    if (j.state === 'running') return setTimeout(tick, 500);
    if (j.state === 'error') return toast(j.error || 'That did not work');
    done?.(j);
  };
  tick();
}

/* --------------------------------------------------------------- dragging
   Long-press a card to pick it up, then drop it on another section to change
   its status. Pointer events rather than HTML5 drag-and-drop, which does not
   work on touch. Dates follow the new status, same as the edit form. */
const DRAG = { id: null, from: null, ghost: null, over: null, timer: null,
               startX: 0, startY: 0, live: false, pointerId: null, card: null };

function dragCleanup() {
  clearTimeout(DRAG.timer);
  try { if (DRAG.card && DRAG.pointerId != null) DRAG.card.releasePointerCapture(DRAG.pointerId); }
  catch { /* it was never captured, or the pointer is already gone */ }
  DRAG.ghost?.remove();
  document.querySelectorAll('.group.drop-on').forEach((g) => g.classList.remove('drop-on'));
  document.querySelector('.card.lifted')?.classList.remove('lifted');
  document.body.classList.remove('dragging');
  Object.assign(DRAG, { id: null, from: null, ghost: null, over: null, timer: null,
                        live: false, pointerId: null, card: null });
}

function groupUnder(x, y) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest('.group') : null;
}

document.addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.card[data-id]');
  if (!card || e.button === 2) return;
  DRAG.startX = e.clientX; DRAG.startY = e.clientY;
  DRAG.pointerId = e.pointerId; DRAG.card = card;
  DRAG.timer = setTimeout(() => {
    DRAG.id = card.dataset.id;
    DRAG.from = card.dataset.status;
    DRAG.live = true;
    document.body.classList.add('dragging');   // reveals the empty sections
    // a selection may already have started before the press was long enough
    try { window.getSelection()?.removeAllRanges(); } catch { /* older webview */ }
    card.classList.add('lifted');
    const r = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.className = 'card drag-ghost';
    ghost.style.width = r.width + 'px';
    ghost.style.left = r.left + 'px';
    ghost.style.top = r.top + 'px';
    document.body.appendChild(ghost);
    DRAG.ghost = ghost;
    /* Keep every later event for this finger, even once it leaves the card or
       the card is re-rendered underneath it. */
    try { card.setPointerCapture(DRAG.pointerId); } catch { /* mouse, or gone */ }
    if (navigator.vibrate) navigator.vibrate(12);
  }, 320);
}, { passive: true });

document.addEventListener('pointermove', (e) => {
  if (!DRAG.live) {
    // moved before the long press completed — treat it as a scroll, not a drag
    if (DRAG.timer && (Math.abs(e.clientX - DRAG.startX) > 8 || Math.abs(e.clientY - DRAG.startY) > 8)) {
      clearTimeout(DRAG.timer); DRAG.timer = null;
    }
    return;
  }
  DRAG.ghost.style.transform = `translate(${e.clientX - DRAG.startX}px, ${e.clientY - DRAG.startY}px)`;
  const g = groupUnder(e.clientX, e.clientY);
  if (g !== DRAG.over) {
    DRAG.over?.classList.remove('drop-on');
    DRAG.over = g && g.dataset.status !== DRAG.from ? g : null;
    DRAG.over?.classList.add('drop-on');
  }
}, { passive: false });

document.addEventListener('pointerup', async () => {
  if (!DRAG.live) { clearTimeout(DRAG.timer); DRAG.timer = null; return; }
  const target = DRAG.over, id = DRAG.id;
  dragCleanup();
  if (!target || !id) return;
  const status = target.dataset.status;
  const project = S.projects.find((p) => String(p.id) === String(id));
  if (!project || project.status === status) return;
  try {
    const patch = applyStatus(project, status, today());
    const saved = await api('/projects/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
    });
    Object.assign(project, saved);
    S.meta = await api('/state');
    paintLogbook();
    const dateKeys = Object.keys(patch).filter((k) => k.startsWith('date_'));
    const filled = dateKeys.filter((k) => patch[k]).length;
    const cleared = dateKeys.filter((k) => !patch[k]).length;
    const note = filled ? ' · dates filled in' : cleared ? ' · dates cleared' : '';
    toast(`${project.title} → ${statusOf(status).short}${note}`);
    // whoever just did it does not need to be told how
    if (!S.prefs.hints?.drag) { await seenHint('drag'); paintLogbook(); }
  } catch (e) { toast(e.message); render(); }
});

/* The one that mattered: preventDefault() on pointermove does NOT stop the
   page panning — only the touch event can, and only from a non-passive
   listener. Without this the WebView takes the first movement as a scroll,
   cancels the pointer, and the drag dies on the spot. */
document.addEventListener('touchmove', (e) => {
  if (DRAG.live) e.preventDefault();
}, { passive: false });

/* A long press on a card would otherwise raise the selection handles or the
   image menu, which is what "it selects instead of dragging" was. */
document.addEventListener('contextmenu', (e) => {
  if (DRAG.live || e.target.closest('.card[data-id]')) e.preventDefault();
});

document.addEventListener('pointercancel', dragCleanup);

/* ------------------------------------------------------------- delegation */
/* A date picker reports itself with `change`, never a click — the click that
   opened it happens long before there is an answer. Routed through the same
   handler so a date row behaves like every other control. */
document.addEventListener('change', (e) => {
  const el = e.target && e.target.closest && e.target.closest('[data-act="setdate"]');
  if (!el) return;
  handleClick({ target: el, type: 'change' }).catch((err) => {
    console.error(err);
    toast(err && err.message ? err.message : 'Something went wrong');
  });
});

document.addEventListener('click', (e) => { handleClick(e).catch((err) => {
  console.error(err);
  toast(err && err.message ? err.message : 'Something went wrong');
  document.querySelectorAll('.btn[disabled]').forEach((b) => { b.disabled = false; });
}); });

async function handleClick(e) {
  const backEl = e.target.closest('[data-back]');
  if (backEl) { back(backEl.dataset.back); return; }
  const goEl = e.target.closest('[data-go]');
  if (goEl) { go(goEl.dataset.go); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  /* A date row answers to `change`, never to the click that opened its picker.
     Without this the tap that opens the calendar also runs the save below,
     which re-renders the page and takes the input — and the picker with it —
     out from under the finger. That is what "it pops up and immediately
     disappears" was, and removing the label around the row did not touch it. */
  if (act === 'setdate' && e.type !== 'change') return;

  if (act === 'filter') { S.filter = el.dataset.k; repaintLogbook(); }
  else if (act === 'lbfilters') { S.lb.open = !S.lb.open; paintLogbook(); }
  else if (act === 'sumyear') {
    SUMMARY.year = el.dataset.k || null;
    SUMMARY.month = null;          // a year you have just picked has no month yet
    forgetScroll('#/summary'); render();
  }
  else if (act === 'summonth') { SUMMARY.month = el.dataset.k || null; forgetScroll('#/summary'); render(); }
  /* Straight from "seventeen projects have no date" to looking at the
     seventeen. Naming a filter and leaving you to find it is most of the work
     still to do. */
  /* The real order dates are gone. The day a kit was added to the logbook is the
     closest honest thing left, so it is offered rather than applied: it writes a
     date you did not choose into a record you keep on purpose. */
  else if (act === 'backfilldates') {
    const { candidates } = await api('/projects/backfill-dates');
    if (!candidates) { toast('Nothing to fill in'); return; }
    if (!confirm(`Set the order date on ${candidates} project${candidates === 1 ? '' : 's'} `
               + 'to the day it was added to the logbook? Their real order dates are not '
               + 'recoverable, and you can change any of them afterwards.')) return;
    const { filled } = await api('/projects/backfill-dates', { method: 'POST' });
    toast(`${filled} project${filled === 1 ? '' : 's'} dated`);
    render();
  }
  else if (act === 'upgradecovers') {
    el.disabled = true;
    el.textContent = 'Fetching…';
    try {
      const { job } = await api('/projects/upgrade-covers?job=1', { method: 'POST' });
      if (job) watchCovers(job);
    } catch (e) { toast(e.message); el.disabled = false; render(); }
  }
  else if (act === 'showsmallpics') {
    S.lb = { ...S.lb, gaps: 'pics', open: true };
    S.filter = 'all'; S.q = '';
    forgetScroll('#/');
    go('#/');
  }
  else if (act === 'shownodates') {
    S.lb = { ...S.lb, gaps: 'dates', open: true };
    S.filter = 'all'; S.q = '';
    forgetScroll('#/');
    go('#/');
  }
  else if (act === 'lbclear') {
    S.lb = { ...S.lb, shop: null, shape: null, size: null, rating: 0, gaps: null, sort: 'recent' };
    repaintLogbook();
  }
  else if (act === 'lbshop' || act === 'lbshape' || act === 'lbsize'
           || act === 'lbrating' || act === 'lbgaps' || act === 'lbsort') {
    const f = S.lb, k = el.dataset.k;
    // tapping the one that is already on turns it off again, as the catalogue does
    if (act === 'lbshop') f.shop = f.shop === k ? null : k;
    if (act === 'lbshape') f.shape = f.shape === k ? null : k;
    if (act === 'lbsize') f.size = f.size === k ? null : k;
    if (act === 'lbrating') f.rating = Number(k);
    if (act === 'lbgaps') f.gaps = f.gaps === k ? null : k;
    if (act === 'lbsort') f.sort = k;
    repaintLogbook();
  }
  else if (act === 'view') { S.view = el.dataset.k; localStorage.setItem('view', S.view); paintLogbook(); }
  else if (act === 'clearq') {
    S.q = '';
    const f = document.getElementById('q');
    if (f) { f.value = ''; f.focus(); }
    paintLogbookBody(); syncClear();
  }
  else if (act === 'backup') {
    const box = document.getElementById('backupbox');
    const say = (t) => { if (box) box.innerHTML = `<p style="margin:10px 2px 0;font-size:12px;color:var(--ink-mute)">${h(t)}</p>`; };
    el.disabled = true;
    try {
      say('Collecting projects…');
      const projects = await api('/projects');
      const photos = [];
      const sessions = [];
      const progress = [];
      let n = 0;
      for (const p of projects) {
        const full = await api('/projects/' + p.id);
        for (const se of (full.sessions || [])) sessions.push({ ...se, project_id: p.id });
        // when the work happened, which the current percentage cannot say
        for (const h of (full.progress_history || [])) progress.push({ ...h, project_id: p.id });
        for (const ph of (full.photos || [])) {
          say(`Shrinking photo ${++n}…`);
          const res = await fetch('/photos/' + encodeURIComponent(ph.file));
          if (!res.ok) continue;
          const small = await downscale(new File([await res.blob()], ph.file, { type: 'image/jpeg' }));
          const buf = new Uint8Array(await small.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
          photos.push({ ...ph, project_id: p.id, data: btoa(bin) });
        }
      }
      const json = JSON.stringify({ version: 3, exportedAt: new Date().toISOString(),
                                    projects, photos, sessions, progress });
      const blob = new Blob([json], { type: 'application/json' });
      say('Writing the file…');
      const where = await saveToPhone('dazzle-diary-backup.json', blob);
      say(`Saved to ${where} — ${projects.length} projects, ${photos.length} photos, ${
        sessions.length} sessions, ${progress.length} progress entries, ${
        (blob.size / 1048576).toFixed(1)} MB`);
      toast('Backup saved');
    } catch (e) { say(e.message); }
    el.disabled = false;
  }
  else if (act === 'export') {
    el.disabled = true;
    try {
      const r = await api('/export');
      // the server route answers with raw CSV, the local one with { __csv }
      const csv = (r && r.__csv) != null ? r.__csv : (typeof r === 'string' ? r : null);
      if (csv == null) throw new Error('Nothing to export');
      const where = await saveToPhone('dazzle-diary-export.csv', new Blob([csv], { type: 'text/csv' }));
      toast('Saved to ' + where);
    } catch (e) { toast(e.message); }
    el.disabled = false;
  }
  else if (act === 'shoptoggle') {
    const id = el.dataset.k;
    const list = new Set(S.prefs.excluded || []);
    list.has(id) ? list.delete(id) : list.add(id);
    S.prefs.excluded = [...list];
    await api('/prefs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ excluded: S.prefs.excluded }) });
    S.browse.loaded = false;                 // its results may no longer apply
    render();
  }
  else if (act === 'syncone') {
    const box = document.getElementById('syncbox');
    el.disabled = true;
    try {
      const { job } = await api('/catalogue/sync?shop=' + encodeURIComponent(el.dataset.k), { method: 'POST' });
      runJob(job, box, () => { toast('Updated'); S.browse.loaded = false; render(); });
    } catch (err) { el.disabled = false; toast(err.message); }
  }
  else if (act === 'cur') {
    S.prefs.currency = el.dataset.k;
    await api('/prefs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ currency: el.dataset.k }) });
    render();
  }
  else if (act === 'theme') {
    localStorage.setItem('theme', el.dataset.k);
    applyTheme(el.dataset.k);
    render();
  }
  else if (act === 'choose') {
    S.chooserFor = S.importPreview.kits.find(k => k.key === el.dataset.k);
    paintChooser();
  }
  else if (act === 'closechoose') { S.chooserFor = null; paintChooser(); }
  else if (act === 'pickalt') {
    const kit = S.importPreview.kits.find(k => k.key === el.dataset.k);
    const fromSearch = el.dataset.src === 'search';
    const alt = fromSearch ? S.chooserHits[Number(el.dataset.i)] : kit.alternatives[Number(el.dataset.i)];
    if (fromSearch) {
      kit.alternatives = [...(kit.alternatives || []).map(a => ({ ...a, chosen: false })), alt];
      Object.assign(kit, {
        shape: alt.shape ?? kit.shape, coverage: alt.coverage ?? kit.coverage,
        width_in: alt.width_in ?? kit.width_in, height_in: alt.height_in ?? kit.height_in,
        special: alt.special ?? kit.special, shop: alt.shop ?? kit.shop
      });
    }
    kit.alternatives.forEach(a => { a.chosen = a === alt; });
    Object.assign(kit, {
      handle: alt.handle, title: alt.title || kit.title, artist: alt.artist, cover: alt.cover,
      drills: alt.drills ?? null, colors: alt.colors ?? null,
      listPrice: alt.price, uncertain: false
    });
    if (kit.priceSource === 'catalogue' && alt.price != null) kit.price = alt.price;
    S.importSel.add(kit.key);
    S.chooserFor = null;
    paintChooser();
    paintImportReview();
    toast('Set to ' + (alt.artist || alt.title || 'that one'));
  }
  else if (act === 'bshop') { S.browse.shop = el.dataset.k || null; forgetScroll('#/browse'); paintBrowse(); loadBrowse(true); }
  else if (act === 'bfilters') { S.browse.open = !S.browse.open; paintBrowse(); paintBrowseBody(); bindPrice(); }
  else if (act === 'bclear') {
    Object.assign(S.browse, { shape: null, size: null, maxPrice: null, inStock: false, sort: 'relevance', scroll: 0 });
    paintBrowse(); loadBrowse(true); bindPrice();
  }
  else if (act === 'bshape' || act === 'bsize' || act === 'bsort' || act === 'bstock') {
    const B = S.browse;
    if (act === 'bshape') B.shape = B.shape === el.dataset.k ? null : el.dataset.k;
    if (act === 'bsize')  B.size  = B.size  === el.dataset.k ? null : el.dataset.k;
    if (act === 'bsort')  B.sort  = el.dataset.k;
    if (act === 'bstock') B.inStock = !B.inStock;
    forgetScroll('#/browse');   // a different set of kits, so the old place means nothing
    paintBrowse(); loadBrowse(true); bindPrice();
  }
  else if (act === 'bmore') { await loadBrowse(false); }
  else if (act === 'pickcat') {
    const pick = S.browse.items[Number(el.dataset.i)];
    S.fromCatalogue = pick;
    /* Adding a canvas you already have splits its hours, photos and progress
       between two rows, and the old flow gave you no hint until you recognised
       your own kit halfway through typing it in again. Owning two of the same
       canvas is a real thing though, so this is an offer, not a refusal. */
    const mine = await api('/projects/find?shop=' + encodeURIComponent(pick.shop || 'dac')
                         + '&handle=' + encodeURIComponent(pick.dac_handle || pick.handle || '')
                         + '&title=' + encodeURIComponent(pick.title || '')).catch(() => ({ id: null }));
    if (mine.id != null
        && confirm(`${mine.title} is already in your logbook. Open it?\n\n`
                 + 'Cancel to add a second copy.')) {
      S.fromCatalogue = null;
      go('#/p/' + mine.id);
      return;
    }
    go('#/new');
  }
  else if (act === 'importshop') { S.importShop = el.dataset.k; render(); }
  else if (act === 'importback') { forgetImport(); render(); }
  else if (act === 'itab') { S.importTab = el.dataset.k; paintImportReview(); }
  /* An order history knows when you bought things. The import only ever created
     what was missing, so the one question a logbook cannot answer for itself —
     when did I order this — went unanswered on every project already in it. */
  else if (act === 'importfill') {
    const kits = [...(S.importPreview.kits || []), ...(S.importPreview.skipped || [])]
      .filter((k) => k.fillCount > 0);
    if (!kits.length) { toast('Nothing to fill in'); return; }
    el.disabled = true;
    try {
      const r = await api('/import/fill', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kits }) });
      toast(r.filled ? `${r.filled} project${r.filled === 1 ? '' : 's'} filled in · ${r.fields} fields`
                     : 'Nothing needed filling in');
      forgetImport();
      go('#/');
    } catch (e) { toast(e.message); el.disabled = false; }
  }
  else if (act === 'pick') {
    const k = el.dataset.k;
    S.importSel.has(k) ? S.importSel.delete(k) : S.importSel.add(k);
    paintImportReview();
  }
  else if (act === 'toggleall') {
    const news = S.importPreview.kits.filter((k) => !k.duplicate);
    S.importSel = S.importSel.size === news.length ? new Set() : new Set(news.map((k) => k.key));
    paintImportReview();
  }
  else if (act === 'sync') {
    el.disabled = true;
    const box = document.getElementById('syncbox');
    try {
      const { job } = await api('/catalogue/sync', { method: 'POST' });
      runJob(job, box, () => { toast('Catalogue ready'); render(); });
    } catch (err) { el.disabled = false; toast(err.message); }
  }
  else if (act === 'commit') {
    const kits = S.importPreview.kits.filter((k) => S.importSel.has(k.key));
    el.disabled = true;
    const box = document.createElement('div');
    el.parentElement.appendChild(box);
    const { job } = await api('/import/commit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kits })
    });
    runJob(job, box, (j) => {
      forgetImport();
      toast(`${j.result.inserted} project${j.result.inserted === 1 ? '' : 's'} added`);
      depth = 0;
      swap('#/');
    });
  }
  else if (act === 'save') {
    const id = el.dataset.id;
    const val = (k) => { const n = document.getElementById(k); return n ? n.value.trim() : undefined; };
    const numOf = (k) => { const v = val(k); if (v === '' || v == null) return null;
                           const n = parseFloat(v.replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
    const seg = (g) => document.querySelector(`#${g} .opt[aria-pressed="true"]`)?.dataset.k ?? null;
    if (!val('title')) return toast('A project name is required');
    const titleEl = document.getElementById('title');
    const body = {
      title: val('title'), artist: val('artist') || null, status: seg('status'),
      shape: seg('shape'), coverage: seg('coverage'),
      currency: seg('currency') || document.getElementById('currency')?.dataset.was || null,
      width_in: numOf('width_in'), height_in: numOf('height_in'),
      colors: numOf('colors'), drills: numOf('drills'), special: val('special') || null,
      brand: val('brand') || null, source: val('source') || null,
      price: numOf('price'), shipping: numOf('shipping'), tax: numOf('tax'),
      sold_price: numOf('sold_price'),   // hours comes from the sessions, not a field
      rating: Number(document.getElementById('rating')?.dataset.v) || null,
      date_ordered: val('date_ordered') || null, date_received: val('date_received') || null,
      date_started: val('date_started') || null, date_completed: val('date_completed') || null,
      notes: val('notes') || null, shop: val('shop') || null,
      // a percentage outside 0-100 is a typo, not an instruction
      progress: (() => { const n = numOf('progress'); return n == null ? null : Math.min(100, Math.max(0, Math.round(n))); })()
    };
    // sent even when empty: unlinking is a change like any other
    body.dac_handle = titleEl.dataset.handle || null;
    body.holds = titleEl.dataset.holds || null;
    // a diamond count you typed yourself stops being an estimate
    const drillsEl = document.getElementById('drills');
    const drillsWas = drillsEl && drillsEl.dataset.orig !== '' && drillsEl.dataset.orig != null
      ? parseFloat(drillsEl.dataset.orig) : null;
    if (body.drills !== drillsWas) body.drills_estimated = 0;
    // a price you typed yourself is yours, not an estimate
    const priceEl = document.getElementById('price');
    const origRaw = priceEl ? priceEl.dataset.orig : '';
    const origPrice = origRaw === '' || origRaw == null ? null : parseFloat(origRaw);
    if (body.price !== origPrice) body.price_source = body.price == null ? null : 'you';
    el.disabled = true;
    try {
      const saved = id
        ? await api('/projects/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await api('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      editing = null;               // saved, so leaving is not losing anything
      toast('Saved');
      // editing returns to the project you were looking at; a brand new one
      // takes the form's place so Back does not reopen the empty form
      if (id) back('#/p/' + saved.id);
      else swap('#/p/' + saved.id);
    } catch (err) { el.disabled = false; toast(err.message); }
  }
  else if (act === 'delete') {
    editing = null;
    if (!confirm('Delete this project and its photos? This cannot be undone.')) return;
    await api('/projects/' + el.dataset.id, { method: 'DELETE' });
    toast('Project deleted');
    depth = 0;
    swap('#/');
  }
  else if (act === 'hintdone') {
    await seenHint(el.dataset.k);
    paintLogbook();
  }
  else if (act === 'statusmenu') {
    /* The pill said what the status was but offered no way to change it, so the
       only routes were a drag on the logbook or the whole edit form. */
    S.statusFor = Number(el.dataset.id);
    paintStatusMenu();
  }
  else if (act === 'closestatus') { S.statusFor = null; paintStatusMenu(); }
  else if (act === 'setstatus') {
    const id = Number(el.dataset.id);
    const project = S.projects.find((x) => String(x.id) === String(id))
                 || await api('/projects/' + id);
    S.statusFor = null; paintStatusMenu();
    if (project.status === el.dataset.k) return;
    const patch = applyStatus(project, el.dataset.k, today());
    await api('/projects/' + id, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    toast(`${project.title} → ${statusOf(el.dataset.k).short}`);
    render();
  }
  else if (act === 'setrating') {
    const rating = Number(el.dataset.k) || null;
    await api('/projects/' + el.dataset.id, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating }) });
    render();
  }
  else if (act === 'shot' || act === 'formshot') { goToShot(el); }
  else if (act === 'opengallery') {
    const g = S.gallery;
    if (g && g.items.length) lightbox(g.items, Number(el.dataset.i) || 0);
  }
  else if (act === 'setdate') {
    const project = await api('/projects/' + el.dataset.id);
    const dates = { [el.dataset.k]: el.value || null };
    // the same rule the form and the drag use, so a date means one thing
    const status = statusFromDates({ ...project, ...dates });
    await api('/projects/' + el.dataset.id, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...dates, status }) });
    toast(status === project.status ? 'Date saved' : `Date saved · now ${statusOf(status).short}`);
    render();
  }
  else if (act === 'savecost') {
    const num = (id) => {
      const v = (document.getElementById(id)?.value || '').trim();
      if (!v) return null;
      const n = parseFloat(v.replace(/[^0-9.\-]/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    const chosen = document.querySelector('#cost_currency .opt[aria-pressed="true"]')?.dataset.k;
    const body = { price: num('cost_price'), shipping: num('cost_shipping'), tax: num('cost_tax') };
    if (chosen) body.currency = chosen;
    // a price you typed is yours, not the catalogue's guess
    const before = await api('/projects/' + el.dataset.id);
    if (body.price !== (before.price ?? null)) body.price_source = body.price == null ? null : 'you';
    await api('/projects/' + el.dataset.id, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast('Cost saved');
    render();
  }
  else if (act === 'sharephoto') {
    const ok = window.LogbookNative?.sharePhoto('photos/' + el.dataset.file, el.dataset.title || '');
    if (!ok) toast('That photo could not be shared');
  }
  else if (act === 'setcover') {
    const box = document.querySelector('.lightbox');
    await api(`/projects/${el.dataset.id}/cover`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo: el.dataset.file }) });
    if (box && box._close) box._close();
    toast('Cover updated');
    render();
  }
  else if (act === 'resetcover') {
    await api(`/projects/${el.dataset.id}/cover`, { method: 'DELETE' });
    toast('Back to the shop\u2019s image');
    render();
  }
  else if (act === 'savehold') {
    const held = document.getElementById('holdfrom')?.value;
    const back = document.getElementById('holdto')?.value;
    if (!held) return toast('Which day did you put it down?');
    await api(`/projects/${el.dataset.id}/holds`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ held, restarted: back || null }) });
    toast(back ? 'Hold recorded' : 'On hold');
    render();
  }
  else if (act === 'delhold') {
    if (!confirm('Remove this hold?')) return;
    await api(`/projects/${el.dataset.id}/holds/${el.dataset.k}`, { method: 'DELETE' });
    toast('Hold removed');
    render();
  }
  else if (act === 'savesession') {
    const mins = Number(document.getElementById('sessmins')?.value);
    if (!mins) return toast('How many minutes?');
    await api(`/projects/${el.dataset.id}/sessions`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes: mins, on: document.getElementById('sesson')?.value,
                             note: document.getElementById('sessnote')?.value || null }) });
    toast(`Logged ${minsText(mins)}`);
    render();
  }
  else if (act === 'delsession') {
    if (!confirm('Remove this session?')) return;
    await api('/sessions/' + el.dataset.k, { method: 'DELETE' });
    toast('Session removed');
    render();
  }
  else if (act === 'starttimer') {
    S.timer = await api('/timer', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: Number(el.dataset.id) }) });
    toast('Timer running');
    render();
  }
  else if (act === 'stoptimer') {
    const done = await api('/timer/stop', { method: 'POST' });
    S.timer = null;
    toast(`Logged ${minsText(done.minutes)}`);
    render();
  }
  else if (act === 'delphoto') {
    const id = el.dataset.id;
    const undo = deleteLater('photo:' + id, 6, () => api('/photos/' + id, { method: 'DELETE' }));
    render();
    toast('Photo removed', { label: 'Undo', run: undo });
  }
}

if (window.matchMedia) {
  const mq = window.matchMedia(TWO_PANE);
  const onChange = () => render();
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

window.addEventListener('hashchange', (e) => {
  // the phone's own Back button pops an entry without going through back()
  if (e && e.oldURL && e.newURL && e.oldURL.length > e.newURL.length && depth > 0) depth--;
  return render();          // returned so callers can await a finished render
});
/* Kits saved before covers were fetched at full width are still carrying the
   thumbnail, and there is no moment in normal use to fix them: re-picking the
   same listing is not a relink, and re-fetching a picture that has not changed
   is waste. So it happens once, by itself, on the first launch after updating.
   It needs a connection; anything it cannot reach keeps its mark and is simply
   tried again next time. */
/* Moves the line that is already on the screen, rather than drawing a second
   one underneath it, and reads how many are done back off the projects each
   tick — so the count is the truth rather than a number painted once. */
async function watchCovers(jobId) {
  const set = (id, text) => { const e = document.getElementById(id); if (e) e.textContent = text; };
  for (;;) {
    let j, soft;
    try { [j, soft] = await Promise.all([api('/jobs/' + jobId), api('/projects/upgrade-covers')]); }
    catch { return; }
    if (!document.getElementById('hifibar')) return;      // gone from the screen
    set('hificount', `${num(soft.done)} of ${num(soft.total)} kit${
      soft.total === 1 ? '' : 's'} have full-size pictures`);
    const bar = document.getElementById('hifibar');
    if (bar) bar.style.width = (soft.total ? Math.round(soft.done / soft.total * 100) : 0) + '%';
    if (j.state === 'running') {
      if (j.message) set('hifiwhy', j.message);
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    if (j.state === 'error') toast(j.error || 'That did not work');
    render();
    return;
  }
}

async function catchUpCovers() {
  try {
    const { candidates } = await api('/projects/upgrade-covers');
    if (!candidates) return;
    toast(`Fetching full-size pictures · ${candidates} kit${candidates === 1 ? '' : 's'}`);
    /* Started as a job so Settings can show how far it has got, and pick it back
       up if you go and look while it is still running. */
    const { job } = await api('/projects/upgrade-covers?job=1', { method: 'POST' });
    if (!job) return;
    for (;;) {
      const j = await api('/jobs/' + job);
      if (j.state === 'running') { await new Promise((r) => setTimeout(r, 700)); continue; }
      const n = (j.result || {}).upgraded || 0;
      if (n) { toast(`${n} kit${n === 1 ? '' : 's'} now full size`); render(); }
      return;
    }
  } catch { /* no connection: the next launch tries again */ }
}

Promise.all([
  api('/prefs').then((p) => { if (p) Object.assign(S.prefs, p); }).catch(() => {}),
  // a timer left running when the app was closed is still running
  api('/timer').then((t) => { S.timer = t || null; }).catch(() => {})
]).finally(() => { render(); catchUpCovers(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
