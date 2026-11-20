// DOM scanner (M.scan) and clipboard-spec formatter (M.formatSpec), exercised in the page's main world.
// MIKRON_CONTENT_DIR points the case at another copy of scan.js/spec.js (to compare against an old build).
import path from 'node:path';
import { describe, test, EXT } from '../lib/harness.mjs';

const DIR = process.env.MIKRON_CONTENT_DIR || path.join(EXT, 'content');
const FX = '/tests/fixtures/';

/** Open a fixture and inject the scanner + formatter into the main world. */
async function load(t, name, viewport = { width: 800, height: 600 }) {
  const page = await t.open(name.startsWith('/') ? name : FX + name, { viewport });
  await page.addScriptTag({ path: path.join(DIR, 'scan.js') });
  await page.addScriptTag({ path: path.join(DIR, 'spec.js') });
  return page;
}

/** Scan with el replaced by a plain projection. */
const scan = (page, opts = {}) =>
  page.evaluate((o) => {
    const m = __MIKRON__.scan(o);
    return {
      truncated: m.truncated,
      nodes: m.nodes.map((n) => ({
        label: n.label, tag: n.el.localName, id: n.el.id, text: n.text, box: n.box, kind: n.kind,
        texts: n.texts.map((x) => ({ w: x.rect.w, y: x.rect.y })),
      })),
    };
  }, opts);

/** Median-of-5 scan time (ms) plus the last model's stats. */
const timed = (page) =>
  page.evaluate(() => {
    const ts = [];
    let m;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      m = __MIKRON__.scan();
      ts.push(performance.now() - t0);
    }
    ts.sort((a, b) => a - b);
    return { ms: ts[2], truncated: m.truncated, texts: m.nodes.map((n) => n.text) };
  });

const spec = (page, sel, format) => page.evaluate(([s, f]) => __MIKRON__.formatSpec(__MIKRON__.scan(), s, { format: f }), [sel, format]);
const scrollTo = (page, y) => page.evaluate((yy) => new Promise((r) => { scrollTo(0, yy); requestAnimationFrame(() => requestAnimationFrame(r)); }), y);

describe('scanner', () => {
  test('S1 content under a zero-area wrapper at a clip edge is kept', async (t) => {
    const page = await load(t, 'scan-fixedwrap.html');
    const m = await scan(page);
    const hdr = m.nodes.find((n) => n.id === 'hdr');
    t.ok(hdr, 'fixed header present: ' + m.nodes.map((n) => n.label).join(', '));
    t.ok(m.nodes.some((n) => n.tag === 'button' && n.text === 'Sign in'), 'header button present');
    t.ok(m.nodes.some((n) => n.id === 'fl'), 'float inside a collapsed float container present');
  });

  test('S2 long flat list is scanned quickly, at the top and in the middle', async (t) => {
    const page = await load(t, 'scan-longlist.html');
    for (const [where, row] of [['top', 0], ['middle', 15000]]) {
      await scrollTo(page, 16 + row * 28 - 100);
      const r = await timed(page);
      t.ok(r.ms < 10, `${where}: scan took ${r.ms.toFixed(1)} ms`);
      t.eq(r.truncated, false, where + ' truncated');
      const want = `Item number ${row + 5}`;
      t.ok(r.texts.includes(want), `${where}: visible row "${want}" present`);
      t.ok(r.texts.length < 400, `${where}: only nearby rows are scanned (${r.texts.length} nodes)`);
    }
  }, { timeout: 40000 });

  test('S3 text from whitespace-separated inline elements merges into lines', async (t) => {
    const page = await load(t, 'scan-spans.html', { width: 1200, height: 600 });
    const m = await scan(page);
    const pre = m.nodes.find((n) => n.tag === 'pre');
    t.ok(pre, 'pre scanned');
    // 25 tokens x ~7 px/char x ~5 chars + spaces ≈ 1000 px per line, merged into one fragment
    t.ok(pre.texts.length >= 20 && pre.texts.length <= 120, 'one fragment per visible line, got ' + pre.texts.length);
    t.ok(pre.texts[0].w > 500, 'first line merged into one wide fragment, w=' + pre.texts[0].w);
    const ys = new Set(pre.texts.map((x) => Math.round(x.y)));
    t.eq(ys.size, pre.texts.length, 'distinct lines');
  });

  test('S4 labels: hash-like and utility classes are dropped', async (t) => {
    const page = await load(t, 'scan-labels.html');
    const m = await scan(page);
    const label = (id) => (m.nodes.find((n) => n.id === id) || {}).label;
    t.eq(label('hash1'), 'ul#hash1', 'styled-components hash');
    t.eq(label('hash2'), 'button#hash2', 'two hashes');
    t.eq(label('util1'), 'div#util1', 'flex flex-row');
    t.eq(label('util2'), 'a#util2', 'overflow-hidden transition-transform');
    t.eq(label('keep1'), 'div#keep1.NavBar.cardTitle', 'clean Pascal/camel words stay');
    t.eq(label('mixed'), 'div#mixed.card', 'utility dropped, meaningful class stays');
    t.eq(label('wrap'), 'div#wrap.container', '.container is a meaningful class and stays');
  });

  test('S4 labels: data-testid / aria-label fallback when nothing else survives', async (t) => {
    const page = await load(t, 'scan-labels.html');
    // the fixture ids would win over the fallback: strip them (and re-scan)
    await page.evaluate(() => document.querySelectorAll('[id]').forEach((e) => { e.dataset.k = e.id; e.removeAttribute('id'); }));
    const m = await page.evaluate(() => __MIKRON__.scan().nodes.map((n) => [n.el.dataset.k, n.label]));
    const label = (k) => (m.find((x) => x[0] === k) || [])[1];
    t.eq(label('testid'), 'div[data-testid=checkout-box]');
    t.eq(label('aria'), 'div[aria-label="Main menu"]');
    t.eq(label('longattr'), 'div', 'over-long attribute value is not used');
    t.eq(label('hash1'), 'ul', 'no hook, no class: bare tag');
  });
});

