/**
 * Walk the whole app the way a finger would, and check nothing falls over.
 *
 * Most of the bugs that reached the phone were not subtle: a route threw and
 * showed "Something went wrong", a form came back blank, a status that was not
 * one of the seven took the page down. None of them needed a clever test —
 * they needed *any* test that actually rendered the screen and looked at it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mount } from './mount.mjs';

/* The IndexedDB shim outlives a single mount, so a test that means "I do not
   own this yet" has to say so — picking a kit you already have now opens it
   instead of adding a second copy. */
const emptyLogbook = async (m) => {
  for (const r of await m.api('/projects')) await m.api('/projects/' + r.id, { method: 'DELETE' });
};

const broke = (m) => /Something went wrong/.test(m.text());

async function app(width = 390) {
  const m = await mount({ width });
  await m.sync();
  const p = await m.seed({
    title: 'Moon Eater', artist: 'Yuumei Art', status: 'started',
    date_ordered: '2026-07-01', date_received: '2026-07-08', date_started: '2026-08-01',
    shop: 'dac', dac_handle: 'moon-eater', drills: 75433, colors: 42,
    price: 169, currency: 'USD', progress: 40, rating: 4
  });
  await m.seed({ title: 'Wanted one', status: 'wishlist', shop: 'dac' });
  await m.seed({ title: 'Given up', status: 'abandoned', shop: 'dac' });
  return { m, p };
}

for (const width of [390, 1028]) {
  const shape = width === 390 ? 'phone' : 'unfolded';

  test(`every screen renders on a ${shape}`, async () => {
    const { m, p } = await app(width);
    for (const hash of ['#/', `#/p/${p.id}`, `#/p/${p.id}/edit`, '#/new',
                        '#/browse', '#/import', '#/settings', '#/licences']) {
      await m.go(hash);
      assert.ok(!broke(m), `${hash} showed the error page on a ${shape}`);
      assert.ok(m.text().trim().length > 40, `${hash} rendered almost nothing`);
    }
  });

  test(`every control on every screen can be tapped on a ${shape}`, async () => {
    const { m, p } = await app(width);
    for (const hash of ['#/', `#/p/${p.id}`, '#/settings', '#/browse']) {
      await m.go(hash);
      const acts = [...new Set(m.all('[data-act]').map(el => el.getAttribute('data-act')))]
        // these leave the screen, delete something, or start a long job
        .filter(a => !['delete', 'delhold', 'delsession', 'delphoto', 'sync', 'syncone',
                       'export', 'backup', 'resetcover', 'commit'].includes(a));
      for (const act of acts) {
        await m.go(hash);
        const el = m.find(`[data-act="${act}"]`);
        if (!el) continue;
        el.dispatchEvent({ type: 'click' });
        await m.settle();
        assert.ok(!broke(m), `tapping ${act} on ${hash} broke the app (${shape})`);
      }
    }
    /* Tapping everything includes the shop switches in Settings, and a shop
       switched off is skipped by a catalogue sync. That preference outlives
       this test in the one database the file shares, so later tests found
       shops that would not sync and catalogues that came back empty — twice.
       Whatever this test turns off, it turns back on. */
    await m.api('/prefs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ excluded: [] }) });
  });
}

test('a project picked from the catalogue arrives with its picture', async () => {
  const m = await mount({ width: 1028 });
  await m.sync();
  await emptyLogbook(m);            // this is the ADD path: nothing here yet
  await m.go('#/browse');
  await m.tap('[data-act="pickcat"]');
  assert.equal(globalThis.location.hash, '#/new');

  const box = m.find('#formshot');
  assert.ok(box, 'the form has no picture area at all');
  assert.ok(!box.hasAttribute('hidden'), 'the picture area is hidden');
  assert.match(m.find('#formshotimg').getAttribute('src'), /^https?:\/\//,
               'the picture area has no image in it');

  // and it survives the form being rendered again, which a fold does
  await m.go('#/new');
  assert.ok(!m.find('#formshot').hasAttribute('hidden'),
            'the picture went away when the form re-rendered');
  assert.match(m.find('input#title').getAttribute('value'), /Moon Eater/,
               'the details went away when the form re-rendered');
});

test('a status that is not one of the seven does not take the page down', async () => {
  const m = await mount();
  const p = await m.seed({ title: 'From a bad import', status: 'nonsense' });
  await m.go('#/p/' + p.id);
  assert.ok(!broke(m), 'an unknown status broke the project page');
  assert.match(m.text(), /From a bad import/);
});

test('the gallery opens from a cover and holds the photos too', async () => {
  const m = await mount();
  await m.sync();
  const p = await m.seed({ title: 'Moon Eater', status: 'started', shop: 'dac',
                           dac_handle: 'moon-eater' });
  await m.api(`/projects/${p.id}/photos`, { method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array([7]).buffer });
  await m.go('#/p/' + p.id);

  const covers = m.all('.shots img').length;
  assert.ok(covers >= 1, 'the project page shows no cover');
  await m.tap('.shots img');
  assert.ok(m.find('.lb-strip'), 'tapping a cover opened no viewer');
  assert.equal(m.all('.lb-slide').length, covers + 1,
               'the viewer does not hold the covers and the photo');
});

test('removing a photo can be undone, and asks nothing first', async () => {
  const m = await mount();
  const p = await m.seed({ title: 'Moon Eater', status: 'started' });
  for (const n of [1, 2]) await m.api(`/projects/${p.id}/photos`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array([n]).buffer });
  await m.go('#/p/' + p.id);
  assert.equal(m.all('.shot').length, 2);

  m.answerConfirms(false);                  // nothing should be asking
  await m.tap('[data-act="delphoto"]');
  assert.equal(m.confirms.length, 0, 'it asked before removing');
  assert.equal(m.all('.shot').length, 1, 'the photo is still on the page');
  assert.equal((await m.api('/projects/' + p.id)).photos.length, 2,
               'it deleted the photo before the offer to undo expired');

  await m.tap('.toast-action');
  assert.equal(m.all('.shot').length, 2, 'undo did not bring it back');
  assert.equal((await m.api('/projects/' + p.id)).photos.length, 2);
});

test('a double tap zooms the viewer and a second one restores it', async () => {
  const m = await mount();
  await m.sync();
  const p = await m.seed({ title: 'Moon Eater', status: 'started', shop: 'dac', dac_handle: 'moon-eater' });
  await m.go('#/p/' + p.id);
  await m.tap('.shots img');
  const slide = m.find('.lb-slide');
  const double = () => { slide.dispatchEvent({ type: 'click' }); slide.dispatchEvent({ type: 'click' }); };

  double();
  assert.ok(slide.classList.contains('zoomed'), 'a double tap did not zoom');
  assert.ok(m.find('.lightbox').classList.contains('has-zoom'), 'the strip still slides while zoomed');
  double();
  assert.ok(!slide.classList.contains('zoomed'), 'a second double tap did not restore it');
  assert.ok(m.find('.lb-strip'), 'zooming closed the viewer');
});

test('pulling the catalogue down updates it', async () => {
  const m = await mount();
  await m.seed({ title: 'Moon Eater', status: 'started' });
  await m.go('#/browse');
  await m.settle();
  const scroll = m.find('#browsebody');
  const text = () => m.find('#pulltext')?.textContent || '';
  const touch = (type, y) => scroll.dispatchEvent({ type, touches: y == null ? [] : [{ clientY: y }] });

  assert.ok(m.find('#pull'), 'there is nowhere for the pull to show');
  // and it is not on the logbook, where refreshing a catalogue means nothing
  await m.go('#/');
  assert.equal(m.find('#pull'), null, 'the logbook still offers to refresh catalogues');
  await m.go('#/browse');
  await m.settle();
  scroll.scrollTop = 0;
  touch('touchstart', 100);
  touch('touchmove', 160);
  assert.match(text(), /Pull to update/, 'a short pull says nothing');
  touch('touchmove', 260);
  assert.match(text(), /Release/, 'a long pull does not offer to update');
  touch('touchend');
  await m.settle();
  assert.notEqual(text(), '', 'releasing did not start an update');

  for (let i = 0; i < 40 && /…/.test(text()); i++) await m.settle();
  assert.equal(text(), '', 'the indicator never went away');

  // part way down the list, a downward drag is scrolling and nothing else
  scroll.scrollTop = 400;
  touch('touchstart', 100);
  touch('touchmove', 300);
  assert.equal(text(), '', 'it tried to refresh while the list was scrolled');
});

