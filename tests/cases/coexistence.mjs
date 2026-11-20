import { describe, test } from '../lib/harness.mjs';
import { state, waitState, watchStates, ui, arm, drag, pin, chipsSettled, resetProbe, count, events, sleep, until, rect, isoEval, cursorStyleInfo } from '../lib/mk.mjs';

const TG = '/tests/fixtures/targets.html';
const G = '/tests/fixtures/gesture.html';

async function center(p, sel) {
  const r = await rect(p, sel);
  return [r.x + r.w / 2, r.y + r.h / 2];
}

async function shiftClick(p, x, y, { armFirst = false } = {}) {
  if (armFirst) {
    await arm(p, { at: [x - 30, y - 30] });
    await p.mouse.move(x, y, { steps: 3 });
  } else {
    await p.mouse.move(x, y);
    await p.keyboard.down('Shift');
  }
  await p.mouse.down();
  await p.mouse.up();
  await p.keyboard.up('Shift');
}

describe('coexistence', () => {
  for (const [sel, what] of [['#link', 'link'], ['#btn', 'button'], ['#chk', 'checkbox']]) {
    for (const armFirst of [false, true]) {
      test(`plain Shift+click on a ${what} delivers click with shiftKey${armFirst ? ' (after visible arm)' : ''}`, async (t) => {
        const p = await t.open(TG);
        const [x, y] = await center(p, sel);
        if (armFirst) await arm(p, { at: [x - 30, 260] });
        await resetProbe(p);
        await shiftClick(p, x, y, { armFirst: false });
        const clicks = (await events(p)).filter((e) => e.type === 'click' && e.phase === 'b');
        t.eq(clicks.length, 1, 'click count');
        t.eq(clicks[0].shift, true, 'click.shiftKey');
        t.ok(clicks[0].target.startsWith(sel.slice(1)) || clicks[0].target.includes(sel), `click target ${clicks[0].target}`);
        t.ok((await state(p)) !== 'pinned' && (await state(p)) !== 'dragging', 'no selection');
        if (what === 'checkbox') t.eq(await p.evaluate(() => document.getElementById('chk').checked), true, 'checkbox toggled');
      });
    }
  }

  test('Shift+click extends an existing text selection', async (t) => {
    const p = await t.open(TG);
    const r = await rect(p, '#para');
    // collapsed selection at the start of the paragraph text
    await p.evaluate(() => {
      const tn = document.getElementById('para').firstChild;
      getSelection().setBaseAndExtent(tn, 0, tn, 0);
    });
    const x = r.x + 200, y = r.y + 10;
    const expected = await p.evaluate(([x, y]) => {
      const c = document.caretPositionFromPoint ? document.caretPositionFromPoint(x, y) : null;
      const o = c ? c.offset : document.caretRangeFromPoint(x, y).startOffset;
      return document.getElementById('para').firstChild.data.slice(0, o);
    }, [x, y]);
    await shiftClick(p, x, y);
    const got = await p.evaluate(() => getSelection().toString());
    t.ok(expected.length > 10, 'sanity: expected text');
    t.eq(got, expected, 'selection after Shift+click');
  });

  test('Shift+click with visible arm also extends the text selection', async (t) => {
    const p = await t.open(TG);
    const r = await rect(p, '#para');
    await p.evaluate(() => {
      const tn = document.getElementById('para').firstChild;
      getSelection().setBaseAndExtent(tn, 0, tn, 0);
    });
    await shiftClick(p, r.x + 200, r.y + 10, { armFirst: true });
    const got = await p.evaluate(() => getSelection().toString());
    t.ok(got.length > 10, `selection after armed Shift+click: "${got}"`);
  });

  test('after a real drag no click / dblclick / auxclick reaches the page; the next normal click does', async (t) => {
    const p = await t.open(G);
    await resetProbe(p);
    await p.mouse.move(100, 300);
    await p.keyboard.down('Shift');
    await p.mouse.down({ clickCount: 1 });
    await p.mouse.move(300, 420, { steps: 8 });
    await p.mouse.up({ clickCount: 1 });
    await p.keyboard.up('Shift');
    await waitState(p, 'pinned');
    await sleep(50);
    t.eq(await count(p, 'click'), 0, 'click after drag');
    t.eq(await count(p, 'dblclick'), 0, 'dblclick after drag');
    t.eq(await count(p, 'auxclick'), 0, 'auxclick after drag');
    // next normal click (outside the pinned rect) must reach the page
    await resetProbe(p);
    await p.mouse.click(600, 120);
    t.eq(await count(p, 'click', 'b'), 1, 'next normal click');
  });

  test('double-click-count press that turns into a drag delivers no dblclick', async (t) => {
    const p = await t.open(G);
    await p.mouse.click(100, 300);
    await resetProbe(p);
    await p.mouse.move(100, 300);
    await p.keyboard.down('Shift');
    await p.mouse.down({ clickCount: 2 });
    await p.mouse.move(300, 420, { steps: 8 });
    await p.mouse.up({ clickCount: 2 });
    await p.keyboard.up('Shift');
    await waitState(p, 'pinned');
    await sleep(50);
    t.eq(await count(p, 'dblclick'), 0, 'dblclick');
    t.eq(await count(p, 'click'), 0, 'click');
  });

  const ignored = [
    ['#txt', 'input'],
    ['#ta', 'textarea'],
    ['#sel', 'select'],
    ['#ce', 'contenteditable'],
    ['#cv', 'canvas'],
    ['#rtb', '[role=textbox]'],
    ['#mon', '.monaco-editor'],
    ['#cm', '.CodeMirror'],
    ['#cmn', '.cm-editor'],
  ];
  for (const [sel, what] of ignored) {
    test(`Shift+drag starting on ${what} is ignored and the page gets an untouched pointerdown/mousedown`, async (t) => {
      const p = await t.open(TG);
      const r = await rect(p, sel);
      await resetProbe(p);
      await p.mouse.move(r.x + 8, r.y + r.h / 2);
      await p.keyboard.down('Shift');
      await p.mouse.down();
      await p.mouse.move(r.x + 120, r.y + r.h / 2 + 4, { steps: 6 });
      const seen = await watchStates(p, 100);
      await p.mouse.up();
      await p.keyboard.up('Shift');
      if (what === 'select') await p.keyboard.press('Escape');
      t.ok(!seen.includes('dragging') && !seen.includes('pinned'), `states: ${seen}`);
      const ev = await events(p);
      const md = ev.find((e) => e.type === 'mousedown' && e.phase === 'c');
      t.ok(md, 'page saw mousedown');
      t.eq(md.prevented, false, 'mousedown defaultPrevented');
      t.ok(ev.some((e) => e.type === 'pointermove'), 'page saw pointermove');
    });
  }

  test('contenteditable="false" is NOT an ignored start target', async (t) => {
    const p = await t.open(TG);
    const r = await rect(p, '#cefalse');
    await pin(p, [r.x + 10, r.y + 10], [r.x + 150, r.y + 100]);
  });

  test('native Shift+drag text selection inside an <input> is untouched', async (t) => {
    const p = await t.open(TG);
    const r = await rect(p, '#txt');
    await p.mouse.click(r.x + 6, r.y + r.h / 2);
    await p.mouse.move(r.x + 6, r.y + r.h / 2);
    await p.keyboard.down('Shift');
    await p.mouse.down();
    await p.mouse.move(r.x + 150, r.y + r.h / 2, { steps: 8 });
    await p.mouse.up();
    await p.keyboard.up('Shift');
    const s = await p.evaluate(() => {
      const i = document.getElementById('txt');
      return [i.selectionStart, i.selectionEnd, document.activeElement === i];
    });
    t.ok(s[1] - s[0] >= 8, `input selection ${s}`);
    t.ok(s[2], 'input focused');
  });

  test('native Shift+click selection inside a <textarea> is untouched', async (t) => {
    const p = await t.open(TG);
    const r = await rect(p, '#ta');
    await p.mouse.click(r.x + 6, r.y + 10);
    await p.mouse.move(r.x + 150, r.y + 30);
    await p.keyboard.down('Shift');
    await p.mouse.down();
    await p.mouse.up();
    await p.keyboard.up('Shift');
    const s = await p.evaluate(() => {
      const i = document.getElementById('ta');
      return [i.selectionStart, i.selectionEnd];
    });
    t.ok(s[1] - s[0] >= 15, `textarea selection ${s}`);
  });

  for (const [id, what] of [['open', 'an open'], ['closed', 'a closed']]) {
    test(`Shift+drag inside an <input> in ${what} shadow root keeps native selection (not measured)`, async (t) => {
      const p = await t.open('/tests/fixtures/shadow-inputs.html');
      const r = await rect(p, '#' + id);
      await p.mouse.click(r.x + 6, r.y + r.h / 2);
      await p.mouse.move(r.x + 6, r.y + r.h / 2);
      await p.keyboard.down('Shift');
      await p.mouse.down();
      await p.mouse.move(r.x + 200, r.y + r.h / 2, { steps: 8 });
      const seen = await watchStates(p, 100);
      await p.mouse.up();
      await p.keyboard.up('Shift');
      const sel = await p.evaluate((id) => {
        const i = id === 'open' ? window.openInput : window.closedInput;
        return [i.selectionStart, i.selectionEnd];
      }, id);
      t.ok(!seen.includes('dragging') && !seen.includes('pinned'), `measured instead of selecting text: ${seen}`);
      t.ok(sel[1] - sel[0] >= 8, `input selection ${sel}`);
    });
  }

  test('auto-repeated Shift keydowns neither taint nor reset the hold timer', async (t) => {
    const p = await t.open(G);
    await arm(p, { at: [200, 300] });
    for (let i = 0; i < 5; i++) {
      await p._mkCdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8, autoRepeat: true });
      await sleep(30);
    }
    await p.mouse.move(260, 340, { steps: 3 });
    t.eq(await state(p), 'armed', 'still armed after key repeat');
    await pin(p, [260, 340], [400, 440], { mod: null });
    await p.keyboard.up('Shift');
  });

  test('Escape with nothing to dismiss reaches the page', async (t) => {
    const p = await t.open(G);
    await arm(p, { at: [200, 300] });
    await p.keyboard.up('Shift');
    await resetProbe(p);
    await p.keyboard.press('Escape');
    t.eq(await count(p, 'keydown', 'b'), 1, 'page keydown Escape');
  });

  test('Shift+drag while focus is in an input still measures (focus elsewhere is fine)', async (t) => {
    const p = await t.open(TG);
    await p.click('#txt');
    await pin(p, [60, 240], [300, 330]);
  });
});

