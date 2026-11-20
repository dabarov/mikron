#!/usr/bin/env node
/**
 * make-store-assets.mjs — regenerates the Chrome Web Store and repository artwork in store/assets/
 * from the REAL extension running in Playwright's Chromium.
 *
 *   node tools/make-store-assets.mjs                       # everything
 *   node tools/make-store-assets.mjs --only shots,promo,icon,gif  # a subset
 *   node tools/make-store-assets.mjs --shots 1,4             # only some screenshots (with --only shots)
 *   node tools/make-store-assets.mjs --work /some/dir         # keep intermediates there
 *
 * Requirements: the repo's Playwright with its Chromium (`npx playwright install chromium`), python3 with
 * Pillow (final downsampling, PNG checks), ffmpeg (hero.mp4 and hero.gif). No other dependencies.
 *
 * Output (store/assets/):
 *   screenshot-1.png … screenshot-5.png   1280×800, 24-bit RGB PNG, no alpha
 *   promo-small-440x280.png, promo-marquee-1400x560.png, social-preview-1280x640.png,
 *   youtube-thumbnail-1280x720.png        24-bit RGB PNG, no alpha
 *   store-icon-128.png                    128×128 RGBA PNG: the icon artwork at 96×96, 16 px transparent margin
 *   hero.gif (README), hero.mp4 (same clip; *.mp4 is git-ignored)
 *
 * How it works
 *  - The repo is served over node:http (content scripts do not run on file://). Chromium maps the fictional
 *    host app.example.com to that server (--host-resolver-rules), so the copied spec, the popup and anything
 *    else that prints the page address shows a placeholder domain, never a local address or path.
 *  - Captures run headless with the unpacked extension and --force-device-scale-factor = 2 × the final
 *    scale, so every capture is twice the pixel density it ends up at. The gesture is real input
 *    (Shift held, pointer moved, button pressed) and each still is taken after the chips' 450 ms count-up.
 *  - Screenshots are composed by store/src/shot.html (caption band, captures, cursor, spec and popup panels)
 *    rendered at device scale 2, then downsampled 2× with Lanczos by Pillow to the exact store size.
 *    Promo tiles are store/src/promo.html?v=<variant>, also rendered at 2× and downsampled.
 *  - The hero clip is recorded with CDP Page.startScreencast (every compositor frame, with timestamps) and a
 *    main-world rAF logger for pointer position and CSS cursor, as in tools/record-demo.mjs; a constant-rate
 *    timeline is rebuilt from the timestamps, a cursor sprite is composited, and ffmpeg makes the MP4 and a
 *    two-pass palette GIF. Held/dropped-frame statistics are printed; the GIF is re-shot when they are bad.
 *  - Intermediates go to a temp dir (default os.tmpdir()/mikron-assets-XXXX, deleted at the end unless --work).
 *  - Source layouts: store/src/shot.html (screenshot frame), store/src/promo.html (tiles), and the fictional
 *    pages in store/src/pages/ (served as app.example.com/settings/connectors, /features, /team); the hero
 *    clip and /connectors use demo/index.html. Every shot is a SHOT[n] function below; framing lives there.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'store', 'assets');
const { chromium } = createRequire(ROOT + '/')('playwright');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const WORK = path.resolve(opt('--work', '') || fs.mkdtempSync(path.join(os.tmpdir(), 'mikron-assets-')));
const KEEP = argv.includes('--work');
const ONLY = opt('--only', 'shots,promo,icon,gif').split(',');
const SHOTS = opt('--shots', '1,2,3,4,5').split(',').map(Number);
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const HOST = 'app.example.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[store-assets]', ...a);

// ---------------------------------------------------------------------------------------------
// Static server: the repo, the work dir under /__work/, and pretty paths for the fictional site.
// ---------------------------------------------------------------------------------------------
const ROUTES = {
  '/settings/connectors': 'store/src/pages/connectors.html',
  '/connectors': 'demo/index.html',
  '/features': 'store/src/pages/features.html',
  '/team': 'store/src/pages/team.html',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let u = decodeURIComponent(req.url.split('?')[0]);
      let p;
      if (u.startsWith('/__work/')) p = path.join(WORK, u.slice(8));
      else p = path.join(ROOT, ROUTES[u] || u);
      if (!p.startsWith(ROOT) && !p.startsWith(WORK)) { res.writeHead(403); res.end(); return; }
      fs.readFile(p, (e, d) => {
        if (e) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(d);
      });
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}
let PORT, BASE;            // BASE: the fictional site; LOCAL: the same server by IP (composition pages)
const LOCAL = () => `http://127.0.0.1:${PORT}`;
const base = () => BASE;

// ---------------------------------------------------------------------------------------------
// Browser with the extension (recipe from tools/record-demo.mjs)
// ---------------------------------------------------------------------------------------------
async function launch(vw, vh, dsf, { reducedMotion } = {}) {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, `profile-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`), {
    channel: 'chromium', headless: true, viewport: null, reducedMotion,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--force-device-scale-factor=${dsf}`,
      `--window-size=${vw},${vh + 87}`, '--hide-scrollbars', `--host-resolver-rules=MAP ${HOST}:80 127.0.0.1:${PORT}`,
      // a secure context for the fictional origin, so the copied spec can be read back from the clipboard
      `--unsafely-treat-insecure-origin-as-secure=http://${HOST}`],
  });
  // fresh profile = fresh install: the extension opens its welcome tab; close it and keep our page in front
  const t0 = Date.now();
  while (Date.now() - t0 < 4000 && !ctx.pages().some((p) => p.url().includes('/welcome/welcome.html'))) await sleep(50);
  await sleep(100);
  for (const p of ctx.pages()) if (p.url().includes('/welcome/welcome.html')) await p.close();
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.bringToFront();
  const cdp = await ctx.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  for (let k = 0; k < 4; k++) {
    await page.goto('about:blank');
    const [iw, ih] = await page.evaluate(() => [innerWidth, innerHeight]);
    if (iw === vw && ih === vh) break;
    const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: bounds.width + vw - iw, height: bounds.height + vh - ih } });
    await sleep(100);
  }
  const [iw, ih, dpr] = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
  if (iw !== vw || ih !== vh || Math.abs(dpr - dsf) > 1e-6) throw new Error(`viewport ${iw}×${ih}@${dpr}, wanted ${vw}×${vh}@${dsf}`);
  const sw = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) || (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  return { ctx, page, cdp, extId };
}

async function rectOf(page, sel) {
  return page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, sel);
}
async function overlay(page) {
  return page.evaluate(() => {
    const h = document.querySelector('mikron-root'); const R = h && h.shadowRoot; if (!R) return null;
    const r = (s) => { const e = R.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, text: e.textContent.trim() }; };
    return { state: h.dataset.state, copy: r('.mk-copy'), marquee: r('.mk-marquee'), label: r('.mk-size-label') };
  });
}
async function waitState(page, want, ms = 2000) {
  const t0 = Date.now();
  for (;;) {
    const s = await page.evaluate(() => document.querySelector('mikron-root')?.dataset.state);
    if (s === want) return;
    if (Date.now() - t0 > ms) throw new Error(`overlay state ${s}, wanted ${want}`);
    await sleep(25);
  }
}
/** Hold Shift and move ≥ 4 px after 250 ms so Mikron arms (crosshair + hint), ending at [x, y]. */
async function arm(page, [x, y]) {
  await page.mouse.move(x - 24, y - 18);
  await sleep(120);
  await page.keyboard.down('Shift');
  await sleep(320);
  for (let i = 1; i <= 8; i++) { await page.mouse.move(x - 24 + 3 * i, y - 18 + 2.25 * i); await sleep(24); }
  await waitState(page, 'armed');
}
/** Press at the current point and drag to [x, y] with eased steps; waits for the chips to settle. */
async function drag(page, from, to, { steps = 36, settle = 1100 } = {}) {
  await page.mouse.move(...from); await sleep(60);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const k = i / steps, e = 1 - Math.pow(1 - k, 3);
    await page.mouse.move(from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e);
    await sleep(16);
  }
  await page.mouse.move(...to);
  await waitState(page, 'dragging');
  await sleep(settle);
}
async function release(page) {
  await page.mouse.up(); await sleep(40); await page.keyboard.up('Shift');
  await waitState(page, 'pinned'); await sleep(700);
}
async function shoot(page, name) {
  const file = path.join(WORK, name + '.png');
  await page.screenshot({ path: file, ...(page.__clip ? { clip: page.__clip } : {}) });
  return file;
}