test('a progress photo can be shared, when the phone can share', async () => {
  const m = await mount();
  const shared = [];
  m.window.LogbookNative.sharePhoto = (path, title) => { shared.push({ path, title }); return true; };
  const p = await m.seed({ title: 'Moon Eater', status: 'started' });
  await m.api(`/projects/${p.id}/photos`, { method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array([7]).buffer });

  await m.go('#/p/' + p.id);
  await m.tap('.shot .open');
  await m.tap('[data-act="sharephoto"]');
  assert.equal(shared.length, 1, 'nothing was handed to the phone to share');
  assert.match(shared[0].path, /^photos\//, 'it shared the wrong path');
  assert.equal(shared[0].title, 'Moon Eater', 'the photo went out unnamed');
});

test('no share button on a phone that cannot share', async () => {
  const m = await mount();
  delete m.window.LogbookNative.sharePhoto;
  const p = await m.seed({ title: 'Moon Eater', status: 'started' });
  await m.api(`/projects/${p.id}/photos`, { method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array([7]).buffer });
  await m.go('#/p/' + p.id);
  await m.tap('.shot .open');
  assert.ok(m.find('.lb-strip'), 'the viewer did not open');
  assert.equal(m.find('[data-act="sharephoto"]'), null,
               'it offered to share on a build with no way to do it');
});

test('cost and dates are corrected where they are read', async () => {
  const m = await mount();
  const p = await m.seed({ title: 'Moon Eater', status: 'received',
                           date_ordered: '2026-07-01', date_received: '2026-07-08',
                           price: 169, currency: 'USD' });
  await m.go('#/p/' + p.id);

  m.find('#cost_price').value = '54.99';
  m.find('#cost_shipping').value = '4.50';
  m.find('#cost_currency .opt[data-k="GBP"]').dispatchEvent({ type: 'click' });
  await m.tap('[data-act="savecost"]');
  let row = await m.api('/projects/' + p.id);
  assert.equal(row.price, 54.99);
  assert.equal(row.shipping, 4.5);
  assert.equal(row.currency, 'GBP', 'the currency chips did nothing');
  assert.equal(row.price_source, 'you', 'a price typed by hand is still credited to the catalogue');

  /* The timeline row is the control now: tap the date, pick one, done. No
     disclosure to open and no Save to find. */
  await m.go('#/p/' + p.id);
  const started = m.find('[data-act="setdate"][data-k="date_started"]');
  assert.ok(started, 'the timeline has no way to set a date');
  started.value = '2026-08-20';
  started.dispatchEvent({ type: 'change', target: started });
  await m.settle();
  row = await m.api('/projects/' + p.id);
  assert.equal(row.date_started, '2026-08-20');
  assert.equal(row.status, 'started', 'the status did not follow the dates');

  // an empty one invites a tap rather than showing nothing
  await m.go('#/p/' + p.id);
  const empty = m.find('[data-act="setdate"][data-k="date_completed"]');
  assert.equal(empty.getAttribute('value'), '');
  assert.match(empty.parentElement.textContent, /Tap to set/);
});

test('the project leads with managing it, not with editing the record', async () => {
  const m = await mount();
  const p = await m.seed({ title: 'Moon Eater', status: 'started', date_started: '2026-08-01' });
  await m.go('#/p/' + p.id);
  const edit = m.find('[data-go$="/edit"]');
  assert.ok(edit, 'there is no way to the record at all');
  assert.ok(!edit.classList.contains('primary'), 'the record editor is still the loudest thing on the page');
  assert.match(edit.textContent, /Details/);
  await m.go(`#/p/${p.id}/edit`);
  assert.match(m.text(), /Project details/, 'the form still calls itself Edit project');
});

test('a kit not in hand is not offered a session', async () => {
  const m = await mount();
  for (const [status, expected] of [['wishlist', false], ['notReceived', false],
                                    ['received', true], ['started', true]]) {
    const p = await m.seed({ title: status, status,
                             date_received: status === 'received' ? '2026-08-01' : null,
                             date_started: status === 'started' ? '2026-08-01' : null });
    await m.go('#/p/' + p.id);
    assert.equal(!!m.find('[data-act="starttimer"]'), expected,
                 `${status} ${expected ? 'should' : 'should not'} offer to time a session`);
  }
});

test('logging time starts a project that had not been started', async () => {
  const m = await mount();
  const p = await m.seed({ title: 'Waiting', status: 'received', date_received: '2026-08-01' });
  await m.api(`/projects/${p.id}/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutes: 45, on: '2026-08-20' }) });
  const after = await m.api('/projects/' + p.id);
  assert.equal(after.status, 'started');
  assert.ok(after.date_started, 'it was started without a date');

  // but a finished or held project keeps what you said about it
  for (const status of ['completed', 'abandoned', 'onHold']) {
    const q = await m.seed({ title: status, status, date_started: '2026-07-01' });
    await m.api(`/projects/${q.id}/sessions`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes: 10, on: '2026-08-20' }) });
    assert.equal((await m.api('/projects/' + q.id)).status, status,
                 `logging time changed a ${status} project`);
  }
});

test('a kit picked from the catalogue shows its pictures and a way to the shop', async () => {
  const m = await mount();
  await m.sync();
  await emptyLogbook(m);
  await m.go('#/browse');
  await m.tap('[data-act="pickcat"]');

  assert.ok(m.all('#formshots img').length > 1, 'the form shows only one of the shop pictures');
  assert.equal(m.find('#formshots img').getAttribute('data-act'), 'opengallery',
               'the pictures on the form do not open');
  const link = m.find('.shoplink');
  assert.ok(link, 'no way to see the kit at the shop before adding it');
  assert.match(link.getAttribute('href'), /diamondartclub\.com\/products\//);

  await m.tap('#formshots img');
  assert.ok(m.find('.lb-strip'), 'tapping a picture on the form opened nothing');
  assert.equal(m.all('.lb-slide').length, m.all('#formshots img').length || 1);
});

test('a picture can be pinched, panned and pinched back', async () => {
  const m = await mount();
  await m.sync();
  const p = await m.seed({ title: 'Moon Eater', status: 'started', shop: 'dac', dac_handle: 'moon-eater' });
  await m.go('#/p/' + p.id);
  await m.tap('.shots img');
  const box = m.find('.lightbox'), slide = m.find('.lb-slide');
  const two = (d) => [{ clientX: 200 - d / 2, clientY: 400 }, { clientX: 200 + d / 2, clientY: 400 }];

  box.dispatchEvent({ type: 'touchstart', touches: two(100) });
  box.dispatchEvent({ type: 'touchmove', touches: two(300), preventDefault() {} });
  assert.ok(Number(slide.dataset.scale) > 2, 'pinching out did not enlarge it');
  box.dispatchEvent({ type: 'touchend', touches: [] });

  box.dispatchEvent({ type: 'touchstart', touches: [{ clientX: 200, clientY: 400 }] });
  box.dispatchEvent({ type: 'touchmove', touches: [{ clientX: 260, clientY: 430 }], preventDefault() {} });
  assert.equal(slide.dataset.ox, '60', 'a zoomed picture cannot be moved');
  box.dispatchEvent({ type: 'touchend', touches: [] });

  box.dispatchEvent({ type: 'touchstart', touches: two(300) });
  box.dispatchEvent({ type: 'touchmove', touches: two(60), preventDefault() {} });
  box.dispatchEvent({ type: 'touchend', touches: [] });
  assert.equal(slide.dataset.scale, '1', 'pinching back in did not restore it');
  assert.ok(!slide.classList.contains('zoomed'));
});

test('the dots follow the strip, and tapping one moves it', async () => {
  const m = await mount();
  await m.sync();
  await emptyLogbook(m);
  await m.go('#/browse');
  await m.tap('[data-act="pickcat"]');

  const strip = m.find('#formshots'), dots = m.all('#formdots button');
  assert.ok(dots.length > 1, 'a strip of several pictures has no dots to say so');
  assert.equal(dots.length, m.all('#formshots img').length);
  assert.equal(dots[0].getAttribute('aria-current'), 'true');

  // tapping the second dot moves the strip to the second picture
  await m.tap('#formdots button[data-i="1"]');
  assert.equal(strip.scrollLeft, strip.clientWidth, 'tapping a dot did not move the strip');

  // and swiping the strip moves the dots, which is what makes a swipe legible
  strip.dispatchEvent({ type: 'scroll' });
  assert.equal(m.all('#formdots button')[1].getAttribute('aria-current'), 'true',
               'the dots did not follow the strip');
  assert.equal(m.all('#formdots button')[0].getAttribute('aria-current'), 'false');
});

test('the project page gallery answers its own dots too', async () => {
  const m = await mount();
  await m.sync();
  const p = await m.seed({ title: 'Moon Eater', status: 'started', shop: 'dac', dac_handle: 'moon-eater' });
  await m.go('#/p/' + p.id);
  const strip = m.find('#shots');
  assert.ok(m.all('#dots button').length > 1, 'the project page shows no dots for its gallery');
  await m.tap('#dots button[data-i="1"]');
  assert.equal(strip.scrollLeft, strip.clientWidth, 'a dot on the project page did nothing');
  strip.dispatchEvent({ type: 'scroll' });
  assert.equal(m.all('#dots button')[1].getAttribute('aria-current'), 'true');
});

test('the catalogue is pulled down from anywhere on the screen, not just the list', async () => {
  const m = await mount();
  await m.sync();
  await m.go('#/browse');
  const at = (y) => ({ clientX: 120, clientY: y });

  // the top of the catalogue is search box, shop chips and filters — starting
  // the pull there is the natural thing to do, and it was doing nothing
  const chip = m.find('.chiprow .chip');
  chip.dispatchEvent({ type: 'touchstart', touches: [at(100)] });
  chip.dispatchEvent({ type: 'touchmove', touches: [at(180)], preventDefault() {} });
  assert.equal(m.find('#pulltext').textContent, 'Pull to update');
  chip.dispatchEvent({ type: 'touchmove', touches: [at(260)], preventDefault() {} });
  assert.equal(m.find('#pulltext').textContent, 'Release to update');
  m.find('#pull').dispatchEvent({ type: 'touchcancel' });

  // but dragging the price slider is not a pull
  await m.tap('[data-act="bfilters"]');
  const slider = m.find('#bprice');
  slider.dispatchEvent({ type: 'touchstart', touches: [at(100)] });
  slider.dispatchEvent({ type: 'touchmove', touches: [at(260)], preventDefault() {} });
  assert.equal(m.find('#pulltext').textContent, '', 'dragging the slider started a refresh');
});

test('a kit whose catalogue row lost its picture still shows one', async () => {
  // a shop that has changed its feed since the last sync leaves rows with no
  // image, and the kit was then blank everywhere it appeared
  const blank = {
    id: 7, title: 'Lost Cover', vendor: 'Someone', handle: 'lost-cover',
    product_type: 'Diamond Art Kit', images: [],
    gallery: ['https://cdn.shopify.com/a.jpg', 'https://cdn.shopify.com/b.jpg'],
    variants: [{ title: '20" x 20" (50cm x 50cm) / Round with 30 Colors / 40000', price: '50.00', available: true }]
  };
  const m = await mount({ products: [blank] });
  await m.sync();
  const row = await m.api('/catalogue/product?shop=dac&handle=lost-cover');
  assert.ok(row && row.image, 'the shop was never asked for the picture');

  const p = await m.seed({ title: 'Lost Cover', status: 'started', shop: 'dac', dac_handle: 'lost-cover' });
  await m.go('#/p/' + p.id);
  assert.ok(m.all('.hero .shots img').length >= 2, 'the project page still has no pictures');

  await m.go('#/p/' + p.id + '/edit');
  assert.ok(m.all('#formshots img').length >= 2, 'the form still has no pictures');
});

test('coming back from a project lands where you left the logbook', async () => {
  const m = await mount();
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push((await m.seed({ title: 'Kit ' + i, status: 'received' })).id);
  await m.go('#/');

  const list = () => m.find('.screen .scroll');
  list().scrollTop = 640;
  await m.go('#/p/' + ids[6]);
  assert.equal(list().scrollTop, 0, 'a project should open at its top');

  await m.go('#/');
  assert.equal(list().scrollTop, 640, 'the logbook came back at the top');

  // a project you have scrolled through also opens where you left it
  await m.go('#/p/' + ids[6]);
  list().scrollTop = 220;
  await m.go('#/');
  await m.go('#/p/' + ids[6]);
  assert.equal(list().scrollTop, 220, 'the project came back at the top');

  // but a project you have never opened starts at the top
  await m.go('#/p/' + ids[9]);
  assert.equal(list().scrollTop, 0);
});

test('the catalogue keeps your place, and loses it when the filters change', async () => {
  const m = await mount();
  await m.sync();
  await m.go('#/browse');
  const body = () => m.find('#browsebody');
  body().scrollTop = 500;

  await m.tap('[data-act="pickcat"]');          // into New project
  await m.go('#/browse');
  assert.equal(body().scrollTop, 500, 'the catalogue came back at the top');

  await m.tap('[data-act="bfilters"]');
  await m.tap('[data-act="bshape"][data-k="Round"]');
  assert.equal(body().scrollTop, 0, 'a different set of kits kept the old place');
});

test('the logbook can be filtered and sorted, not just searched', async () => {
  const m = await mount();
  // this file's store is one database shared by every test in it, so a test
  // that counts what is on screen has to start from a known logbook
  for (const p of await m.api('/projects')) await m.api('/projects/' + p.id, { method: 'DELETE' });
  await m.seed({ title: 'Big Round DAC', status: 'received', shop: 'dac',
                 shape: 'Round', width_in: 32, height_in: 24, rating: 5, drills: 90000 });
  await m.seed({ title: 'Small Square DAC', status: 'received', shop: 'dac',
                 shape: 'Square', width_in: 12, height_in: 12, rating: 2, drills: 9000 });
  await m.seed({ title: 'Mystical Round', status: 'received', shop: 'mdd',
                 shape: 'Round', width_in: 20, height_in: 16, rating: 4, drills: 40000 });
  await m.go('#/');
  const titles = () => m.all('.card .name').map((n) => n.textContent);
  const count = () => m.find('#lbcount').textContent.trim();
  assert.equal(count(), '3 projects');

  await m.tap('[data-act="lbfilters"]');
  assert.ok(m.find('[data-act="lbsort"]'), 'the panel did not open');

  // shop
  await m.tap('[data-act="lbshop"][data-k="mdd"]');
  assert.deepEqual(titles(), ['Mystical Round']);
  await m.tap('[data-act="lbshop"][data-k="mdd"]');   // tapping it again turns it off
  assert.equal(count(), '3 projects');

  // shape, and size, and rating
  await m.tap('[data-act="lbshape"][data-k="Square"]');
  assert.deepEqual(titles(), ['Small Square DAC']);
  await m.tap('[data-act="lbshape"][data-k="Square"]');
  await m.tap('[data-act="lbsize"][data-k="sml"]');
  assert.deepEqual(titles(), ['Small Square DAC']);
  await m.tap('[data-act="lbsize"][data-k="sml"]');
  await m.tap('[data-act="lbrating"][data-k="4"]');
  assert.deepEqual(titles().sort(), ['Big Round DAC', 'Mystical Round']);

  // the badge counts what is on, and Clear all turns the lot off
  assert.equal(m.find('[data-act="lbfilters"] .n').textContent, '1');
  await m.tap('[data-act="lbsort"][data-k="name"]');
  assert.equal(m.find('[data-act="lbfilters"] .n').textContent, '2');
  await m.tap('[data-act="lbclear"]');
  assert.equal(count(), '3 projects');
  assert.equal(m.find('[data-act="lbfilters"] .n'), null, 'the badge outlived the filters');

  // sorting applies inside a section
  await m.tap('[data-act="lbsort"][data-k="name"]');
  assert.deepEqual(titles(), ['Big Round DAC', 'Mystical Round', 'Small Square DAC']);
  await m.tap('[data-act="lbsort"][data-k="drills"]');
  assert.deepEqual(titles(), ['Big Round DAC', 'Mystical Round', 'Small Square DAC']);
  await m.tap('[data-act="lbsort"][data-k="rating"]');
  assert.deepEqual(titles(), ['Big Round DAC', 'Mystical Round', 'Small Square DAC']);
});

test('filtering the logbook puts you back at the top of it', async () => {
  const m = await mount();
  for (let i = 0; i < 12; i++) await m.seed({ title: 'Kit ' + i, status: 'received', shape: i % 2 ? 'Round' : 'Square' });
  await m.go('#/');
  const list = () => m.find('.screen .scroll');
  list().scrollTop = 500;
  await m.tap('[data-act="lbfilters"]');
  await m.tap('[data-act="lbshape"][data-k="Round"]');
  assert.equal(list().scrollTop, 0, 'a smaller list kept a scroll position from a bigger one');
});

/* The summary is arithmetic over dates, and dates are where this app has always
   got things subtly wrong, so the numbers are checked rather than the markup. */
const summarySeed = async (m) => {
  for (const p of await m.api('/projects')) await m.api('/projects/' + p.id, { method: 'DELETE' });
  const big = await m.seed({ title: 'Moon Eater', status: 'completed', drills: 90000,
    width_in: 24, height_in: 32, price: 85, shop: 'dac', artist: 'Yuumei Art',
    date_ordered: '2026-01-05', date_started: '2026-02-01', date_completed: '2026-04-01',
    holds: JSON.stringify([{ held: '2026-02-10', restarted: '2026-03-02' }]) });
  const small = await m.seed({ title: 'Tiny', status: 'completed', drills: 9000,
    width_in: 8, height_in: 8, price: 20, shop: 'dac', artist: 'Yuumei Art',
    date_ordered: '2026-03-01', date_started: '2026-03-10', date_completed: '2026-03-20' });
  // a wish-list kit is not owned, so nothing about it is a fact yet
  await m.seed({ title: 'Wished', status: 'wishlist', drills: 500000, price: 999, width_in: 60, height_in: 60 });
  for (const [id, on, minutes] of [[big.id, '2026-02-02', 120], [big.id, '2026-02-03', 90],
                                   [big.id, '2026-02-04', 60], [small.id, '2026-03-11', 240]])
    await m.api(`/projects/${id}/sessions`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on, minutes }) });
  return { big, small };
};

test('the summary counts what happened, and a wish-list kit is not a fact', async () => {
  const m = await mount();
  const { big } = await summarySeed(m);
  const s = await m.api('/summary');

  assert.equal(s.totals.done, 2);
  assert.equal(s.totals.bought, 2, 'the wish-list kit was counted as owned');
  assert.equal(s.totals.hours, 8.5);
  assert.equal(s.totals.days, 4, 'four distinct days had a session');
  assert.equal(s.totals.streak, 3, '2, 3 and 4 February are a run of three');
  assert.deepEqual(s.totals.spendBy.map(({ currency, total }) => ({ currency, total })),
                   [{ currency: 'GBP', total: 105 }], 'the wished-for £999 was counted as spent');
  assert.equal(s.records.biggestSize.title, 'Moon Eater');
  assert.equal(s.records.smallestSize.title, 'Tiny', 'the wish-list kit won "biggest"');

  // 1 Feb to 1 Apr is 59 days; 20 of them were spent put down
  assert.equal(s.records.longestDays.value, 59);
  assert.equal(s.records.longestDaysNet.value, 39);
  assert.equal(s.records.longestHeld.value, 20);
  assert.equal(s.records.longestDays.id, big.id);
});

test('the summary can be narrowed to a year and to a month', async () => {
  const m = await mount();
  await summarySeed(m);

  const year = await m.api('/summary?year=2026');
  assert.deepEqual(year.years, ['2026']);
  assert.deepEqual(year.months, ['01', '02', '03', '04'], 'only months with something in them');
  assert.equal(year.totals.done, 2);

  const march = await m.api('/summary?year=2026&month=03');
  assert.equal(march.totals.done, 1, 'only Tiny was finished in March');
  assert.equal(march.totals.bought, 1);
  assert.equal(march.totals.hours, 4, 'only the March session counts');
  assert.equal(march.totals.days, 1);
  assert.equal(march.totals.placed, 9000, 'diamonds should be those of what was finished');
  assert.equal(march.records.biggestSize.title, 'Tiny',
               'a record in March should be about March, not the whole stash');

  const february = await m.api('/summary?year=2026&month=02');
  assert.equal(february.totals.done, 0, 'nothing was finished in February');
  assert.equal(february.totals.hours, 4.5, 'but 4.5 hours were worked');
});

test('the summary page shows the figures and narrows when a month is tapped', async () => {
  const m = await mount();
  await summarySeed(m);
  await m.go('#/summary');

  const tiles = () => m.all('.tile').map((t) => t.textContent.replace(/\s+/g, ' ').trim());
  assert.ok(tiles().some((t) => /2paintings finished/.test(t)), tiles().join(' | '));
  assert.ok(m.all('.panel .row').length > 8, 'the records are missing');

  // every record opens the canvas it is about
  const row = m.find('.panel .row[data-go]');
  assert.match(row.getAttribute('data-go'), /^#\/p\/\d+$/);

  await m.tap('[data-act="sumyear"][data-k="2026"]');
  assert.ok(m.find('[data-act="summonth"][data-k="03"]'), 'the month chips did not appear');
  await m.tap('[data-act="summonth"][data-k="03"]');
  assert.ok(tiles().some((t) => /1paintings finished/.test(t)), tiles().join(' | '));

  // and back out again
  await m.tap('[data-act="sumyear"][data-k=""]');
  assert.equal(m.find('[data-act="summonth"]'), null, 'All time should have no months');
  assert.ok(tiles().some((t) => /2paintings finished/.test(t)));
});

test('deleting a project takes its sessions with it', async () => {
  const m = await mount();
  for (const p of await m.api('/projects')) await m.api('/projects/' + p.id, { method: 'DELETE' });
  const p = await m.seed({ title: 'Doomed', status: 'started' });
  await m.api(`/projects/${p.id}/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: '2026-05-01', minutes: 300 }) });
  assert.equal((await m.api('/summary')).totals.hours, 5);

  await m.api('/projects/' + p.id, { method: 'DELETE' });
  // hours worked on a canvas you deleted are not hours you worked
  assert.equal((await m.api('/summary')).totals.hours, 0);
  assert.equal((await m.api('/summary')).totals.days, 0);
});

