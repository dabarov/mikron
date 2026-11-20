import { describe, test } from '../lib/harness.mjs';
import { state, waitState, ui, arm, drag, pin, chips, chipsSettled, resetProbe, count, events, copyCenter, sleep, until, cursorStyleInfo, cursor, mikronListeners } from '../lib/mk.mjs';

const G = '/tests/fixtures/gesture.html';
const S = '/tests/fixtures/static.html';

async function windowListeners(p) {
  const l = await mikronListeners(p);
  if (!(l.window > 20)) throw new Error(`listener introspection looks wrong: ${JSON.stringify(l)}`);
  return l;
}

async function faded(p) {
  await until(async () => {
    const u = await ui(p);
    return u && !u.stageVisible && u.chipCount === 0;
  }, { msg: 'overlay faded and cleared', timeout: 1500 });
}

describe('hygiene', () => {
  test('full flow on light.html (arm, drag, pin, copy, scroll, nested scroll, dismiss) logs no errors', async (t) => {
    const p = await t.open('/demo/light.html');
    await arm(p, { at: [300, 300] });
    await p.mouse.move(20, 80, { steps: 4 });
    await p.mouse.down();
    await p.mouse.move(700, 470, { steps: 12 });
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await waitState(p, 'pinned');
    const [x, y] = await copyCenter(p);
    await p.mouse.click(x, y);
    await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copied', timeout: 800 });
    await p.evaluate(() => window.scrollBy(0, 900));
    await sleep(200);
    await p.evaluate(() => {
      const s = document.querySelector('.scroller');
      if (s) s.scrollTop = 80;
    });
    await sleep(250);
    await p.keyboard.press('Escape');
    await waitState(p, 'idle');
    await faded(p);
  });

  test('after dismiss nothing intercepts page events (hover, click, hit-testing)', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    await p.keyboard.press('Escape');
    await faded(p);
    await resetProbe(p);
    await p.mouse.move(150, 300, { steps: 5 });
    await p.mouse.move(100, 100, { steps: 5 }); // into #a -> mouseover
    await p.mouse.click(200, 330);
    for (const ty of ['mousemove', 'pointermove', 'mouseover', 'mousedown', 'mouseup', 'click']) t.ok((await count(p, ty, 'b')) > 0, `page saw ${ty}`);
    t.eq(await p.evaluate(() => document.elementFromPoint(200, 330).localName), 'body', 'hit target at the old selection');
    const u = await ui(p);
    t.ok(!u.shieldOn, 'shield off');
    t.eq(await p.evaluate(() => getComputedStyle(document.querySelector('mikron-root')).pointerEvents), 'none', 'host pointer-events');
    t.ok((await cursor(p)) !== 'crosshair', 'cursor restored');
    const sel = await p.evaluate(() => getComputedStyle(document.body).userSelect);
    t.ok(sel !== 'none', `user-select not overridden (${sel})`);
  });

  test('after cancelling a drag with Esc nothing intercepts page events', async (t) => {
    const p = await t.open(G);
    await drag(p, [100, 260], [300, 400], { release: false, keepMod: true });
    await waitState(p, 'dragging');
    await p.keyboard.press('Escape');
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await faded(p);
    await resetProbe(p);
    await p.mouse.move(150, 300, { steps: 5 });
    await p.mouse.move(100, 100, { steps: 5 }); // into #a -> mouseover
    await p.mouse.click(200, 330);
    for (const ty of ['mousemove', 'mouseover', 'click']) t.ok((await count(p, ty, 'b')) > 0, `page saw ${ty}`);
    t.ok(!(await ui(p)).shieldOn, 'shield off');
  });

  test('DOM writes are limited to <mikron-root> and style[data-mikron]', async (t) => {
    const p = await t.open(S);
    await resetProbe(p);
    await arm(p, { at: [300, 300] });
    await p.mouse.move(20, 20, { steps: 4 });
    await p.mouse.down();
    await p.mouse.move(420, 260, { steps: 10 });
    await p.mouse.up();
    await waitState(p, 'pinned');
    await p.mouse.click(600, 400); // dismiss (Shift still held -> may start a candidate; fine)
    await p.keyboard.up('Shift');
    await sleep(300);
    const muts = await p.evaluate(() => window.__mk.mut);
    const bad = muts.filter((m) => {
      if (m.type === 'attributes') return m.target !== 'mikron-root';
      if (m.type === 'childList') {
        const nodes = [...m.added, ...m.removed];
        return !nodes.every((n) => n === 'mikron-root' || n === 'style[data-mikron]');
      }
      return true;
    });
    t.eq(bad, [], 'unexpected DOM mutations');
    const extra = await p.evaluate(() => [...document.documentElement.children].map((c) => c.localName + (c.hasAttribute('data-mikron') ? '[data-mikron]' : '')));
    t.eq(extra, ['head', 'body', 'mikron-root', 'style[data-mikron]'].filter((x) => extra.includes(x)), 'documentElement children');
    t.ok(extra.every((x) => ['head', 'body', 'mikron-root', 'style[data-mikron]'].includes(x)), `children: ${extra}`);
  });

  test('20 drag–dismiss cycles: no growth in chips, canvases, arcs, shadow nodes or listeners', async (t) => {
    const p = await t.open('/demo/index.html');
    const cycle = async (i) => {
      const dx = (i % 3) * 4;
      await pin(p, [90 + dx, 20], [630 - dx, 470], { steps: 6 });
      await sleep(60);
      if (i % 2) await p.keyboard.press('Escape');
      else await p.mouse.click(30 + dx, 30); // outside
      await waitState(p, 'idle');
    };
    await cycle(0);
    await faded(p);
    const base = await ui(p);
    const l0 = await windowListeners(p);
    for (let i = 1; i < 20; i++) await cycle(i);
    await faded(p);
    const end = await ui(p);
    const l1 = await windowListeners(p);
    t.eq(
      { chips: end.chipCount, canvas: end.canvasCount, arcs: end.arcCount, nodes: end.elementCount },
      { chips: base.chipCount, canvas: base.canvasCount, arcs: base.arcCount, nodes: base.elementCount },
      'shadow tree after 20 cycles vs after 1',
    );
    t.eq(l1, l0, 'window/document listener counts');
    t.eq(await p.evaluate(() => [document.querySelectorAll('mikron-root').length, document.querySelectorAll('style[data-mikron]').length <= 1]), [1, true], 'one host, at most one style');
  }, { timeout: 40000 });

  test('live chip count while pinned does not grow across rescans (scroll jiggle)', async (t) => {
    const p = await t.open(G);
    await pin(p, [20, 20], [460, 180]);
    const n0 = (await chipsSettled(p)).length;
    for (let i = 0; i < 10; i++) {
      await p.evaluate((y) => window.scrollTo(0, y), i % 2 ? 6 : 0);
      await sleep(110);
    }
    await p.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    const n1 = (await chipsSettled(p)).length;
    t.eq(n1, n0, 'chip count');
  });

  // Must stay LAST: it reloads the extension, which does not come back under Playwright.
  test('orphaned content script (extension reloaded) tears itself down on the next event', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 260], [300, 400]);
    const sw = t.ext.sw;
    sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
    await sleep(800);
    await resetProbe(p);
    await p.mouse.move(150, 300);
    await p.keyboard.down('Shift');
    await p.mouse.down();
    await p.mouse.move(350, 420, { steps: 6 });
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await sleep(100);
    const left = await p.evaluate(() => document.querySelectorAll('mikron-root, style[data-mikron]').length);
    t.eq(left, 0, 'Mikron DOM left behind');
    const md = (await events(p)).find((e) => e.type === 'mousedown' && e.phase === 'c');
    t.ok(md && !md.prevented, 'page mousedown untouched after teardown');
    t.ok((await count(p, 'mousemove', 'b')) > 0, 'page sees mousemove');
    t.ok((await cursor(p)) !== 'crosshair', 'cursor restored');
  }, { timeout: 15000 });
});