// ---------------------------------------------------------------------------------------------
// Python helpers (Pillow): downsample to an exact size, flatten to RGB, write a plain PNG.
// ---------------------------------------------------------------------------------------------
function py(code, ...args) {
  const r = spawnSync('python3', ['-c', code, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('python failed: ' + r.stderr);
  return r.stdout.trim();
}
const PY_FINAL = String.raw`
import sys
from PIL import Image, PngImagePlugin
src, dst, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
im = Image.open(src)
if im.mode != 'RGB':
    bg = Image.new('RGB', im.size, (0, 0, 0)); bg.paste(im.convert('RGBA'), mask=im.convert('RGBA').split()[3]); im = bg
if im.size != (w, h): im = im.resize((w, h), Image.LANCZOS)
info = PngImagePlugin.PngInfo(); info.add(b'sRGB', b'\x00')   # explicit sRGB, no other metadata
im.save(dst, 'PNG', optimize=True, pnginfo=info)
out = Image.open(dst); print(out.size, out.mode)
`;
function finalize(src, dst, w, h) { return py(PY_FINAL, src, dst, String(w), String(h)); }

/** Render a composition page at device scale 2 and downsample to w×h. */
async function renderComposite(browser, url, w, h, data, dst) {
  const pg = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await pg.goto(url);
  if (data) await pg.evaluate((d) => window.render(d), data);
  else await pg.waitForFunction(() => document.body.dataset.ready === '1');
  await pg.evaluate(() => document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {})))));
  await sleep(150);
  const tmp = path.join(WORK, path.basename(dst, '.png') + '@2x.png');
  await pg.screenshot({ path: tmp });
  await pg.close();
  log(path.basename(dst), finalize(tmp, dst, w, h));
}