const AN = '/tests/fixtures/annoy.html';

/** Hold Shift for the visible-arm time, then move to (x, y), press and release (no travel). */
async function shiftPress(p, x, y, { jitter = null } = {}) {
  await p.mouse.move(x - 30, y - 20);
  await p.keyboard.down('Shift');
  await sleep(300);
  await p.mouse.move(x, y, { steps: 4 });
  await p.mouse.down();
  if (jitter) await p.mouse.move(x + jitter[0], y + jitter[1], { steps: 2 });
  await p.mouse.up();
  await p.keyboard.up('Shift');
}

describe('always-on coexistence', () => {
  for (const [sel, what] of [['#sortable div:nth-child(2)', 'sortable item'], ['#scrub', 'scrubber']]) {
    test(`T3-1 page that captures the pointer on pointerdown (${what}) keeps the gesture under Shift`, async (t) => {
      const p = await t.open(AN);
      const r = await rect(p, sel);
      const x = r.x + 40, y = r.y + r.h / 2;
      await p.mouse.move(x - 20, y);
      await p.keyboard.down('Shift');
      await sleep(300);
      await p.mouse.move(x, y, { steps: 3 });
      await p.mouse.down();
      await p.mouse.move(x + 120, y + 6, { steps: 8 });
      const seen = await watchStates(p, 120);
      await p.mouse.up();
      await p.keyboard.up('Shift');
      await sleep(60);
      t.ok(!seen.includes('dragging') && !seen.includes('pinned'), `states: ${seen}`);
      const log = await p.evaluate(() => window.__log.join('|'));
      t.ok(/(sort|scrub)-down/.test(log) && /(sort|scrub)-up/.test(log), `page saw pointerdown and pointerup (log ${log})`);
      t.ok(!(await ui(p)).shieldOn, 'shield off');
    });
  }

  for (const [sel, what] of [['#ign0', '.leaflet-container (id)'], ['#map', '.leaflet-container'], ['#ign1', '.maplibregl-map'], ['#ign2', '.mapboxgl-map'], ['#ign3', '.ol-viewport'], ['#ign4', '.gm-style'], ['#dd', '[draggable]'], ['#vid', 'video'], ['#sl', '[role=slider]'], ['#ign5', '[role=scrollbar]'], ['#ign6', '[role=separator]']]) {
    test(`T3-2 Shift+drag starting on ${what} is left to the page`, async (t) => {
      const p = await t.open(AN);
      const r = await rect(p, sel);
      await p.mouse.move(r.x + 3, r.y + 3);
      await p.keyboard.down('Shift');
      await sleep(300);
      await p.mouse.down();
      await p.mouse.move(r.x + 30, r.y + 12, { steps: 6 });
      const seen = await watchStates(p, 100);
      await p.mouse.up();
      await p.keyboard.up('Shift');
      t.ok(!seen.includes('dragging') && !seen.includes('pinned'), `states: ${seen}`);
      const id = sel.slice(1);
      if (sel !== '#vid' && sel !== '#dd') t.eq(await p.evaluate((i) => window.__md[i] && window.__md[i].shift, id), true, 'page saw Shift+mousedown');
    });
  }

  test('T3-3 Shift+click with 4 px of hand jitter is still a click (and extends the list range)', async (t) => {
    const p = await t.open(AN);
    const a = await rect(p, '#list li:nth-child(1)');
    const b = await rect(p, '#list li:nth-child(4)');
    await p.mouse.click(a.x + 20, a.y + 10);
    await shiftPress(p, b.x + 20, b.y + 10, { jitter: [4, 1] });
    await sleep(60);
    t.eq(await state(p), 'idle', 'no selection started');
    t.ok((await p.evaluate(() => window.__log.join('|'))).includes('list-range 0 3'), 'page received the click');
  });

  test('T3-4 list that prevents Shift+mousedown itself: no text selection from our emulation, page still gets the click', async (t) => {
    const p = await t.open(AN);
    const a = await rect(p, '#plist li:nth-child(1)');
    const b = await rect(p, '#plist li:nth-child(4)');
    await p.mouse.click(a.x + 20, a.y + 10);
    t.ok(await p.evaluate(() => !!getSelection().anchorNode), 'precondition: caret in the first item');
    await shiftPress(p, b.x + 60, b.y + 10);
    await sleep(60);
    const r = await p.evaluate(() => ({ sel: getSelection().toString(), log: window.__log.join('|') }));
    t.eq(r.sel, '', 'text selection');
    t.ok(r.log.includes('plist-range 0 3'), `page click handler ran (${r.log})`);
  });

  test('T3-4 control: a list that leaves Shift+mousedown alone still gets text-selection extension', async (t) => {
    const p = await t.open(AN);
    const a = await rect(p, '#list li:nth-child(1)');
    const b = await rect(p, '#list li:nth-child(4)');
    await p.mouse.click(a.x + 20, a.y + 10);
    await shiftPress(p, b.x + 40, b.y + 10);
    await sleep(60);
    t.ok((await p.evaluate(() => getSelection().toString())).includes('Item 2'), 'selection extended across items');
  });

  test('T3-4 Shift+click on a link moves focus to it (the browser default we suppressed)', async (t) => {
    const p = await t.open(AN);
    const r = await rect(p, '#lnk');
    await shiftPress(p, r.x + 10, r.y + r.h / 2);
    await sleep(60);
    t.eq(await p.evaluate(() => document.activeElement && document.activeElement.id), 'lnk', 'activeElement');
    t.ok((await p.evaluate(() => window.__log.join('|'))).includes('link-click shift=true'), 'page click seen');
  });

  test('T3-4 Shift+click on plain content blurs a focused input', async (t) => {
    const p = await t.open(AN);
    await p.click('#inp');
    t.eq(await p.evaluate(() => document.activeElement.id), 'inp', 'precondition');
    const r = await rect(p, '#plain');
    await shiftPress(p, r.x + 50, r.y + 40);
    await sleep(60);
    t.eq(await p.evaluate(() => document.activeElement.localName), 'body', 'focus left the input');
  });

  test('T3-4 mousedown default is suppressed in bubble phase: capture-phase listeners see it unprevented', async (t) => {
    const p = await t.open(AN);
    const r = await rect(p, '#plain');
    await resetProbe(p);
    await shiftPress(p, r.x + 50, r.y + 40);
    const md = (await events(p)).filter((e) => e.type === 'mousedown');
    t.eq(md.find((e) => e.phase === 'c').prevented, false, 'capture-phase view');
  });

  test('T3-5 typing capitals in a focused input with the mouse drifting never flashes the armed state', async (t) => {
    const p = await t.open(AN);
    await p.click('#inp');
    await p.mouse.move(500, 420);
    await p.keyboard.type('x');
    const watching = watchStates(p, 2600);
    for (const ch of 'ABC') {
      await p.keyboard.down('Shift');
      for (let i = 0; i < 8; i++) {
        await p.mouse.move(500 + i * 3, 420 + i * 2);
        await sleep(40);
      }
      await p.keyboard.press('Key' + ch);
      await p.keyboard.up('Shift');
      await sleep(60);
    }
    const seen = await watching;
    t.ok(!seen.includes('armed'), `states: ${seen}`);
    t.eq(await p.evaluate(() => document.getElementById('inp').value), 'xABC', 'typed text');
  });

  test('T3-5 mouse travel only counts once the 250 ms hold has elapsed', async (t) => {
    const p = await t.open(AN);
    await p.mouse.move(100, 360);
    await p.keyboard.down('Shift');
    for (let i = 0; i < 8; i++) {
      await p.mouse.move(100 + i * 12, 360);
      await sleep(15);
    }
    await sleep(250); // hold elapsed with the pointer at rest
    const seen = await watchStates(p, 150);
    t.ok(!seen.includes('armed'), `armed from pre-hold travel: ${seen}`);
    await p.mouse.move(190, 362, { steps: 2 });
    await waitState(p, 'armed');
    await p.keyboard.up('Shift');
  });

  test('T3-6 cursor stylesheet is skipped above 5 000 elements and used below', async (t) => {
    for (const [n, expect] of [[5200, 0], [3000, 1]]) {
      const p = await t.open(AN);
      await p.evaluate((n) => {
        const f = document.createDocumentFragment();
        for (let i = 0; i < n; i++) f.appendChild(document.createElement('i'));
        document.body.appendChild(f);
      }, n);
      await arm(p, { at: [200, 440] });
      t.eq((await cursorStyleInfo(p)).length, expect, `style[data-mikron] with ~${n} elements`);
      await p.keyboard.up('Shift');
      await p.close();
    }
  });

  async function stubScan(p, ms) {
    await isoEval(p, `(() => { const M = globalThis.__MIKRON__; if (!M.__real) M.__real = M.scan; M.__n = 0; M.scan = function (o) { M.__n++; const t = performance.now(); while (performance.now() - t < ${ms}); return M.__real(o); }; })()`);
  }
  const scans = (p) => isoEval(p, 'globalThis.__MIKRON__.__n');

  test('I1 a layout change between arming and the drag is measured (no stale pre-scan)', async (t) => {
    const p = await t.open(G);
    await stubScan(p, 0);
    await arm(p, { at: [20, 400] }); // visuals appear here; the old code scanned now
    await p.evaluate(() => { document.getElementById('a').style.height = '160px'; });
    await sleep(600);
    t.eq(await scans(p), 0, 'nothing is scanned before the drag starts');
    await p.mouse.move(20, 20);
    await p.mouse.down();
    await p.mouse.move(280, 260, { steps: 8 });
    await waitState(p, 'dragging');
    t.eq(await scans(p), 1, 'exactly one scan, at drag start');
    await p.mouse.up();
    await waitState(p, 'pinned');
    await p.keyboard.up('Shift');
    const c = (await chipsSettled(p)).map((x) => x.text);
    t.ok(c.includes('200 × 160'), `a dimension chip shows the new size 200 × 160 (chips: ${c})`);
    t.ok(!c.includes('200 × 100'), `no stale 200 × 100 chip (chips: ${c})`);
  });

  test('T3-6 rescan throttle grows with the scan duration (max(80, 4 × scan))', async (t) => {
    const p = await t.open(AN);
    await stubScan(p, 40);
    await pin(p, [30, 330], [200, 420]);
    const n0 = await scans(p);
    const t0 = Date.now();
    while (Date.now() - t0 < 900) {
      await p.evaluate(() => window.scrollBy(0, 1));
      await sleep(15);
    }
    const n = (await scans(p)) - n0;
    t.ok(n >= 1 && n <= 5, `rescans in 0.9 s of continuous scrolling with 40 ms scans: ${n} (≤ 5 expected at ≥ 160 ms spacing + scan time)`);
  });

  const SP = '/tests/fixtures/stopprop.html';

  test('I2a a widget whose pointerdown does preventDefault + stopPropagation keeps its drag (no measurement takeover)', async (t) => {
    const p = await t.open(SP);
    const r = await rect(p, '#widget');
    await p.mouse.move(r.x + 20, r.y + 40);
    await p.keyboard.down('Shift');
    await sleep(300);
    await p.mouse.down();
    await p.mouse.move(r.x + 120, r.y + 50, { steps: 8 });
    const seen = await watchStates(p, 100);
    await p.mouse.up();
    await p.keyboard.up('Shift');
    t.ok(!seen.includes('dragging') && !seen.includes('pinned'), `states: ${seen}`);
    const log = await p.evaluate(() => window.__log.join('|'));
    t.ok(/widget down\|widget up (1\d\d)/.test(log), `the widget followed the pointer to the end: ${log}`);
    t.eq(await state(p), 'idle', 'idle afterwards');
  });

  test('I2a control: a measurement drag on the same page outside the widget still works', async (t) => {
    const p = await t.open(SP);
    await pin(p, [30, 440], [300, 560]);
  });

  test('I2b list that prevents Shift+mousedown AND stops propagation: no forced text selection, page gets the click', async (t) => {
    const p = await t.open(SP);
    const a = await rect(p, '#slist li:nth-child(1)');
    const b = await rect(p, '#slist li:nth-child(4)');
    await p.mouse.click(a.x + 20, a.y + 10);
    t.ok(await p.evaluate(() => !!getSelection().anchorNode), 'precondition: caret in the first item');
    await shiftPress(p, b.x + 60, b.y + 10);
    await sleep(60);
    const r = await p.evaluate(() => ({ sel: getSelection().toString(), log: window.__log.join('|'), ae: document.activeElement.localName }));
    t.eq(r.sel, '', 'text selection');
    t.ok(r.log.includes('s-click 3 shift'), `page click handler ran (${r.log})`);
  });

  test('I2b control: the same list without prevention still gets text-selection extension', async (t) => {
    const p = await t.open(SP);
    const a = await rect(p, '#clist li:nth-child(1)');
    const b = await rect(p, '#clist li:nth-child(4)');
    await p.mouse.click(a.x + 20, a.y + 10);
    await shiftPress(p, b.x + 40, b.y + 10);
    await sleep(60);
    t.ok((await p.evaluate(() => getSelection().toString())).includes('C-Item 2'), 'selection extended across items');
  });

  test('I2c list that only stops mousedown propagation: Shift+click extends the text selection like the control', async (t) => {
    const p = await t.open(SP);
    const a = await rect(p, '#tlist li:nth-child(1)');
    const b = await rect(p, '#tlist li:nth-child(4)');
    await p.mouse.click(a.x + 20, a.y + 10);
    await shiftPress(p, b.x + 40, b.y + 10);
    await sleep(60);
    const r = await p.evaluate(() => ({ sel: getSelection().toString(), log: window.__log.join('|') }));
    t.ok(r.sel.includes('T-Item 2') && r.sel.includes('T-Item 3'), `selection extended across items: ${JSON.stringify(r.sel)}`);
    t.ok(r.log.includes('t-click 3 shift'), `page click handler ran (${r.log})`);
  });
});
