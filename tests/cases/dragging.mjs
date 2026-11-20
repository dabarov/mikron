import { describe, test } from '../lib/harness.mjs';
import { state, waitState, watchStates, ui, drag, pin, resetProbe, count, events, sleep, until } from '../lib/mk.mjs';

const G = '/tests/fixtures/gesture.html';

function rectEq(t, r, exp, msg, tol = 0.6) {
  for (const k of ['x', 'y', 'w', 'h']) t.near(r[k], exp[k], tol, `${msg} ${k} (got ${JSON.stringify(r)})`);
}

describe('dragging', () => {
  const dirs = [
    ['down-right', [100, 280], [300, 420], { x: 100, y: 280, w: 200, h: 140 }],
    ['up-left', [300, 420], [100, 280], { x: 100, y: 280, w: 200, h: 140 }],
    ['up-right', [100, 420], [300, 280], { x: 100, y: 280, w: 200, h: 140 }],
    ['down-left', [300, 280], [100, 420], { x: 100, y: 280, w: 200, h: 140 }],
  ];
  for (const [name, from, to, exp] of dirs) {
    test(`drag ${name} pins the exact rectangle`, async (t) => {
      const p = await t.open(G);
      const u = await pin(p, from, to);
      rectEq(t, u.marquee, exp, 'marquee');
      t.eq(u.label, `${exp.w} × ${exp.h}`, 'size label');
      t.ok(u.copyShown, 'copy tab shown');
    });
  }

  test('a drag can start immediately (modifier + press, no prior hold/move)', async (t) => {
    const p = await t.open(G);
    await p.mouse.move(100, 280);
    await p.keyboard.down('Shift');
    await p.mouse.down();
    await p.mouse.move(110, 290);
    await waitState(p, 'dragging', { timeout: 500 });
    await p.mouse.move(200, 380, { steps: 4 });
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await waitState(p, 'pinned');
  });

  test('pointer movement < 6 px after press does not start a drag', async (t) => {
    const p = await t.open(G);
    await p.mouse.move(100, 280);
    await p.keyboard.down('Shift');
    await p.mouse.down();
    await p.mouse.move(104, 283); // 5 px
    const seen = await watchStates(p, 120);
    await p.mouse.up();
    await p.keyboard.up('Shift');
    t.ok(!seen.includes('dragging'), `states: ${seen}`);
  });

  test('snap 4: W/H round to multiples of 4 (103 × 51 -> 104 × 52), anchor not snapped', async (t) => {
    const p = await t.open(G);
    const u = await pin(p, [101, 281], [204, 332]);
    t.eq(u.label, '104 × 52');
    rectEq(t, u.marquee, { x: 101, y: 281, w: 104, h: 52 }, 'marquee');
  });

  test('snap 0: W/H are exact pixels', async (t) => {
    await t.settings({ snap: 0 });
    const p = await t.open(G);
    const u = await pin(p, [101, 281], [204, 332]);
    t.eq(u.label, '103 × 51');
    rectEq(t, u.marquee, { x: 101, y: 281, w: 103, h: 51 }, 'marquee');
  });

  test('release with snapped size < 8 × 8 cancels (no pin, no Copy tab)', async (t) => {
    const p = await t.open(G);
    await drag(p, [100, 280], [105, 285], { steps: 3 });
    await waitState(p, 'idle');
    await sleep(300);
    const u = await ui(p);
    t.eq(u.state === 'pinned', false, 'pinned');
    t.ok(!u.copyShown, 'no Copy tab');
    t.ok(!u.stageVisible, 'stage faded out');
  });

  test('wide but flat selection (200 × 4) cancels', async (t) => {
    const p = await t.open(G);
    await drag(p, [100, 280], [300, 283], { steps: 6 });
    await waitState(p, 'idle');
  });

  test('Escape mid-drag cancels; the following release neither pins nor clicks', async (t) => {
    const p = await t.open(G);
    await drag(p, [100, 280], [300, 420], { release: false, keepMod: true });
    await waitState(p, 'dragging');
    await resetProbe(p);
    await p.keyboard.press('Escape');
    await waitState(p, 'idle');
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await sleep(250);
    t.ok((await state(p)) !== 'pinned', 'pinned after Esc');
    t.eq(await count(p, 'keydown'), 0, 'page saw the Escape keydown');
    t.eq(await count(p, 'click'), 0, 'page saw a click');
    t.ok(!(await ui(p)).stageVisible, 'stage hidden');
  });

  test('releasing the modifier mid-drag still pins the full selection', async (t) => {
    const p = await t.open(G);
    await p.mouse.move(100, 280);
    await p.keyboard.down('Shift');
    await p.mouse.down();
    await p.mouse.move(180, 330, { steps: 5 });
    await p.keyboard.up('Shift');
    await p.mouse.move(300, 420, { steps: 5 });
    await waitState(p, 'dragging');
    await p.mouse.up();
    await waitState(p, 'pinned');
    t.eq((await ui(p)).label, '200 × 140');
  });

  test('release outside the viewport pins', async (t) => {
    const p = await t.open(G);
    await drag(p, [500, 300], [600, 400], { release: false });
    await p.mouse.move(800, 600, { steps: 6 });
    await p.mouse.up();
    await waitState(p, 'pinned');
    const u = await ui(p);
    t.eq(u.label, '300 × 300');
    rectEq(t, u.marquee, { x: 500, y: 300, w: 300, h: 300 }, 'marquee');
  });

  test('released corner = true pointer even when the eased corner lags (fast flick)', async (t) => {
    const p = await t.open(G);
    await p.mouse.move(60, 260);
    await p.keyboard.down('Shift');
    await p.mouse.down();
    await p.mouse.move(68, 268);
    await waitState(p, 'dragging');
    await p.mouse.move(460, 460); // one big jump
    const lag = await p.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => r(document.querySelector('mikron-root').shadowRoot.querySelector('.mk-marquee').getBoundingClientRect().width)),
        ),
    );
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await waitState(p, 'pinned');
    const u = await ui(p);
    t.ok(lag < 396, `corner should trail the pointer right after a 400 px jump (width ${lag})`);
    t.eq(u.label, '400 × 200', 'pinned size uses the true pointer');
    rectEq(t, u.marquee, { x: 60, y: 260, w: 400, h: 200 }, 'pinned marquee');
  });

  test('moving corner settles exactly on a stationary pointer', async (t) => {
    const p = await t.open(G);
    await drag(p, [60, 260], [261, 401], { release: false, steps: 3 });
    await sleep(350);
    const u = await ui(p);
    t.eq(u.label, '200 × 140', 'label while held still');
    rectEq(t, u.marquee, { x: 60, y: 260, w: 200, h: 140 }, 'marquee while held still');
    await p.mouse.up();
  });

  test('wheel-scrolling mid-drag keeps the anchor glued to the page', async (t) => {
    const p = await t.open(G);
    await drag(p, [100, 300], [300, 400], { release: false, keepMod: true });
    await waitState(p, 'dragging');
    await p.mouse.wheel(0, 100);
    await until(() => p.evaluate(() => window.scrollY === 100), { msg: 'scrollY 100' });
    await p.mouse.move(301, 401);
    await p.mouse.move(300, 400);
    await sleep(250);
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await waitState(p, 'pinned');
    const u = await ui(p);
    rectEq(t, u.marquee, { x: 100, y: 200, w: 200, h: 200 }, 'marquee after scroll');
  });

  test('size label is centred 8 px under the marquee and flips inside near the bottom', async (t) => {
    const p = await t.open(G);
    let u = await pin(p, [100, 100], [300, 200]);
    t.near(u.labelRect.x + u.labelRect.w / 2, 200, 1, 'label centre x');
    t.near(u.labelRect.y, 208, 1, 'label top');
    await p.keyboard.press('Escape');
    await waitState(p, 'idle');
    await sleep(250);
    u = await pin(p, [100, 300], [300, 476]);
    t.ok(u.labelRect.y + u.labelRect.h <= 479, `label on screen: ${JSON.stringify(u.labelRect)}`);
    t.ok(u.labelRect.y >= u.marquee.y, 'label inside the marquee');
  });

  test('size label ends with "· partial" (and a title) only while the scan is truncated', async (t) => {
    const small = await t.open(G);
    const a = await pin(small, [100, 280], [300, 420]);
    t.eq(a.label, '200 × 140', 'small page: plain size');
    t.eq(a.labelTitle, null, 'small page: no title');
    const huge = await t.open('/tests/fixtures/scan-huge.html');
    const b = await pin(huge, [100, 100], [300, 240]);
    t.eq(b.label, '200 × 140 · partial', 'huge page: partial marker');
    t.ok(/too large/i.test(b.labelTitle || ''), 'huge page: title explains it: ' + b.labelTitle);
    t.ok(b.labelRect.w >= 100, `label wide enough for its text: ${JSON.stringify(b.labelRect)}`);
    // a rescan that clears the flag restores the plain label
    await huge.evaluate(() => {
      document.getElementById('grid').replaceChildren();
      document.body.style.height = '2000px';
      scrollTo(0, 10); // scrolling triggers the rescan
    });
    const c = await until(async () => { const u = await ui(huge); return u.label === '200 × 140' ? u : null; }, { msg: 'plain label after the page shrinks' });
    t.eq(c.labelTitle, null, 'title removed');
  });

  test('I5 size label stays 8 px below the marquee (cut by the viewport) while >= 10 px of it would show', async (t) => {
    const p = await t.open('/demo/index.html');
    const u = await pin(p, [38, 27], [642, 459]);
    t.near(u.marquee.y + u.marquee.h, 459, 1, `marquee bottom ${JSON.stringify(u.marquee)}`);
    t.near(u.labelRect.y, u.marquee.y + u.marquee.h + 8, 1, `label top 8 below: ${JSON.stringify(u.labelRect)}`);
    await p.keyboard.press('Escape');
    await waitState(p, 'idle');
    await sleep(250);
    const v = await pin(p, [100, 300], [300, 460]); // 11 px of the label would show
    t.near(v.labelRect.y, v.marquee.y + v.marquee.h + 8, 1, `label top 8 below: ${JSON.stringify(v.labelRect)}`);
  });

  test('I5 with < 10 px of the label visible it sits fully inside, 6 px above the marquee bottom', async (t) => {
    const p = await t.open(G);
    const u = await pin(p, [100, 300], [300, 479]);
    t.near(u.marquee.y + u.marquee.h, 479, 1, `marquee bottom ${JSON.stringify(u.marquee)}`);
    t.near(u.labelRect.y + u.labelRect.h, u.marquee.y + u.marquee.h - 6, 1, `label bottom 6 above: ${JSON.stringify(u.labelRect)}`);
  });

  test('hint pill fades out once the drag starts and does not come back while dragging', async (t) => {
    const p = await t.open(G);
    await drag(p, [100, 280], [300, 420], { armFirst: true, release: false, keepMod: true });
    await waitState(p, 'dragging');
    await sleep(150);
    t.ok(!(await ui(p)).hintOn, 'hint hidden while dragging');
    await p.mouse.up();
    await p.keyboard.up('Shift');
  });

  test('window blur mid-drag cancels and releases pointer capture', async (t) => {
    const p = await t.open(G);
    await drag(p, [100, 280], [300, 420], { release: false, keepMod: true });
    await waitState(p, 'dragging');
    await p.evaluate(() => window.dispatchEvent(new Event('blur')));
    await waitState(p, 'idle');
    t.ok(!(await ui(p)).shieldOn, 'shield released');
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await sleep(150);
    t.ok((await state(p)) !== 'pinned', 'no pin after blur');
  });

  test('custom snap value from storage (8) is honoured', async (t) => {
    await t.settings({ snap: 8 });
    const p = await t.open(G);
    const u = await pin(p, [101, 281], [204, 332]);
    t.eq(u.label, '104 × 48');
  });

  test('page that sets pointer capture on its own element at pointerdown owns the gesture (hand-off)', async (t) => {
    const p = await t.open('/tests/fixtures/capture.html');
    await drag(p, [60, 60], [360, 260], { release: false, keepMod: true });
    const seen = await watchStates(p, 150);
    t.ok(!seen.includes('dragging') && !seen.includes('pinned'), `states: ${seen}`);
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await sleep(60);
    t.eq(await p.evaluate(() => window.__lost), 1, 'page element lost capture only on its own pointerup');
    t.ok((await p.evaluate(() => window.__moves)) > 5, 'page element kept receiving pointermove');
    t.eq(await p.evaluate(() => window.__up), 1, 'page saw pointerup');
    t.ok(!(await ui(p)).shieldOn, 'shield off');
  });

  test('pointer capture handed off: a press outside the capturing widget still measures', async (t) => {
    const p = await t.open('/tests/fixtures/capture.html');
    const u = await pin(p, [480, 60], [680, 260]);
    t.eq(u.label, '200 × 200');
  });

  test('losing pointer capture mid-drag counts as release at the last known position', async (t) => {
    const p = await t.open(G);
    await drag(p, [100, 280], [300, 420], { release: false, keepMod: true, pause: 200 });
    await p.evaluate(() => {
      const s = document.querySelector('mikron-root').shadowRoot.querySelector('.mk-shield');
      for (let i = 0; i < 8; i++) try { if (s.hasPointerCapture(i)) s.releasePointerCapture(i); } catch (_) {}
    });
    await p.mouse.move(420, 460, { steps: 2 }); // lostpointercapture is delivered before the next pointer event
    await waitState(p, 'pinned');
    t.eq((await ui(p)).label, '200 × 140', 'pinned at the last captured position');
    await p.mouse.up();
    await p.keyboard.up('Shift');
  });

  test('drag over an <iframe> keeps the pointer (no events reach the frame)', async (t) => {
    const p = await t.open('/tests/fixtures/iframe.html');
    await p.waitForFunction(() => document.getElementById('f').contentDocument && document.getElementById('f').contentDocument.readyState === 'complete');
    await drag(p, [100, 100], [200, 150], { release: false, keepMod: true });
    await waitState(p, 'dragging');
    await p.evaluate(() => (window.__frameMsgs.length = 0));
    await p.mouse.move(500, 300, { steps: 10 });
    await sleep(120);
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await waitState(p, 'pinned');
    const u = await ui(p);
    t.eq(u.label, '400 × 200', 'size');
    const msgs = await p.evaluate(() => window.__frameMsgs);
    t.eq(msgs.filter((m) => m !== 'fmove').length + msgs.filter((m) => m === 'fmove').length, 0, `frame saw events: ${msgs.slice(0, 5)}`);
  });

  test('page that preventDefault()s pointerdown claimed the interaction: no measurement (hand-off)', async (t) => {
    const p = await t.open('/tests/fixtures/prevent-pointerdown.html');
    await drag(p, [60, 60], [360, 260], { release: false, keepMod: true });
    const seen = await watchStates(p, 150);
    await p.mouse.up();
    await p.keyboard.up('Shift');
    t.ok(!seen.includes('dragging') && !seen.includes('pinned'), `states: ${seen}`);
    await sleep(100);
    t.ok(!(await ui(p)).shieldOn, 'shield off');
  });

  test('a prevented pointerdown on a different element does not affect a press elsewhere', async (t) => {
    const p = await t.open('/tests/fixtures/prevent-pointerdown.html');
    const u = await pin(p, [480, 60], [680, 260]);
    t.eq(u.label, '200 × 200');
  });

  test('page hover/move listeners see nothing during the drag; pointerup/mouseup still arrive', async (t) => {
    const p = await t.open(G);
    await drag(p, [60, 260], [100, 300], { release: false, keepMod: true });
    await waitState(p, 'dragging');
    await resetProbe(p);
    await p.mouse.move(400, 450, { steps: 15 });
    await p.mouse.move(200, 300, { steps: 10 });
    const hover = ['mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave'];
    const ev = await events(p);
    const leaked = ev.filter((e) => hover.includes(e.type));
    t.eq(leaked.length, 0, `hover/move events leaked to the page: ${[...new Set(leaked.map((e) => e.type))]}`);
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await waitState(p, 'pinned');
    t.ok((await count(p, 'pointerup')) >= 1, 'page saw pointerup');
    t.ok((await count(p, 'mouseup')) >= 1, 'page saw mouseup');
  });

  test('dragging across text creates no text selection', async (t) => {
    const p = await t.open(G);
    await pin(p, [30, 190], [430, 270]);
    const s = await p.evaluate(() => ({ text: getSelection().toString(), collapsed: getSelection().isCollapsed }));
    t.eq(s.text, '', 'selected text');
  });

  test('drag starting on a link/image does not start a native drag', async (t) => {
    const p = await t.open('/tests/fixtures/targets.html');
    await resetProbe(p);
    await pin(p, [80, 380], [300, 460]);
    t.eq(await count(p, 'dragstart'), 0, 'dragstart reached the page');
    t.eq(await p.evaluate(() => location.hash), '', 'navigated');
  });
});