/* Some shops publish the canvas size, diamond count and colour count on the
   product page and nowhere in the feed. Fetching that page for every kit at
   sync time would add megabytes to every sync, so it happens once, for a kit
   you actually own. */
const SPEC_HTML = `<ul>
  <li><b>Diamond Amount:</b> 95,200</li>
  <li><b>Image Size:</b> 60cm x 85cm (23.6" x 33.5")</li>
  <li><b>Color Amount:</b> 80 Colors Including 3 AB, 5 Shimmer, 2 Metallic</li></ul>`;
/* Each test gets its own handle. The whole file shares one database, and a
   catalogue row that another test has already filled in and had cached is
   indistinguishable from one this test's own fetch filled in — which is how a
   test asserting that an empty page yields nothing came back with 95,200. */
let muniN = 0;
/* Stand the shop up from a known state. A catalogue sync skips shops that are
   switched off, and every test in this file shares one database — so a shop
   another test disabled would simply never sync here, leaving no catalogue row
   and a test comparing fields on an object that was never a row. */
const muniMount = async (product) => {
  const m = await mount({ products: [product], shop: 'muni' });
  await m.api('/prefs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ excluded: [] }) });
  await m.sync();
  const [row] = await m.api('/catalogue/browse?shop=muni&limit=5');
  assert.ok(row, 'the shop did not sync, so nothing below is about what it says it is');
  return m;
};
const muniProduct = (over = {}) => ({
  id: 42, title: "'The Underwater Castle' by Femke Deborah, Diamond Painting Canvas Kit (128)",
  vendor: 'Vancy Arts', handle: 'underwater-castle-' + (++muniN),
  product_type: 'Diamond Painting Kit',
  tags: ['square', 'square drill'], specHtml: SPEC_HTML,
  images: [{ src: 'https://cdn.shopify.com/a.jpg' }],
  variants: [{ title: 'Default Title', price: '85.00', available: true }], ...over
});

test('a kit whose spec is only on the shop page gets it when you own it', async () => {
  const kit = muniProduct();
  const m = await muniMount(kit);

  /* Ask for this shop by name. An earlier test walks Settings and taps every
     control, which switches shops off, and that preference outlives it in the
     one database this file shares — so an unqualified browse can legitimately
     come back empty and has nothing to do with what is being tested here. */
  const listed = await m.api('/catalogue/browse?shop=muni&limit=5');
  assert.equal(listed.length, 1, 'the catalogue did not come back');
  assert.equal(listed[0].width_in, null, 'the feed itself carries no size');
  assert.equal(listed[0].drills, null);

  const row = await m.api('/catalogue/product?shop=muni&handle=' + kit.handle);
  assert.equal(row.width_in, 23.6, 'the inches on the page are used rather than converted from cm');
  assert.equal(row.height_in, 33.5);
  assert.equal(row.drills, 95200);
  assert.equal(row.colors, 80);
  assert.equal(row.special, '3 AB, 5 Shimmer, 2 Metallic');
  assert.equal(row.spec_checked, 1, 'the answer should be remembered, not asked for twice');
});

test('the backfill fills owned projects and never overwrites what you typed', async () => {
  const kit = muniProduct();
  const m = await muniMount(kit);
  for (const p of await m.api('/projects')) await m.api('/projects/' + p.id, { method: 'DELETE' });

  const mine = await m.seed({ title: 'The Underwater Castle', status: 'started',
                              shop: 'muni', dac_handle: kit.handle });
  // a count you corrected by hand is yours and must survive
  const typed = await m.seed({ title: 'Corrected', status: 'started', shop: 'muni',
                               dac_handle: kit.handle, drills: 1234, colors: 7 });
  await m.sync();

  const filled = await m.api('/projects/' + mine.id);
  assert.equal(filled.drills, 95200, 'the blank project was not filled in');
  assert.equal(filled.width_in, 23.6);
  assert.equal(filled.colors, 80);

  const kept = await m.api('/projects/' + typed.id);
  assert.equal(kept.drills, 1234, 'a hand-typed diamond count was overwritten');
  assert.equal(kept.colors, 7);
  assert.equal(kept.width_in, 23.6, 'the fields that were empty should still be filled');
});

test('a shop page with nothing on it is not asked about twice', async () => {
  const kit = muniProduct({ specHtml: '<html><body>nothing here</body></html>' });
  const m = await muniMount(kit);
  const row = await m.api('/catalogue/product?shop=muni&handle=' + kit.handle);
  /* A real catalogue row carries the kit's title; the fallback for a handle the
     catalogue does not have carries a null one. Asserting the title pins that
     this came from the catalogue rather than from the shop, which is what fails
     when the in-memory copy has been emptied by a sync and not rebuilt. */
  assert.equal(row.title, 'The Underwater Castle', 'this did not come from the catalogue');
  assert.equal(row.drills, null);
  assert.equal(row.spec_checked, 1, 'an empty page must still be marked as read');
});

test('a counted diamond number stops being an estimate', async () => {
  const kit = muniProduct();
  const m = await muniMount(kit);
  for (const p of await m.api('/projects')) await m.api('/projects/' + p.id, { method: 'DELETE' });

  // a linked kit now takes the shop's own count as it is created
  const p = await m.seed({ title: 'Linked', status: 'started', shop: 'muni', dac_handle: kit.handle });
  assert.equal(p.drills, 95200, 'the count on the shop page did not come across');
  assert.ok(!p.drills_estimated);

  /* An older build left projects carrying an estimate and no real count. The
     backfill still has to replace one when the shop turns out to publish it. */
  await m.api('/projects/' + p.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drills: null, drills_estimated: 1 }) });
  await m.sync();
  const after = await m.api('/projects/' + p.id);
  assert.equal(after.drills, 95200);
  assert.ok(!after.drills_estimated, 'a counted number is not an estimate');
});