// ---------------------------------------------------------------------------------------------
// Screenshots. Composite coordinates: 1280×800, caption band 72 px, stage 1280×728 below it.
// A capture at final scale s (final px per CSS px) is shot at device scale 2·s and placed 1:1 in the
// 2× composite, so the only resampling is the final 2× Lanczos downsample.
// ---------------------------------------------------------------------------------------------
const BAND = 72, STAGE_H = 800 - BAND;
const CAPTIONS = {
  1: 'Hold Shift and drag: the page turns into a blueprint',
  2: 'Up close: padding, gaps, sizes and corner radii',
  3: 'Card grids on light pages, measured in place',
  4: 'Release to pin, then copy the spec as text',
  5: 'Settings: modifier key, hint, 4 px snap, copy format',
};

/** Open `url` in a fresh extension browser at vw×vh CSS (device scale 2·s), run `act`, return its result. */
async function withPage(url, vw, vh, s, act, opts) {
  // Chromium windows are at least 500 px wide: a narrower capture is the centre `vw` of a 500 px viewport
  const W = Math.max(vw, 500), ox = (W - vw) / 2;
  const { ctx, page, extId } = await launch(W, vh, 2 * s, opts);
  page.__clip = ox ? { x: ox, y: 0, width: vw, height: vh } : null; page.__ox = ox;
  try {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://${HOST}` });
    await page.goto(url); await page.evaluate(() => document.fonts.ready); await sleep(700);
    return await act(page, { ctx, extId, ox });
  } finally { await ctx.close(); }
}
const img = (file, x, y, w, h) => ({ type: 'img', src: `${LOCAL()}/__work/${path.basename(file)}`, x, y, w, h });

const SHOT = {};

// 1 — hero: the whole dark card as a blueprint, mid-drag, crosshair at the corner, size label below.
SHOT[1] = async () => {
  const s = Number(opt('--s1', '1.8')), vw = Math.ceil(1280 / s - 1e-9), vh = Math.ceil(STAGE_H / s - 1e-9);
  const rows = opt('--rows1', '3');
  return withPage(`${base()}/settings/connectors?rows=${rows}&dx=${opt('--dx1', '-14')}`, vw, vh, s, async (page) => {
    const c = await rectOf(page, '#card');
    const q = opt('--sel1', '');
    // from inside the card (left of it stays the real UI) to past its bottom-right corner
    const R = q ? q.split(',').map(Number) : [204, -24, c.w + 28, c.h + 30];
    const from = [c.x + R[0], c.y + R[1]], to = [c.x + R[2], c.y + R[3]];
    await arm(page, from);
    await drag(page, from, to);
    const file = await shoot(page, 'shot1');
    const ov = await overlay(page);
    await release(page);
    log('shot1', JSON.stringify({ c, ov }));
    return { n: 1, caption: CAPTIONS[1], layers: [img(file, 0, 0, vw * s, vh * s), { type: 'cursor', kind: 'cross', x: to[0] * s, y: to[1] * s, s }] };
  });
};

const fit = (s) => [Math.ceil(1280 / s - 1e-9), Math.ceil(STAGE_H / s - 1e-9)];

// 2 — one component up close (2.5×): padding bands, gap bands, W × H chips, radius callouts.
SHOT[2] = async () => {
  const s = 2.25, [vw, vh] = fit(s);
  return withPage(`${base()}/team`, vw, vh, s, async (page) => {
    // centre the callout in the frame (the panel moves; nothing inside it changes)
    let b = await rectOf(page, '#callout');
    await page.evaluate(([dx, dy]) => { const p = document.getElementById('panel'); p.style.position = 'relative'; p.style.left = dx + 'px'; p.style.top = dy + 'px'; },
      [Math.round(vw / 2 - (b.x + b.w / 2)), Math.round(vh * 0.5 - 14 - (b.y + b.h / 2))]);
    await sleep(100); b = await rectOf(page, '#callout');
    // 48 px to the sides leaves room for the panel's own padding chips; above/below stays clear of the text
    const from = [b.x - 48, b.y - 24], to = [b.x + b.w + 48, b.y + b.h + 36];
    await arm(page, from); await drag(page, from, to);
    const file = await shoot(page, 'shot2');
    log('shot2', JSON.stringify({ b, ov: await overlay(page) }));
    await release(page);
    return { n: 2, caption: CAPTIONS[2], layers: [img(file, 0, 0, vw * s, vh * s), { type: 'cursor', kind: 'cross', x: (to[0] - page.__ox) * s, y: to[1] * s, s: 2 }] };
  });
};

// 3 — a light page: the three-card grid measured in place, pinned (Copy tab), arrow at the release point.
SHOT[3] = async () => {
  const s = 1.8, [vw, vh] = fit(s);
  return withPage(`${base()}/features`, vw, vh, s, async (page) => {
    let g = await rectOf(page, '.grid');
    await page.evaluate((y) => scrollTo(0, y), Math.round(g.y - 104)); await sleep(200);
    g = await rectOf(page, '.grid');
    const from = [g.x - 28, g.y - 28], to = [g.x + g.w + 28, g.y + g.h + 32];
    await arm(page, from); await drag(page, from, to); await release(page);
    await page.mouse.move(vw - 2, vh - 2); await sleep(300);          // pointer out of the way
    const file = await shoot(page, 'shot3');
    log('shot3', JSON.stringify({ g, ov: await overlay(page) }));
    return { n: 3, caption: CAPTIONS[3], layers: [img(file, 0, 0, vw * s, vh * s)] };
  });
};

