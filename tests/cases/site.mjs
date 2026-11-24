// The project website (tools/build-site.mjs): the landing page runs the extension's own content scripts as a live
// demo, steps aside when the real extension is there, and the page Chrome opens after an uninstall.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, REPO, EXT, OUT, launchSub, sleep, until } from '../lib/harness.mjs';
import { makeVariant, removeVariant } from '../lib/variants.mjs';
import { state, waitState, ui, pin, chips, chipsSettled, readClipboard, writeClipboard, copyCenter, rect } from '../lib/mk.mjs';

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const TOOL = path.join(REPO, 'tools/build-site.mjs');
const DIR = path.join(OUT, 'site');
const HOME = '/tests/.out/site/index.html';
const GONE = '/tests/.out/site/uninstalled/index.html';
const G = '/tests/fixtures/gesture.html';
const STORE = 'https://chromewebstore.google.com/detail/mikron-measure-css-spacin/ijpekfklopidjlpghniabhgglndlochd';

let built = null;
/** Build the site once per run into tests/.out/site (served by the test server). */
function build() {
  if (!built) built = spawnSync(process.execPath, [TOOL, '--out', DIR], { encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`build-site failed: ${built.stderr || built.stdout}`);
  return built;
}

async function home(t, opts = {}) {
  build();
  const p = await t.open(HOME, { viewport: { width: 1100, height: 820 }, ...opts });
  await p.evaluate(() => document.getElementById('card').scrollIntoView({ block: 'center', behavior: 'instant' }));
  await sleep(150);
  return p;
}

/** Drag across the whole sample card, starting just outside its top-left corner. */
async function cardDrag(p, opts = {}) {
  const r = await rect(p, '#card');
  return pin(p, [r.x - 14, r.y - 14], [r.x + r.w + 14, r.y + r.h + 14], { pause: 150, ...opts });
}
const demoMode = (p) => p.evaluate(() => document.documentElement.dataset.mikronDemo || '');
const roots = (p) => p.evaluate(() => document.querySelectorAll('mikron-root').length);

describe('site', () => {
  test('build: the bundle holds the manifest content scripts in order, inside the demo shim; pages are stamped and complete', async (t) => {
    const b = build();
    for (const f of ['index.html', 'site.css', 'site.js', 'mikron-demo.js', 'uninstalled/index.html', '404.html', 'robots.txt', 'sitemap.xml', '.nojekyll', 'fonts/GeistMono-Bold.woff2', 'fonts/OFL.txt', 'img/hero.gif', 'img/social-preview.png', 'img/icon-48.png']) {
      t.ok(fs.existsSync(path.join(DIR, f)), `built ${f}`);
    }
    t.ok(!fs.existsSync(path.join(DIR, '_demo')), 'build inputs are not published');
    const js = fs.readFileSync(path.join(DIR, 'mikron-demo.js'), 'utf8');
    const marks = [...js.matchAll(/^\/\/ ---- (\S+) ----$/gm)].map((m) => m[1]);
    const scripts = manifest.content_scripts[0].js.map((s) => `extension/${s}`);
    t.eq(marks, ['site/_demo/prelude.js', ...scripts.slice(0, -1), 'site/_demo/yield.js', scripts[scripts.length - 1]], 'bundle parts, in order');
    for (const s of manifest.content_scripts[0].js) t.ok(js.includes(fs.readFileSync(path.join(EXT, s), 'utf8').trimEnd()), `${s} is included unchanged`);
    t.ok(js.startsWith(`/* Mikron ${manifest.version} web demo.`), 'banner with the version');
    const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
    t.ok(!html.includes('__VERSION__') && html.includes(`"softwareVersion": "${manifest.version}"`) && html.includes(`Version ${manifest.version}`), 'version stamped');
    t.ok(/\d+ files, \d+ bytes/.test(b.stdout), 'prints a summary');
    t.eq(fs.readFileSync(path.join(DIR, 'fonts/GeistMono-Bold.woff2')).equals(fs.readFileSync(path.join(EXT, 'fonts/GeistMono-Bold.woff2'))), true, 'the font is the packaged one');
  });

  test('landing page: nothing external is loaded, store links are tagged, and it holds up at 360 px', async (t) => {
    const p = await home(t);
    const external = await p.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((n) => !n.startsWith(location.origin)));
    t.eq(external, [], 'no external resources');
    const links = await p.evaluate(() => [...document.querySelectorAll('[data-store]')].map((a) => [a.dataset.store, a.href, a.textContent.trim()]));
    t.eq(links.map((l) => l[0]), ['header', 'hero', 'closing'], 'three install links');
    for (const [where, href, text] of links) {
      t.eq(href, `${STORE}?utm_source=site&utm_medium=${where}`, `install link (${where})`);
      t.eq(text, 'Add to Chrome', `install label (${where})`);
    }
    t.eq(await p.title(), 'Mikron: measure CSS spacing, padding, sizes and radius on any web page', 'title');
    await p.setViewportSize({ width: 360, height: 740 });
    await sleep(120);
    const over = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, card: document.getElementById('card').getBoundingClientRect().width }));
    t.ok(over.sw <= over.iw, `no sideways scroll at 360 px (${over.sw} > ${over.iw})`);
    t.ok(over.card <= 360 && over.card > 280, `card fits (${over.card})`);
  });

  test('landing page: the copy formats are tabs (click and arrow keys), one panel at a time', async (t) => {
    const p = await home(t);
    const shown = () => p.evaluate(() => [...document.querySelectorAll('#formats .panel')].filter((x) => !x.hidden && x.getBoundingClientRect().height > 0).map((x) => x.id));
    const selected = () => p.evaluate(() => [...document.querySelectorAll('#formats [role=tab]')].filter((x) => x.getAttribute('aria-selected') === 'true').map((x) => x.id));
    t.eq(await shown(), ['panel-text'], 'text first');
    await p.click('#tab-prompt');
    t.eq([await shown(), await selected()], [['panel-prompt'], ['tab-prompt']], 'For AI');
    t.ok((await p.textContent('#panel-prompt code')).startsWith('UI spec measured from a rendered web page with Mikron.'), 'prompt sample');
    await p.focus('#tab-prompt');
    await p.keyboard.press('ArrowLeft');
    t.eq([await shown(), await selected()], [['panel-json'], ['tab-json']], 'arrow left');
    t.eq(await p.evaluate(() => document.activeElement.id), 'tab-json', 'focus follows');
    await p.keyboard.press('Home');
    t.eq(await shown(), ['panel-text'], 'Home');
    JSON.parse(await p.textContent('#panel-json code'));
  });

  test('landing page: the three format samples are the real output for the second row of the card', async (t) => {
    await t.settings({ enabled: false });
    const p = await home(t);
    const got = await p.evaluate(() => {
      const r = document.querySelectorAll('#card .row')[1].getBoundingClientRect();
      const sel = { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height };
      const m = __MIKRON__.scan();
      const here = `${location.host}${location.pathname}`;
      const out = {}, shown = {};
      for (const f of ['text', 'json', 'prompt']) {
        out[f] = __MIKRON__.formatSpec(m, sel, { format: f }).split(here).join('dabarov.github.io/mikron');
        shown[f] = document.querySelector(`#panel-${f} code`).textContent;
      }
      return { out, shown };
    });
    for (const f of ['text', 'json', 'prompt']) t.eq(got.shown[f], got.out[f], `${f} sample`);
  });

  test('live demo without the extension: arm, drag over the card, pin, bundled font, Copy, dismiss; no rating reminder', async (t) => {
    await t.settings({ enabled: false }); // the installed extension stays out of it
    await t.stats({ copies: 4, rateAsked: false });
    const p = await home(t);
    const reader = await t.open(G);
    await writeClipboard(reader, 'sentinel');
    await p.bringToFront();
    t.eq(await roots(p), 0, 'nothing in the page before the first gesture');
    const u = await cardDrag(p);
    t.eq(await state(p), 'pinned', 'pinned');
    t.eq(await demoMode(p), 'page', 'the page copy is the one running');
    t.eq(await roots(p), 1, 'one overlay');
    t.ok(/^\d+ × \d+$/.test(u.label), `size label ${u.label}`);
    const c = await chipsSettled(p);
    t.ok(c.length > 12, `chips drawn (${c.length})`);
    t.ok(c.some((x) => x.text === '97 × 32'), 'button size chip');
    await until(() => p.evaluate(() => document.fonts.check('700 11px "Mikron Mono"')), { msg: 'bundled chip font', timeout: 3000 });
    const [x, y] = await copyCenter(p);
    await p.mouse.click(x, y);
    await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copied', timeout: 1500 });
    await sleep(300);
    t.ok(!(await ui(p)).rateShown, 'no rating reminder on the website');
    t.eq(await t.readStats(), { copies: 4, rateAsked: false }, 'the extension counted nothing');
    await reader.bringToFront();
    const txt = await readClipboard(reader);
    t.ok(/^Mikron — \d+ × \d+ selection on localhost:\d+\/tests\/\.out\/site\/index\.html/.test(txt), `spec header:\n${txt.slice(0, 200)}`);
    t.ok(/^article#card\.card — 480 × \d+ · padding 8/m.test(txt), `card line:\n${txt.slice(0, 400)}`);
    t.eq((txt.match(/button\.action "/g) || []).length, 3, 'three buttons in the spec');
    await p.bringToFront();
    await p.keyboard.press('Escape');
    await waitState(p, 'idle');
  });

  test('live demo with the extension installed: the page copy steps aside and there is one overlay, the extension\'s', async (t) => {
    await t.stats({ copies: 4, rateAsked: false });
    const p = await home(t);
    await cardDrag(p);
    t.eq(await state(p), 'pinned', 'pinned');
    t.eq(await roots(p), 1, 'one overlay');
    t.eq(await demoMode(p), 'extension', 'the page copy stepped aside');
    // only the real extension has a worker that counts copies: its reminder proves whose overlay this is
    const [x, y] = await copyCenter(p);
    await p.mouse.click(x, y);
    await until(async () => (await ui(p)).rateShown, { msg: 'reminder from the extension', timeout: 2000 });
    await p.keyboard.press('Escape');
    await waitState(p, 'idle');
    // and it stays that way for the next selection
    await cardDrag(p);
    t.eq(await roots(p), 1, 'still one overlay');
    t.ok((await chips(p)).length > 12, 'chips drawn');
  });

  test('uninstalled page: reason links open the feedback form with the reason and the version; odd versions are ignored', async (t) => {
    build();
    const read = (p) => p.evaluate(() => [...document.querySelectorAll('#reasons a')].map((a) => {
      const u = new URL(a.href);
      return { origin: u.origin + u.pathname, template: u.searchParams.get('template'), reason: u.searchParams.get('reason'), version: u.searchParams.get('version'), text: a.textContent.trim() };
    }));
    const p = await t.open(`${GONE}?v=1.2.3`);
    const a = await read(p);
    t.eq(a.length, 5, 'five reasons');
    for (const x of a) {
      t.eq([x.origin, x.template, x.version], ['https://github.com/dabarov/mikron/issues/new', 'feedback.yml', '1.2.3'], x.text);
      t.eq(x.reason, x.text, 'the reason is the label');
    }
    t.ok(fs.existsSync(path.join(REPO, '.github/ISSUE_TEMPLATE/feedback.yml')), 'the form exists');
    const yml = fs.readFileSync(path.join(REPO, '.github/ISSUE_TEMPLATE/feedback.yml'), 'utf8');
    for (const id of ['reason', 'version']) t.ok(new RegExp(`^\\s+id: ${id}$`, 'm').test(yml), `form field ${id}`);
    const again = await p.evaluate(() => document.querySelector('.cta .btn').href);
    t.eq(again, `${STORE}?utm_source=site&utm_medium=uninstalled`, 'add-again link');
    const external = await p.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((n) => !n.startsWith(location.origin)));
    t.eq(external, [], 'no external resources');
    const q = await t.open(`${GONE}?v=${encodeURIComponent('"><img src=x>')}`);
    t.ok((await read(q)).every((x) => x.version === null), 'a version that is not a version is dropped');
    const none = await t.open(GONE);
    t.ok((await read(none)).every((x) => x.version === null), 'no version, no parameter');
  });

  test('removing the extension opens the uninstalled page with the version', async (t) => {
    build();
    const site = t.url('/tests/.out/site/');
    const dir = makeVariant({ siteUrl: site });
    const sub = await launchSub(t, dir);
    try {
      const [opened] = await Promise.all([
        sub.env.ctx.waitForEvent('page', { timeout: 8000 }),
        sub.ext.sw.evaluate(() => chrome.management.uninstallSelf()).catch(() => {}), // the worker dies with the extension
      ]);
      t.pages.push(opened);
      await opened.waitForLoadState('domcontentloaded');
      t.eq(opened.url(), `${site}uninstalled/?v=${manifest.version}`, 'address');
    } finally {
      await sub.close();
      removeVariant(dir);
    }
  }, { timeout: 30000 });
});