/* Each record carries the scope that suits it rather than the page carrying one
   for all of them: "the dearest kit I finished" is not a question anybody asks.
   And a record with nothing to say is left out rather than shown empty. */
test('records use the scope that suits them, and empty ones are left out', async () => {
  const m = await mount();
  for (const p of await m.api('/projects')) await m.api('/projects/' + p.id, { method: 'DELETE' });
  // the biggest and dearest canvas you own is not one you have finished
  await m.seed({ title: 'Huge Unfinished', status: 'started', drills: 200000,
                 width_in: 40, height_in: 50, price: 200, date_ordered: '2026-01-02' });
  await m.seed({ title: 'Finished Medium', status: 'completed', drills: 50000,
                 width_in: 20, height_in: 24, price: 60, date_ordered: '2026-02-01',
                 date_started: '2026-02-05', date_completed: '2026-03-05' });

  const s = await m.api('/summary');
  // the stash records are about everything owned
  assert.equal(s.records.biggestSize.title, 'Huge Unfinished');
  assert.equal(s.records.dearest.title, 'Huge Unfinished');
  // the finished ones are about what you finished
  assert.equal(s.records.biggestFinished.title, 'Finished Medium');
  assert.equal(s.records.mostDiamondsFinished.title, 'Finished Medium');
  assert.equal(s.heldAmongFinished, 0, 'nothing was ever put down');

  await m.go('#/summary');
  const labels = () => m.all('.panel .row').map((x) => x.textContent.replace(/\s+/g, ' ').trim());
  const shown = labels().join(' | ');

  // nothing here was ever put down, so the "not counting time put down"
  // variants would only repeat the plain ones
  assert.ok(!/not counting time put down/i.test(shown), shown);
  // one finished canvas, so the longest and quickest collapse to one line
  assert.ok(/Start to finish/.test(shown), shown);

  // no sessions were logged, so there is nothing to say about time at the board
  assert.ok(!/Longest single sitting/.test(shown), shown);
  // and no tile claims zero hours
  const tiles = m.all('.tile').map((x) => x.textContent.replace(/\s+/g, ' ').trim());
  assert.ok(!tiles.some((x) => /^0/.test(x)), tiles.join(' | '));
  assert.ok(!tiles.some((x) => /hours logged/.test(x)), 'an empty hours tile was shown');

  // the scope switch is gone
  assert.equal(m.find('[data-act="sumscope"]'), null);
});

test('once a canvas has been put down, both readings of the time appear', async () => {
  const m = await mount();
  for (const p of await m.api('/projects')) await m.api('/projects/' + p.id, { method: 'DELETE' });
  await m.seed({ title: 'Paused', status: 'completed', drills: 40000, width_in: 20, height_in: 20,
                 date_ordered: '2026-01-01', date_started: '2026-01-10', date_completed: '2026-04-10',
                 holds: JSON.stringify([{ held: '2026-02-01', restarted: '2026-03-01' }]) });
  const s = await m.api('/summary');
  assert.equal(s.heldAmongFinished, 1);
  assert.equal(s.records.longestDays.value, 90);
  assert.equal(s.records.longestDaysNet.value, 62);

  await m.go('#/summary');
  const shown = m.all('.panel .row').map((x) => x.textContent.replace(/\s+/g, ' ').trim()).join(' | ');
  assert.ok(/[Nn]ot counting time put down/.test(shown), shown);
});

test('the way into the summary is a card, not a stretched button', async () => {
  const m = await mount();
  await m.go('#/settings');
  const card = m.find('.navcard');
  assert.ok(card, 'no way into the summary from Settings');
  assert.equal(card.getAttribute('data-go'), '#/summary');
  assert.equal(m.find('.btn.ghost.wide[data-go="#/summary"]'), null,
               'the full-width button put its label at one edge and its chevron at the other');
});

test('a most-and-least pair that lands on one canvas becomes one line', async () => {
  const m = await mount();
  for (const p of await m.api('/projects')) await m.api('/projects/' + p.id, { method: 'DELETE' });
  // one finished canvas: biggest and smallest are the same fact twice
  await m.seed({ title: 'Only One', status: 'completed', drills: 90000, width_in: 30, height_in: 40,
                 price: 120, date_ordered: '2026-01-01', date_started: '2026-02-01',
                 date_completed: '2026-05-01' });
  await m.seed({ title: 'Still Going', status: 'started', drills: 40000, width_in: 20, height_in: 20,
                 price: 50, date_ordered: '2026-01-05' });
  await m.go('#/summary');
  const rows = m.all('.panel .row').map((x) => x.textContent.replace(/\s+/g, ' ').trim());
  const finished = rows.filter((x) => /Only One/.test(x));

  assert.ok(finished.some((x) => /^Canvas /.test(x)), rows.join(' | '));
  assert.ok(!finished.some((x) => /^Smallest /.test(x)),
            'the only finished canvas was named as both biggest and smallest');
  assert.ok(!rows.some((x) => /^Fewest diamonds Only One/.test(x)), rows.join(' | '));

  // but the stash has two, so its pairs stay pairs
  assert.ok(rows.some((x) => /^Biggest /.test(x)), rows.join(' | '));
  assert.ok(rows.some((x) => /^Smallest /.test(x)), rows.join(' | '));
});