// 4 — pinned row, Copy clicked ("Copied", pointing hand), and the exact clipboard text in a panel below.
SHOT[4] = async () => {
  const s = 1.8, [vw, vh] = fit(s);
  return withPage(`${base()}/settings/connectors?rows=1&pad=10`, vw, vh, s, async (page) => {
    const r = await rectOf(page, '.row'), c = await rectOf(page, '#card');
    const from = [c.x - 16, r.y], to = [c.x + c.w + 16, r.y + r.h];   // exactly the row's height (72, a 4 px step)
    await arm(page, from); await drag(page, from, to); await release(page);
    const { text, at } = await copyViaTab(page);
    await sleep(120);
    const file = await shoot(page, 'shot4');
    fs.writeFileSync(path.join(WORK, 'spec4.txt'), text);
    log('shot4 spec\n' + text);
    const lines = text.split('\n').length;
    const lh = 24, ph = 46 + 28 + lines * lh, py0 = STAGE_H - 24 - ph;
    return { n: 4, caption: CAPTIONS[4], layers: [img(file, 0, 0, vw * s, vh * s), { type: 'cursor', kind: 'hand', x: at[0] * s, y: at[1] * s, s },
      { type: 'spec', title: 'Clipboard', sub: '· plain text, exactly as copied', text, x: 40, y: py0, w: 1200, h: ph, font: 17.5, lh }] };
  });
};

// 5 — the real popup (reduced-motion state of its illustration) over a page with a pinned selection.
SHOT[5] = async () => {
  const s = 1.6, [vw, vh] = fit(s);
  const pageLayer = await withPage(`${base()}/features?lm=60`, vw, vh, s, async (page) => {
    let g = await rectOf(page, '.grid');
    await page.evaluate((y) => scrollTo(0, y), Math.round(g.y - 140)); await sleep(200);
    const c = await rectOf(page, '.card');
    const from = [c.x - 28, c.y - 28], to = [c.x + c.w + 28, c.y + c.h + 32];
    await arm(page, from); await drag(page, from, to); await release(page);
    await page.mouse.move(vw - 4, 4); await sleep(300);
    return img(await shoot(page, 'shot5-page'), 0, 0, vw * s, vh * s);
  });
  // the popup is shown down to the end of its settings group (Copy format); the rest runs off the bottom edge
  const POP_TOP = 16;
  const need = await withPage('about:blank', 500, 700, 1, async (page, { extId }) => {
    await page.goto(`chrome-extension://${extId}/popup/popup.html?host=${HOST}`); await sleep(400);
    return page.evaluate(() => document.getElementById('copyFormat').closest('.group').getBoundingClientRect().bottom);
  }, { reducedMotion: 'reduce' });
  // scale so the bottom edge of the frame falls in the gap between the settings group and the key legend
  const ps = Math.round(((STAGE_H - POP_TOP - 6) / need + (STAGE_H - POP_TOP) / (need + 16)) / 2 * 100) / 100;
  const pop = await withPage('about:blank', 500, 700, ps, async (page, { extId }) => {
    await page.goto(`chrome-extension://${extId}/popup/popup.html?host=${HOST}`);
    await page.evaluate(() => document.fonts.ready); await sleep(600);
    const [h, need] = await page.evaluate(() => [Math.ceil(document.getElementById('pop').getBoundingClientRect().height),
      Math.ceil(document.getElementById('copyFormat').closest('.group').getBoundingClientRect().bottom)]);
    log('popup height', h, 'settings end', need, 'visible', (STAGE_H - POP_TOP) / ps);
    const file = path.join(WORK, 'shot5-popup.png');
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 300, height: h } });
    return { file, h };
  }, { reducedMotion: 'reduce' });
  const pw = 300 * ps, ph = pop.h * ps;
  return { n: 5, caption: CAPTIONS[5], layers: [pageLayer, { type: 'popup', src: `${LOCAL()}/__work/${path.basename(pop.file)}`, x: 1280 - 40 - pw, y: POP_TOP, w: pw, h: ph }] };
};

/** Click the Copy tab like a user and read back what landed on the clipboard. */
async function copyViaTab(page) {
  const ov = await overlay(page);
  const c = [ov.copy.x + ov.copy.w * 0.62, ov.copy.y + ov.copy.h * 0.5];
  await page.mouse.move(c[0] - 30, c[1] + 20); await sleep(80);
  await page.mouse.move(...c); await sleep(160);
  await page.mouse.down(); await sleep(90); await page.mouse.up();
  const t0 = Date.now();
  while (!/Copied/.test((await overlay(page)).copy.text)) { if (Date.now() - t0 > 1500) throw new Error('no Copied state'); await sleep(20); }
  const text = await page.evaluate(() => navigator.clipboard.readText());
  return { text, at: c };
}

