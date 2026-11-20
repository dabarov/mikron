import { describe, test } from '../lib/harness.mjs';
import { state, waitState, ui, arm, drag, pin, chips, chipsSettled, copyCenter, readClipboard, cursorStyleInfo, cursor, sleep, until, rect } from '../lib/mk.mjs';

const F = (n) => `/tests/fixtures/${n}.html`;

function rectEq(t, r, exp, msg, tol = 0.6) {
  for (const k of ['x', 'y', 'w', 'h']) t.near(r[k], exp[k], tol, `${msg} ${k} (got ${JSON.stringify(r)})`);
}
const tally = (list) => {
  const m = {};
  for (const c of [...list].sort((a, b) => (a.text < b.text ? -1 : 1))) m[c.text] = (m[c.text] || 0) + 1;
  return m;
};
function chipUnder(t, cs, box, text) {
  const c = cs.find((x) => x.text === text);
  t.ok(c, `chip "${text}" present (chips: ${JSON.stringify(cs.map((x) => x.text))})`);
  t.near(c.x + c.w / 2, box.x + box.w / 2, 1.5, `"${text}" centred under its element`);
  const gap = c.y - (box.y + box.h);
  t.ok((Math.abs(gap - 5) < 1.2 || Math.abs(gap - 8) < 1.2), `"${text}" sits 5/8 px under its element (gap ${gap})`);
  return c;
}

