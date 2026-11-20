// First-run welcome page: the try-it card is measurable with the real overlay, the bundled font is used,
// links point where they should, and it holds up at 360 px.
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, EXT, sleep, until } from '../lib/harness.mjs';
import { state, waitState, ui, arm, pin, drag, readClipboard, writeClipboard, copyCenter, rect } from '../lib/mk.mjs';

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const G = '/tests/fixtures/gesture.html';

async function welcome(t, opts = {}) {
  const p = await t.open(t.ext.welcomeUrl, { raw: true, viewport: { width: 1000, height: 820 }, ...opts });
  await p.waitForFunction(() => globalThis.__MIKRON__ && globalThis.__MIKRON__.booted && document.querySelector('.key').textContent.trim().length > 0);
  await p.evaluate(() => document.getElementById('sample').scrollIntoView({ block: 'center' }));
  await sleep(150);
  return p;
}

/** Drag across the whole sample card, starting just outside its top-left corner. */
async function cardDrag(p, opts = {}) {
  const r = await rect(p, '#sample');
  return pin(p, [r.x - 14, r.y - 14], [r.x + r.w + 14, r.y + r.h + 14], { pause: 150, ...opts });
}

/** Platform fonts Chrome used to paint the text children of the element `expr` evaluates to. */
async function platformFonts(p, expr) {
  const cdp = await t_ctx(p).newCDPSession(p);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('DOM.getDocument', { depth: 0 });
    const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
    const { nodeId } = await cdp.send('DOM.requestNode', { objectId: result.objectId });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    return fonts.map((f) => ({ name: f.familyName, custom: f.isCustomFont, glyphs: f.glyphCount }));
  } finally {
    await cdp.detach().catch(() => {});
  }
}
const t_ctx = (p) => p.context();