test('money is never added across currencies', async () => {
  const m = await mount();
  for (const p of await m.api('/projects')) await m.api('/projects/' + p.id, { method: 'DELETE' });
  await m.seed({ title: 'Pounds One', status: 'received', price: 80, currency: 'GBP',
                 drills: 40000, date_ordered: '2026-01-02' });
  await m.seed({ title: 'Pounds Two', status: 'received', price: 60, currency: 'GBP',
                 drills: 60000, date_ordered: '2026-01-03' });
  await m.seed({ title: 'Dollars', status: 'received', price: 90, currency: 'USD',
                 drills: 30000, date_ordered: '2026-01-04' });

  const s = await m.api('/summary');
  // £140 and $90 are two facts, not one number
  assert.deepEqual(s.totals.spendBy.map(({ currency, total }) => ({ currency, total })),
                   [{ currency: 'GBP', total: 140 }, { currency: 'USD', total: 90 }]);
  assert.equal(s.totals.spend, undefined, 'a single mixed-currency total should not exist');
  assert.equal(s.mainCurrency, 'GBP');
  assert.equal(s.currencies, 2);

  // the $90 kit is the largest number, but it is not the dearest thing in pounds
  assert.equal(s.records.dearest.title, 'Pounds One');
  assert.equal(s.records.dearest.currency, 'GBP');
  assert.equal(s.records.bestValue.title, 'Pounds Two');

  await m.go('#/summary');
  const tiles = m.all('.tile').map((x) => x.textContent.replace(/\s+/g, ' ').trim());
  const spent = tiles.find((x) => /spent/.test(x));
  assert.match(spent, /£140\.00/);
  assert.match(spent, /\$90\.00/, 'the dollars were folded into the pounds');
  assert.ok(!/£230/.test(spent), 'currencies were added together');

  const rows = m.all('.panel .row').map((x) => x.textContent.replace(/\s+/g, ' ').trim());
  assert.ok(rows.some((x) => /Dearest .*£80\.00/.test(x)), rows.join(' | '));
});

/* Settings and the summary answer the same questions from the same rows. They
   were written months apart and drifted once already over currency, so they are
   held together here rather than by hoping. */
test('Settings and the summary agree on the same collection', async () => {
  const m = await mount();
  for (const p of await m.api('/projects')) await m.api('/projects/' + p.id, { method: 'DELETE' });
  await m.seed({ title: 'Wished', status: 'wishlist', price: 999, drills: 500000 });
  await m.seed({ title: 'Waiting', status: 'notReceived', price: 60, drills: 40000, date_ordered: '2026-01-02' });
  await m.seed({ title: 'Going', status: 'started', price: 70, drills: 100000, progress: 30,
                 date_ordered: '2026-02-02', date_started: '2026-02-10' });
  await m.seed({ title: 'Dollars', status: 'received', price: 90, currency: 'USD', drills: 30000,
                 date_ordered: '2026-03-02' });
  await m.seed({ title: 'Done', status: 'completed', price: 100, drills: 90000,
                 date_ordered: '2026-01-05', date_started: '2026-02-01', date_completed: '2026-04-01' });

  const stats = await m.api('/stats');
  const s = await m.api('/summary');
  assert.equal(s.totals.done, stats.completed, 'completed count');
  assert.equal(s.totals.bought, stats.projects - stats.wishlist, 'owned count');
  assert.equal(s.totals.placed, stats.placed, 'diamonds placed');
  assert.equal(s.totals.remaining, stats.remaining, 'diamonds still to place');
  assert.deepEqual(s.totals.spendBy, stats.spendBy, 'spend, per currency');
});

test('a project with no order date is accounted for rather than quietly dropped', async () => {
  const m = await mount();
  for (const p of await m.api('/projects')) await m.api('/projects/' + p.id, { method: 'DELETE' });
  await m.seed({ title: 'Dated', status: 'received', price: 40, drills: 10000, date_ordered: '2026-02-02' });
  /* A project created now gets the dates its status implies, so an undated one
     has to be made the way older builds left them: dates cleared afterwards. */
  const undated = await m.seed({ title: 'No date at all', status: 'received', price: 60, drills: 20000 });
  await m.api('/projects/' + undated.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date_ordered: null, date_received: null }) });

  const all = await m.api('/summary');
  const year = await m.api('/summary?year=2026');
  assert.equal(all.totals.bought, 2);
  assert.equal(year.totals.bought, 1, 'the undated project belongs to no year');
  assert.equal(year.totals.undated, 1);

  // and the page says so, because otherwise the year simply fails to add up
  await m.go('#/summary');
  await m.tap('[data-act="sumyear"][data-k="2026"]');
  assert.match(m.screen(), /no order or delivery date/);
  // said on All time as well, because a logbook with nothing dated has no year
  // chips at all and would never be offered the fix
  await m.tap('[data-act="sumyear"][data-k=""]');
  assert.match(m.screen(), /no order or delivery date/);

  // but not once there is nothing missing
  await m.api('/projects/backfill-dates', { method: 'POST' });
  await m.go('#/summary');
  assert.ok(!/no order or delivery date/.test(m.screen()));
});

/* A period has to be applied with the date that belongs to the fact. Time put
   down is measured by when it was put down; time at the board by when you sat
   at it. Scoping either by the order date made a year name one canvas and all
   time name another, on the same data. */
test('a hold is counted in the year it happened, not the year the kit was bought', async () => {
  const m = await mount();
  for (const p of await m.api('/projects')) await m.api('/projects/' + p.id, { method: 'DELETE' });

  // bought in 2025, put down for three weeks during 2026
  await m.seed({ title: 'Bought Earlier', status: 'started', drills: 50000,
                 date_ordered: '2025-06-01', date_started: '2025-07-01',
                 holds: JSON.stringify([{ held: '2026-03-01', restarted: '2026-03-22' }]) });
  // bought in 2026, put down for nine days
  await m.seed({ title: 'Bought In Year', status: 'started', drills: 40000,
                 date_ordered: '2026-01-05', date_started: '2026-02-01',
                 holds: JSON.stringify([{ held: '2026-05-01', restarted: '2026-05-10' }]) });

  const year = await m.api('/summary?year=2026');
  assert.equal(year.records.longestHeld.title, 'Bought Earlier',
               'the longest hold in 2026 was on a kit bought in 2025');
  assert.equal(year.records.longestHeld.value, 21);
  assert.equal(year.totals.everHeld, 2, 'both were put down during 2026');

  const all = await m.api('/summary');
  assert.equal(all.records.longestHeld.title, 'Bought Earlier');

  // a hold that happened entirely in another year is not in this one
  const other = await m.api('/summary?year=2025');
  assert.equal(other.totals.everHeld, 0);
  assert.equal(other.records.longestHeld, null);
});

test('time at the board is measured by when you sat at it', async () => {
  const m = await mount();
  for (const p of await m.api('/projects')) await m.api('/projects/' + p.id, { method: 'DELETE' });
  const old = await m.seed({ title: 'Old Kit', status: 'started', drills: 50000, date_ordered: '2025-01-01' });
  const fresh = await m.seed({ title: 'New Kit', status: 'started', drills: 40000, date_ordered: '2026-01-01' });
  // the kit bought in 2025 got far more hours during 2026
  for (const [id, on, minutes] of [[old.id, '2026-04-01', 300], [old.id, '2026-04-02', 240],
                                   [fresh.id, '2026-04-03', 60], [old.id, '2025-05-01', 600]])
    await m.api(`/projects/${id}/sessions`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on, minutes }) });

  const year = await m.api('/summary?year=2026');
  assert.equal(year.records.mostHours.title, 'Old Kit', 'hours were scoped by the order date');
  assert.equal(year.records.mostHours.value, 9, 'only the 2026 sessions count');
  assert.equal(year.records.mostSessions.value, 2);
  assert.equal(year.records.longestSession.value, 300);

  // and the 2025 sitting belongs to 2025
  const before = await m.api('/summary?year=2025');
  assert.equal(before.records.longestSession.value, 600);
  assert.equal(before.records.mostHours.value, 10);
});

/* Only the current percentage was ever kept, so "diamonds placed in March" had
   no answer. Every change to a project's progress is recorded now. */
test('moving a project on records what was placed and when', async () => {
  const m = await mount();
  for (const p of await m.api('/projects')) await m.api('/projects/' + p.id, { method: 'DELETE' });
  const p = await m.seed({ title: 'Working', status: 'started', drills: 100000, progress: 0,
                           date_ordered: '2026-01-01', date_started: '2026-01-10' });
  const move = (progress) => m.api('/projects/' + p.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progress }) });

  await move(20);
  await move(35);
  const s = await m.api('/summary');
  assert.ok(s.totals.historyFrom, 'nothing was recorded');

  // 35% of 100,000 was placed, in two goes
  const today = new Date().toISOString().slice(0, 10);
  const month = await m.api(`/summary?year=${today.slice(0, 4)}&month=${today.slice(5, 7)}`);
  assert.equal(month.totals.placed, 35000);

  // and going backwards is not a placement
  await move(30);
  const after = await m.api(`/summary?year=${today.slice(0, 4)}&month=${today.slice(5, 7)}`);
  assert.equal(after.totals.placed, 30000, 'undoing progress should take it back off');
});

test('a canvas finished before any history existed still counts in its month', async () => {
  const m = await mount();
  for (const p of await m.api('/projects')) await m.api('/projects/' + p.id, { method: 'DELETE' });
  // seeded straight to completed, the way an import or an older build leaves it
  await m.seed({ title: 'Old Finish', status: 'completed', drills: 60000,
                 date_ordered: '2026-01-01', date_started: '2026-01-05', date_completed: '2026-03-20' });
  const march = await m.api('/summary?year=2026&month=03');
  assert.equal(march.totals.placed, 60000, 'a finished canvas with no history was ignored');
});