async function composeShots(list) {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    for (const [n, d] of list) await renderComposite(browser, `${LOCAL()}/store/src/shot.html`, 1280, 800, d, path.join(OUT, `screenshot-${n}.png`));
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------------------------------------
// Promo tiles, GitHub social preview, YouTube thumbnail: store/src/promo.html?v=…
// ---------------------------------------------------------------------------------------------
const PROMOS = [
  ['small', 440, 280, 'promo-small-440x280.png'],
  ['marquee', 1400, 560, 'promo-marquee-1400x560.png'],
  ['social', 1280, 640, 'social-preview-1280x640.png'],
  ['youtube', 1280, 720, 'youtube-thumbnail-1280x720.png'],
];
async function makePromos() {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    for (const [v, w, h, name] of PROMOS) await renderComposite(browser, `${LOCAL()}/store/src/promo.html?v=${v}`, w, h, null, path.join(OUT, name));
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------------------------------------
// Hero clip (README): the real gesture on the dark demo card, recorded frame-accurately.
// Same method as tools/record-demo.mjs: CDP screencast with capture timestamps, a main-world rAF logger
// for pointer + CSS cursor, a corner colour flash to align the two clocks, a constant 60 fps timeline,
// and a composited cursor. Loop: idle → arm → drag (chips count up) → release (Copy tab) → Copy →
// dismiss → pointer back where it started, so the last frame flows into the first.
// ---------------------------------------------------------------------------------------------
const GIF = { vw: 640, vh: 560, dsf: 2, fps: 60, gifFps: 25, gifW: 880, dur: 9.0 };

function pchip(ts, vs) {
  const n = ts.length, h = [], d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { h[i] = ts[i + 1] - ts[i]; d[i] = (vs[i + 1] - vs[i]) / h[i]; }
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] === 0 || d[i] === 0 || Math.sign(d[i - 1]) !== Math.sign(d[i])) m[i] = 0;
    else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
  }
  return (t) => {
    if (t <= ts[0]) return vs[0];
    if (t >= ts[n - 1]) return vs[n - 1];
    let i = 0; while (t > ts[i + 1]) i++;
    const s = (t - ts[i]) / h[i], s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * vs[i] + (s3 - 2 * s2 + s) * h[i] * m[i] + (-2 * s3 + 3 * s2) * vs[i + 1] + (s3 - s2) * h[i] * m[i + 1];
  };
}

const LOGGER = `(() => {
  const P = { x: -1, y: -1, t: 0 };
  const onp = (e) => { if (e.timeStamp >= P.t) { P.x = e.clientX; P.y = e.clientY; P.t = e.timeStamp; } };
  for (const ty of ['pointermove', 'pointerdown', 'pointerup', 'pointerrawupdate', 'mousemove', 'mousedown', 'mouseup'])
    window.addEventListener(ty, onp, { capture: true, passive: true });
  window.__mkLog = []; window.__mkOn = false;
  const deep = (x, y) => { let el = document.elementFromPoint(x, y);
    for (let k = 0; el && el.shadowRoot && k < 5; k++) { const e2 = el.shadowRoot.elementFromPoint(x, y); if (!e2 || e2 === el) break; el = e2; } return el; };
  function frame(ts) {
    if (window.__mkOn) {
      const h = document.querySelector('mikron-root'); const R = h && h.shadowRoot;
      let cur = 'auto';
      if (P.x >= 0) {
        const el = deep(P.x, P.y); if (el) cur = getComputedStyle(el).cursor;
        const mq0 = R && h.dataset.state === 'pinned' && R.querySelector('.mk-marquee');
        if (mq0 && !(el && el.closest && el.closest('.mk-copy'))) {
          const b = mq0.getBoundingClientRect();
          if (P.x >= b.left && P.x <= b.right && P.y >= b.top && P.y <= b.bottom) cur = 'default';
        }
      }
      const mq = R && R.querySelector('.mk-marquee'); const mr = mq ? mq.getBoundingClientRect() : null;
      window.__mkLog.push([performance.timeOrigin + ts, P.x, P.y, cur, h ? h.dataset.state : '-',
        mr ? [mr.x, mr.y, mr.width, mr.height].map((v) => Math.round(v * 100) / 100).join(',') : '']);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();`;