describe('welcome page', () => {
  test('loads the same scripts as the manifest content script, in the same order, and nothing external', async (t) => {
    const p = await welcome(t);
    const srcs = await p.evaluate(() => [...document.scripts].map((s) => new URL(s.src).pathname.replace(/^\//, '')));
    const idx = srcs.indexOf(manifest.content_scripts[0].js[0]);
    t.eq(srcs.slice(idx, idx + manifest.content_scripts[0].js.length), manifest.content_scripts[0].js, 'content script files, in order');
    const external = await p.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((n) => !n.startsWith(location.origin)));
    t.eq(external, [], 'no external resources');
    t.eq(await p.evaluate(() => document.querySelectorAll('[style*="http"], link[href^="http"], img[src^="http"]').length), 0, 'no remote assets in markup');
  });

  test('try-it card: arm, drag, pin, Copy, dismiss all work, and the spec describes the card', async (t) => {
    const p = await welcome(t);
    const reader = await t.open(G);
    await writeClipboard(reader, 'sentinel');
    await p.bringToFront();
    const r = await rect(p, '#sample');
    await arm(p, { at: [r.x - 60, r.y - 30] });
    t.ok((await ui(p)).hintOn, 'hint pill while armed');
    await p.keyboard.up('Shift');
    await waitState(p, 'idle');
    const u = await cardDrag(p);
    t.eq(await state(p), 'pinned', 'pinned');
    t.ok(u.copyShown, 'Copy tab shown');
    t.ok(/^\d+ × \d+$/.test(u.label), `size label ${u.label}`);
    const [x, y] = await copyCenter(p);
    await p.mouse.click(x, y);
    await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copied', timeout: 1500 });
    await reader.bringToFront();
    const spec = await readClipboard(reader);
    t.ok(spec.startsWith('Mikron — '), `spec header: ${spec.split('\n')[0]}`);
    t.ok(/article#sample\.sample — \d+ × \d+/.test(spec) || /#sample/.test(spec), 'spec names the card');
    t.ok(/"Studio plan"/.test(spec) && /"Start trial"/.test(spec), 'spec holds the card text');
    t.ok(/radius 20/.test(spec) && /97 × 32/.test(spec), 'radius and button size measured');
    await p.bringToFront();
    await p.keyboard.press('Escape');
    await waitState(p, 'idle');
    t.eq(await p.evaluate(() => document.querySelectorAll('mikron-root').length), 1, 'one overlay host');
  });

  test('try-it card: clicking outside dismisses, and a second selection can be pinned', async (t) => {
    const p = await welcome(t);
    await cardDrag(p);
    await p.mouse.click(8, 8);
    await waitState(p, 'idle');
    await cardDrag(p);
    t.eq(await state(p), 'pinned', 'second selection');
    await p.keyboard.press('Escape');
    await waitState(p, 'idle');
  });

  test('the bundled font paints the page numerals and the overlay chips', async (t) => {
    const p = await welcome(t);
    t.eq(await p.evaluate(() => document.fonts.check('700 12px "Mikron Mono"')), true, 'face available');
    const num = await platformFonts(p, "document.querySelector('.num')");
    t.ok(num.length && num.every((f) => f.custom && /Geist Mono/i.test(f.name)), `step numeral font: ${JSON.stringify(num)}`);
    await cardDrag(p);
    await sleep(500);
    const chip = await platformFonts(p, "document.querySelector('mikron-root').shadowRoot.querySelector('.mk-size-label')");
    t.ok(chip.length && chip.every((f) => f.custom && /Geist Mono/i.test(f.name)), `size label font: ${JSON.stringify(chip)}`);
    const chips = await p.evaluate(() => [...document.querySelector('mikron-root').shadowRoot.querySelectorAll('.mk-chip')].map((c) => getComputedStyle(c).fontFamily));
    t.ok(chips.length > 3 && chips.every((f) => /^"?Mikron Mono"?,/.test(f)), `chips use the bundled face: ${chips.slice(0, 2)}`);
  });

  test('links: GitHub, Report a problem, Say thanks have the right hrefs and open safely', async (t) => {
    const p = await welcome(t);
    const l = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.foot a')].map((a) => [a.textContent.trim(), [a.href, a.target, a.rel]])));
    t.eq(l['GitHub'], ['https://github.com/dabarov/mikron', '_blank', 'noopener noreferrer'], 'GitHub');
    t.eq(l['Report a problem'], ['https://github.com/dabarov/mikron/issues', '_blank', 'noopener noreferrer'], 'issues');
    t.eq(l['Say thanks'], ['https://ko-fi.com/dabarov', '_blank', 'noopener noreferrer'], 'Ko-fi');
    t.eq(await p.evaluate(() => !!document.querySelector('.foot a[data-link=donate] svg')), true, 'inline SVG heart');
    t.eq(await p.evaluate(() => document.querySelectorAll('audio, video, embed, iframe, object').length), 0, 'no media or embeds');
  });

  test('copy: nothing in the page asks for attention (no dialogs, no autoplay, no timers that open things)', async (t) => {
    const before = t.env.ctx.pages().length;
    const p = await welcome(t);
    await sleep(1500);
    t.eq(t.env.ctx.pages().length, before + 1, 'no extra tabs');
    t.eq(await p.evaluate(() => document.querySelectorAll('dialog[open], [role=alertdialog]').length), 0, 'no dialogs');
  });

  test('keyboard: every link and the sample button are reachable with Tab, with a visible focus ring', async (t) => {
    const p = await welcome(t);
    await p.evaluate(() => { window.scrollTo(0, 0); document.activeElement && document.activeElement.blur(); });
    const seen = [];
    for (let i = 0; i < 8; i++) {
      await p.keyboard.press('Tab');
      seen.push(await p.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return null;
        const cs = getComputedStyle(a);
        return { text: a.textContent.trim(), ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 };
      }));
    }
    const texts = seen.filter(Boolean).map((s) => s.text);
    for (const w of ['Start trial', 'GitHub', 'Report a problem', 'Say thanks']) t.ok(texts.includes(w), `Tab reaches "${w}" (got ${texts})`);
    t.ok(seen.filter(Boolean).every((s) => s.ring), 'focus ring on each stop');
  });

  test('reduced motion: no entrance animation', async (t) => {
    const p = await welcome(t, { reducedMotion: 'reduce' });
    t.eq(await p.evaluate(() => [...document.querySelectorAll('.hero, .steps, .try')].map((e) => getComputedStyle(e).animationName)), ['none', 'none', 'none'], 'animation names');
  });

  test('keycaps follow the chosen modifier; a switched-off Mikron shows a note', async (t) => {
    await t.settings({ modifier: 'alt' });
    const p = await welcome(t);
    t.eq(await p.evaluate(() => [...document.querySelectorAll('[data-mod]')].map((e) => e.textContent)), ['⌥ Alt', '⌥ Alt', '⌥ Alt'], 'keycaps');
    t.eq(await p.evaluate(() => document.getElementById('off').hidden), true, 'no note while on');
    await t.settings({ modifier: 'alt', enabled: false }, { wait: 0 });
    await p.waitForFunction(() => !document.getElementById('off').hidden);
    await t.settings({}, { wait: 0 });
    await p.waitForFunction(() => document.getElementById('off').hidden);
  });

  describe('at 360 px', () => {
    test('no horizontal scroll, steps stack, card fits, and the card still measures', async (t) => {
      const p = await welcome(t, { viewport: { width: 360, height: 740 } });
      const m = await p.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        cols: new Set([...document.querySelectorAll('.step')].map((e) => Math.round(e.getBoundingClientRect().left))).size,
        card: document.getElementById('sample').getBoundingClientRect().toJSON(),
      }));
      t.ok(m.sw <= m.cw, `scrollWidth ${m.sw} <= ${m.cw}`);
      t.eq(m.cols, 1, 'steps in one column');
      t.ok(m.card.x >= 0 && m.card.x + m.card.width <= 360, `card inside the viewport: ${JSON.stringify(m.card)}`);
      const u = await cardDrag(p);
      t.eq(await state(p), 'pinned', 'pinned at 360 px');
      t.ok(u.copyShown, 'Copy tab shown');
      await p.keyboard.press('Escape');
      await waitState(p, 'idle');
    });
  });
});