test('progress history goes with the project when it is deleted', async () => {
  const m = await mount();
  for (const q of await m.api('/projects')) await m.api('/projects/' + q.id, { method: 'DELETE' });
  const p = await m.seed({ title: 'Doomed', status: 'started', drills: 50000, progress: 0 });
  await m.api('/projects/' + p.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progress: 50 }) });
  const today = new Date().toISOString().slice(0, 10);
  const q = `?year=${today.slice(0, 4)}&month=${today.slice(5, 7)}`;
  assert.equal((await m.api('/summary' + q)).totals.placed, 25000);

  await m.api('/projects/' + p.id, { method: 'DELETE' });
  assert.equal((await m.api('/summary' + q)).totals.placed, 0,
               'diamonds placed on a canvas you deleted are not diamonds you placed');
});

test('a backup carries progress history, and restoring twice does not double it', async () => {
  const m = await mount();
  for (const q of await m.api('/projects')) await m.api('/projects/' + q.id, { method: 'DELETE' });
  const p = await m.seed({ title: 'Tracked', status: 'started', drills: 80000, progress: 0,
                           date_ordered: '2026-01-01', date_started: '2026-01-05' });
  await m.api('/projects/' + p.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progress: 25 }) });

  const full = await m.api('/projects/' + p.id);
  assert.equal(full.progress_history.length, 1, 'the project does not carry its history');
  const backup = JSON.stringify({
    version: 3, projects: [full], photos: [], sessions: [],
    progress: full.progress_history.map((h) => ({ ...h, project_id: p.id }))
  });

  // restore into an empty logbook
  await m.api('/projects/' + p.id, { method: 'DELETE' });
  const first = await m.api('/restore', { method: 'POST', body: backup });
  assert.equal(first.progress, 1, 'the history was not restored');

  const today = new Date().toISOString().slice(0, 10);
  const q = `?year=${today.slice(0, 4)}&month=${today.slice(5, 7)}`;
  assert.equal((await m.api('/summary' + q)).totals.placed, 20000);

  // and again: the same diamonds must not be counted twice
  const second = await m.api('/restore', { method: 'POST', body: backup });
  assert.equal(second.progress, 0, 'restoring twice duplicated the history');
  assert.equal((await m.api('/summary' + q)).totals.placed, 20000);
});

/* The rule that a status implies its earlier dates ran when a status was
   changed and not when a project was created, so anything added from the
   catalogue kept the default status and arrived with no dates at all — and then
   belonged to no month, which is why a year did not add up to All time. */
test('a project created with a status gets the dates that status implies', async () => {
  const m = await mount();
  for (const q of await m.api('/projects')) await m.api('/projects/' + q.id, { method: 'DELETE' });

  const waiting = await m.seed({ title: 'Added from the catalogue', status: 'notReceived' });
  assert.ok(waiting.date_ordered, 'a kit on its way has no order date');

  const here = await m.seed({ title: 'On the shelf', status: 'received' });
  assert.ok(here.date_ordered && here.date_received);

  // a wish-list kit has not been bought, so it gets no dates at all
  const wished = await m.seed({ title: 'Wished for', status: 'wishlist' });
  assert.ok(!wished.date_ordered && !wished.date_received);

  // and a date you supplied is yours
  const mine = await m.seed({ title: 'Ordered in February', status: 'received', date_ordered: '2026-02-01' });
  assert.equal(mine.date_ordered, '2026-02-01');

  // so nothing new lands outside every year
  assert.equal((await m.api('/summary?year=2026')).totals.undated, 0);
});

/* A logbook built over months has gaps in it, and the only way to find them was
   to open everything. A project with no order date is the one that matters:
   it belongs to no month and falls quietly out of every year. */
test('the logbook can show you what still needs filling in', async () => {
  const m = await mount();
  for (const q of await m.api('/projects')) await m.api('/projects/' + q.id, { method: 'DELETE' });
  const complete = await m.seed({ title: 'All there', status: 'received', price: 50,
                                  drills: 40000, width_in: 20, height_in: 20, date_ordered: '2026-02-01' });
  const bare = await m.seed({ title: 'Nothing known', status: 'received' });
  // older builds left projects with no dates at all
  await m.api('/projects/' + bare.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date_ordered: null, date_received: null }) });

  await m.go('#/');
  await m.tap('[data-act="lbfilters"]');
  const chip = m.find('[data-act="lbgaps"][data-k="dates"]');
  assert.ok(chip, 'there is no way to find the projects with no dates');
  assert.match(chip.textContent, /No dates · 1/, chip.textContent);

  await m.tap('[data-act="lbgaps"][data-k="dates"]');
  const titles = m.all('.card .name').map((n) => n.textContent);
  assert.deepEqual(titles, ['Nothing known']);

  // tapping it again turns it off, like every other filter
  await m.tap('[data-act="lbgaps"][data-k="dates"]');
  assert.equal(m.all('.card .name').length, 2);

  // and a gap nobody has is not offered
  await m.api('/projects/' + bare.id, { method: 'DELETE' });
  await m.api('/projects/' + complete.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ price: 50 }) });
  await m.go('#/');
  await m.tap('[data-act="lbfilters"]');
  assert.equal(m.find('[data-act="lbgaps"][data-k="dates"]'), null,
               'a filter for a gap that nobody has is just noise');
});

test('the summary takes you straight to the projects with no dates', async () => {
  const m = await mount();
  for (const q of await m.api('/projects')) await m.api('/projects/' + q.id, { method: 'DELETE' });
  await m.seed({ title: 'Dated', status: 'received', price: 40, date_ordered: '2026-02-02' });
  const bare = await m.seed({ title: 'Undated', status: 'received', price: 60 });
  await m.api('/projects/' + bare.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date_ordered: null, date_received: null }) });

  await m.go('#/summary');
  await m.tap('[data-act="sumyear"][data-k="2026"]');
  await m.tap('[data-act="shownodates"]');

  assert.equal(globalThis.location.hash, '#/', 'it should land on the logbook');
  assert.deepEqual(m.all('.card .name').map((n) => n.textContent), ['Undated'],
                   'the logbook is not showing the undated projects');
});

/* The date rule ran when a status was tapped, and a new project already has one
   selected — so add from the catalogue and save, which is the commonest path
   there is, went through the form with every date box empty. */
test('a new project shows the dates its status implies before you save', async () => {
  const m = await mount();
  for (const q of await m.api('/projects')) await m.api('/projects/' + q.id, { method: 'DELETE' });
  await m.sync();
  await m.go('#/browse');
  await m.tap('[data-act="pickcat"]');

  const ordered = m.find('#date_ordered');
  assert.ok(ordered, 'the form has no order date field');
  assert.match(ordered.getAttribute('value'), /^\d{4}-\d{2}-\d{2}$/,
               'the form shows no order date for a kit that is on its way');

  // what it shows is what it saves
  await m.tap('[data-act="save"]');
  const [saved] = await m.api('/projects');
  assert.equal(saved.date_ordered, ordered.getAttribute('value'));

  // a wish-list kit has not been bought, so the form offers no dates for it
  await m.go('#/new');
  await m.tap('#status .opt[data-k="wishlist"]');
  assert.equal(m.find('#date_ordered').value || '', '',
               'a kit you have only wished for was given an order date');
});

test('a date row is not a label, so the picker is not closed by its own tap', () => {
  // A label forwards a second, synthetic click to the control it names. With the
  // input covering the whole row that meant one tap opened the picker and shut
  // it again, which is what "it pops up and immediately disappears" was.
  const src = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.ok(!/<label[^>]*class="row daterow"/.test(src),
            'the date row is a label again, which closes the picker as it opens');
  assert.match(src, /<div class="row daterow">/);
});

test('the undated projects can be dated from the day they were added', async () => {
  const m = await mount();
  for (const q of await m.api('/projects')) await m.api('/projects/' + q.id, { method: 'DELETE' });

  const bare = await m.seed({ title: 'No dates', status: 'received', price: 40 });
  await m.api('/projects/' + bare.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date_ordered: null, date_received: null }) });
  await m.seed({ title: 'Wished', status: 'wishlist' });
  await m.seed({ title: 'Already dated', status: 'received', date_ordered: '2026-02-01' });

  assert.equal((await m.api('/projects/backfill-dates')).candidates, 1);
  assert.equal((await m.api('/projects/backfill-dates', { method: 'POST' })).filled, 1);

  const byTitle = Object.fromEntries((await m.api('/projects')).map((r) => [r.title, r]));
  assert.ok(byTitle['No dates'].date_ordered, 'the undated project was not dated');
  assert.equal(byTitle['No dates'].date_ordered,
               String(byTitle['No dates'].created_at).slice(0, 10));
  // a wish-list kit has not been bought, and a date you typed is yours
  assert.ok(!byTitle['Wished'].date_ordered);
  assert.equal(byTitle['Already dated'].date_ordered, '2026-02-01');

  // running it twice does nothing the second time
  assert.equal((await m.api('/projects/backfill-dates', { method: 'POST' })).filled, 0);
});

test('the summary offers the backfill, and asks first', async () => {
  const m = await mount();
  for (const q of await m.api('/projects')) await m.api('/projects/' + q.id, { method: 'DELETE' });
  const bare = await m.seed({ title: 'Undated', status: 'received', price: 40 });
  await m.api('/projects/' + bare.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date_ordered: null, date_received: null }) });

  /* Offered on All time too. With nothing dated there are no year chips at all,
     so an offer that only appeared under a year would be unreachable by exactly
     the logbook that needs it most. */
  await m.go('#/summary');
  assert.ok(m.find('[data-act="backfilldates"]'), 'the summary does not offer to fill them in');

  // saying no changes nothing
  m.answerConfirms(false);
  await m.tap('[data-act="backfilldates"]');
  assert.ok(!(await m.api('/projects/' + bare.id)).date_ordered, 'it dated them without asking');

  m.answerConfirms(true);
  await m.tap('[data-act="backfilldates"]');
  assert.ok((await m.api('/projects/' + bare.id)).date_ordered);
});

/* The tap that opens a date picker must do nothing else. The input carries a
   data-act so a pick can be routed, and the click delegation matched the same
   attribute — so opening the calendar also ran the save, which re-rendered the
   page and took the input, and the picker with it, out from under the finger.
   The earlier test only ever dispatched `change`, so it never saw this. */