describe('environments', () => {
  test('modal <dialog>: overlay above it, Copy clickable, Esc dismisses without closing the dialog', async (t) => {
    const p = await t.open(F('dialog'));
    const u = await pin(p, [150, 50], [570, 300], { pause: 150 });
    t.eq(u.parent, 'DIALOG', 'host re-parented into the modal dialog');
    t.ok((await chipsSettled(p)).length > 3, 'chips rendered over the dialog');
    const [x, y] = await copyCenter(p);
    t.eq(await p.evaluate(([x, y]) => document.elementFromPoint(x, y)?.localName, [x, y]), 'mikron-root', 'Copy tab is the hit target');
    await p.mouse.click(x, y);
    await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copied', timeout: 800 });
    t.ok((await readClipboard(p)).startsWith('Mikron —'), 'spec copied');
    await p.keyboard.press('Escape');
    await waitState(p, 'idle');
    t.eq(await p.evaluate(() => [document.getElementById('dlg').open, window.__cancels]), [true, 0], 'dialog open, no cancel');
    await p.keyboard.press('Escape');
    await until(() => p.evaluate(() => !document.getElementById('dlg').open), { msg: 'second Esc closes the dialog' });
  });

  test('html{zoom:1.25}: marquee follows the pointer, chips show layout px under the element', async (t) => {
    const p = await t.open(F('zoom'));
    const u = await pin(p, [40, 40], [320, 200], { pause: 150 });
    rectEq(t, u.marquee, { x: 40, y: 40, w: 280, h: 160 }, 'marquee (screen px)');
    const cs = await chipsSettled(p);
    chipUnder(t, cs, await rect(p, '#z'), '200 × 100');
    // the Copy tab must be clickable where it is drawn
    const [x, y] = await copyCenter(p);
    await p.mouse.click(x, y);
    await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copied after clicking the drawn Copy tab', timeout: 800 });
    t.ok(/^.*200 × 100/m.test(await readClipboard(p)), 'spec lists 200 × 100');
  });

  test('page scrolled before the drag: chips line up with the content', async (t) => {
    const p = await t.open(F('gesture'));
    await p.evaluate(() => window.scrollTo(0, 1100));
    await sleep(50);
    await pin(p, [20, 70], [300, 260], { pause: 120 });
    chipUnder(t, await chipsSettled(p), await rect(p, '#far'), '200 × 100');
  });

  test('app shell (full-viewport scrolling div): pinned selection stays glued when the div scrolls', async (t) => {
    const p = await t.open(F('appshell'));
    const u = await pin(p, [40, 40], [340, 220], { pause: 150 });
    const before = await chipsSettled(p);
    await p.evaluate(() => (document.getElementById('shell').scrollTop = 100));
    await until(async () => Math.abs((await ui(p)).marquee.y - (u.marquee.y - 100)) < 0.6, { msg: 'marquee moved up 100 with the shell', timeout: 1000 }).catch(async (e) =>
      t.fail(`${e.message}; marquee ${JSON.stringify((await ui(p)).marquee)}`),
    );
    const after = await chipsSettled(p);
    const dimB = before.find((c) => c.text === '240 × 120');
    const dimA = after.find((c) => c.text === '240 × 120');
    t.ok(dimB && dimA, 'block chip before/after');
    t.near(dimA.y, dimB.y - 100, 1, 'block chip moved with the shell');
  });

  test('app shell: wheel-scrolling the shell mid-drag keeps the anchor glued', async (t) => {
    const p = await t.open(F('appshell'));
    await drag(p, [40, 240], [340, 400], { release: false, keepMod: true });
    await waitState(p, 'dragging');
    await p.mouse.wheel(0, 120);
    await until(() => p.evaluate(() => document.getElementById('shell').scrollTop === 120), { msg: 'shell scrolled' });
    await p.mouse.move(341, 401);
    await p.mouse.move(340, 400);
    await sleep(250);
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await waitState(p, 'pinned');
    rectEq(t, (await ui(p)).marquee, { x: 40, y: 120, w: 300, h: 280 }, 'marquee');
  });

  test('open shadow root content is measured', async (t) => {
    const p = await t.open(F('shadow'));
    await pin(p, [20, 20], [380, 240], { pause: 150 });
    const cs = await chipsSettled(p);
    const d = tally(cs.filter((c) => c.kind === 'dim'));
    t.eq(d['120 × 40'], 2, `two shadow buttons measured (${JSON.stringify(d)})`);
    t.eq(d['300 × 140'], 1, 'shadow box measured');
    const sp = cs.filter((c) => c.kind === 'space').map((c) => c.text);
    t.ok(sp.includes('20') && sp.includes('16'), `padding 20 + gap 16 chips (${sp})`);
  });

  test('position:fixed element on a scrolled page is measured where it is drawn', async (t) => {
    const p = await t.open(F('fixed'));
    await p.evaluate(() => window.scrollTo(0, 300));
    await sleep(50);
    await pin(p, [380, 180], [540, 300], { pause: 120 });
    chipUnder(t, await chipsSettled(p), await rect(p, '#fx'), '100 × 60');
  });

  test('position:fixed element stays correct after a rescan triggered by scrolling while pinned', async (t) => {
    const p = await t.open(F('fixed'));
    await pin(p, [380, 180], [540, 300], { pause: 120 });
    await chipsSettled(p);
    await p.evaluate(() => window.scrollTo(0, 20));
    await sleep(400);
    const cs = await chipsSettled(p);
    const fx = await rect(p, '#fx');
    const c = cs.find((x) => x.text === '100 × 60');
    t.ok(c, `fixed chip still revealed (chips ${JSON.stringify(cs.map((x) => [x.text, x.y]))})`);
    t.near(c.y, fx.y + fx.h + (c.y - (fx.y + fx.h) > 6 ? 8 : 5), 1.2, 'fixed chip glued to the fixed element');
  });

  test('RTL page: drag, chips and Copy tab placement work', async (t) => {
    const p = await t.open(F('rtl'));
    const card = await rect(p, '#card');
    const u = await pin(p, [card.x - 20, card.y - 12], [card.x + card.w + 20, card.y + card.h + 40], { pause: 150 });
    const cs = await chipsSettled(p);
    t.eq(tally(cs.filter((c) => c.kind === 'dim'))['60 × 40'], 3, 'three 60 × 40 chips');
    const c = (await ui(p)).copyRect;
    t.near(c.x + c.w, u.marquee.x + u.marquee.w, 0.6, 'Copy tab right-aligned');
  });

  test('prefers-reduced-motion: chips show final values immediately and the corner does not trail', async (t) => {
    const p = await t.open(F('gesture'), { reducedMotion: 'reduce' });
    await p.mouse.move(60, 260);
    await p.keyboard.down('Shift');
    await p.mouse.down();
    await p.mouse.move(68, 268);
    await waitState(p, 'dragging');
    await p.mouse.move(460, 460);
    const w = await p.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(document.querySelector('mikron-root').shadowRoot.querySelector('.mk-marquee').getBoundingClientRect().width)))),
    );
    t.near(w, 400, 0.6, 'marquee width right after a big jump');
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await waitState(p, 'pinned');
    await p.keyboard.press('Escape');
    await sleep(250);
    // count-up disabled
    await p.evaluate(() => {
      window.__zeros = 0;
      new MutationObserver((ms) => {
        for (const m of ms) {
          const n = m.type === 'characterData' ? m.target.parentElement : null;
          const all = [...(m.addedNodes || [])].filter((x) => x.nodeType === 1).concat(n ? [n] : []);
          for (const el of all) if (/^(0 × 0|0|r 0)$/.test(el.textContent)) window.__zeros++;
        }
      }).observe(document.querySelector('mikron-root').shadowRoot, { subtree: true, childList: true, characterData: true });
    });
    await pin(p, [20, 20], [460, 180]);
    await sleep(200);
    t.eq(await p.evaluate(() => window.__zeros), 0, 'chips that started from 0');
  });

  test('DPR 2: same chip set on the demo card, canvas backing store doubled', async (t) => {
    const p = await t.open('/demo/index.html');
    await p._mkCdp.send('Emulation.setDeviceMetricsOverride', { width: 718, height: 479, deviceScaleFactor: 2, mobile: false });
    await sleep(100);
    await pin(p, [90, 20], [630, 470], { pause: 150 });
    const d = tally((await chipsSettled(p)).filter((c) => c.kind === 'dim'));
    t.eq(d, { '3 × 40': 4, '40 × 40': 4, '480 × 391': 1, '97 × 32': 4 }, 'dimension chips');
    const cv = await p.evaluate(() => {
      const c = document.querySelector('mikron-root').shadowRoot.querySelector('.mk-bp-canvas');
      return [c.width, c.getBoundingClientRect().width];
    });
    t.eq(cv[0], cv[1] * 2, 'canvas.width = 2 × css width');
  });

  test('page with > 5 000 elements: no cursor override, gesture still works', async (t) => {
    const p = await t.open(F('many'));
    await arm(p, { at: [300, 300] });
    t.eq((await cursorStyleInfo(p)).length, 0, 'style[data-mikron] count');
    t.ok((await ui(p)).hintOn, 'hint still shown');
    await p.mouse.move(30, 30, { steps: 3 });
    await p.mouse.down();
    await p.mouse.move(260, 160, { steps: 6 });
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await waitState(p, 'pinned');
  });

  test('hostile page CSS (mikron-root{display:none!important}, :not(:defined)) cannot hide the overlay', async (t) => {
    const p = await t.open(F('hostile'));
    await pin(p, [20, 20], [300, 200], { pause: 120 });
    const cs = await p.evaluate(() => {
      const s = getComputedStyle(document.querySelector('mikron-root'));
      return { display: s.display, visibility: s.visibility, opacity: s.opacity, transform: s.transform };
    });
    t.eq(cs, { display: 'block', visibility: 'visible', opacity: '1', transform: 'none' }, 'host computed style');
    const [x, y] = await copyCenter(p);
    await p.mouse.click(x, y);
    await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copy works', timeout: 800 });
  });

  test('top frame only: no overlay host inside an iframe', async (t) => {
    const p = await t.open(F('iframe'));
    const f = p.frames().find((fr) => fr !== p.mainFrame());
    await p.mouse.move(400, 200);
    await p.keyboard.down('Shift');
    await sleep(300);
    await p.mouse.move(420, 220, { steps: 4 });
    await sleep(100);
    await p.keyboard.up('Shift');
    t.eq(await f.evaluate(() => document.querySelectorAll('mikron-root, style[data-mikron]').length), 0, 'mikron nodes inside the frame');
  });

  test('light.html: scanning the rotated note + fixed help button + shadow callout raises no errors', async (t) => {
    const p = await t.open('/demo/light.html');
    await p.evaluate(() => document.querySelector('.tilt').scrollIntoView({ block: 'center' }));
    await sleep(100);
    await pin(p, [5, 5], [712, 474], { pause: 150 });
    const cs = await chipsSettled(p);
    t.ok(cs.length > 5, `chips (${cs.length})`);
    await p.evaluate(() => window.scrollBy(0, 200));
    await sleep(300);
    t.eq(await state(p), 'pinned');
  });
});