const GIF_PY = String.raw`
import json, sys, subprocess, statistics as st
from PIL import Image
M = json.load(open(sys.argv[1]))
FPS = M['fps']; FP = 1000.0 / 60.0; W, H = M['w'], M['h']
sc = M['scene']; fr = sc['frames']; raf = sc['raf']
# clock alignment from the corner flashes
d = int(round(5 * sc['dsf'])); cols = []
for i, ts in fr:
    if not any(abs(ts - c[0]) < 300 for c in sc['calib']): continue
    px = Image.open('%s/%05d.png' % (sc['dir'], i)).convert('RGB').getpixel((d, d))
    cols.append((ts, 'r' if px[0] > 200 and px[2] < 80 else 'b' if px[2] > 200 and px[0] < 80 else '-'))
offs = []
for t, c in sc['calib']:
    prev = None
    for ts, cc in cols:
        if ts < t - 5: prev = cc; continue
        if cc == c and prev != c: offs.append(ts - t); break
        prev = cc
off = st.median(offs)
t0 = sc['t0'] + off
near = min(fr, key=lambda f: abs(f[1] - t0)); ph = (near[1] - t0) % FP
t0a = t0 + (ph - FP if ph > FP / 2 else ph)
n = int(round(sc['end'] * FPS))
plan = []; fi = 0; ri = 0
def kind(c): return 'cross' if c == 'crosshair' else 'hand' if c == 'pointer' else 'arrow'
for j in range(n):
    T = t0a + j * 1000.0 / FPS
    while fi + 1 < len(fr) and fr[fi + 1][1] <= T + 4: fi += 1
    Tr = T - off
    while ri + 1 < len(raf) and abs(raf[ri + 1][0] - Tr) <= abs(raf[ri][0] - Tr): ri += 1
    r = raf[ri]; rn = raf[min(ri + 1, len(raf) - 1)]
    plan.append((fr[fi][0], r[1], r[2], kind(r[3]), r[4], rn[5]))
held_drag = sum(1 for a, b in zip(plan, plan[1:]) if a[0] == b[0] and b[4] in ('armed', 'dragging') and (abs(a[1] - b[1]) > 0.3 or abs(a[2] - b[2]) > 0.3))
held_rect = sum(1 for a, b in zip(plan, plan[1:]) if a[0] == b[0] and b[4] == 'dragging' and a[5] != b[5])
win = [f for f in fr if t0a - 1 <= f[1] <= t0a + sc['end'] * 1000 + 1]
dts = [b[1] - a[1] for a, b in zip(win, win[1:])]
stats = dict(calib_offsets_ms=[round(o, 2) for o in offs], capture_frames=len(win), dt_max_ms=round(max(dts), 2),
             gaps_hist={str(k): [round(x / FP) for x in dts].count(k) for k in sorted(set(round(x / FP) for x in dts))},
             held_while_dragging_pointer_moving=held_drag, held_while_marquee_changed=held_rect, output_frames=len(plan))
sprites = {k: (Image.open(v['png']).convert('RGBA'), v['hx'], v['hy']) for k, v in M['sprites'].items()}
def render(p):
    im = Image.open('%s/%05d.png' % (sc['dir'], p[0])).convert('RGB')
    if im.size != (W, H): im = im.crop((0, 0, W, H))
    if p[1] >= 0:
        spr, hx, hy = sprites[p[3]]
        im.paste(spr, (int(round(p[1] * sc['dsf'] - hx)), int(round(p[2] * sc['dsf'] - hy))), spr)
    return im
mp4 = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '%dx%d' % (W, H), '-r', str(FPS), '-i', '-',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-tune', 'animation',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', M['mp4']], stdin=subprocess.PIPE)
gw = M['gifW']; gh = int(round(H * gw / W / 2)) * 2
picks = set(int(round(k * FPS / M['gifFps'])) for k in range(int(len(plan) * M['gifFps'] / FPS)))   # 25 fps = exact 4 cs GIF delays
gif = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '%dx%d' % (gw, gh), '-r', str(M['gifFps']), '-i', '-',
    '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=256:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
    '-loop', '0', M['gif']], stdin=subprocess.PIPE)
for j, p in enumerate(plan):
    im = render(p)
    mp4.stdin.write(im.tobytes())
    if j in picks: gif.stdin.write(im.resize((gw, gh), Image.LANCZOS).tobytes())
mp4.stdin.close(); gif.stdin.close(); mp4.wait(); gif.wait()
json.dump({'stats': stats, 'plan': plan}, open(M['stats'], 'w'))
print(json.dumps(stats))
`;

async function renderCursorSprites(scale) {
  const SPR = {
    arrow: { w: 24, h: 28, hx: 3, hy: 2.5, svg: `<path d="M3 2.5V20.6L7.4 16.4L10.2 23L13.4 21.7L10.6 15.2H16.6Z" fill="#000" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/>` },
    cross: { w: 22, h: 22, hx: 11, hy: 11, svg: `<path d="M11 3.2V18.8M3.2 11H18.8" stroke="rgba(0,0,0,.55)" stroke-width="4.8" stroke-linecap="round"/><path d="M11 3.6V18.4M3.6 11H18.4" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><path d="M11 4.6V17.4M4.6 11H17.4" stroke="#000" stroke-width="1.1"/>` },
    hand: { w: 22, h: 24, hx: 8.2, hy: 2.2, svg: `<path d="M6.8 12.6V3.4C6.8 2.5 7.4 1.9 8.2 1.9S9.6 2.5 9.6 3.4V9.6C9.6 8.9 10.2 8.4 10.9 8.4S12.2 8.9 12.2 9.6V10.2C12.2 9.5 12.8 9 13.5 9S14.8 9.5 14.8 10.2V10.9C14.8 10.3 15.3 9.8 16 9.8S17.2 10.3 17.2 11V15.8C17.2 18.9 15.3 21.2 12.3 21.2H10.7C8.9 21.2 7.8 20.5 6.8 19.2L3.4 14.6C2.9 13.9 3 13 3.7 12.5S5.4 12.1 5.9 12.7Z" fill="#fff" stroke="#000" stroke-width="1.15" stroke-linejoin="round"/><path d="M9.6 9.6V13.6M12.2 10.2V13.6M14.8 10.9V13.6" stroke="#000" stroke-width=".9" stroke-linecap="round"/>` },
  };
  const out = {};
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  const pg = await browser.newPage({ deviceScaleFactor: scale, viewport: { width: 200, height: 100 } });
  for (const [k, sp] of Object.entries(SPR)) {
    const pad = 4;
    await pg.setContent(`<html><body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" width="${sp.w + 2 * pad}" height="${sp.h + 2 * pad}" viewBox="${-pad} ${-pad} ${sp.w + 2 * pad} ${sp.h + 2 * pad}" style="display:block;filter:drop-shadow(0 1px 1.1px rgba(0,0,0,.42))">${sp.svg}</svg></body></html>`);
    const file = path.join(WORK, `cursor-${k}.png`);
    await pg.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: sp.w + 2 * pad, height: sp.h + 2 * pad } });
    out[k] = { png: file, hx: (sp.hx + pad) * scale, hy: (sp.hy + pad) * scale };
  }
  await browser.close();
  return out;
}