test('the tap that opens a date picker does not itself save anything', async () => {
  const m = await mount();
  const p = await m.seed({ title: 'Moon Eater', status: 'received',
                           date_ordered: '2026-03-01', date_received: '2026-03-08' });
  await m.go('#/p/' + p.id);

  const el = m.find('[data-act="setdate"][data-k="date_started"]');
  const before = m.find('.daterow');
  el.dispatchEvent({ type: 'click' });
  await m.settle();

  // nothing saved, nothing navigated, and the row was not rebuilt underneath it
  assert.equal((await m.api('/projects/' + p.id)).date_started ?? null, null,
               'opening the picker saved a date on its own');
  assert.equal(globalThis.location.hash, '#/p/' + p.id);
  assert.equal(m.find('.daterow'), before, 'the page re-rendered and took the picker with it');

  // and the pick itself still works
  el.value = '2026-08-20';
  el.dispatchEvent({ type: 'change' });
  await m.settle();
  const row = await m.api('/projects/' + p.id);
  assert.equal(row.date_started, '2026-08-20');
  assert.equal(row.status, 'started', 'the status did not follow the date');
});

/* A canvas size implies roughly how many diamonds cover it, and that estimate
   was only ever applied by the order importer — so a kit added from the
   catalogue or by hand, from a shop that publishes no count, had nothing. */
test('a canvas with a size gets an estimated diamond count however it arrived', async () => {
  const m = await mount();
  for (const q of await m.api('/projects')) await m.api('/projects/' + q.id, { method: 'DELETE' });

  const byHand = await m.seed({ title: 'By hand', status: 'received',
                                width_in: 24, height_in: 32, shape: 'Square' });
  assert.ok(byHand.drills > 0, 'a canvas with a size got no estimate');
  assert.equal(byHand.drills_estimated, 1, 'the estimate is not marked as one');

  // no shape, no estimate: the density depends on it
  const noShape = await m.seed({ title: 'No shape', status: 'received', width_in: 24, height_in: 32 });
  assert.ok(!noShape.drills, 'guessed a count with no drill shape to go on');

  // and a real count is never replaced by a guess
  const counted = await m.seed({ title: 'Counted', status: 'received', width_in: 24, height_in: 32,
                                 shape: 'Square', drills: 12345 });
  assert.equal(counted.drills, 12345);
  assert.ok(!counted.drills_estimated);
});

test('relinking fills the blanks from the listing and leaves the rest alone', async () => {
  const m = await mount();
  for (const q of await m.api('/projects')) await m.api('/projects/' + q.id, { method: 'DELETE' });
  await m.sync();

  // a project with almost nothing on it, and one thing typed by hand
  const p = await m.seed({ title: 'Blank', status: 'received', colors: 7 });
  const linked = await m.api('/projects/' + p.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dac_handle: 'moon-eater', shop: 'dac' }) });

  assert.equal(linked.artist, 'Yuumei Art', 'relinking brought across no artist');
  assert.ok(linked.width_in > 0 && linked.height_in > 0, 'no canvas size came across');
  assert.ok(linked.drills > 0, 'no diamond count came across');
  assert.equal(linked.shape, 'Square');
  assert.ok(linked.price > 0, 'no price came across');
  assert.equal(linked.price_source, 'catalogue', 'a price from the shop should say where it came from');
  // the colour count was typed, so it stays as it was
  assert.equal(linked.colors, 7, 'relinking overwrote a value that was typed by hand');

  // relinking again changes nothing that is now filled in
  const again = await m.api('/projects/' + p.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dac_handle: 'moon-eater-2', shop: 'dac' }) });
  assert.equal(again.colors, 7);
  assert.equal(again.artist, 'Yuumei Art');
});

test('a kit picked from the catalogue arrives with its details filled in', async () => {
  const m = await mount();
  for (const q of await m.api('/projects')) await m.api('/projects/' + q.id, { method: 'DELETE' });
  await m.sync();
  await m.go('#/browse');
  await m.tap('[data-act="pickcat"]');
  await m.tap('[data-act="save"]');

  const [saved] = await m.api('/projects');
  assert.equal(saved.artist, 'Yuumei Art');
  assert.ok(saved.drills > 0, 'the diamond count did not come across');
  assert.ok(saved.colors > 0);
  assert.ok(saved.date_ordered, 'and it should still get the date its status implies');
});

test('an estimated count never blocks the real one', async () => {
  const kit = muniProduct();
  const m = await muniMount(kit);
  for (const q of await m.api('/projects')) await m.api('/projects/' + q.id, { method: 'DELETE' });

  /* A size with no count gets an estimate. An estimate is a number, so it would
     have looked like a filled field and stopped the shop's real count ever
     being fetched — a guess outliving the truth. */
  const p = await m.seed({ title: 'Guessed', status: 'started', width_in: 20, height_in: 24, shape: 'Square' });
  assert.ok(p.drills > 0 && p.drills_estimated, 'no estimate was made');
  const guess = p.drills;

  await m.api('/projects/' + p.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shop: 'muni', dac_handle: kit.handle }) });
  const after = await m.api('/projects/' + p.id);

  assert.equal(after.drills, 95200, `the estimate of ${guess} was never replaced`);
  assert.ok(!after.drills_estimated, 'it is a counted number now, not an estimate');
});

/* An order history knows when you bought things. The import only ever created
   what was missing and skipped the rest as duplicates, so a second import could
   not answer the one question a logbook cannot answer for itself. */
const ORDER_CSV = 'Order,Date,Payment Status,Fulfillment Status,Total,Products\n' +
                  '#100,2026/03/07,paid,fulfilled,£169.00,Moon Eater\n';

test('an order history fills the blanks on projects already in the logbook', async () => {
  const m = await mount();
  for (const q of await m.api('/projects')) await m.api('/projects/' + q.id, { method: 'DELETE' });
  await m.sync();

  // the project is already there, with no order date and a colour count typed in
  const p = await m.seed({ title: 'Moon Eater', status: 'received', colors: 7 });
  await m.api('/projects/' + p.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date_ordered: null, date_received: null }) });

  const preview = await m.api('/import/preview?shop=dac', { method: 'POST', body: ORDER_CSV });
  const dupe = preview.kits.find((k) => k.duplicate);
  assert.ok(dupe, 'the order line did not match the project already in the logbook');
  assert.equal(preview.summary.fillable, 1);
  assert.ok(dupe.fills.date_ordered, 'the order date is not offered as a fill');
  assert.ok(!('colors' in dupe.fills), 'a colour count typed by hand was offered up to be overwritten');

  const r = await m.api('/import/fill', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kits: [dupe] }) });
  assert.equal(r.filled, 1);

  const after = await m.api('/projects/' + p.id);
  assert.equal(after.date_ordered, '2026-03-07', 'the order date was not filled in');
  assert.equal(after.colors, 7, 'the typed colour count was overwritten');
  assert.equal(after.order_ref, '#100');

  // and it no longer counts as undated
  assert.equal((await m.api('/summary')).totals.undated, 0);

  // running it again fills nothing, because nothing is blank any more
  const again = await m.api('/import/fill', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kits: [dupe] }) });
  assert.equal(again.filled, 0);
});

test('the review screen offers the fill, on the tab where the matches are', () => {
  /* The review is reached through a file input, which a test cannot hand a file
     to; the behaviour above is covered at the API. This checks the offer is
     actually wired to it and sits on the Logged tab, where the projects it
     talks about are listed. */
  const src = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.match(src, /tab === 'dupe' && sum\.fillable/, 'the fill is not offered on the Logged tab');
  assert.match(src, /data-act="importfill"/);
  assert.match(src, /act === 'importfill'/, 'the button has no handler');
  assert.match(src, /'\/import\/fill'/, 'the handler does not call the fill route');
});

test('an order for a kit the shop no longer sells can still date it', async () => {
  const m = await mount();
  for (const q of await m.api('/projects')) await m.api('/projects/' + q.id, { method: 'DELETE' });
  await m.sync();

  /* Shops retire listings. A kit bought last May may not be sold any more, and
     those are exactly the oldest — and so the undated — projects. The line will
     not match the catalogue, but the logbook still has the project. */
  const p = await m.seed({ title: 'Retired Canvas', status: 'received' });
  await m.api('/projects/' + p.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date_ordered: null, date_received: null }) });

  const csv = 'Order,Date,Payment Status,Fulfillment Status,Total,Products\n' +
              '#900,2026/05/24,paid,fulfilled,£70.00,Retired Canvas\n';
  const preview = await m.api('/import/preview?shop=dac', { method: 'POST', body: csv });

  assert.equal(preview.kits.length, 0, 'the catalogue should not have matched it');
  const line = (preview.skipped || []).find((x) => x.fillCount > 0);
  assert.ok(line, 'a line the catalogue could not match was not offered against the logbook');
  assert.equal(preview.summary.fillable, 1);

  await m.api('/import/fill', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kits: [line] }) });
  assert.equal((await m.api('/projects/' + p.id)).date_ordered, '2026-05-24');

  // and a line matching nothing in the logbook is still just skipped
  const other = 'Order,Date,Payment Status,Fulfillment Status,Total,Products\n' +
                '#901,2026/05/24,paid,fulfilled,£70.00,Never Heard Of It\n';
  const second = await m.api('/import/preview?shop=dac', { method: 'POST', body: other });
  assert.equal(second.summary.fillable, 0);
});

/* A bulk change to your records belongs where you would look for one. It was
   small grey underlined text part-way down the summary, which is not a place
   anybody finds an action. */
test('the offer to date undated projects is in Settings, under Your data', async () => {
  const m = await mount();
  for (const q of await m.api('/projects')) await m.api('/projects/' + q.id, { method: 'DELETE' });
  const p = await m.seed({ title: 'Undated', status: 'received' });
  await m.api('/projects/' + p.id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date_ordered: null, date_received: null }) });

  await m.go('#/settings');
  assert.ok(m.find('[data-act="backfilldates"]'), 'Settings does not offer to fill in the dates');
  assert.ok(m.find('[data-act="shownodates"]'), 'Settings does not offer to show them');
  // it says how many, so you know what you are agreeing to
  assert.match(m.screen(), /1 project has no order date/);

  // and once there is nothing to do, the offer is not there
  await m.api('/projects/backfill-dates', { method: 'POST' });
  await m.go('#/settings');
  assert.equal(m.find('[data-act="backfilldates"]'), null,
               'the offer outlived the thing it was offering to fix');
});

/* An order history only makes sense against the shop it came from — the titles
   are matched to that shop's catalogue. The import silently assumed Diamond Art
   Club, so a history from anywhere else was matched against the wrong catalogue
   and found nothing, with no way to say otherwise. */
