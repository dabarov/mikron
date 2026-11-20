import { describe, test } from '../lib/harness.mjs';
import { state, waitState, watchStates, ui, arm, drag, cursor, cursorStyleInfo, KEY, sleep, until } from '../lib/mk.mjs';

const hintCs = (p) =>
  p.evaluate(() => {
    const h = document.querySelector('mikron-root').shadowRoot.querySelector('.mk-hint');
    const c = getComputedStyle(h);
    const k = h.querySelector('.mk-key');
    return { visibility: c.visibility, opacity: parseFloat(c.opacity), height: h.getBoundingClientRect().height, pad: c.paddingTop, keyH: k.getBoundingClientRect().height, keyShadow: getComputedStyle(k).boxShadow, on: h.classList.contains('on') };
  });

const G = '/tests/fixtures/gesture.html';
const TG = '/tests/fixtures/targets.html';

describe('arming', () => {
  test('overlay host and cursor style are created lazily (nothing at load)', async (t) => {
    const p = await t.open(G);
    await sleep(200);
    const n = await p.evaluate(() => ({ host: document.querySelectorAll('mikron-root').length, style: document.querySelectorAll('style[data-mikron]').length }));
    t.eq(n, { host: 0, style: 0 }, 'DOM additions before first arm');
  });

  test('hold Shift >= 250 ms + move >= 4 px shows crosshair and hint', async (t) => {
    const p = await t.open(G);
    await arm(p, { at: [200, 300] });
    const u = await ui(p);
    t.eq(u.state, 'armed');
    t.ok(u.hintOn, 'hint pill visible');
    t.ok(/Shift/.test(u.hintText) && /\+ drag/.test(u.hintText), `hint text: ${u.hintText}`);
    t.ok(/<svg/.test(u.hintHtml), 'shift keycap has an SVG arrow');
    t.eq(await cursor(p), 'crosshair', 'body cursor');
    t.eq(await cursor(p, '#a'), 'crosshair', 'element cursor');
    const cs = await cursorStyleInfo(p);
    t.eq(cs.length, 1, 'one style[data-mikron]');
    t.eq(cs[0].disabled, false, 'cursor sheet enabled');
  });

  test('typing with Shift never arms and cannot start a drag', async (t) => {
    const p = await t.open(G);
    await p.mouse.move(200, 300);
    await p.keyboard.down('Shift');
    await p.keyboard.press('KeyA');
    await sleep(300);
    await p.mouse.move(230, 320, { steps: 4 });
    const seen = await watchStates(p, 300);
    t.ok(!seen.includes('armed'), `states seen: ${seen}`);
    await p.mouse.down();
    await p.mouse.move(400, 420, { steps: 8 });
    const seen2 = await watchStates(p, 150);
    await p.mouse.up();
    await p.keyboard.up('Shift');
    t.ok(!seen2.includes('dragging'), `states during drag attempt: ${seen2}`);
  });

  test('modifier held < 250 ms never shows the armed visuals (page-timed)', async (t) => {
    // Timed inside the page so CPU contention cannot produce a false failure; retried if the
    // harness itself was too slow to release within 250 ms.
    for (let attempt = 0; attempt < 4; attempt++) {
      const p = await t.open(G);
      await p.evaluate(() => {
        window.__armAt = null;
        new MutationObserver(() => {
          const h = document.querySelector('mikron-root');
          if (h && h.dataset.state === 'armed' && window.__armAt == null) window.__armAt = performance.now();
        }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
      });
      await p.mouse.move(200, 300);
      await p.keyboard.down('Shift');
      await p.mouse.move(240, 330, { steps: 3 });
      await sleep(100);
      await p.keyboard.up('Shift');
      await sleep(350);
      const r = await p.evaluate(() => {
        const kd = window.__mk.ev.find((e) => e.type === 'keydown' && e.key === 'Shift');
        const ku = window.__mk.ev.find((e) => e.type === 'keyup' && e.key === 'Shift');
        return { armAfter: window.__armAt == null ? null : window.__armAt - kd.t, held: ku.t - kd.t };
      });
      if (r.armAfter != null) t.ok(r.armAfter >= 250, `armed ${Math.round(r.armAfter)} ms after keydown (must be >= 250)`);
      if (r.held < 240) {
        t.eq(r.armAfter, null, `armed although the modifier was held only ${Math.round(r.held)} ms`);
        return;
      }
      await p.close();
    }
    t.note('harness too slow to release the modifier within 250 ms; only the >= 250 ms bound was checked');
  });

  test('modifier held without pointer movement does not arm', async (t) => {
    const p = await t.open(G);
    await p.mouse.move(200, 300);
    await p.keyboard.down('Shift');
    const seen = await watchStates(p, 700);
    await p.keyboard.up('Shift');
    t.ok(!seen.includes('armed'), `states: ${seen}`);
  });

  test('another key while armed taints until the modifier is re-pressed', async (t) => {
    const p = await t.open(G);
    await arm(p, { at: [200, 300] });
    await p.keyboard.press('KeyK');
    await waitState(p, 'idle');
    t.ok(!(await ui(p)).hintOn, 'hint hidden after taint');
    t.ok((await cursor(p)) !== 'crosshair', 'cursor restored after taint');
    await p.mouse.move(260, 340, { steps: 4 });
    const seen = await watchStates(p, 300);
    t.ok(!seen.includes('armed'), `re-armed while tainted: ${seen}`);
    await p.keyboard.up('Shift');
    await arm(p, { at: [220, 300] });
    t.eq(await state(p), 'armed', 'arms again after re-press');
    await p.keyboard.up('Shift');
  });

  test('wheel while armed taints (no armed state, no drag)', async (t) => {
    const p = await t.open(G);
    await arm(p, { at: [200, 300] });
    await p.mouse.wheel(0, 40);
    await waitState(p, 'idle');
    await p.mouse.move(260, 340, { steps: 4 });
    const seen = await watchStates(p, 300);
    t.ok(!seen.includes('armed'), `states after wheel: ${seen}`);
    await p.mouse.down();
    await p.mouse.move(400, 420, { steps: 6 });
    const seen2 = await watchStates(p, 100);
    await p.mouse.up();
    await p.keyboard.up('Shift');
    t.ok(!seen2.includes('dragging'), `drag started after wheel taint: ${seen2}`);
  });

  test('a second modifier taints (Shift+Ctrl neither arms nor drags)', async (t) => {
    const p = await t.open(G);
    await p.mouse.move(200, 300);
    await p.keyboard.down('Shift');
    await p.keyboard.down('Control');
    await sleep(300);
    await p.mouse.move(240, 330, { steps: 4 });
    const seen = await watchStates(p, 200);
    t.ok(!seen.includes('armed'), `armed with Shift+Ctrl: ${seen}`);
    await p.mouse.down();
    await p.mouse.move(400, 420, { steps: 6 });
    const seen2 = await watchStates(p, 100);
    await p.mouse.up();
    await p.keyboard.up('Control');
    await p.keyboard.up('Shift');
    t.ok(!seen2.includes('dragging'), `dragged with Shift+Ctrl: ${seen2}`);
  });

  test('releasing the modifier disarms: hint hidden, cursor restored', async (t) => {
    const p = await t.open(G);
    await arm(p, { at: [200, 300] });
    await p.keyboard.up('Shift');
    await waitState(p, 'idle');
    const u = await ui(p);
    t.ok(!u.hintOn, 'hint hidden');
    t.ok((await cursor(p)) !== 'crosshair', 'cursor restored');
    t.eq((await cursorStyleInfo(p))[0].disabled, true, 'cursor sheet disabled');
  });

  test('pointer event reporting the modifier up disarms (lost keyup)', async (t) => {
    const p = await t.open(G);
    await arm(p, { at: [200, 300] });
    // A mouse move whose modifiers say "Shift is up", without a keyup (focus was elsewhere).
    await p._mkCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 260, y: 330, modifiers: 0 });
    await waitState(p, 'idle');
    t.ok(!(await ui(p)).hintOn, 'hint hidden');
    await p.keyboard.up('Shift');
  });

  test('pointer moves with shiftKey but no keydown arm (missed keydown)', async (t) => {
    const p = await t.open(G);
    for (const [x, y] of [[200, 300], [205, 302], [215, 310], [225, 318]]) {
      await p._mkCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: 8 /* shift */ });
      await sleep(20);
    }
    await waitState(p, 'armed');
    t.ok((await ui(p)).hintOn, 'hint shown');
  });

  test('window blur disarms', async (t) => {
    const p = await t.open(G);
    await arm(p, { at: [200, 300] });
    await p.evaluate(() => window.dispatchEvent(new Event('blur')));
    await waitState(p, 'idle');
    t.ok((await cursor(p)) !== 'crosshair', 'cursor restored');
    await p.keyboard.up('Shift');
  });

  for (const [sel, what] of [['#txt', 'text input'], ['#ta', 'textarea'], ['#ce', 'contenteditable'], ['#cv', 'canvas'], ['#rtb', '[role=textbox]'], ['#mon', '.monaco-editor']]) {
    test(`armed visuals are suppressed over ${what} and restored after`, async (t) => {
      const p = await t.open(TG);
      await arm(p, { at: [200, 250] });
      const r = await p.evaluate((s) => {
        const b = document.querySelector(s).getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }, sel);
      await p.mouse.move(r.x, r.y, { steps: 6 });
      await waitState(p, 'idle');
      const u = await ui(p);
      t.ok(!u.hintOn, 'hint hidden over target');
      t.ok((await cursor(p, sel)) !== 'crosshair', `cursor over ${what} is not crosshair`);
      await p.mouse.move(200, 260, { steps: 6 });
      await waitState(p, 'armed');
      t.ok((await ui(p)).hintOn, 'hint back over plain content');
      t.eq(await cursor(p), 'crosshair', 'crosshair back');
      await p.keyboard.up('Shift');
    });
  }

  test('showHint:false keeps the crosshair but never shows the pill', async (t) => {
    await t.settings({ showHint: false });
    const p = await t.open(G);
    await arm(p, { at: [200, 300] });
    t.eq(await cursor(p), 'crosshair');
    const seen = await p.evaluate(() => document.querySelector('mikron-root').shadowRoot.querySelector('.mk-hint').classList.contains('on'));
    t.eq(seen, false, 'hint .on');
    await p.keyboard.up('Shift');
  });

  for (const [mod, label, glyph] of [['alt', 'Option', '⌥'], ['ctrl', 'Ctrl', '⌃'], ['meta', 'Cmd', '⌘']]) {
    test(`modifier "${mod}" arms with its key, keycap reads ${glyph} ${label}; Shift no longer arms`, async (t) => {
      await t.settings({ modifier: mod });
      const p = await t.open(G);
      // Shift must not arm
      await p.mouse.move(200, 300);
      await p.keyboard.down('Shift');
      await sleep(290);
      await p.mouse.move(230, 320, { steps: 4 });
      const seen = await watchStates(p, 200);
      await p.keyboard.up('Shift');
      t.ok(!seen.includes('armed'), `Shift armed under modifier=${mod}: ${seen}`);
      await arm(p, { mod, at: [210, 300] });
      const u = await ui(p);
      t.ok(u.hintOn, 'hint visible');
      t.ok(u.hintText.includes(label), `keycap label "${label}" in "${u.hintText}"`);
      t.ok(u.hintText.includes(glyph), `keycap glyph "${glyph}" in "${u.hintText}"`);
      await p.keyboard.up(KEY[mod]);
      await waitState(p, 'idle');
    });
  }

  test('hint pill sits at pointer + (16, 16) and follows the pointer', async (t) => {
    const p = await t.open(G);
    await arm(p, { at: [190, 290] });
    await p.mouse.move(300, 260, { steps: 5 });
    await until(async () => {
      const u = await ui(p);
      return Math.abs(u.hintRect.x - 316) < 1.5 && Math.abs(u.hintRect.y - 276) < 1.5;
    }, { msg: 'hint at (316, 276)', timeout: 1500 }).catch(async (e) => {
      const u = await ui(p);
      t.fail(`${e.message}; hint rect ${JSON.stringify(u.hintRect)}`);
    });
    await p.keyboard.up('Shift');
  });

  test('hint pill flips near the right and bottom viewport edges', async (t) => {
    const p = await t.open(G);
    await arm(p, { at: [600, 400] });
    await p.mouse.move(700, 465, { steps: 5 });
    await sleep(400);
    const u = await ui(p);
    t.ok(u.hintRect.x + u.hintRect.w <= 700 - 15, `hint should be left of the pointer: ${JSON.stringify(u.hintRect)}`);
    t.ok(u.hintRect.y + u.hintRect.h <= 465 - 15, `hint should be above the pointer: ${JSON.stringify(u.hintRect)}`);
    t.ok(u.hintRect.x >= 0 && u.hintRect.y >= 0, 'hint on screen');
    await p.keyboard.up('Shift');
  });

  test('while pinned the modifier shows crosshair but no hint; hint returns after Esc with modifier held', async (t) => {
    const p = await t.open(G);
    await drag(p, [100, 260], [300, 400], { armFirst: true, keepMod: true });
    await waitState(p, 'pinned');
    await p.mouse.move(420, 420, { steps: 4 });
    await sleep(120);
    let u = await ui(p);
    t.ok(!u.hintOn, 'no hint while pinned');
    t.eq(await cursor(p), 'crosshair', 'crosshair while pinned + modifier');
    await p.keyboard.press('Escape');
    await p.mouse.move(430, 425, { steps: 2 });
    await until(async () => (await ui(p)).hintOn, { msg: 'hint back after dismiss', timeout: 1000 });
    await p.keyboard.up('Shift');
  });

  test('M5 hint pill geometry: 29 px tall (padding 3, keycap 21), keycap highlight .14', async (t) => {
    const p = await t.open(G);
    await arm(p, { at: [200, 300] });
    await sleep(250);
    const h = await hintCs(p);
    t.near(h.height, 29, 0.6, 'pill height');
    t.eq(h.pad, '3px', 'padding');
    t.near(h.keyH, 21, 0.6, 'keycap height');
    t.ok(/0\.14/.test(h.keyShadow), `keycap shadow ${h.keyShadow}`);
    await p.keyboard.up('Shift');
  });

  test('M2 hint pill hides instantly when the modifier is released (no fade)', async (t) => {
    const p = await t.open(G);
    await arm(p, { at: [200, 300] });
    await sleep(250);
    await p.keyboard.up('Shift');
    const h = await hintCs(p);
    t.eq(h.visibility, 'hidden', 'visibility right after keyup (a 100 ms fade would still be visible)');
    t.ok(!h.on, 'not .on');
    // and it shows again normally afterwards
    await arm(p, { at: [220, 300] });
    await sleep(250);
    const h2 = await hintCs(p);
    t.eq([h2.visibility, h2.opacity], ['visible', 1], 'shows again');
    await p.keyboard.up('Shift');
  });

  test('M3 hint pill hides as soon as the press exists (before the drag threshold) and returns on a click', async (t) => {
    const p = await t.open(G);
    await arm(p, { at: [200, 300] });
    await sleep(250);
    t.ok((await hintCs(p)).on, 'precondition: hint on');
    await p.mouse.down();
    await sleep(30);
    t.ok(!(await hintCs(p)).on, 'hint class removed on press');
    await sleep(150);
    t.eq((await hintCs(p)).visibility, 'hidden', 'hidden after the fade');
    t.eq(await state(p), 'armed', 'press has not become a drag');
    await p.mouse.up();
    await until(async () => (await hintCs(p)).on, { msg: 'hint back after a click without drag', timeout: 800 });
    await p.keyboard.up('Shift');
  });

  test('I3 with an input focused the armed state needs a 500 ms hold and 16 px of travel', async (t) => {
    const p = await t.open(TG);
    await p.click('#txt');
    await p.mouse.move(300, 440);
    await p.keyboard.down('Shift');
    await sleep(300);
    await p.mouse.move(306, 444, { steps: 2 });
    await p.mouse.move(312, 448, { steps: 2 }); // 14 px of travel, 300 ms: enough without focus, not with it
    const seen = await watchStates(p, 120);
    t.ok(!seen.includes('armed'), `armed too early: ${seen}`);
    await sleep(150); // > 500 ms held now, but the travel is still short
    await p.mouse.move(313, 449);
    t.ok(!(await watchStates(p, 80)).includes('armed'), 'armed on < 16 px of travel');
    await p.mouse.move(340, 470, { steps: 4 });
    await waitState(p, 'armed');
    await p.keyboard.up('Shift');
  });

  test('I3 without an editable focused, 250 ms + 4 px still arms', async (t) => {
    const p = await t.open(TG);
    await arm(p, { at: [300, 440] });
    await p.keyboard.up('Shift');
  });
});