describe('scanner spec', () => {
  test('P1 background images are summarised, never cut mid-token', async (t) => {
    const page = await load(t, 'spec-bg.html');
    const s = await spec(page, { x: 0, y: 0, w: 400, h: 400 });
    t.ok(s.includes('bg image(triangle.svg)'), 'layered url + gradient -> first layer, file name only:\n' + s);
    t.ok(/div\.grad — .*bg gradient\b(?!\()/.test(s), 'gradient:\n' + s);
    t.ok(/bg rgb\(238, 238, 255\)/.test(s), 'colour unchanged');
    t.ok(/div\.setimg — .*bg image(?!\()/.test(s), 'image-set -> bg image:\n' + s);
    t.ok(!/url\(|linear-gra[^d]|\?v=2/.test(s), 'no raw css left');
  });

  test('P2 runs of identical rows collapse to one with ×N', async (t) => {
    const page = await load(t, 'spec-list.html', { width: 600, height: 1700 });
    const sel = { x: 0, y: 0, w: 600, h: 1600 };
    const s = await spec(page, sel);
    t.ok(/\n {2}li\.row ×20 — 568 × 73 · padding 16 · gap 12 · radius 8/.test(s), 'collapsed top line:\n' + s);
    t.eq((s.match(/li\.row/g) || []).length, 1, 'one exemplar');
    t.ok(s.includes('span.tag "#0"') && !s.includes('"#1"'), 'exemplar keeps its own children and texts');
    const j = JSON.parse(await spec(page, sel, 'json'));
    const li = j.children[0].children[0];
    t.eq([li.label, li.count], ['li.row', 20]);
    t.ok(li.children.length === 2, 'exemplar children kept in JSON');
  });

  test('P2 rows that differ are not merged', async (t) => {
    const page = await load(t, 'spec-list.html', { width: 600, height: 1700 });
    await page.evaluate(() => { document.querySelectorAll('li.row')[10].style.padding = '20px 16px'; });
    const s = await spec(page, { x: 0, y: 0, w: 600, h: 1700 });
    t.ok(s.includes('li.row ×10 —'), 'first run of 10:\n' + s);
    t.ok(/li\.row — 568 × 81 · padding 20 16/.test(s), 'the odd one on its own');
    t.ok(s.includes('li.row ×9 —'), 'trailing run of 9');
  });

  test('P3 full-page wrappers become an Inside: context line', async (t) => {
    const page = await load(t, 'spec-wrappers.html', { width: 1000, height: 700 });
    await scrollTo(page, 1000);
    const sel = { x: 150, y: 1010, w: 460, h: 160 };
    const s = await spec(page, sel);
    t.ok(/^Mikron — 460 × 160 selection.*\nInside: div\.page › div\.container › section\.hero\n\ndiv\.plan — /.test(s), 'context then tree (bare `main` dropped):\n' + s);
    t.ok(!/^(div\.page|main|section\.hero) —/m.test(s), 'wrappers are not tree levels');
    const j = JSON.parse(await spec(page, sel, 'json'));
    t.eq(j.context, ['div.page', 'div.container', 'section.hero']);
    t.eq(j.children[0].label, 'div.plan');
  });

  test('P3 no context when the wrapper is not much larger than the selection; only 4 levels are listed', async (t) => {
    const page = await load(t, 'spec-wrappers.html', { width: 1000, height: 700 });
    await scrollTo(page, 1000);
    // the selection spans the whole page: no wrapper is > 2x its area
    const all = await spec(page, { x: 0, y: 0, w: 1000, h: 2400 });
    t.ok(!all.includes('Inside:'), 'no Inside line:\n' + all);
    // three more wrappers around the card -> page, main, div, hero, div, div, div, pricing, plan: the 4 innermost are listed
    await page.evaluate(() => {
      let host = document.querySelector('.pricing');
      for (let i = 0; i < 3; i++) { const d = document.createElement('div'); d.style.cssText = 'width:900px;padding:20px 0'; host.parentNode.insertBefore(d, host); d.appendChild(host); host = d; }
    });
    const s = await spec(page, { x: 200, y: 1090, w: 300, h: 40 });   // inside the card, which is a wrapper itself now
    t.ok(s.split('\n')[1] === 'Inside: div.container › section.hero › div.pricing › div.plan', 'innermost 4 named, outermost first (anonymous wrappers dropped):\n' + s);
  });

  test('S1a Inside: drops anonymous wrappers (bare tags) and is omitted when nothing named remains', async (t) => {
    const page = await load(t, 'spec-wrappers.html', { width: 1000, height: 700 });
    await scrollTo(page, 1000);
    const sel = { x: 150, y: 1010, w: 460, h: 160 };
    const s = await spec(page, sel);
    t.ok(/\nInside: div\.page › div\.container › section\.hero\n/.test(s), 'bare `main` is dropped:\n' + s);
    t.eq((await spec(page, sel, 'json').then(JSON.parse)).context, ['div.page', 'div.container', 'section.hero']);
    // every wrapper anonymous
    await page.evaluate(() => {
      document.querySelectorAll('.page,.container,.hero,.pricing').forEach((n) => { n.removeAttribute('class'); });
      document.querySelectorAll('.container,.hero,.pricing').length;
    });
    const s2 = await spec(page, sel);
    t.ok(!s2.includes('Inside:'), 'no Inside line:\n' + s2);
    const j = JSON.parse(await spec(page, sel, 'json'));
    t.ok(!('context' in j), 'no context key: ' + JSON.stringify(j.context));
  });

  test('S1b sub-pixel padding / gap / radius (< 0.5 layout px) read as 0 in the text and JSON spec', async (t) => {
    const page = await load(t, 'spec-wrappers.html', { width: 1000, height: 700 });
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('afterbegin', '<div id="sub" style="position:absolute;left:10px;top:10px;width:300px;height:80px;background:#ddd;padding:0.05px 44px 0;border-radius:0.2px;display:flex;gap:0.3px"><span style="width:50px;height:20px;background:#aaa"></span><span style="width:50px;height:20px;background:#bbb"></span></div>');
    });
    const sel = { x: 0, y: 0, w: 400, h: 120 };
    const s = await spec(page, sel);
    const line = s.split('\n').find((l) => l.startsWith('div#sub'));
    t.ok(line && /padding 0 44( |$)/.test(line) && !/0\.05/.test(line), 'padding 0 44 (0.05 -> 0):\n' + s);
    t.ok(!/radius|gap/.test(line), 'no radius/gap noise:\n' + line);
    const j = JSON.parse(await spec(page, sel, 'json'));
    const n = j.children.find((c) => c.label === 'div#sub');
    t.eq(n.padding, [0, 44, 0, 44]);
    t.ok(!('radius' in n) && !('gap' in n), 'json: ' + JSON.stringify(n));
  });

  test('S1c a truncated model adds a Note line after the heading (text) and "truncated": true (JSON)', async (t) => {
    const page = await load(t, 'spec-wrappers.html', { width: 1000, height: 700 });
    const sel = { x: 0, y: 0, w: 400, h: 120 };
    const [full, cut, cutJson, fullJson] = await page.evaluate((s) => {
      const m = __MIKRON__.scan();
      const t = { ...m, truncated: true };
      const f = (mm, format) => __MIKRON__.formatSpec(mm, s, { format });
      return [f(m), f(t), f(t, 'json'), f(m, 'json')];
    }, sel);
    const note = 'Note: page too large to measure completely; some elements are missing.';
    const lines = cut.split('\n');
    const at = lines.findIndex((l) => l.startsWith('Inside:')) + 1 || 1;
    t.eq(lines[at], note, 'note right after the heading / Inside line:\n' + cut);
    t.eq(cut.replace('\n' + note, ''), full, 'nothing else changes');
    t.ok(!full.includes('Note:'), 'no note when complete');
    t.eq(JSON.parse(cutJson).truncated, true, 'json truncated');
    t.ok(!('truncated' in JSON.parse(fullJson)), 'json: no key when complete');
  });

  test('demo card selection has no wrapper context and keeps its numbers', async (t) => {
    const page = await load(t, '/demo/index.html', { width: 718, height: 479 });
    const s = await spec(page, { x: 90, y: 20, w: 540, h: 450 });
    t.ok(!s.includes('Inside:'), 'no Inside line');
    t.ok(/main#card\.card — 480 × 391 · padding 8 · gap 20 · radius 20/.test(s), 'card line:\n' + s);
    t.ok(/li\.row — 464 × 73 · padding 16 · gap 12/.test(s), 'row line');
    t.ok(/button\.btn "Disconnect" — 97 × 32/.test(s), 'button');
  });
});