test('the import says which shop it is reading the file against', async () => {
  const m = await mount({ products: [muniProduct()], shop: 'muni' });
  await m.api('/prefs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ excluded: [] }) });
  await m.sync();
  await m.go('#/import');

  const chip = m.find('[data-act="importshop"][data-k="muni"]');
  assert.ok(chip, 'the import does not say which shop it is about to read this as');
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  assert.match(m.find('#drop').textContent, /Munimade/,
               'the dropzone does not name the shop the file will be matched against');

  // and the chosen shop is what the preview is asked for, rather than always dac
  const src = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.match(src, /\/import\/preview\?shop=' \+ encodeURIComponent\(S\.importShop\)/,
               'the import still asks for a fixed shop');
});

/* A CSV you did not mean to open used to be a one-way door. The review screen's
   back arrow left the import altogether, and the half-read file stayed in hand,
   so coming back to Import showed the same review again — with no way to reach
   the file picker short of finishing an import you did not want. */
test('backing out of a review returns to the file picker, not out of the import', async () => {
  const m = await mount();
  await m.sync();
  await m.go('#/import');
  await m.dropCsv(ORDER_CSV);

  assert.ok(m.find('[data-act="itab"]'), 'choosing a file did not reach the review');

  await m.tap('.titlerow [aria-label="Back"]');
  assert.ok(m.find('#csv'), 'backing out of the review did not return to the file picker');
  assert.equal(m.find('[data-act="itab"]'), null, 'the abandoned review is still on screen');

  // and the file really was let go of, so a second look starts clean
  await m.go('#/');
  await m.go('#/import');
  assert.ok(m.find('#csv'), 'the abandoned file came back');
});

test('leaving the import by any other route lets go of a half-read file', async () => {
  const m = await mount();
  await m.sync();
  await m.go('#/import');
  await m.dropCsv(ORDER_CSV);
  assert.ok(m.find('[data-act="itab"]'), 'choosing a file did not reach the review');

  await m.go('#/settings');            // the phone's own Back, a tapped link — same thing
  await m.go('#/import');
  assert.ok(m.find('#csv'), 'the import reopened onto a review of a file already abandoned');
});

/* A cover is the picture of the canvas you are about to spend eighty hours on.
   It was fetched at 600px wide — fine for a thumbnail, soft the moment you open
   it. Shopify serves whatever width you ask for, so asking for a small one was
   the only thing making these pictures compressed. */
test('a cover is fetched at full fidelity, not a thumbnail', async () => {
  const m = await mount();
  await m.sync();
  const cat = await m.api('/catalogue/search?q=moon');
  m.net.length = 0;
  await m.api('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: cat[0].title, shop: cat[0].shop, dac_handle: cat[0].handle }) });

  const shots = m.net.filter((u) => /\.(jpg|jpeg|png|webp)/i.test(u));
  assert.ok(shots.length, 'adding a kit fetched no pictures at all');
  for (const u of shots)
    assert.equal(new URL(u).searchParams.get('width'), null,
                 'a cover was fetched at a asked-for width, so it is not the original');
});

/* The pictures already on disk were fetched small, and the filename does not
   say how wide they are — so the "is it already here?" check kept handing back
   the soft copy for ever. Existing kits have to be able to catch up. */
test('kits cached before full fidelity can be upgraded in place', async () => {
  const m = await mount();
  await m.sync();
  const cat = await m.api('/catalogue/search?q=moon');
  const made = await m.api('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: cat[0].title, shop: cat[0].shop, dac_handle: cat[0].handle }) });

  // put it back the way an older version of the app left it
  const row = await m.api('/projects/' + made.id);
  await m.api('/projects/' + made.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cover_hifi: 0 }) });

  const before = await m.api('/projects/upgrade-covers');
  assert.equal(before.candidates, 1, 'the kit with soft pictures was not offered an upgrade');

  m.net.length = 0;
  const done = await m.api('/projects/upgrade-covers', { method: 'POST' });
  assert.equal(done.upgraded, 1, 'the upgrade skipped the kit whose file was already on disk');
  const shots = m.net.filter((u) => /\.(jpg|jpeg|png|webp)/i.test(u));
  assert.ok(shots.length, 'the upgrade re-fetched nothing — the on-disk check still short-circuits');
  for (const u of shots)
    assert.equal(new URL(u).searchParams.get('width'), null, 'refetched at a reduced width');

  // and it does not keep offering to do work it has already done
  assert.equal((await m.api('/projects/upgrade-covers')).candidates, 0,
               'the upgrade offers itself again after finishing');
  assert.ok(row.cover, 'sanity: the project had a cover to begin with');
});

/* Moving a kit to Started is the moment you actually look at it. */
test('changing status fetches full fidelity for a kit still on thumbnails', async () => {
  const m = await mount();
  await m.sync();
  const cat = await m.api('/catalogue/search?q=moon');
  const made = await m.api('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: cat[0].title, shop: cat[0].shop, dac_handle: cat[0].handle }) });
  await m.api('/projects/' + made.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cover_hifi: 0 }) });

  m.net.length = 0;
  await m.api('/projects/' + made.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'started' }) });
  const shots = m.net.filter((u) => /\.(jpg|jpeg|png|webp)/i.test(u));
  assert.ok(shots.length, 'a status change did not hot-fetch the full-fidelity pictures');
});

/* An offer nobody can find is not an offer. */
test('the offer to get full-size pictures is in Settings, under Your data', async () => {
  const m = await mount();
  await m.sync();
  const cat = await m.api('/catalogue/search?q=moon');
  const made = await m.api('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: cat[0].title, shop: cat[0].shop, dac_handle: cat[0].handle }) });
  await m.api('/projects/' + made.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cover_hifi: 0 }) });

  await m.go('#/settings');
  assert.ok(m.find('[data-act="upgradecovers"]'), 'Settings never offers to fetch the full-size pictures');

  await m.tap('[data-act="upgradecovers"]');
  assert.equal((await m.api('/projects/upgrade-covers')).candidates, 0, 'the button did not do it');
  assert.equal(m.find('[data-act="upgradecovers"]'), null,
               'the offer outlived the thing it was offering to fix');
});

/* Picking a kit you already own used to open a blank New project form, so the
   only way to notice was to recognise your own canvas halfway through typing it
   in again — and the logbook would then hold it twice, splitting its hours,
   photos and progress between two rows. */
test('picking a kit already in the logbook opens it instead of adding it twice', async () => {
  const m = await mount();
  await m.sync();
  await emptyLogbook(m);
  const cat = await m.api('/catalogue/search?q=moon');
  const made = await m.api('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: cat[0].title, shop: cat[0].shop, dac_handle: cat[0].handle }) });
  const before = (await m.api('/projects')).length;

  m.answerConfirms(true);
  await m.go('#/browse');
  await m.tap('[data-act="pickcat"]');

  assert.equal(globalThis.location.hash, '#/p/' + made.id, 'it did not open the kit already logged');
  assert.equal((await m.api('/projects')).length, before, 'a second copy was created anyway');
});

/* Owning two of the same canvas is a real thing, so the answer is an offer, not
   a refusal. */
test('declining opens the New project form so a second copy can still be added', async () => {
  const m = await mount();
  await m.sync();
  await emptyLogbook(m);
  const cat = await m.api('/catalogue/search?q=moon');
  await m.api('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: cat[0].title, shop: cat[0].shop, dac_handle: cat[0].handle }) });

  m.answerConfirms(false);
  await m.go('#/browse');
  await m.tap('[data-act="pickcat"]');
  assert.equal(globalThis.location.hash, '#/new', 'saying no did not let a second copy be added');
});

/* A kit typed in by hand has no listing behind it, and is still the same canvas. */
test('a kit added by hand is recognised by name, with no listing link', async () => {
  const m = await mount();
  await m.sync();
  await emptyLogbook(m);
  const cat = await m.api('/catalogue/search?q=moon');
  const typed = await m.api('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: cat[0].title.toUpperCase() }) });   // no shop, no handle

  m.answerConfirms(true);
  await m.go('#/browse');
  await m.tap('[data-act="pickcat"]');
  assert.equal(globalThis.location.hash, '#/p/' + typed.id, 'the one typed in by hand went unrecognised');
});

/* Kits saved before covers went full width cannot be caught up by saving them —
   re-picking the same listing is not a relink, and refetching a picture that has
   not changed is waste. So the catching up happens once, by itself, on the first
   launch after updating. */
test('kits still on thumbnails are caught up on launch, without being asked', async () => {
  const first = await mount();
  await first.sync();
  await emptyLogbook(first);
  const cat = await first.api('/catalogue/search?q=moon');
  const made = await first.api('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: cat[0].title, shop: cat[0].shop, dac_handle: cat[0].handle }) });
  // put it back the way a version before full-fidelity covers left it
  await first.api('/projects/' + made.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cover_hifi: 0 }) });
  assert.equal((await first.api('/projects/upgrade-covers')).candidates, 1);

  // the next launch
  const next = await mount();
  await next.settle();
  await next.settle();

  assert.equal((await next.api('/projects/upgrade-covers')).candidates, 0,
               'launching did not catch up the kits still on thumbnails');
  const shots = next.net.filter((u) => /\.(jpg|jpeg|png|webp)/i.test(u));
  assert.ok(shots.length, 'launching fetched no pictures at all');
  for (const u of shots)
    assert.equal(new URL(u).searchParams.get('width'), null, 'launch refetched at a reduced width');
});

/* Covers were fetched at 1600 before they were fetched at full size, and those
   kits were marked done. A mark that only says "done" cannot tell the two
   apart, so they would have kept the smaller picture for ever. */
test('kits upgraded to the old 1600px size are caught up again on launch', async () => {
  const first = await mount();
  await first.sync();
  await emptyLogbook(first);
  const cat = await first.api('/catalogue/search?q=moon');
  const made = await first.api('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: cat[0].title, shop: cat[0].shop, dac_handle: cat[0].handle }) });
  // exactly how a version that fetched 1600px left it
  await first.api('/projects/' + made.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cover_hifi: 1 }) });

  assert.equal((await first.api('/projects/upgrade-covers')).candidates, 1,
               'a kit stuck at 1600px was treated as already done');

  const next = await mount();
  await next.settle(); await next.settle();
  assert.equal((await next.api('/projects/upgrade-covers')).candidates, 0, 'launch did not catch it up');
});