async function recordHero() {
  const dir = path.join(WORK, 'hero'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'f'), { recursive: true });
  const { ctx, page, cdp } = await launch(GIF.vw, GIF.vh, GIF.dsf);
  const epoch = () => performance.timeOrigin + performance.now();
  try {
    await page.addInitScript(LOGGER);
    await page.goto(`${base()}/connectors`); await page.evaluate(() => document.fonts.ready); await sleep(900);
    const c = await rectOf(page, '#card');
    // waypoints [t, x, y]; consecutive equal points are pauses
    const S = [c.x - 28, c.y - 24], E = [c.x + c.w + 28, c.y + c.h + 28];
    const P0 = [c.x + c.w * 0.2, Math.min(c.y + c.h + 40, GIF.vh - 30)];      // rest point below the card
    const copyAt = [E[0] - 19, S[1] - 11];                        // the Copy tab sits on the marquee's top-right corner
    const D = [c.x + c.w + 60 > GIF.vw - 8 ? GIF.vw - 12 : c.x + c.w + 60, c.y + c.h * 0.62];
    const pts = [
      [0, ...P0], [0.35, ...P0],
      [0.75, S[0] + 30, S[1] + 70], [1.05, S[0] + 6, S[1] + 10], [1.2, S[0] + 1, S[1] + 2], [1.3, ...S], [1.62, ...S],
      // drag: accelerate, overshoot nothing, settle on E
      [1.8, S[0] + 40, S[1] + 26], [2.05, S[0] + (E[0] - S[0]) * 0.42, S[1] + (E[1] - S[1]) * 0.36], [2.35, S[0] + (E[0] - S[0]) * 0.8, S[1] + (E[1] - S[1]) * 0.78],
      [2.6, E[0] - 10, E[1] - 8], [2.78, E[0] - 2, E[1] - 1], [2.9, ...E], [4.25, ...E],
      // to the Copy tab
      [4.55, E[0] - 6, E[1] - 60], [4.95, copyAt[0] + 4, copyAt[1] + 40], [5.2, copyAt[0] + 1, copyAt[1] + 3], [5.3, ...copyAt], [5.75, ...copyAt],
      // out to the right of the card, click to dismiss
      [6.15, D[0] - 10, D[1] - 120], [6.55, D[0], D[1] - 6], [6.65, ...D], [7.05, ...D],
      // home
      // home, passing below the card (no hover on its buttons)
      [7.45, c.x + c.w + 18, c.y + c.h + 26], [7.95, (c.x + c.w + P0[0]) / 2, P0[1] + 6], [8.35, P0[0] + 4, P0[1] + 1], [8.5, ...P0], [GIF.dur, ...P0],
    ];
    const fx = pchip(pts.map((p) => p[0]), pts.map((p) => p[1])), fy = pchip(pts.map((p) => p[0]), pts.map((p) => p[2]));
    const events = [[0.55, 'keydown'], [1.62, 'down'], [4.0, 'up'], [4.12, 'keyup'], [5.5, 'down'], [5.6, 'up'], [6.8, 'down'], [6.86, 'up']];
    await page.mouse.move(...P0); await sleep(300);

    const frames = []; let pending = 0;
    cdp.on('Page.screencastFrame', (f) => {
      const i = frames.length; frames.push([i, f.metadata.timestamp * 1000]);
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      pending++; fs.writeFile(path.join(dir, 'f', `${String(i).padStart(5, '0')}.png`), Buffer.from(f.data, 'base64'), () => pending--);
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 4096, maxHeight: 4096 });
    await page.evaluate(() => { window.__mkOn = true; });
    await sleep(400);
    const calib = async () => page.evaluate(async () => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;z-index:2147483647;pointer-events:none;background:#ff0000';
      document.documentElement.appendChild(d);
      const out = []; let k = 0;
      await new Promise((res) => { const f = (ts) => { k++; if (k % 6 === 0) { const col = out.length % 2 ? 'r' : 'b'; d.style.background = col === 'r' ? '#ff0000' : '#0000ff'; out.push([performance.timeOrigin + ts, col]); }
        if (out.length >= 8) { res(); return; } requestAnimationFrame(f); }; requestAnimationFrame(f); });
      await new Promise((r) => setTimeout(r, 120)); d.remove(); return out;
    });
    const n0 = epoch(); const pageNow = await page.evaluate(() => performance.timeOrigin + performance.now()); const n1 = epoch();
    const skew = pageNow - (n0 + n1) / 2;
    const calibA = await calib(); await sleep(250);
    const T0 = epoch(); let ei = 0, lx = -1e9, ly = -1e9;
    for (;;) {
      const t = (epoch() - T0) / 1000; if (t > GIF.dur) break;
      const x = fx(t), y = fy(t);
      if (Math.abs(x - lx) > 0.02 || Math.abs(y - ly) > 0.02) { await page.mouse.move(x, y); lx = x; ly = y; }
      while (ei < events.length && events[ei][0] <= (epoch() - T0) / 1000) {
        const e = events[ei++][1];
        if (e === 'keydown') await page.keyboard.down('Shift'); else if (e === 'keyup') await page.keyboard.up('Shift');
        else if (e === 'down') await page.mouse.down(); else if (e === 'up') await page.mouse.up();
      }
      await sleep(3);
    }
    await sleep(300);
    const calibB = await calib(); await sleep(200);
    await page.evaluate(() => { window.__mkOn = false; });
    await cdp.send('Page.stopScreencast');
    while (pending) await sleep(20);
    const raf = await page.evaluate(() => window.__mkLog);
    const states = [...new Set(raf.map((r) => r[4]))];
    return { dir: path.join(dir, 'f'), dsf: GIF.dsf, t0: T0 + skew, end: GIF.dur, frames, raf, calib: [...calibA, ...calibB], states };
  } finally { await ctx.close(); }
}

