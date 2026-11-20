#!/usr/bin/env node
/**
 * record-demo.mjs — records the Mikron demo video from the REAL extension running in Chromium.
 *
 *   node tools/record-demo.mjs                 # -> ./mikron-demo.mp4 (≈ 1 min)
 *   node tools/record-demo.mjs --work /some/dir --out /path/video.mp4 --keep
 *
 * Requirements: the repo's Playwright (+ its Chromium, `npx playwright install chromium`),
 * ffmpeg with libx264, python3 with Pillow (used only for the cursor compositing step).
 *
 * How it works
 *  1. Serves the repo over node:http (content scripts do not run on file://) and launches
 *     Playwright's Chromium headless with the unpacked `extension/` loaded and
 *     `--force-device-scale-factor` (2 for scene 1, 1.5 for scene 2). A forced DSF makes
 *     `Page.startScreencast` deliver frames at device resolution; an emulated deviceScaleFactor
 *     would only deliver CSS-pixel frames.
 *  2. Records every compositor frame with CDP `Page.startScreencast` (PNG, 60 Hz) and keeps
 *     each frame's capture timestamp. The page gets a main-world requestAnimationFrame logger
 *     (pointer position, overlay state, CSS cursor under the pointer) — it only reads.
 *     A short colour flash in a corner before each scene (cut away) calibrates the offset
 *     between rAF time and screencast timestamps, so cursor and content line up per frame.
 *  3. Drives the extension with real input (Playwright keyboard/mouse -> CDP Input.dispatch*):
 *     timed waypoints interpolated with a monotone cubic (eased, no overshoot) per axis,
 *     giving curved, accelerating/decelerating pointer paths with pauses.
 *     Scene 1 is a scripted run on demo/index.html (718×479 CSS viewport);
 *     scene 2 is on demo/light.html (958×639 CSS viewport, same aspect).
 *  4. Builds a constant 60 fps timeline from the capture timestamps (holding the last frame only
 *     where Chromium produced no new frame because nothing changed), composites a macOS-style
 *     cursor (arrow / crosshair / pointing hand, picked from the CSS cursor the page reports under
 *     the pointer; the arrow over a pinned selection except on its Copy tab), cross-fades the scenes (cursor
 *     hidden during the 0.4 s fade), and encodes H.264 yuv420p CRF 12 +faststart at 1436×958.
 *  Intermediate frames go to a temp dir (default: os.tmpdir()/mikron-demo-XXXX, deleted unless --keep).
 *  Frame-timing statistics are printed at the end and written to <work>/stats.json.
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
const { chromium } = createRequire(ROOT + '/')('playwright');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const WORK = path.resolve(opt('--work', '') || fs.mkdtempSync(path.join(os.tmpdir(), 'mikron-demo-')));
const OUT = path.resolve(opt('--out', path.join(ROOT, 'mikron-demo.mp4')));
const KEEP = argv.includes('--keep') || argv.includes('--work');
const ONLY = opt('--scenes', '1,2').split(',').map(Number);
fs.mkdirSync(WORK, { recursive: true });

const FPS = 60, OUT_W = 1436, OUT_H = 958, XFADE = 0.4, CRF = 12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const epoch = () => performance.timeOrigin + performance.now();
const log = (...a) => console.log('[record-demo]', ...a);

// ---------------------------------------------------------------------------------------------
// Choreography. Waypoints [t (s), x, y] in CSS px; consecutive equal points = a pause.
// Scene 1 coordinates were laid out for a 710 px wide viewport (card at 115,43);
// our 718×479 viewport puts the card at 119,44, so they are shifted by S1_SHIFT.
// ---------------------------------------------------------------------------------------------
const S1_SHIFT = [4, 1];
const SCENE1 = {
  name: 'scene1', page: '/demo/index.html', vw: 718, vh: 479, dsf: 2, start: -1.6, end: 17.1, shift: S1_SHIFT,
  path: [
    [-1.6, 300, 340], [-0.5, 236, 292],
    // 0–1.6 s: wander with the hint pill, settle near the top-left
    [0.00, 204.7, 265.3], [0.13, 146, 238], [0.27, 30, 116], [0.38, 21.5, 76], [0.50, 21.3, 74.7],
    [0.62, 26.5, 50], [0.78, 33.3, 37.5], [0.98, 37.5, 27.6], [1.10, 38.7, 26], [1.58, 38.7, 26],
    // drag 1 down-right -> 604 × 432
    [1.667, 78, 42], [1.767, 121, 80], [1.867, 157, 92], [1.967, 181, 101], [2.067, 209, 117], [2.167, 245, 135],
    [2.267, 293, 165], [2.367, 357, 200], [2.467, 412, 232], [2.567, 452, 255], [2.667, 485, 275], [2.767, 514, 292],
    [2.85, 521, 297], [3.07, 522, 298], [3.167, 605, 381], [3.267, 621, 400], [3.367, 629, 417], [3.467, 633, 433],
    [3.567, 637, 445], [3.667, 640, 455], [3.75, 642.7, 458], [5.30, 642.7, 458],
    // shrink up-left, swing back to the 304 × 420 pause
    [5.367, 628, 447], [5.467, 585, 412], [5.567, 545, 390], [5.667, 529, 377], [5.767, 501, 360], [5.867, 469, 345],
    [5.967, 441, 333], [6.067, 401, 330], [6.167, 357, 333], [6.267, 309, 338], [6.367, 269, 343], [6.467, 243, 350],
    [6.567, 233, 365], [6.667, 234, 385], [6.767, 241, 409], [6.867, 253, 423], [6.967, 273, 433], [7.067, 297, 441],
    [7.167, 313, 443], [7.267, 325, 445], [7.37, 342.7, 446], [8.30, 342.7, 446],
    // shrink to the tiny 36 × 32 selection
    [8.367, 321, 425], [8.467, 281, 370], [8.567, 225, 290], [8.667, 185, 215], [8.767, 158, 160], [8.867, 125, 125],
    [8.967, 101, 98], [9.067, 88, 78], [9.167, 78, 64], [9.27, 74.7, 58], [9.90, 74.7, 58],
    // move off, press outside (10.3 s)
    [10.05, 88, 44], [10.22, 106.7, 25.3], [10.45, 106.7, 25.3],
    // travel to the bottom-right
    [10.62, 300, 70], [10.80, 640, 128], [10.88, 680, 136], [10.98, 684, 142], [11.12, 640, 360], [11.22, 606, 442],
    [11.35, 599, 447], [11.50, 602, 428], [11.62, 603, 425], [11.78, 628, 450], [11.88, 637.3, 456.7], [12.00, 637.3, 456.7],
    // drag 2 up-left -> 460 × 328
    [12.10, 576, 426], [12.167, 485, 358], [12.267, 366, 274], [12.367, 308, 226], [12.467, 269, 194], [12.567, 230, 170],
    [12.667, 196, 146], [12.767, 183, 134], [12.867, 179.5, 130], [13.2, 178.5, 129.5], [13.5, 177.3, 128.7], [14.85, 177.3, 128.7],
    // arrow over the pinned blueprint, then to the bottom-left outside it
    [14.95, 190, 150], [15.05, 237, 217], [15.15, 283, 329], [15.25, 300, 410], [15.35, 290, 445], [15.48, 200, 450],
    [15.60, 135, 432], [15.70, 117, 426], [15.98, 117, 426],
    [16.12, 147, 439], [16.25, 181, 458], [16.45, 200, 468], [17.1, 200, 468],
  ],
  // Mikron's marquee corner eases after the pointer (~1–2 frames); the waypoints above are where the
  // marquee corner should be, so during drags the pointer runs this much ahead of them.
  lead: [[1.60, 3.75, 0.03], [5.31, 7.37, 0.03], [8.31, 9.27, 0.03], [12.02, 13.5, 0.04]],
  events: [
    [-0.95, 'keydown'], [1.58, 'down'], [9.85, 'up'], [10.30, 'down'], [10.36, 'up'],
    [12.00, 'down'], [13.80, 'up'], [14.00, 'keyup'], [15.30, 'keydown'], [15.84, 'down'], [15.90, 'up'], [16.30, 'keyup'],
  ],
};

// Scene 2: waypoints that depend on the live layout are filled in by planScene2().
function planScene2(L) {
  const b1 = L.btn1, b2 = L.btn2;                         // hero buttons
  const s0 = [b1.x - 7, b1.y - 7], s1 = [b2.x + b2.w + 6, b2.y + b2.h + 7]; // tight marquee
  const cp = L.copy;                                       // Copy tab (measured in a dry run)
  const c = [cp.x + cp.w * 0.62, cp.y + cp.h * 0.5];       // over the "Copy" label
  const g = L.grid;                                        // card grid after scrolling by L.scroll1
  const g0 = [g.x - 9, g.y - 10], g1 = [g.x + g.w + 9, g.y + g.h + 8];   // the whole grid, even margins
  const dis1 = [L.empty1.x, L.empty1.y], dis2 = [L.empty2.x, L.empty2.y];
  return {
    name: 'scene2', page: '/demo/light.html', vw: 958, vh: 639, dsf: 1.5, start: -1.2, end: 9.9, shift: [0, 0],
    path: [
      [-1.2, 780, 575], [0.45, 760, 560],
      [0.85, 600, 470], [1.15, 420, 380], [1.32, s0[0] + 4, s0[1] + 3], [1.42, ...s0], [1.62, ...s0],
      [1.80, s0[0] + 60, s0[1] + 18], [2.05, s0[0] + 200, s1[1] - 6], [2.28, s1[0] - 14, s1[1] + 2], [2.42, s1[0] - 2, s1[1] + 0.5], [2.52, ...s1], [3.05, ...s1],
      [3.30, s1[0] - 6, s1[1] - 30], [3.55, c[0] + 2, c[1] + 4], [3.65, ...c], [4.05, ...c],
      [4.32, c[0] + 62, c[1] - 16], [4.55, c[0] + 72, c[1] - 20],
      [4.85, (c[0] + dis1[0]) / 2 + 60, dis1[1] - 10], [5.05, ...dis1], [5.25, ...dis1],
      [5.45, dis1[0] - 10, dis1[1] + 20], [5.95, dis1[0] - 60, dis1[1] + 40],
      [6.25, 300, 220], [6.50, g0[0] + 14, g0[1] + 9], [6.62, ...g0], [6.80, ...g0],
      [7.00, g0[0] + 110, g0[1] + 60], [7.30, 520, g1[1] - 60], [7.55, g1[0] - 40, g1[1] - 6], [7.70, g1[0] - 4, g1[1]], [7.80, ...g1], [8.25, ...g1],
      [8.50, g1[0] - 30, g1[1] - 10], [8.95, g1[0] - 40, g1[1] - 14],
      [9.20, ...dis2], [9.9, ...dis2],
    ],
    events: [
      [0.70, 'keydown'], [1.62, 'down'], [3.05, 'up'], [3.22, 'keyup'],
      [3.85, 'down'], [3.97, 'up'],                         // click Copy, ~120 ms press
      [5.25, 'down'], [5.31, 'up'],                         // dismiss
      ...wheelBurst(5.45, 0.45, L.scroll1),                 // scroll to the card grid
      [6.20, 'keydown'], [6.80, 'down'], [8.25, 'up'], [8.38, 'keyup'],
      ...wheelBurst(8.50, 0.45, L.scroll2),                 // scroll while pinned
      [9.35, 'down'], [9.41, 'up'],                         // dismiss
    ],
  };
}
function wheelBurst(t0, dur, total) {
  // trackpad-like burst: deltas follow a bell curve
  const n = 12, w = [], ev = [];
  for (let i = 0; i < n; i++) w.push(Math.sin(Math.PI * (i + 0.5) / n));
  const s = w.reduce((a, b) => a + b, 0); let acc = 0, done = 0;
  for (let i = 0; i < n; i++) { acc += total * w[i] / s; const d = Math.round(acc - done); done += d; ev.push([t0 + dur * i / n, 'wheel', d]); }
  return ev;
}

// ---------------------------------------------------------------------------------------------
// Monotone cubic (Fritsch–Carlson) interpolation per axis: smooth, eased, never overshoots a
// waypoint (important: the marquee snaps to 4 px, so pauses must stay exactly put).
// ---------------------------------------------------------------------------------------------
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
function makePath(pts, shift) {
  const ts = pts.map((p) => p[0]);
  const fx = pchip(ts, pts.map((p) => p[1] + shift[0])), fy = pchip(ts, pts.map((p) => p[2] + shift[1]));
  return (t) => [fx(t), fy(t)];
}

// ---------------------------------------------------------------------------------------------
// Static server
// ---------------------------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.json': 'application/json' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(p, (e, d) => {
        if (e) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(d);
      });
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// Main-world logger: one entry per animation frame. Reads only.
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
        // While a selection is pinned the page under it is not clickable (a press there is swallowed and
        // dismisses), so the page's own hover cursor (links, text) does not apply: draw the arrow,
        // except over the Copy tab.
        const mq0 = R && h.dataset.state === 'pinned' && R.querySelector('.mk-marquee');
        if (mq0 && !(el && el.closest && el.closest('.mk-copy'))) {
          const b = mq0.getBoundingClientRect();
          if (P.x >= b.left && P.x <= b.right && P.y >= b.top && P.y <= b.bottom) cur = 'default';
        }
      }
      const cp = R && R.querySelector('.mk-copy'), lb = R && R.querySelector('.mk-size-label'), mq = R && R.querySelector('.mk-marquee');
      const mr = mq ? mq.getBoundingClientRect() : null;
      window.__mkLog.push([performance.timeOrigin + ts, P.x, P.y, cur, h ? h.dataset.state : '-', Math.round(scrollY), cp ? cp.textContent.trim() : '',
        lb ? lb.textContent.trim() : '', mr ? [mr.x, mr.y, mr.width, mr.height].map((v) => Math.round(v * 100) / 100).join(',') : '']);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();`;

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------
async function launch(vw, vh, dsf) {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, `profile-${dsf}-${Date.now()}`), {
    channel: 'chromium', headless: true, viewport: null,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--force-device-scale-factor=${dsf}`,
      `--window-size=${vw},${vh + 87}`, '--hide-scrollbars'],
  });
  // A fresh profile is a fresh install, so the extension opens its welcome tab. Close it, and keep the page
  // we record in front: a background tab would have its timers and rAF throttled.
  const t0 = Date.now();
  while (Date.now() - t0 < 4000 && !ctx.pages().some((p) => p.url().includes('/welcome/welcome.html'))) await sleep(50);
  await sleep(100);
  for (const p of ctx.pages()) if (p.url().includes('/welcome/welcome.html')) await p.close();
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.bringToFront();
  // headless window chrome height is not guaranteed: fix the window so innerWidth/innerHeight match
  const cdp = await ctx.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  for (let k = 0; k < 3; k++) {
    await page.goto('about:blank');
    const [iw, ih] = await page.evaluate(() => [innerWidth, innerHeight]);
    if (iw === vw && ih === vh) break;
    const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: bounds.width + vw - iw, height: bounds.height + vh - ih } });
    await sleep(100);
  }
  return { ctx, page, cdp };
}

async function overlayInfo(page) {
  return page.evaluate(() => {
    const R = document.querySelector('mikron-root')?.shadowRoot; if (!R) return null;
    const r = (s) => { const e = R.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, text: e.textContent.trim() }; };
    return { state: document.querySelector('mikron-root').dataset.state, copy: r('.mk-copy'), marquee: r('.mk-marquee'), label: r('.mk-size-label') };
  });
}

// Dry run on the light page to learn layout-dependent coordinates for scene 2.
async function measureScene2(base) {
  const { ctx, page } = await launch(958, 639, 1.5);
  await page.goto(base + '/demo/light.html'); await sleep(700);
  const L = await page.evaluate(() => {
    const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const [b1, b2] = document.querySelectorAll('.hero .btn');
    return { btn1: r(b1), btn2: r(b2), gridAbs: r(document.querySelector('.grid')) };
  });
  const s0 = [L.btn1.x - 7, L.btn1.y - 7], s1 = [L.btn2.x + L.btn2.w + 6, L.btn2.y + L.btn2.h + 7];
  await page.mouse.move(s0[0] - 40, s0[1] - 30); await page.keyboard.down('Shift');
  for (let i = 1; i <= 10; i++) { await page.mouse.move(s0[0] - 40 + 4 * i, s0[1] - 30 + 3 * i); await sleep(30); }
  await sleep(300); await page.mouse.down();
  for (let i = 1; i <= 30; i++) { await page.mouse.move(s0[0] + (s1[0] - s0[0]) * i / 30, s0[1] + (s1[1] - s0[1]) * i / 30); await sleep(16); }
  await sleep(500); await page.mouse.up(); await page.keyboard.up('Shift'); await sleep(500);
  const info = await overlayInfo(page);
  if (!info || !info.copy) throw new Error('dry run: no Copy tab after pinning ' + JSON.stringify(info));
  L.copy = info.copy; L.pinned1 = info;
  // clipboard check
  await page.mouse.move(info.copy.x + info.copy.w / 2, info.copy.y + info.copy.h / 2); await sleep(100);
  await page.mouse.down(); await page.mouse.up(); await sleep(150);
  L.copyAfterClick = (await overlayInfo(page))?.copy?.text;
  await ctx.close();
  // pick scroll so the grid sits ~170 px below the top
  L.scroll1 = Math.round(L.gridAbs.y - 172);
  L.grid = { ...L.gridAbs, y: L.gridAbs.y - L.scroll1 };
  L.scroll2 = 110;
  L.empty1 = { x: 868, y: 292 };                            // empty hero background right of the paragraph
  L.empty2 = { x: 470, y: Math.min(612, L.grid.y + L.grid.h + 18 - L.scroll2 + 70) };
  return L;
}

// ---------------------------------------------------------------------------------------------
// Record one scene
// ---------------------------------------------------------------------------------------------
async function recordScene(sc, base) {
  const dir = path.join(WORK, sc.name); fs.mkdirSync(path.join(dir, 'f'), { recursive: true });
  const { ctx, page, cdp } = await launch(sc.vw, sc.vh, sc.dsf);
  await page.addInitScript(LOGGER);
  await page.goto(base + sc.page); await sleep(900);
  const pts = sc.path.map(([t, x, y]) => { const l = (sc.lead || []).find(([a, b]) => t > a && t <= b); return [l ? t - l[2] : t, x, y]; });
  const pos = makePath(pts, sc.shift);
  await page.mouse.move(...pos(sc.start)); await sleep(300);

  const frames = []; let pending = 0;
  cdp.on('Page.screencastFrame', (f) => {
    const i = frames.length; frames.push([i, f.metadata.timestamp * 1000]);
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    pending++; fs.writeFile(path.join(dir, 'f', `${String(i).padStart(5, '0')}.png`), Buffer.from(f.data, 'base64'), () => pending--);
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 4096, maxHeight: 4096 });
  await page.evaluate(() => { window.__mkOn = true; });
  await sleep(400);

  // clock check + calibration flashes (cut away later)
  const calib = async () => page.evaluate(async () => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;z-index:2147483647;pointer-events:none;background:#ff0000';
    document.documentElement.appendChild(d);
    const out = []; let k = 0;
    await new Promise((res) => { const f = (ts) => { k++; if (k % 6 === 0) { const c = out.length % 2 ? 'r' : 'b'; d.style.background = c === 'r' ? '#ff0000' : '#0000ff'; out.push([performance.timeOrigin + ts, c]); }
      if (out.length >= 8) { res(); return; } requestAnimationFrame(f); }; requestAnimationFrame(f); });
    await new Promise((r) => setTimeout(r, 120)); d.remove(); return out;
  });
  const n0 = epoch(); const pageNow = await page.evaluate(() => performance.timeOrigin + performance.now()); const n1 = epoch();
  const clockSkew = pageNow - (n0 + n1) / 2;
  const calibA = await calib();
  await sleep(250);

  // run the timeline
  const events = [...sc.events].sort((a, b) => a[0] - b[0]);
  const T0 = epoch() - sc.start * 1000;               // node epoch of scene t = 0
  const evLog = []; let ei = 0, lx = -1e9, ly = -1e9, moves = 0;
  for (;;) {
    const t = (epoch() - T0) / 1000;
    if (t > sc.end) break;
    const [x, y] = pos(t);
    if (Math.abs(x - lx) > 0.02 || Math.abs(y - ly) > 0.02) { await page.mouse.move(x, y); lx = x; ly = y; moves++; }
    while (ei < events.length && events[ei][0] <= (epoch() - T0) / 1000) {
      const [, e, arg] = events[ei++];
      evLog.push([+((epoch() - T0) / 1000).toFixed(4), e, arg ?? null]);
      if (e === 'keydown') await page.keyboard.down('Shift');
      else if (e === 'keyup') await page.keyboard.up('Shift');
      else if (e === 'down') await page.mouse.down();
      else if (e === 'up') await page.mouse.up();
      else if (e === 'wheel') await page.mouse.wheel(0, arg);
    }
    await sleep(3);
  }
  await sleep(300);
  const calibB = await calib();
  await sleep(200);
  await page.evaluate(() => { window.__mkOn = false; });
  await cdp.send('Page.stopScreencast');
  while (pending) await sleep(20);
  const raf = await page.evaluate(() => window.__mkLog);
  await ctx.close();
  const meta = { name: sc.name, dir: path.join(dir, 'f'), dsf: sc.dsf, vw: sc.vw, vh: sc.vh, t0: T0 + clockSkew, end: sc.end, clockSkew, moves, frames, raf, calib: [...calibA, ...calibB], events: evLog };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  log(sc.name, `frames=${frames.length} raf=${raf.length} moves=${moves} skew=${clockSkew.toFixed(2)}ms`, JSON.stringify(evLog));
  return meta;
}

// ---------------------------------------------------------------------------------------------
// Cursor sprites, rendered by Chromium from SVG with a transparent background.
// ---------------------------------------------------------------------------------------------
const SPRITES = {
  arrow: { w: 24, h: 28, hx: 3, hy: 2.5, svg: `<path d="M3 2.5V20.6L7.4 16.4L10.2 23L13.4 21.7L10.6 15.2H16.6Z" fill="#000" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/>` },
  cross: { w: 22, h: 22, hx: 11, hy: 11, svg: `<path d="M11 3.2V18.8M3.2 11H18.8" stroke="rgba(0,0,0,.55)" stroke-width="4.8" stroke-linecap="round"/><path d="M11 3.6V18.4M3.6 11H18.4" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><path d="M11 4.6V17.4M4.6 11H17.4" stroke="#000" stroke-width="1.1"/>` },
  hand: { w: 22, h: 24, hx: 8.2, hy: 2.2, svg: `<path d="M6.8 12.6V3.4C6.8 2.5 7.4 1.9 8.2 1.9S9.6 2.5 9.6 3.4V9.6C9.6 8.9 10.2 8.4 10.9 8.4S12.2 8.9 12.2 9.6V10.2C12.2 9.5 12.8 9 13.5 9S14.8 9.5 14.8 10.2V10.9C14.8 10.3 15.3 9.8 16 9.8S17.2 10.3 17.2 11V15.8C17.2 18.9 15.3 21.2 12.3 21.2H10.7C8.9 21.2 7.8 20.5 6.8 19.2L3.4 14.6C2.9 13.9 3 13 3.7 12.5S5.4 12.1 5.9 12.7Z" fill="#fff" stroke="#000" stroke-width="1.15" stroke-linejoin="round"/><path d="M9.6 9.6V13.6M12.2 10.2V13.6M14.8 10.9V13.6" stroke="#000" stroke-width=".9" stroke-linecap="round"/>` },
  ibeam: { w: 16, h: 24, hx: 8, hy: 12, svg: `<path d="M5 3.5H6.6C7.3 3.5 7.8 3.9 8 4.3C8.2 3.9 8.7 3.5 9.4 3.5H11M8 4.3V19.7M5 20.5H6.6C7.3 20.5 7.8 20.1 8 19.7C8.2 20.1 8.7 20.5 9.4 20.5H11" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M5 3.5H6.6C7.3 3.5 7.8 3.9 8 4.3C8.2 3.9 8.7 3.5 9.4 3.5H11M8 4.3V19.7M5 20.5H6.6C7.3 20.5 7.8 20.1 8 19.7C8.2 20.1 8.7 20.5 9.4 20.5H11" fill="none" stroke="#000" stroke-width="1.1" stroke-linecap="round"/>` },
};
async function renderSprites(scales) {
  const out = {};
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  for (const s of scales) {
    const pg = await browser.newPage({ deviceScaleFactor: s, viewport: { width: 200, height: 100 } });
    out[s] = {};
    for (const [k, sp] of Object.entries(SPRITES)) {
      const pad = 4;
      await pg.setContent(`<html><body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" width="${sp.w + 2 * pad}" height="${sp.h + 2 * pad}" viewBox="${-pad} ${-pad} ${sp.w + 2 * pad} ${sp.h + 2 * pad}" style="display:block;filter:drop-shadow(0 1px 1.1px rgba(0,0,0,.42))">${sp.svg}</svg></body></html>`);
      const file = path.join(WORK, `cursor-${k}@${s}.png`);
      await pg.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: sp.w + 2 * pad, height: sp.h + 2 * pad } });
      out[s][k] = { png: file, hx: (sp.hx + pad) * s, hy: (sp.hy + pad) * s };
    }
    await pg.close();
  }
  await browser.close();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Compositor (python3 + Pillow): CFR timeline, cursor, cross-fade, raw RGB -> ffmpeg.
// ---------------------------------------------------------------------------------------------
const PY = String.raw`
import json, sys, subprocess, statistics as st
from PIL import Image
M = json.load(open(sys.argv[1]))
FPS, W, H, XF = M['fps'], M['w'], M['h'], M['xfade']
FP = 1000.0 / 60.0
stats = {}

def calibrate(sc):
    # find colour flips of the corner marker in the captured frames
    fr = sc['frames']; d = int(round(5 * sc['dsf']))
    out = []
    lo = sc['calib'][0][0] - 200; hi = sc['calib'][-1][0] + 400
    cols = []
    for i, ts in fr:
        near = any(abs(ts - c[0]) < 300 for c in sc['calib'])
        if not near: continue
        px = Image.open('%s/%05d.png' % (sc['dir'], i)).convert('RGB').getpixel((d, d))
        c = 'r' if px[0] > 200 and px[2] < 80 else 'b' if px[2] > 200 and px[0] < 80 else '-'
        cols.append((ts, c))
    offs = []
    for t, c in sc['calib']:
        prev = None
        for ts, cc in cols:
            if ts < t - 5: prev = cc; continue
            if cc == c and prev != c: offs.append(ts - t); break
            prev = cc
    return offs

def kind(cur):
    if cur == 'crosshair': return 'cross'
    if cur == 'pointer': return 'hand'
    if cur == 'text': return 'ibeam'
    return 'arrow'

plans = []
for sc in M['scenes']:
    offs = calibrate(sc)
    off = st.median(offs)
    fr = sc['frames']; raf = sc['raf']
    t0 = sc['t0'] + off                       # scene t=0 in frame clock
    # align to the capture vsync grid
    near = min(fr, key=lambda f: abs(f[1] - t0)); ph = (near[1] - t0) % FP
    t0a = t0 + (ph - FP if ph > FP / 2 else ph)   # same phase as the capture vsync grid
    n = int(round(sc['end'] * FPS)) + 1
    plan = []; fi = 0; ri = 0
    for j in range(n):
        T = t0a + j * 1000.0 / FPS
        while fi + 1 < len(fr) and fr[fi + 1][1] <= T + 4: fi += 1
        Tr = T - off
        while ri + 1 < len(raf) and abs(raf[ri + 1][0] - Tr) <= abs(raf[ri][0] - Tr): ri += 1
        r = raf[ri]
        # the logger's rAF callback runs before Mikron's in the same frame, so the overlay geometry this
        # frame shows is what the logger reads one rAF later; pointer/cursor come from this rAF
        rn = raf[min(ri + 1, len(raf) - 1)]
        plan.append((fr[fi][0], r[1], r[2], kind(r[3]), r[4], r[6], fr[fi][1], r[0], rn[8] if len(rn) > 8 else ''))
    plans.append(plan)
    # timing stats over the scene window
    win = [f for f in fr if t0a - 1 <= f[1] <= t0a + sc['end'] * 1000 + 1]
    dts = [b[1] - a[1] for a, b in zip(win, win[1:])]
    slots = [round(x / FP) for x in dts]
    jit = [abs(x - s * FP) for x, s in zip(dts, slots)]
    used = [p[0] for p in plan]
    # a "repeat" is an output frame whose capture frame equals the previous one while the overlay or page state was changing
    rep = sum(1 for a, b in zip(plan, plan[1:]) if a[0] == b[0])
    rep_moving = 0; rep_overlay = []
    for a, b in zip(plan, plan[1:]):
        if a[0] == b[0] and b[4] == 'dragging' and (abs(a[1] - b[1]) > 0.3 or abs(a[2] - b[2]) > 0.3): rep_moving += 1
        if a[0] == b[0] and b[4] == 'dragging' and a[8] != b[8]: rep_overlay.append(round((b[6] - t0a) / 1000, 3))
    stats[sc['name']] = dict(calib_offsets_ms=[round(o, 2) for o in offs], offset_ms=round(off, 2), capture_frames=len(win),
        span_s=round((win[-1][1] - win[0][1]) / 1000, 3), capture_fps_avg=round((len(win) - 1) / ((win[-1][1] - win[0][1]) / 1000), 2),
        dt_median_ms=round(st.median(dts), 3), dt_min_ms=round(min(dts), 3), dt_max_ms=round(max(dts), 3),
        jitter_vs_vsync_ms_max=round(max(jit), 3), jitter_vs_vsync_ms_mean=round(sum(jit) / len(jit), 4),
        gaps_hist={str(k): slots.count(k) for k in sorted(set(slots))}, output_frames=len(plan), unique_capture_frames_used=len(set(used)),
        held_output_frames=rep, held_frames_while_dragging_pointer_moving=rep_moving,
        held_frames_while_marquee_rect_changed=rep_overlay, raf_entries=len(raf), raf_interval_hist={str(k): v for k, v in sorted(__import__('collections').Counter(round((b[0] - a[0]) / FP) for a, b in zip(raf, raf[1:])).items())})

sprites = {s: {k: (Image.open(v['png']).convert('RGBA'), v['hx'], v['hy']) for k, v in d.items()} for s, d in M['sprites'].items()}

def render(si, p, cursor=True):
    sc = M['scenes'][si]
    im = Image.open('%s/%05d.png' % (sc['dir'], p[0])).convert('RGB')
    if im.size != (W, H): im = im.crop((0, 0, W, H)) if im.size[0] >= W and im.size[1] >= H else im.resize((W, H), Image.LANCZOS)
    if cursor and p[1] >= 0:
        spr, hx, hy = sprites[str(sc['dsf'])][p[3]]
        im.paste(spr, (int(round(p[1] * sc['dsf'] - hx)), int(round(p[2] * sc['dsf'] - hy))), spr)
    return im

ff = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '%dx%d' % (W, H), '-r', str(FPS), '-i', '-',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', str(M['crf']), '-tune', 'animation', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', M['out']], stdin=subprocess.PIPE)
nx = int(round(XF * FPS))
track = []
for si, plan in enumerate(plans):
    last = si == len(plans) - 1
    body = plan if last else plan[:len(plan) - nx]
    start = nx if si > 0 else 0
    if si > 0:
        prev = plans[si - 1][-nx:]
        for k in range(nx):
            a = render(si - 1, prev[k], False); b = render(si, plan[k], False)   # no cursor during the cross-fade
            ff.stdin.write(Image.blend(a, b, (k + 1) / (nx + 1)).tobytes()); track.append([si, k, 'xfade'])
    for k in range(start, len(body)):
        ff.stdin.write(render(si, body[k]).tobytes()); track.append([si, k] + list(body[k]))
ff.stdin.close(); ff.wait()
json.dump({'stats': stats, 'track': track}, open(M['stats'], 'w'))
print(json.dumps(stats, indent=1))
`;

// ---------------------------------------------------------------------------------------------
async function main() {
  log('work dir', WORK);
  const srv = await serve(); const base = `http://127.0.0.1:${srv.address().port}`;
  const metas = [];
  try {
    if (ONLY.includes(1)) metas.push(await recordScene(SCENE1, base));
    if (ONLY.includes(2)) {
      const L = await measureScene2(base);
      log('scene2 layout', JSON.stringify({ btn1: L.btn1, btn2: L.btn2, copy: L.copy, grid: L.grid, scroll1: L.scroll1, copyAfterClick: L.copyAfterClick }));
      metas.push(await recordScene(planScene2(L), base));
    }
  } finally { srv.close(); }
  const sprites = await renderSprites([...new Set(metas.map((m) => m.dsf))]);
  const manifest = { fps: FPS, w: OUT_W, h: OUT_H, xfade: XFADE, crf: CRF, out: OUT, stats: path.join(WORK, 'stats.json'), sprites, scenes: metas };
  fs.writeFileSync(path.join(WORK, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(WORK, 'compose.py'), PY);
  const r = spawnSync('python3', [path.join(WORK, 'compose.py'), path.join(WORK, 'manifest.json')], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('compositing failed');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,r_frame_rate,nb_frames,pix_fmt,bit_rate:format=duration,size', '-of', 'compact', OUT]).stdout.toString();
  log('wrote', OUT, '\n' + probe.trim());
  if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
}
main().catch((e) => { console.error(e); process.exit(1); });
