import { describe, test } from '../lib/harness.mjs';
import { state, waitState, watchStates, ui, arm, drag, pin, chips, chipsSettled, resetProbe, count, events, readClipboard, writeClipboard, copyCenter, cursor, sleep, until, rect, isoEval } from '../lib/mk.mjs';

const G = '/tests/fixtures/gesture.html';
const DEMO = '/demo/index.html';
const FULL = [[90, 20], [630, 470]]; // generous selection around the demo card
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

function rectEq(t, r, exp, msg, tol = 0.6) {
  for (const k of ['x', 'y', 'w', 'h']) t.near(r[k], exp[k], tol, `${msg} ${k} (got ${JSON.stringify(r)})`);
}

async function clickCopy(p) {
  const [x, y] = await copyCenter(p);
  await p.mouse.click(x, y);
}

describe('pinned', () => {
  test('Copy tab sits on the top edge, right-aligned with the marquee', async (t) => {
    const p = await t.open(G);
    const u = await pin(p, [100, 260], [300, 400]);
    await sleep(200);
    const c = (await ui(p)).copyRect;
    t.near(c.x + c.w, u.marquee.x + u.marquee.w, 0.6, 'copy right edge = marquee right edge');
    t.near(c.y + c.h, u.marquee.y + 1, 1, 'copy bottom on the marquee top border');
    t.near(c.h, 22, 0.5, 'copy height');
    t.ok(/Copy/.test((await ui(p)).copyText), 'label Copy');
  });

  test('Copy tab moves inside the top-right corner when there is < 26 px above', async (t) => {
    const p = await t.open(G);
    const u = await pin(p, [100, 10], [300, 200]);
    await sleep(200);
    const c = (await ui(p)).copyRect;
    t.ok(c.y >= u.marquee.y, `copy inside (copy.y ${c.y}, marquee.y ${u.marquee.y})`);
    t.near(c.x + c.w, u.marquee.x + u.marquee.w - 1, 1, 'right-aligned inside the border');
  });

  test('Copy tab stays on screen for a narrow selection at the left edge', async (t) => {
    const p = await t.open(G);
    await pin(p, [2, 300], [22, 400]);
    await sleep(200);
    const c = (await ui(p)).copyRect;
    t.ok(c.x >= 0, `copy tab left edge on screen: ${c.x}`);
  });

  test('Copy tab stays reachable when the selection was released past the right viewport edge', async (t) => {
    const p = await t.open(G);
    await drag(p, [500, 300], [600, 400], { release: false });
    await p.mouse.move(800, 420, { steps: 6 });
    await p.mouse.up();
    await waitState(p, 'pinned');
    await sleep(200);
    const c = (await ui(p)).copyRect;
    t.ok(c.x + c.w <= 718 && c.x >= 0, `Copy tab on screen (rect ${JSON.stringify(c)}, viewport width 718)`);
  });

  test('Copy tab stays reachable when the selection was released past the top viewport edge', async (t) => {
    const p = await t.open(G);
    await drag(p, [300, 300], [400, 200], { release: false });
    await p.mouse.move(420, -60, { steps: 6 });
    await p.mouse.up();
    await waitState(p, 'pinned');
    await sleep(200);
    const c = (await ui(p)).copyRect;
    t.ok(c.y >= 0 && c.y + c.h <= 479, `Copy tab on screen (rect ${JSON.stringify(c)})`);
  });

  test('Copy click copies the text spec of the demo card; tab shows "Copied" then reverts', async (t) => {
    const p = await t.open(DEMO);
    await writeClipboard(p, 'sentinel');
    await pin(p, ...FULL, { pause: 150 });
    await clickCopy(p);
    await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copied state', timeout: 800 });
    const t0 = Date.now();
    const txt = await readClipboard(p);
    t.ok(txt.startsWith(`Mikron — 540 × 452 selection on localhost:${t.env.port}/demo/index.html`), `header line: ${txt.split('\n')[0]}`);
    const must = [
      /^main#card\.card — 480 × 391 · padding 8 · gap 20 · radius 20/m,
      /^  header\.card-head — 464 × 64 · padding 16 16 0$/m,
      /^    div\.titles — .*gap 4/m,
      /^  ul\.list — 464 × 291 · radius 12/m,
      /^    li\.row — 464 × 73 · padding 16 · gap 12$/m,
      /^      span\.status\.ok — 3 × 40/m,
      /^      span\.icon — 40 × 40 · radius 10/m,
      /^      button\.btn "Disconnect" — 97 × 32 · padding 0 12 · radius 8/m,
      /h2 "Connectors" — font 18px\/24px 500/,
    ];
    for (const re of must) t.ok(re.test(txt), `spec text should match ${re}\n--- got ---\n${txt.slice(0, 900)}`);
    t.eq((txt.match(/button\.btn "/g) || []).length, 4, 'four buttons in the spec');
    await until(async () => /^Copy$/.test((await ui(p)).copyText), { msg: 'revert to Copy', timeout: 2500 });
    const dt = Date.now() - t0;
    t.ok(dt > 900 && dt < 2200, `Copied state lasted ~1.4 s (observed ≈${dt} ms after copy)`);
    t.eq(await state(p), 'pinned', 'still pinned after copy');
  });

  test('copyFormat json: Copy produces parseable JSON with the card tree', async (t) => {
    await t.settings({ copyFormat: 'json' });
    const p = await t.open(DEMO);
    await pin(p, ...FULL, { pause: 150 });
    await clickCopy(p);
    await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copied state', timeout: 800 });
    const txt = await readClipboard(p);
    let j;
    try {
      j = JSON.parse(txt);
    } catch (e) {
      t.fail(`clipboard is not JSON: ${e.message}\n${txt.slice(0, 300)}`);
    }
    t.eq(j.selection, [540, 452], 'selection');
    const card = j.children[0];
    t.eq(card.size, [480, 391], 'card size');
    t.eq(card.padding, [8, 8, 8, 8], 'card padding');
    t.eq(card.radius, [20, 20, 20, 20], 'card radius');
    const flat = [];
    const walk = (n) => {
      flat.push(n);
      (n.children || []).forEach(walk);
    };
    j.children.forEach(walk);
    t.eq(flat.filter((n) => n.label === 'button.btn' && n.size[0] === 97 && n.size[1] === 32).length, 4, 'four 97×32 buttons');
    t.eq(flat.filter((n) => n.size[0] === 40 && n.size[1] === 40).length, 4, 'four 40×40 icons');
    t.ok(flat.some((n) => n.gap && n.gap.x && n.gap.x.includes(12)), 'x-gap 12 present');
    t.ok(flat.some((n) => n.gap && n.gap.y && n.gap.y.includes(4)), 'y-gap 4 present');
  });

  test(`${MOD}+C while pinned (no page selection) copies the spec`, async (t) => {
    const p = await t.open(DEMO);
    await writeClipboard(p, 'sentinel');
    await pin(p, ...FULL, { pause: 150 });
    await p.keyboard.press(`${MOD}+KeyC`);
    await until(async () => (await readClipboard(p)).startsWith('Mikron —'), { msg: 'spec on clipboard', timeout: 1000 });
    t.ok(/Copied/.test((await ui(p)).copyText), 'Copy tab shows Copied');
  });

  test(`${MOD}+C with a page text selection copies the selection, not the spec`, async (t) => {
    const p = await t.open(G);
    await writeClipboard(p, 'sentinel');
    await pin(p, [100, 300], [300, 420]);
    await p.evaluate(() => {
      const tn = document.getElementById('txt').firstChild;
      getSelection().setBaseAndExtent(tn, 4, tn, 9);
    });
    await p.keyboard.press(`${MOD}+KeyC`);
    await until(async () => (await readClipboard(p)) !== 'sentinel', { msg: 'clipboard changed', timeout: 1000 });
    t.eq(await readClipboard(p), 'quick');
  });

  test('Copy tab events stay inside the overlay (no page bubble listeners fire, selection stays)', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    await sleep(150);
    await resetProbe(p);
    await clickCopy(p);
    await sleep(80);
    const ev = (await events(p)).filter((e) => ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].includes(e.type));
    const bubble = ev.filter((e) => e.phase === 'b');
    t.eq(bubble.map((e) => e.type), [], 'bubble-phase document listeners');
    t.eq(await state(p), 'pinned', 'still pinned');
    t.eq(ev.filter((e) => e.phase === 'c').map((e) => e.type), [], 'capture-phase document listeners');
  });

  test('Esc dismisses and the page never sees that keydown', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    await resetProbe(p);
    await p.keyboard.press('Escape');
    await waitState(p, 'idle');
    t.eq(await count(p, 'keydown'), 0, 'page keydown listeners');
    await until(async () => !(await ui(p)).stageVisible, { msg: 'stage faded out', timeout: 800 });
  });

  test('Esc that dismisses: the matching keyup does not reach the page either', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    await resetProbe(p);
    await p.keyboard.press('Escape');
    await waitState(p, 'idle');
    t.eq(await count(p, 'keyup', 'b'), 0, 'page keyup Escape listeners (modal libs that close on keyup)');
  });

  test('pressing the modifier fresh while pinned shows the crosshair but not the hint', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    await arm(p, { at: [420, 420], wait: false });
    await sleep(100);
    const u = await ui(p);
    t.eq(u.state, 'pinned');
    t.ok(!u.hintOn, 'no hint while pinned');
    t.eq(await cursor(p), 'crosshair', 'crosshair');
    await p.keyboard.up('Shift');
    await until(async () => (await cursor(p)) !== 'crosshair', { msg: 'cursor restored on release', timeout: 800 });
  });

  test('press outside dismisses and the page receives the full click', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    await resetProbe(p);
    await p.mouse.click(500, 120);
    await waitState(p, 'idle');
    for (const ty of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) t.eq(await count(p, ty, 'b'), 1, `page ${ty}`);
  });

  test('press inside dismisses and the page receives nothing', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    await resetProbe(p);
    await p.mouse.click(200, 330);
    await waitState(p, 'idle');
    await sleep(50);
    const got = (await events(p)).filter((e) => ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].includes(e.type)).map((e) => e.type + ':' + e.phase);
    t.eq(got, [], 'page saw');
    // and the very next click works normally
    await resetProbe(p);
    await p.mouse.click(200, 330);
    t.eq(await count(p, 'click', 'b'), 1, 'next click reaches page');
  });

  test('right-click inside the pinned rect dismisses without a page contextmenu', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    await resetProbe(p);
    await p.mouse.click(200, 330, { button: 'right' });
    await waitState(p, 'idle');
    t.eq(await count(p, 'contextmenu'), 0, 'contextmenu');
    t.eq(await count(p, 'mousedown'), 0, 'mousedown');
  });

  test('new Shift+drag while pinned replaces the selection (starting outside)', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    const u = await pin(p, [400, 100], [600, 300]);
    rectEq(t, u.marquee, { x: 400, y: 100, w: 200, h: 200 }, 'new marquee');
    t.eq(u.label, '200 × 200');
    t.eq(await p.evaluate(() => document.querySelectorAll('mikron-root').length), 1, 'one host');
  });

  test('new Shift+drag while pinned replaces the selection (starting inside)', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    const u = await pin(p, [150, 300], [450, 460]);
    rectEq(t, u.marquee, { x: 150, y: 300, w: 300, h: 160 }, 'new marquee');
    await sleep(300);
    t.ok((await ui(p)).stageVisible, 'new selection still visible after the old fade time');
  });

  test('window scroll while pinned keeps marquee and chips glued to the content', async (t) => {
    const p = await t.open(G);
    await pin(p, [20, 20], [460, 180]);
    const before = await chipsSettled(p);
    t.ok(before.length > 0, 'chips present');
    await p.evaluate(() => window.scrollTo(0, 60));
    await until(async () => Math.abs((await ui(p)).marquee.y - (20 - 60)) < 0.6, { msg: 'marquee moved up by 60', timeout: 1000 });
    const after = await chipsSettled(p);
    const moved = before.filter((b) => after.some((a) => a.text === b.text && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - (b.y - 60)) < 1));
    t.ok(moved.length >= Math.min(before.length, 3), `chips should move with the page: ${moved.length}/${before.length}`);
    t.eq(await state(p), 'pinned');
  });

  test('scroll inside a nested scroller while pinned re-measures the scrolled content', async (t) => {
    // varied row heights: identical rows would be deduped to one chip (computeQuiet), and the height in the chip text names the row
    const p = await t.open('/tests/fixtures/scroller-varied.html');
    const u = await pin(p, [30, 30], [360, 300]);
    const DY = 52;
    const rowRects = () => p.evaluate(() => [...document.querySelectorAll('#sc li')].map((l) => { const r = l.getBoundingClientRect(); return { h: Math.round(r.height), y: r.y, bottom: r.bottom }; }));
    const rowChips = (cs) => cs.filter((c) => c.kind === 'dim' && /^300 × \d+$/.test(c.text) && c.text !== '300 × 240');
    const hOf = (c) => +c.text.split(' × ')[1];
    const before = await chipsSettled(p);
    const rowsBefore = await rowRects();
    const stale = rowChips(before).find((c) => c.text === '300 × 38'); // first row: scrolled out of the region by the scroll
    t.ok(stale, 'precondition: first row has a chip');
    await p.evaluate((dy) => (document.getElementById('sc').scrollTop = dy), DY);
    const rowsAfter = await rowRects();
    t.near(rowsAfter[1].y - rowsBefore[1].y, -DY, 0.5, 'scroller really scrolled');
    const atRow = (c) => { const row = rowsAfter.find((r) => r.h === hOf(c)); return !!row && c.y >= row.y - 1 && c.y <= row.bottom + 10; };
    let after = [];
    await until(async () => {
      after = await chips(p);
      return rowChips(after).filter(atRow).length >= 2 && !after.some((c) => c.text === stale.text);
    }, { msg: 'row chips follow the scrolled rows and the scrolled-out row loses its chip', timeout: 1500 }).catch((e) => t.fail(`${e.message}\nbefore ${JSON.stringify(before.map((c) => [c.text, c.y]))}\nafter ${JSON.stringify(after.map((c) => [c.text, c.y]))}\nrows ${JSON.stringify(rowsAfter)}`));
    after = await chipsSettled(p);
    // every row chip now drawn belongs to a row in view, at its new position; survivors moved by their row's delta
    let moved = 0;
    for (const c of rowChips(after)) {
      t.ok(atRow(c), `chip ${c.text} at y ${c.y} sits at its row`);
      const old = rowChips(before).find((b) => b.text === c.text);
      if (!old) continue;
      const i = rowsAfter.findIndex((r) => r.h === hOf(c));
      t.near(c.y - old.y, rowsAfter[i].y - rowsBefore[i].y, 1.5, `chip ${c.text} moved by its row's delta`);
      moved++;
    }
    t.ok(moved >= 2, `at least two row chips survived and moved (${moved})`);
    // content outside the scroller did not move
    const outer = (cs) => cs.find((c) => c.kind === 'dim' && c.text === '300 × 240');
    t.ok(outer(before) && outer(after), 'scroller-size chip present before and after');
    t.near(outer(after).y, outer(before).y, 0.6, 'chip of the scroller itself stays put');
    rectEq(t, (await ui(p)).marquee, u.marquee, 'marquee unchanged');
  });

  test('window resize while pinned keeps the selection and resizes the canvas', async (t) => {
    const p = await t.open(G);
    const u = await pin(p, [100, 100], [300, 260]);
    await p.setViewportSize({ width: 600, height: 420 });
    await sleep(300);
    const v = await ui(p);
    t.eq(v.state, 'pinned');
    rectEq(t, v.marquee, u.marquee, 'marquee');
    const cw = await p.evaluate(() => document.querySelector('mikron-root').shadowRoot.querySelector('.mk-bp-canvas').getBoundingClientRect().width);
    t.near(cw, 600, 1, 'canvas width follows the viewport');
  });

  test('history.pushState to a new path dismisses', async (t) => {
    const p = await t.open('/tests/fixtures/spa.html');
    await pin(p, [30, 30], [350, 250]);
    await p.evaluate(() => history.pushState({}, '', '/tests/fixtures/spa-next'));
    await waitState(p, 'idle');
  });

  test('history.replaceState with the same URL does not dismiss', async (t) => {
    const p = await t.open('/tests/fixtures/spa.html');
    await pin(p, [30, 30], [350, 250]);
    await p.evaluate(() => history.replaceState({ x: 1 }, '', location.href));
    const seen = await watchStates(p, 250);
    t.eq(seen, ['pinned'], 'states');
  });

  test('hashchange dismisses', async (t) => {
    const p = await t.open('/tests/fixtures/spa.html');
    await pin(p, [30, 30], [350, 250]);
    await p.evaluate(() => (location.hash = '#section'));
    await waitState(p, 'idle');
  });

  test('popstate (history.back) dismisses', async (t) => {
    const p = await t.open('/tests/fixtures/spa.html');
    await p.evaluate(() => history.pushState({}, '', '/tests/fixtures/spa-next'));
    await pin(p, [30, 30], [350, 250]);
    await p.evaluate(() => history.back());
    await waitState(p, 'idle');
  });

  test('Shift+click (no drag) inside the pinned rect does not click the hidden element underneath', async (t) => {
    const p = await t.open('/tests/fixtures/under.html');
    await pin(p, [100, 100], [320, 260], { keepMod: true });
    // modifier still held; the user clicks inside the blueprint (e.g. to dismiss) without moving
    await p.mouse.move(200, 140);
    await p.mouse.down();
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await sleep(100);
    t.eq(await p.evaluate(() => window.__danger), 0, 'clicks delivered to the hidden "Delete everything" button');
    t.ok((await state(p)) !== 'pinned', 'selection dismissed');
  });

  test('Shift+click (no drag) inside the pinned rect does not follow a hidden link', async (t) => {
    const p = await t.open('/tests/fixtures/under.html');
    await pin(p, [100, 100], [320, 260], { keepMod: true });
    const r = await rect(p, '#lnk');
    await p.mouse.move(r.x + 10, r.y + r.h / 2);
    await p.mouse.down();
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await sleep(100);
    t.eq(await p.evaluate(() => window.__link || 0), 0, 'hidden link clicked (with shiftKey: would open a new window)');
  });

  test('Copy click does not trigger capture-phase click-outside handlers (e.g. Headless UI menus)', async (t) => {
    const p = await t.open('/tests/fixtures/under.html');
    await pin(p, [100, 100], [320, 260]);
    await sleep(150);
    await p.evaluate(() => (window.__menuClosed = 0));
    const [x, y] = await copyCenter(p);
    await p.mouse.click(x, y);
    await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copied', timeout: 800 });
    t.eq(await p.evaluate(() => window.__menuClosed), 0, 'page outside-click handler fired on Copy click');
  });

  test('pinned overlay does not block hit-testing; cursor normal once the modifier is released', async (t) => {
    const p = await t.open(G);
    await pin(p, [20, 20], [300, 180]);
    t.eq(await p.evaluate(() => document.elementFromPoint(100, 80).id), 'a', 'elementFromPoint inside the pinned rect');
    t.ok((await cursor(p)) !== 'crosshair', 'cursor not forced while pinned without modifier');
  });

  test(`${MOD}+C while focus is in an input with a selection copies the input text`, async (t) => {
    const p = await t.open('/tests/fixtures/targets.html');
    await writeClipboard(p, 'sentinel');
    await pin(p, [40, 240], [400, 330]);
    await p.evaluate(() => {
      const i = document.getElementById('txt');
      i.focus();
      i.setSelectionRange(0, 5);
    });
    await p.keyboard.press(`${MOD}+KeyC`);
    await until(async () => (await readClipboard(p)) !== 'sentinel', { msg: 'clipboard changed', timeout: 1000 });
    t.eq(await readClipboard(p), 'hello');
  });

  test('partial selection: spec marks cut elements "(partial)" and omits elements outside', async (t) => {
    const p = await t.open(DEMO);
    await pin(p, [90, 20], [360, 470], { pause: 120 });
    await clickCopy(p);
    await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copied', timeout: 800 });
    const txt = await readClipboard(p);
    t.ok(/^main#card\.card — 480 × 391.*\(partial\)$/m.test(txt), `card line partial:\n${txt.slice(0, 400)}`);
    t.ok(!/button\.btn/.test(txt), 'buttons (outside) omitted');
    t.ok(/span\.icon — 40 × 40/.test(txt), 'icons (inside) listed');
  });

  test('empty selection copies a header with "(no measurable elements)"', async (t) => {
    const p = await t.open(G);
    await pin(p, [450, 400], [570, 470]);
    await clickCopy(p);
    await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copied', timeout: 800 });
    const txt = await readClipboard(p);
    t.eq(txt, `Mikron — 120 × 72 selection on localhost:${t.env.port}/tests/fixtures/gesture.html\n\n(no measurable elements)`);
  });

  test('pagehide resets to idle', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    await p.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await waitState(p, 'idle');
  });

  test('T1-1 Shift+click inside the pinned rect: the whole sequence is swallowed, no selection extension', async (t) => {
    const p = await t.open('/tests/fixtures/under.html');
    await pin(p, [100, 100], [320, 260], { keepMod: true });
    await p.evaluate(() => {
      const tn = document.getElementById('lnk').firstChild;
      getSelection().setBaseAndExtent(tn, 2, tn, 4);
    });
    await resetProbe(p);
    await p.mouse.move(200, 140);
    await p.mouse.down();
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await sleep(100);
    const got = (await events(p)).filter((e) => ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].includes(e.type)).map((e) => e.type + ':' + e.phase);
    t.eq(got, [], 'page saw');
    t.eq(await p.evaluate(() => getSelection().toString()), 'li', 'text selection untouched');
    t.ok((await state(p)) !== 'pinned', 'selection dismissed');
  });

  test('T1-1 a press inside the pinned rect with the modifier can still start a new drag; the page sees no press/click', async (t) => {
    const p = await t.open('/tests/fixtures/under.html');
    await pin(p, [100, 100], [320, 260], { keepMod: true });
    await sleep(100);
    await resetProbe(p);
    await p.mouse.move(150, 130);
    await p.mouse.down();
    await p.mouse.move(400, 330, { steps: 10 });
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await waitState(p, 'pinned');
    t.eq((await ui(p)).label, '252 × 200', 'new selection (snap 4)');
    const got = (await events(p)).filter((e) => ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].includes(e.type)).map((e) => e.type + ':' + e.phase);
    t.eq(got, [], 'page saw');
  });

  test('T1-4 window-capture listeners never see pointer/mouse/click events on the Copy tab', async (t) => {
    const p = await t.open('/tests/fixtures/under.html');
    await pin(p, [100, 100], [320, 260]);
    await sleep(150);
    await p.evaluate(() => {
      window.__w = [];
      for (const ty of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) window.addEventListener(ty, (e) => window.__w.push(ty), true);
      document.getElementById('danger').focus();
    });
    const [x, y] = await copyCenter(p);
    await p.mouse.click(x, y);
    await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copied', timeout: 800 });
    t.eq(await p.evaluate(() => window.__w), [], 'window capture listeners');
    t.eq(await p.evaluate(() => document.activeElement.id), 'danger', 'focus not stolen by the Copy tab');
    t.eq(await state(p), 'pinned');
  });

  test('T1-4 Copy tab keeps its hover and pressed styling', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    await sleep(200);
    const style = () => p.evaluate(() => { const c = getComputedStyle(document.querySelector('mikron-root').shadowRoot.querySelector('.mk-copy')); const i = getComputedStyle(document.querySelector('mikron-root').shadowRoot.querySelector('.mk-copy-in')); return { bg: c.backgroundColor, scale: c.scale, inScale: i.scale }; });
    const idle = await style();
    const [x, y] = await copyCenter(p);
    await p.mouse.move(x, y, { steps: 3 });
    await sleep(160);
    const hover = await style();
    t.ok(hover.bg !== idle.bg, `hover background changes (${idle.bg} -> ${hover.bg})`);
    await p.mouse.down();
    await sleep(160);
    const active = await style();
    t.ok(active.bg !== hover.bg, `pressed background changes (${hover.bg} -> ${active.bg})`);
    t.eq(active.scale, '1', 'the tab itself is not scaled (it would move)');
    t.eq(active.inScale, '0.97', 'pressed label scale');
    await p.mouse.up();
  });

  test('M4 Copy tab enters with opacity only (no translate animation), 120 ms, cubic-bezier(0, 0, .58, 1)', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    const cs = await p.evaluate(() => {
      const c = getComputedStyle(document.querySelector('mikron-root').shadowRoot.querySelector('.mk-copy'));
      return { translate: c.translate, props: c.transitionProperty, dur: c.transitionDuration, ease: c.transitionTimingFunction };
    });
    // `translate` is now the tab's position (I6), so assert it is not animated rather than that it is none
    t.ok(!/translate/.test(cs.props), `transition props ${cs.props}`);
    t.ok(cs.props.split(', ')[0] === 'opacity' && cs.dur.split(', ')[0] === '0.12s', `opacity 120 ms (${cs.props} / ${cs.dur})`);
    t.ok(/cubic-bezier\(0, 0, 0\.58, 1\)/.test(cs.ease), `easing ${cs.ease}`);
  });

  test('M6 Copy icon is 10 × 10 with stroke-width 1', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    const r = await p.evaluate(() => { const s = document.querySelector('mikron-root').shadowRoot.querySelector('.mk-copy svg'); const b = s.getBoundingClientRect(); return { w: b.width, h: b.height, sw: s.getAttribute('stroke-width') }; });
    t.eq(r, { w: 10, h: 10, sw: '1' });
  });

  test('M7 size label and Copy tab land on whole device pixels (DPR 1)', async (t) => {
    const p = await t.open(G);
    for (const [a, b] of [[[101, 281], [204, 332]], [[100, 300], [209, 400]], [[103, 290], [262, 470]]]) {
      const u = await pin(p, a, b, { pause: 120 });
      await sleep(200);
      const v = await ui(p);
      t.ok(Number.isInteger(v.labelRect.x) && Number.isInteger(v.labelRect.y) && Number.isInteger(v.labelRect.w), `label rect ${JSON.stringify(v.labelRect)}`);
      t.near(v.labelRect.x + v.labelRect.w / 2, v.marquee.x + v.marquee.w / 2, 1, 'label centred');
      t.ok(Number.isInteger(v.copyRect.x) && Number.isInteger(v.copyRect.w), `copy rect ${JSON.stringify(v.copyRect)}`);
      await p.keyboard.press('Escape');
      await waitState(p, 'idle');
      await sleep(250);
    }
  });

  test('T1-3 Copy tab stays fully on screen with the selection hanging off the right and top edges', async (t) => {
    const p = await t.open(G);
    await drag(p, [500, 300], [600, 400], { release: false });
    await p.mouse.move(900, -80, { steps: 8 });
    await p.mouse.up();
    await waitState(p, 'pinned');
    await sleep(200);
    const c = (await ui(p)).copyRect;
    t.ok(c.x >= 0 && c.x + c.w <= 718 && c.y >= 0 && c.y + c.h <= 479, `Copy tab on screen ${JSON.stringify(c)}`);
  });

  test('T3-7 beforeprint dismisses a pinned selection at once (no fade left for the print snapshot)', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    await p.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await waitState(p, 'idle');
    const u = await ui(p);
    t.ok(!u.stageVisible && !u.copyShown, `overlay gone immediately: ${JSON.stringify({ stage: u.stageVisible, copy: u.copyShown })}`);
  });

  test('T3-8 a hidden tab keeps the pinned selection (pagehide still dismisses)', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    await isoEval(p, "(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); })()");
    await sleep(250);
    t.eq(await state(p), 'pinned', 'still pinned while hidden');
    await isoEval(p, "(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); })()");
    t.eq(await state(p), 'pinned', 'still pinned after coming back');
    await p.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await waitState(p, 'idle');
  });

  test('T3-8 a hidden tab resets a drag in progress (like blur)', async (t) => {
    const p = await t.open(G);
    await drag(p, [100, 280], [300, 420], { release: false, keepMod: true });
    await waitState(p, 'dragging');
    await isoEval(p, "(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); })()");
    await waitState(p, 'idle');
    await isoEval(p, "delete document.visibilityState");
    await p.mouse.up();
    await p.keyboard.up('Shift');
  });

  describe('eatAll safety', () => {
    const TGT = '/tests/fixtures/targets.html';
    const nativeClick = (p, detail) =>
      p.evaluate((d) => { document.getElementById('btn').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: d })); }, detail);

    async function pressInsidePinnedWithoutRelease(t) {
      const p = await t.open(TGT);
      await p.evaluate(() => { window.__clicks = []; document.getElementById('btn').addEventListener('click', (e) => window.__clicks.push(e.detail)); });
      await pin(p, [180, 300], [380, 420]);
      await p.mouse.move(250, 360);
      await p.mouse.down(); // pointerup never arrives (released over an iframe, say)
      await waitState(p, 'idle');
      return p;
    }

    test('I4 a keyboard-activated click (detail 0) is never swallowed while a swallowed press is unreleased', async (t) => {
      const p = await pressInsidePinnedWithoutRelease(t);
      await p.focus('#btn');
      await p.keyboard.press('Enter');
      await sleep(50);
      t.eq(await p.evaluate(() => window.__clicks), [0], 'page saw the Enter click');
      await p.mouse.up();
    });

    test('I4 eatAll clears itself 2 s after the swallowed press when no pointerup arrives', async (t) => {
      const p = await pressInsidePinnedWithoutRelease(t);
      await nativeClick(p, 1);
      await sleep(50);
      t.eq(await p.evaluate(() => window.__clicks), [], 'a mouse-like click is still eaten within the window');
      await sleep(2100);
      await nativeClick(p, 1);
      t.eq(await p.evaluate(() => window.__clicks), [1], 'after 2 s the flag is gone');
      await p.mouse.up();
    });

    test('I4 pointercancel clears the swallow flags', async (t) => {
      const p = await pressInsidePinnedWithoutRelease(t);
      await p.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, isPrimary: true, bubbles: true })));
      await nativeClick(p, 1);
      t.eq(await p.evaluate(() => window.__clicks), [1], 'click reaches the page after cancel');
      await p.mouse.up();
    });
  });

  for (const [name, fx, fy] of [['top-left', 2, 2], ['top-right', -2, 2], ['bottom-left', 2, -2], ['bottom-right', -2, -2]]) {
    test(`I6 press-and-hold on the Copy tab (${name} corner, wide viewport, selection near the right edge): the tab does not move and the copy happens`, async (t) => {
      const p = await t.open(G, { viewport: { width: 1400, height: 800 } });
      await pin(p, [1000, 300], [1380, 500]);
      await sleep(300);
      const rest = (await ui(p)).copyRect;
      const x = fx > 0 ? rest.x + fx : rest.x + rest.w + fx;
      const y = fy > 0 ? rest.y + fy : rest.y + rest.h + fy;
      await p.mouse.move(x, y);
      await p.mouse.down();
      await sleep(150);
      const held = (await ui(p)).copyRect;
      for (const k of ['x', 'y', 'w', 'h']) t.near(held[k], rest[k], 1, `held rect ${k}: rest ${JSON.stringify(rest)} held ${JSON.stringify(held)}`);
      t.ok(x >= held.x && x <= held.x + held.w && y >= held.y && y <= held.y + held.h, 'pointer still inside the pressed tab');
      await writeClipboard(p, 'sentinel');
      await p.mouse.up();
      await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copied shown after release', timeout: 800 });
      t.ok(/^Mikron/.test(await readClipboard(p)), 'clipboard holds the spec');
    });
  }
});