async function makeHero() {
  const sprites = await renderCursorSprites(GIF.dsf);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const scene = await recordHero();
    if (!['armed', 'dragging', 'pinned'].every((s) => scene.states.includes(s))) { log('hero: overlay states', scene.states, '- re-shooting'); continue; }
    const manifest = { fps: GIF.fps, w: GIF.vw * GIF.dsf, h: GIF.vh * GIF.dsf, gifW: GIF.gifW, gifFps: GIF.gifFps, scene, sprites,
      mp4: path.join(OUT, 'hero.mp4'), gif: path.join(OUT, 'hero.gif'), stats: path.join(WORK, 'hero-stats.json') };
    fs.writeFileSync(path.join(WORK, 'hero-manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(WORK, 'hero-compose.py'), GIF_PY);
    const r = spawnSync('python3', [path.join(WORK, 'hero-compose.py'), path.join(WORK, 'hero-manifest.json')], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('hero compositing failed: ' + r.stderr);
    const st = JSON.parse(r.stdout.trim().split('\n').pop());
    log('hero stats', JSON.stringify(st));
    // long capture gaps are fine (the screencast only sends a frame when the page changes); a repeated frame
    // while the hint follows the pointer or the marquee grows is a dropped frame
    if ((st.held_while_dragging_pointer_moving > 2 || st.held_while_marquee_changed > 0) && attempt < 3) { log('hero: held/dropped frames - re-shooting'); continue; }
    const size = fs.statSync(manifest.gif).size;
    log('hero.gif', size, 'bytes', size < 4 * 1024 * 1024 ? 'ok' : 'OVER 4 MB');
    return;
  }
}

// ---------------------------------------------------------------------------------------------
// Store icon: Google asks for 128×128 with the artwork in the central 96×96 and 16 px of transparent
// padding. The artwork is re-rendered as a vector at 96 px from the same svg() that tools/make-icons.mjs
// uses for extension/icons (read from that file, so there is one design source), not downscaled.
// ---------------------------------------------------------------------------------------------
async function makeStoreIcon() {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'make-icons.mjs'), 'utf8');
  const blue = src.match(/const BLUE = '([^']+)'/)[1];
  const a = src.indexOf('function svg(size)'), b = src.indexOf('\nconst browser', a);
  if (a < 0 || b < 0) throw new Error('svg() not found in tools/make-icons.mjs');
  const svg = new Function('BLUE', src.slice(a, b) + '\nreturn svg;')(blue);
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const pg = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
    await pg.setContent(`<html><body style="margin:0;background:transparent"><div style="position:absolute;left:16px;top:16px;width:96px;height:96px">${svg(96)}</div></body></html>`);
    const file = path.join(OUT, 'store-icon-128.png');
    await pg.screenshot({ path: path.join(WORK, 'store-icon.png'), omitBackground: true, clip: { x: 0, y: 0, width: 128, height: 128 } });
    log('store-icon-128.png', py(String.raw`
import sys
from PIL import Image, PngImagePlugin
im = Image.open(sys.argv[1]).convert('RGBA')
a = im.split()[3]
bb = a.getbbox()
assert im.size == (128, 128) and bb and bb[0] >= 16 and bb[1] >= 16 and bb[2] <= 112 and bb[3] <= 112, ('artwork outside 96x96', bb)
info = PngImagePlugin.PngInfo(); info.add(b'sRGB', b'\x00')
im.save(sys.argv[2], 'PNG', optimize=True, pnginfo=info)
print(im.size, im.mode, 'artwork bbox', bb)
`, path.join(WORK, 'store-icon.png'), file));
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------------------------------------
async function main() {
  log('work dir', WORK);
  const srv = await serve(); PORT = srv.address().port; BASE = `http://${HOST}`;
  try {
    if (ONLY.includes('shots')) {
      const list = [];
      for (const n of SHOTS) if (SHOT[n]) list.push([n, await SHOT[n]()]);
      await composeShots(list);
    }
    if (ONLY.includes('promo')) await makePromos();
    if (ONLY.includes('icon')) await makeStoreIcon();
    if (ONLY.includes('gif')) await makeHero();
  } finally { srv.close(); }
  if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
}
main().catch((e) => { console.error(e); process.exit(1); });
