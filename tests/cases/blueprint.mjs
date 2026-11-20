import { describe, test } from '../lib/harness.mjs';
import { state, waitState, ui, drag, pin, chips, arcs, chipsSettled, sleep, until, overlaps, rect } from '../lib/mk.mjs';

const DEMO = '/demo/index.html';
const FULL = [[90, 20], [630, 470]];
// demo card: 480 × 391 at (119, 44), radius 20
const CARD = { x: 119, y: 44, w: 480, h: 391, r: 20 };

function tally(list) {
  const m = {};
  for (const c of [...list].sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))) m[c.text] = (m[c.text] || 0) + 1;
  return m;
}

/** Per chip element: the sequence of texts it showed. */
function byElement(log) {
  const m = new Map();
  for (const e of log) {
    if (!m.has(e.id)) m.set(e.id, []);
    m.get(e.id).push(e);
  }
  return [...m.values()];
}

/** Record every text a chip shows while `fn` runs (MutationObserver on the open shadow root). */
async function recordChipTexts(p, fn) {
  await p.evaluate(() => {
    const sr = document.querySelector('mikron-root').shadowRoot;
    window.__chipLog = [];
    const ids = new WeakMap();
    let next = 1;
    const log = (n) => {
      const el = n.nodeType === 1 ? n : n.parentElement;
      if (!el || !el.classList || !el.classList.contains('mk-chip')) return;
      if (!ids.has(el)) ids.set(el, next++);
      window.__chipLog.push({ t: performance.now(), id: ids.get(el), kind: el.dataset.kind, text: el.textContent, x: Math.round(el.getBoundingClientRect().x), w: el.getBoundingClientRect().width });
    };
    window.__chipMo = new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === 'characterData') log(m.target);
        for (const n of m.addedNodes || []) if (n.nodeType === 1) log(n);
      }
    });
    window.__chipMo.observe(sr, { subtree: true, childList: true, characterData: true });
  });
  await fn();
  return p.evaluate(() => {
    window.__chipMo.disconnect();
    return window.__chipLog;
  });
}

async function ensureHost(p) {
  // create the overlay host (first arm) so a MutationObserver can be attached before the drag
  await p.mouse.move(40, 460);
  await p.keyboard.down('Shift');
  await sleep(280);
  await p.mouse.move(50, 466, { steps: 3 });
  await waitState(p, 'armed');
  await p.keyboard.up('Shift');
  await waitState(p, 'idle');
}

describe('blueprint (demo card)', () => {
  test('full-card selection: exact dimension chip set', async (t) => {
    const p = await t.open(DEMO);
    await pin(p, ...FULL, { pause: 150 });
    const c = await chipsSettled(p);
    const dims = tally(c.filter((x) => x.kind === 'dim'));
    t.eq(dims, { '3 × 40': 4, '40 × 40': 4, '480 × 391': 1, '97 × 32': 4 }, 'dimension chips');
  });

  test('full-card selection: spacing chips 8 / 16 / 12 / 4 / 20 present, all integers', async (t) => {
    const p = await t.open(DEMO);
    await pin(p, ...FULL, { pause: 150 });
    const c = await chipsSettled(p);
    const sp = tally(c.filter((x) => x.kind === 'space'));
    for (const v of ['8', '16', '12', '4', '20']) t.ok(sp[v] > 0, `spacing chip ${v} present (got ${JSON.stringify(sp)})`);
    for (const k of Object.keys(sp)) t.ok(/^\d+$/.test(k), `spacing chip "${k}" is an integer`);
  });

  test('dimension chips sit under their element (5 px for atoms, 8 px for containers)', async (t) => {
    const p = await t.open(DEMO);
    await pin(p, ...FULL, { pause: 150 });
    const c = await chipsSettled(p);
    const card = c.find((x) => x.text === '480 × 391');
    t.ok(card, 'card chip');
    t.near(card.y, CARD.y + CARD.h + 8, 1, 'card chip top');
    t.near(card.x + card.w / 2, CARD.x + CARD.w / 2, 1, 'card chip centred');
    const btn = await rect(p, '.btn');
    const bchip = c.filter((x) => x.text === '97 × 32').sort((a, b) => a.y - b.y)[0];
    t.near(bchip.x + bchip.w / 2, btn.x + btn.w / 2, 1, 'button chip centred');
    t.ok(Math.abs(bchip.y - (btn.y + btn.h + 5)) < 1 || Math.abs(bchip.y + 8 - (btn.y + btn.h / 2)) < 1, `button chip below (5px) or centred: chip.y=${bchip.y} btn=${JSON.stringify(btn)}`);
  });

  test('atom dimension chips: 3 × 40 and 40 × 40 sit right of their element on the row centre line; buttons keep theirs below', async (t) => {
    const p = await t.open(DEMO);
    await pin(p, ...FULL, { pause: 150 });
    const c = await chipsSettled(p);
    const row = await rect(p, '.row');
    const mid = row.y + row.h / 2;
    for (const [txt, sel] of [['3 × 40', '.status'], ['40 × 40', '.icon']]) {
      const el = await rect(p, sel);
      const ch = c.filter((x) => x.text === txt).sort((a, b) => a.y - b.y)[0];
      t.ok(ch, `${txt} chip`);
      t.near(ch.x, el.x + el.w + 5, 1.5, `${txt} starts 5 px right of its element`);
      t.near(ch.y + ch.h / 2, mid, 2.5, `${txt} on the row centre line`);
    }
    const btn = await rect(p, '.btn');
    const bc = c.filter((x) => x.text === '97 × 32').sort((a, b) => a.y - b.y)[0];
    t.near(bc.y, btn.y + btn.h + 5, 1.5, '97 × 32 stays 5 px below the button');
  });

  test('row padding chips (16) beside the rows are not dropped by the overflow clip', async (t) => {
    const p = await t.open(DEMO);
    await pin(p, ...FULL, { pause: 150 });
    const c = await chipsSettled(p);
    const n = c.filter((x) => x.kind === 'space' && x.text === '16').length;
    t.ok(n >= 8, `16 chips: ${n}`);
  });

  test('dismiss releases the canvas backing store and the next drag still renders', async (t) => {
    const p = await t.open(DEMO);
    const cw = () => p.evaluate(() => document.querySelector('mikron-root').shadowRoot.querySelector('.mk-bp-canvas').width);
    await pin(p, ...FULL, { pause: 150 });
    await chipsSettled(p);
    t.ok((await cw()) > 0, 'canvas allocated while a selection is shown');
    await p.keyboard.press('Escape');
    await until(async () => (await cw()) === 0, { timeout: 2000 }).catch(() => {});
    t.eq(await cw(), 0, 'canvas width after dismiss');
    await pin(p, ...FULL, { pause: 150 });
    const c = await chipsSettled(p);
    t.ok((await cw()) > 0 && c.some((x) => x.text === '480 × 391'), 'second drag renders');
  });

  test('no two live chips overlap', async (t) => {
    const p = await t.open(DEMO);
    await pin(p, ...FULL, { pause: 150 });
    const c = await chipsSettled(p);
    const bad = [];
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) if (overlaps(c[i], c[j], 0.5)) bad.push(`${c[i].text}@${Math.round(c[i].x)},${Math.round(c[i].y)} × ${c[j].text}@${Math.round(c[j].x)},${Math.round(c[j].y)}`);
    t.eq(bad, [], 'overlapping chips');
  });

  test('no two chips overlap on light.html (hero + cards selection)', async (t) => {
    const p = await t.open('/demo/light.html');
    await pin(p, [5, 70], [710, 475], { pause: 150 });
    const c = await chipsSettled(p);
    t.ok(c.length > 5, `chips present (${c.length})`);
    const bad = [];
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) if (overlaps(c[i], c[j], 0.5)) bad.push(`${c[i].text}@${Math.round(c[i].x)},${Math.round(c[i].y)} × ${c[j].text}@${Math.round(c[j].x)},${Math.round(c[j].y)}`);
    t.eq(bad, [], 'overlapping chips');
  });

  test('radius callout follows the card corner nearest the pointer (br)', async (t) => {
    const p = await t.open(DEMO);
    await pin(p, ...FULL, { pause: 200 });
    const a = await arcs(p);
    const br = { x: CARD.x + CARD.w - CARD.r, y: CARD.y + CARD.h - CARD.r };
    t.ok(a.some((d) => Math.abs(d.x - br.x) < 1.5 && Math.abs(d.y - br.y) < 1.5), `callout dot at card br centre ${JSON.stringify(br)}; dots ${JSON.stringify(a.map((d) => [d.x, d.y]))}`);
    const c = await chipsSettled(p);
    t.ok(c.some((x) => x.kind === 'radius' && x.text === 'r 20'), 'r 20 chip');
  });

  test('reverse drag puts the callout on the top-left corner', async (t) => {
    const p = await t.open(DEMO);
    await pin(p, FULL[1], FULL[0], { pause: 200 });
    const a = await arcs(p);
    const tl = { x: CARD.x + CARD.r, y: CARD.y + CARD.r };
    t.ok(a.some((d) => Math.abs(d.x - tl.x) < 1.5 && Math.abs(d.y - tl.y) < 1.5), `callout at card tl; dots ${JSON.stringify(a.map((d) => [d.x, d.y]))}`);
  });

  test('radius callout switches corner when the pointer side changes (br -> tr)', async (t) => {
    const p = await t.open(DEMO);
    await drag(p, FULL[0], FULL[1], { release: false, keepMod: true, pause: 250 });
    const br = { x: CARD.x + CARD.w - CARD.r, y: CARD.y + CARD.h - CARD.r };
    const tr = { x: CARD.x + CARD.w - CARD.r, y: CARD.y + CARD.r };
    const has = (list, pt) => list.some((d) => Math.abs(d.x - pt.x) < 1.5 && Math.abs(d.y - pt.y) < 1.5);
    t.ok(has(await arcs(p), br), 'callout at br first');
    await p.mouse.move(630, 300, { steps: 6 });
    await sleep(250);
    const a = await arcs(p);
    await p.mouse.up();
    await p.keyboard.up('Shift');
    t.ok(has(a, tr), `callout moved to tr; dots ${JSON.stringify(a.map((d) => [d.x, d.y]))}`);
    t.ok(!has(a, br), 'old br callout removed');
  });

  test('tight selection around one button shows its radius (r 8)', async (t) => {
    const p = await t.open(DEMO);
    const b = await rect(p, '.btn');
    await pin(p, [b.x - 12, b.y - 12], [b.x + b.w + 12, b.y + b.h + 28], { pause: 200 });
    const c = await chipsSettled(p);
    t.ok(c.some((x) => x.kind === 'radius' && x.text === 'r 8'), `r 8 chip; chips ${JSON.stringify(c.map((x) => x.text))}`);
    t.ok(c.some((x) => x.text === '97 × 32'), '97 × 32 chip');
  });

  test('chips straddling the selection edge are clipped, not hidden', async (t) => {
    const p = await t.open(DEMO);
    const card = { x: CARD.x, y: CARD.y };
    // right edge through the middle of the card's dimension chip
    await pin(p, [100, 30], [360, 456], { pause: 150 });
    const u = await ui(p);
    const c = await chipsSettled(p);
    const right = u.marquee.x + u.marquee.w;
    const straddle = c.filter((x) => x.x < right - 1 && x.x + x.w > right + 1);
    t.ok(straddle.length >= 1, `a chip straddles the right edge at ${right}: ${JSON.stringify(c.map((x) => [x.text, Math.round(x.x), Math.round(x.x + x.w)]))}`);
    const m = /inset\(([\d.]+)px ([\d.]+)px ([\d.]+)px ([\d.]+)px\)/.exec(u.bpClip || '');
    t.ok(m, `blueprint clip-path set: ${u.bpClip}`);
    t.near(718 - Number(m[2]), right - 1, 1, 'clip right edge inside the 1px border');
    t.near(Number(m[4]), u.marquee.x + 1, 1, 'clip left edge');
  });

  test('count-up runs from 0 through intermediate values to the exact value (~450 ms)', async (t) => {
    const p = await t.open(DEMO);
    await ensureHost(p);
    const log = await recordChipTexts(p, async () => {
      await pin(p, ...FULL, { pause: 100 });
      await sleep(700);
    });
    const btn = byElement(log).find((seq) => seq[seq.length - 1].text === '97 × 32') || [];
    const texts = btn.map((e) => e.text).filter((s, i, a) => i === 0 || s !== a[i - 1]);
    t.ok(btn.length, 'a 97 × 32 chip was revealed');
    t.ok(texts[0] === '0 × 0', `first value 0 × 0 (got ${texts.slice(0, 3)})`);
    t.ok(texts.includes('97 × 32'), 'ends at 97 × 32');
    const mids = texts.filter((s) => s !== '0 × 0' && s !== '97 × 32');
    t.ok(mids.length >= 3, `intermediate values seen: ${mids.slice(0, 8)}`);
    const first = btn[0].t, end = btn.find((e) => e.text === '97 × 32').t;
    t.ok(end - first > 300 && end - first < 700, `count-up duration ${Math.round(end - first)} ms`);
    t.eq([...new Set(btn.map((e) => e.w))].length, 1, `chip width constant during the count-up (${[...new Set(btn.map((e) => e.w))]})`);
    // monotonic
    const ws = texts.map((s) => Number(s.split(' × ')[0]));
    t.ok(ws.every((v, i) => i === 0 || v >= ws[i - 1]), `monotonic: ${ws}`);
  });

  test('a chip that leaves the selection and re-enters replays its count-up', async (t) => {
    const p = await t.open(DEMO);
    await ensureHost(p);
    const card = CARD;
    // the card dim chip lives below the card (y ≈ 443..459)
    const log = await recordChipTexts(p, async () => {
      await drag(p, [90, 20], [630, 470], { release: false, keepMod: true, pause: 600 });
      await p.mouse.move(630, 300, { steps: 5 }); // chip leaves
      await sleep(200);
      await p.mouse.move(630, 470, { steps: 5 }); // chip re-enters
      await sleep(600);
      await p.mouse.up();
      await p.keyboard.up('Shift');
    });
    const seqs = byElement(log).filter((seq) => seq.some((e) => e.text === '480 × 391'));
    t.ok(seqs.length >= 2, `card chip element revealed twice (saw ${seqs.length})`);
    for (const seq of seqs) t.eq(seq[0].text, '0 × 0', 'each reveal starts at 0 × 0');
  });

  test('chip elements are created lazily (tiny selection -> only the chips it touches)', async (t) => {
    const p = await t.open(DEMO);
    await drag(p, [140, 120], [160, 140], { release: false, keepMod: true, pause: 100 });
    const n = (await ui(p)).chipCount;
    await p.mouse.up();
    await p.keyboard.up('Shift');
    t.ok(n <= 3, `live chips for a 20 × 20 selection: ${n}`);
  });

  test('rescan on scroll does not replay count-ups of already revealed chips', async (t) => {
    const p = await t.open('/tests/fixtures/gesture.html');
    await pin(p, [20, 20], [460, 180], { pause: 100 });
    await chipsSettled(p);
    const log = await recordChipTexts(p, async () => {
      await p.evaluate(() => window.scrollTo(0, 10));
      await sleep(400);
    });
    t.eq(log.filter((e) => /\b0\b/.test(e.text) && !/[1-9]/.test(e.text)).map((e) => e.text), [], 'chips restarted from 0');
  });
});

const STYLE = `<style>body{margin:0;background:#fff;font:14px system-ui;display:block}
ul{list-style:none;margin:20px;padding:0;width:560px;border:1px solid #ddd;border-radius:8px}
.r{display:flex;align-items:center;gap:12px;padding:10px 12px;border-bottom:1px solid #eee}
.ic{width:16px;height:16px;background:#999;border-radius:3px;flex:none}.t{flex:1}
button{padding:4px 10px;border:1px solid #bbb;border-radius:6px;background:#fff}</style>`;
const LIST = `${STYLE}<ul>${'<li class="r"><i class="ic"></i><div class="t">Item name</div><button>Open</button></li>'.repeat(20)}</ul>`;
const IDROWS = `${STYLE}<div style="margin:20px;width:560px">${Array.from({ length: 20 }, (_, i) => `<div class="r" id="row-${i}"><i class="ic"></i><div class="t">Item ${i}</div></div>`).join('')}</div>`;
const TABLE = `<style>body{margin:0;background:#fff;font:14px system-ui;display:block}
table{margin:20px;border-collapse:separate;border-spacing:3px}td{padding:3px;background:#eef;border-radius:2px;width:40px}</style>
<table>${('<tr>' + '<td>cell</td>'.repeat(12) + '</tr>').repeat(8)}</table>`;
const PAD3 = `<style>body{margin:0;background:#fff;font:14px system-ui}div{padding:3px;background:#eef;margin:12px;border-radius:4px;display:inline-block;vertical-align:top}</style>${[60, 70, 80, 90, 100, 110].map((w, i) => `<div style="width:${w}px;height:${50 + i * 7}px"><span>c${i}</span></div>`).join('')}`;

/** Index of the row (selector) whose rect contains the chip centre; -1 if none. */
async function rowOf(p, sel, ch) {
  return p.evaluate(([s, cy]) => [...document.querySelectorAll(s)].findIndex((e) => { const b = e.getBoundingClientRect(); return cy >= b.top && cy <= b.bottom; }), [sel, ch.y + ch.h / 2]);
}
const setPage = (p, html) => p.evaluate((h) => { document.body.innerHTML = h; }, html);

describe('blueprint repeated siblings (selection-relative dedupe)', () => {
  test('20 identical rows, selection in the middle: exactly one row carries chips, all in that row', async (t) => {
    const p = await t.open(DEMO);
    await setPage(p, LIST);
    await pin(p, [10, 200], [640, 460], { pause: 150 }); // the first row is far outside the selection
    const c = await chipsSettled(p);
    const ic = c.filter((x) => x.text === '16 × 16'), op = c.filter((x) => x.kind === 'dim' && /^\d+ × \d+$/.test(x.text) && x.text !== '16 × 16' && x.x > 380);
    t.eq(ic.length, 1, `one 16 × 16 chip (chips: ${c.map((x) => x.text)})`);
    t.eq(op.length, 1, 'one button chip');
    t.eq(await rowOf(p, '.r', ic[0]), await rowOf(p, '.r', op[0]), 'icon and button chips are in the same row');
    t.ok(await rowOf(p, '.r', ic[0]) > 2, 'the row is one that is inside the selection, not the first row');
  });

  test('the carrying row does not hop while the pinned selection scrolls with the page', async (t) => {
    const p = await t.open(DEMO);
    await setPage(p, LIST);
    await pin(p, [10, 200], [640, 460], { pause: 150 });
    const rows = [];
    for (let i = 0; i < 4; i++) {
      const c = await chipsSettled(p);
      const ic = c.filter((x) => x.text === '16 × 16');
      rows.push(ic.length === 1 ? await rowOf(p, '.r', ic[0]) : -1);
      await p.mouse.wheel(0, 20);
      await sleep(250);
    }
    t.ok(rows.every((r) => r >= 0 && r === rows[0]), `carrying row per step ${rows}`);
  });

  test('rows with unique #ids still group (tr#row-N style)', async (t) => {
    const p = await t.open(DEMO);
    await setPage(p, IDROWS);
    await pin(p, [10, 100], [640, 460], { pause: 150 });
    const c = await chipsSettled(p);
    t.eq(c.filter((x) => x.text === '16 × 16').length, 1, `one 16 × 16 chip (chips: ${c.map((x) => x.text)})`);
  });

  test('a lone first member outside the selection no longer hides everything (table, selection in the middle)', async (t) => {
    const p = await t.open(DEMO);
    await setPage(p, TABLE);
    await pin(p, [120, 150], [300, 300], { pause: 150 });
    const c = await chipsSettled(p);
    t.ok(c.length > 0, `chips present (${c.length})`);
    const bad = [];
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) if (overlaps(c[i], c[j], 0.5)) bad.push(`${c[i].text} × ${c[j].text}`);
    t.eq(bad, [], 'overlapping chips');
  });

  test('bands keep drawing for every member: chips only on one row but the canvas is painted over all rows', async (t) => {
    const p = await t.open(DEMO);
    await setPage(p, LIST);
    await pin(p, [10, 200], [640, 460], { pause: 150 });
    await chipsSettled(p);
    const n = await p.evaluate(() => {
      const cv = document.querySelector('mikron-root').shadowRoot.querySelector('.mk-bp-canvas');
      const g = cv.getContext('2d'), d = g.getImageData(0, 0, cv.width, cv.height).data;
      let k = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) k++;
      return k / (cv.width * cv.height);
    });
    t.ok(n > 0.5, `painted fraction ${n.toFixed(2)}`);
  });
});

const GROUPS = `<style>body{display:block;margin:0;background:#fff;font:14px system-ui}
ul{position:absolute;left:20px;top:20px;list-style:none;margin:0;padding:10px 10px 10px 40px;width:400px;background:#f4f4ff;border-radius:8px}
li{padding:6px 8px;height:32px;box-sizing:border-box;background:#e8e8ff;margin:0 0 4px;border-radius:4px}</style>
<ul id=ul>${Array.from({ length: 8 }, (_, i) => `<li><b>Row ${i}</b></li>`).join('')}</ul>
<div style="position:absolute;left:20px;top:344px;width:300px;height:30px;background:#ffe8c8"></div>`;

describe('blueprint repeated siblings: hidden members and the active row', () => {
  test('list padding and row-gap chips are not pushed out by the hidden rows\' chips (one row annotated)', async (t) => {
    const p = await t.open(DEMO);
    await setPage(p, GROUPS);
    const u = await rect(p, '#ul');
    await pin(p, [6, 6], [u.x + u.w + 30, u.y + u.h + 30], { pause: 150 });
    const c = await chipsSettled(p);
    const n = (txt) => c.filter((x) => x.kind === 'space' && x.text === txt).length;
    t.eq(n('40'), 1, `list left padding chip (${c.map((x) => x.text)})`);
    t.eq(n('10'), 3, 'list top / right / bottom padding chips');
    t.ok(n('4') >= 1, `at least one row-gap chip (${n('4')})`);
    t.eq(c.filter((x) => x.text === '350 × 32').length, 1, 'exactly one annotated row');
    t.eq(c.filter((a, i) => c.some((b, j) => j > i && overlaps(a, b, 0.5))).length, 0, 'no chips overlap');
  });

  test('a drag that starts inside a row ends with a fully visible row annotated, not the cut-off one', async (t) => {
    const p = await t.open(DEMO);
    await setPage(p, GROUPS);
    const rows = await p.evaluate(() => [...document.querySelectorAll('#ul li')].map((e) => { const b = e.getBoundingClientRect(); return [b.top, b.bottom]; }));
    const y0 = Math.round(rows[2][0] + 0.7 * 32), y1 = Math.round((rows[6][0] + rows[6][1]) / 2);
    await pin(p, [50, y0], [470, y1], { pause: 150 });
    const c = await chipsSettled(p);
    const d = c.filter((x) => x.text === '350 × 32');
    t.eq(d.length, 1, `one annotated row (${c.map((x) => x.text)})`);
    const row = await rowOf(p, '#ul li', d[0]);
    t.ok(row >= 0 && rows[row][0] >= y0 && rows[row][1] <= y1, `annotated row ${row} [${rows[row]}] lies inside the selection y ${y0}..${y1}`);
  });
});

describe('blueprint lod-1 chips (hysteresis + fade)', () => {
  test('lod-1 "3" chips: shown on small selections, hidden above 66 000 px², fade out (no pop), back below 54 000, nothing leaks', async (t) => {
    const p = await t.open(DEMO);
    await setPage(p, PAD3);
    await p.mouse.move(250, 0);
    await p.keyboard.down('Shift');
    await sleep(300);
    await p.mouse.move(260, 2, { steps: 3 });
    await p.mouse.down();
    await p.evaluate(() => {
      window.__L = [];
      window.__on = true;
      const f = () => {
        if (!window.__on) return;
        const h = document.querySelector('mikron-root'), sr = h && h.shadowRoot;
        if (sr) {
          const cs = [...sr.querySelectorAll('.mk-chip[data-kind=space]')].filter((c) => c.textContent === '3');
          const m = sr.querySelector('.mk-marquee'), b = m && m.getBoundingClientRect();
          window.__L.push({ n: cs.length, op: cs.map((c) => +getComputedStyle(c).opacity), pos: cs.map((c) => c.style.left + ',' + c.style.top), area: b ? b.width * b.height : 0 });
        }
        requestAnimationFrame(f);
      };
      f();
    });
    await p.mouse.move(418, 370, { steps: 25 }); await sleep(250); // between thresholds
    await p.mouse.move(418, 430, { steps: 25 }); await sleep(300); // above 66 000
    await p.mouse.move(418, 370, { steps: 25 }); await sleep(250); // back in the band: still hidden
    const mid = await p.evaluate(() => window.__L[window.__L.length - 1]);
    await p.mouse.move(418, 330, { steps: 25 }); await sleep(400); // below 54 000
    const L = await p.evaluate(() => { window.__on = false; return window.__L; });
    await p.mouse.up();
    await p.keyboard.up('Shift');
    const before = L.filter((f) => f.area > 40000 && f.area < 54000 && f.n > 0);
    t.ok(before.length > 0, `lod-1 chips visible below the thresholds: ${JSON.stringify(L.filter((f, i) => i % 12 === 0).map((f) => [Math.round(f.area), f.n]))}`);
    t.eq(mid.n, 0, `hidden while inside the hysteresis band (area ${Math.round(mid.area)})`);
    t.ok(L.every((f) => f.area <= 66000 || f.op.every((o) => o <= 1)), 'opacities sane');
    const fading = L.filter((f) => f.op.some((o) => o > 0.02 && o < 0.98));
    t.ok(fading.length >= 2, `intermediate opacities seen while hiding (${fading.length} frames)`);
    t.eq(L.filter((f) => new Set(f.pos).size !== f.pos.length).length, 0, 'no duplicate chips at one position');
    t.ok(L[L.length - 1].n > 0, 'chips are back after dropping below 54 000 px²');
    await p.keyboard.press('Escape');
    await sleep(700);
    t.eq((await ui(p) || { chipCount: 0 }).chipCount, 0, 'no chip elements left after dismiss');
  });
});

describe('blueprint radius callouts (sticky, nested, no giant arcs)', () => {
  /** Per-frame list of "r<radius>:<corner>" of the live arcs, deduped. */
  async function logCorners(p, fn) {
    await p.evaluate(() => {
      window.__L = [];
      window.__on = true;
      const f = () => {
        if (!window.__on) return;
        const sr = document.querySelector('mikron-root') && document.querySelector('mikron-root').shadowRoot;
        if (sr) {
          window.__L.push([...sr.querySelectorAll('.mk-arcs g')].map((g) => {
            const m = g.querySelector('path').getAttribute('d').match(/M([\d.-]+),([\d.-]+)A([\d.-]+),[\d.-]+ 0 0 1 ([\d.-]+),([\d.-]+)/);
            const [sx, sy, r, ex, ey] = m.slice(1).map(Number);
            return 'r' + r + ':' + (ex > sx && ey < sy ? 'tl' : ex > sx && ey > sy ? 'tr' : ex < sx && ey > sy ? 'br' : 'bl');
          }).sort().join(' '));
        }
        requestAnimationFrame(f);
      };
      f();
    });
    await fn();
    return p.evaluate(() => {
      window.__on = false;
      const out = [];
      for (const s of window.__L) if (out[out.length - 1] !== s) out.push(s);
      return out;
    });
  }

  test('drag 1 (38,27 -> 642,459): callouts start top-left and end bottom-right; the card never visits tr/bl', async (t) => {
    const p = await t.open(DEMO);
    await p.mouse.move(28, 17);
    await p.keyboard.down('Shift');
    await sleep(300);
    await p.mouse.move(38, 27, { steps: 3 });
    await p.mouse.down();
    const seq = await logCorners(p, async () => { await p.mouse.move(642, 459, { steps: 40 }); await sleep(500); });
    await p.mouse.up();
    await p.keyboard.up('Shift');
    t.eq(seq[seq.length - 1], 'r12:br r20:br', `final corners (sequence ${JSON.stringify(seq)})`);
    t.ok(seq.some((s) => s.includes('r20:tl')), 'the card callout first appears top-left');
    t.ok(!seq.some((s) => /r20:(tr|bl)/.test(s)), 'never tr/bl');
  });

  test('drag 2 (633,436 -> 173,108): callouts stay bottom-right although the pointer ends top-left; nested chips take opposite sides', async (t) => {
    const p = await t.open(DEMO);
    await p.mouse.move(633, 436);
    await p.keyboard.down('Shift');
    await sleep(300);
    await p.mouse.move(633, 437, { steps: 2 });
    await p.mouse.down();
    const seq = await logCorners(p, async () => { await p.mouse.move(173, 108, { steps: 40 }); await sleep(500); });
    await p.mouse.up();
    await p.keyboard.up('Shift');
    await waitState(p, 'pinned');
    t.ok(seq.length >= 1 && seq.every((s) => s === '' || s === 'r12:br r20:br'), `corners ${JSON.stringify(seq)}`);
    const c = await chipsSettled(p);
    const rad = c.filter((x) => x.kind === 'radius');
    t.eq(rad.length, 2, 'two radius chips');
    const inCard = (ch) => ch.x >= CARD.x && ch.x + ch.w <= CARD.x + CARD.w && ch.y >= CARD.y && ch.y + ch.h <= CARD.y + CARD.h;
    t.eq(rad.filter(inCard).length, 1, `exactly one chip inward, the other outward: ${JSON.stringify(rad.map((x) => [x.text, Math.round(x.x), Math.round(x.y)]))}`);
    const btns = await p.evaluate(() => [...document.querySelectorAll('.btn')].map((e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }));
    for (const ch of rad) for (const b of btns) t.ok(!overlaps(ch, b, 0.5), `${ch.text} chip does not cover a button plate`);
    t.eq(c.filter((a, i) => c.some((b, j) => j > i && overlaps(a, b, 0.5))).length, 0, 'no chips overlap');
  });

  test('giant arcs are skipped (radius > 64, or >= min(w,h)/2 on a wide element); a normal radius still gets one', async (t) => {
    const p = await t.open(DEMO);
    await setPage(p, `<style>body{margin:0;background:#fff;display:block}div{position:absolute;background:#eef;left:20px}</style>
      <div id=a style="top:10px;width:300px;height:200px;border-radius:200px"></div>
      <div id=b style="top:220px;width:300px;height:240px;border-radius:80px"></div>
      <div id=c style="top:10px;left:340px;width:200px;height:150px;border-radius:20px"></div>`);
    await pin(p, [8, 4], [700, 470], { pause: 200 });
    await chipsSettled(p);
    const a = await arcs(p);
    const ds = a.map((x) => x.d.match(/A([\d.]+),/)[1]);
    t.eq(ds, ['20'], `only the r 20 callout is drawn (radii ${ds})`);
  });
});

describe('blueprint chip placement polish', () => {
  test('card padding "8" chips: none stray in the left / right gutter (dropped rather than slid away from their I-beam)', async (t) => {
    const p = await t.open(DEMO);
    await pin(p, [38, 27], [642, 459], { pause: 200 });
    const c = await chipsSettled(p);
    const eights = c.filter((x) => x.kind === 'space' && x.text === '8');
    t.ok(eights.length >= 1, `the card's top padding chip is still shown (${eights.length})`);
    const cx = CARD.x + CARD.w / 2;
    const stray = eights.filter((x) => Math.abs(x.x + x.w / 2 - cx) > 40);
    t.eq(stray.map((x) => [Math.round(x.x), Math.round(x.y)]), [], 'no 8 chip beside the card sides');
  });

  // ---- per-frame helpers: sample every live chip on every animation frame while a real drag runs ----
  const line = (a, b, n) => Array.from({ length: n }, (_, i) => [a[0] + ((b[0] - a[0]) * (i + 1)) / n, a[1] + ((b[1] - a[1]) * (i + 1)) / n]);
  async function paced(p, pts, ms) { // wall-clock paced pointer moves (a realistic 400-700 px/s, many intermediate frames)
    const t0 = Date.now();
    for (let i = 0; i < pts.length; i++) {
      const wait = t0 + (ms * (i + 1)) / pts.length - Date.now();
      if (wait > 0) await sleep(wait);
      await p.mouse.move(pts[i][0], pts[i][1]);
    }
  }
  async function startSampler(p) {
    await p.evaluate(() => {
      window.__F = []; window.__on = true; window.__ids = new WeakMap(); window.__n = 1;
      const f = () => {
        if (!window.__on) return;
        const h = document.querySelector('mikron-root'), sr = h && h.shadowRoot;
        const cs = sr ? [...sr.querySelectorAll('.mk-chip')].map((c) => {
          if (!window.__ids.has(c)) window.__ids.set(c, window.__n++);
          const r = c.getBoundingClientRect(), st = getComputedStyle(c);
          return { id: window.__ids.get(c), kind: c.dataset.kind, text: c.textContent, x: r.x, y: r.y, w: r.width, h: r.height, op: +st.opacity, tr: st.transitionDuration };
        }) : [];
        window.__F.push(cs);
        requestAnimationFrame(f);
      };
      f();
    });
  }
  const stopSampler = (p) => p.evaluate(() => { window.__on = false; return window.__F; });
  async function pressAt(p, from) {
    await p.mouse.move(from[0] - 10, from[1] - 10);
    await p.keyboard.down('Shift');
    await sleep(300);
    await p.mouse.move(from[0], from[1], { steps: 3 });
    await p.mouse.down();
  }
  async function release(p) { await p.mouse.up(); await p.keyboard.up('Shift'); await waitState(p, 'pinned'); }
  const inCard = (c) => c.x + c.w / 2 > CARD.x && c.x + c.w / 2 < CARD.x + CARD.w && c.y + c.h / 2 > CARD.y && c.y + c.h / 2 < CARD.y + CARD.h;
  const radOf = (frame) => frame.filter((c) => c.kind === 'radius');
  const lastRad = (frames) => radOf(frames[frames.length - 1]);

  /** B: no two live chips intersect on any frame; a radius chip is only ever at whole-pixel rects, never mid-glide. */
  function checkFrames(t, frames, what) {
    t.ok(frames.length > 20, `${what}: enough frames sampled (${frames.length})`);
    let bad = 0, firstBad = null;
    frames.forEach((f, i) => {
      for (let a = 0; a < f.length; a++) for (let b = a + 1; b < f.length; b++) if (overlaps(f[a], f[b], 0)) { bad++; firstBad ||= `frame ${i}: ${f[a].text}@${f[a].x},${f[a].y} x ${f[b].text}@${f[b].x},${f[b].y}`; }
    });
    t.eq(bad, 0, `${what}: frames with two intersecting live chips (${firstBad})`);
    const frac = [];
    let moving = 0;
    const prev = new Map();
    frames.forEach((f) => {
      for (const c of radOf(f)) {
        if (!Number.isInteger(c.x) || !Number.isInteger(c.y)) frac.push(`${c.text}@${c.x},${c.y}`);
        if (c.tr !== '0s') moving++;
        const q = prev.get(c.id);
        if (q && (q.x !== c.x || q.y !== c.y)) { /* a relocation: jumps by whole spots, checked below */ }
        prev.set(c.id, c);
      }
    });
    t.eq(frac, [], `${what}: radius chips only at whole-pixel rects (no interpolated frames)`);
    t.eq(moving, 0, `${what}: no CSS transition on any radius chip`);
  }
  /** Relocations of radius chips: [{id, from, to}] (a chip is either at the old rect or at the new one). */
  function relocations(frames) {
    const out = [], last = new Map();
    for (const f of frames) for (const c of radOf(f)) {
      const q = last.get(c.id);
      if (q && (q.x !== c.x || q.y !== c.y)) out.push({ id: c.id, from: [q.x, q.y], to: [c.x, c.y] });
      last.set(c.id, c);
    }
    return out;
  }
  function checkArrangement(t, rad, what, side) {
    const r20 = rad.find((x) => x.text === 'r 20'), r12 = rad.find((x) => x.text === 'r 12');
    t.ok(r20 && r12, `${what}: both radius chips present (${JSON.stringify(rad.map((x) => x.text))})`);
    if (!(r20 && r12)) return;
    t.ok(inCard(r20), `${what}: r 20 inward (inside the card): ${JSON.stringify([r20.x, r20.y])}`);
    t.ok(!inCard(r12), `${what}: r 12 outward (beyond the card corner): ${JSON.stringify([r12.x, r12.y])}`);
    if (side === 'br') t.ok(r12.x >= CARD.x + CARD.w - 28, `${what}: r 12 beside / beyond the br corner (x ${r12.x})`);
    else t.ok(r12.x + r12.w <= CARD.x + 28, `${what}: r 12 beside / beyond the bl corner (right edge ${r12.x + r12.w})`);
  }

  async function drag1Hold(p, hold = 600) {
    await pressAt(p, [38, 27]);
    await startSampler(p);
    await paced(p, line([38, 27], [642, 459], 70), 1100);
    await sleep(hold);
    return stopSampler(p);
  }
  async function drag2(p, pts, ms) {
    await pressAt(p, [633, 436]);
    await startSampler(p);
    await paced(p, pts, ms);
    await sleep(600);
    return stopSampler(p);
  }

  test('A+B drag 1 (38,27 -> 642,459, hold 604 x 432): r 20 inward, r 12 outward; no frame with intersecting chips', async (t) => {
    const p = await t.open(DEMO);
    const fr = await drag1Hold(p);
    await release(p);
    checkArrangement(t, lastRad(fr), 'drag 1 hold', 'br');
    checkFrames(t, fr, 'drag 1');
    const pinned = (await chipsSettled(p)).filter((x) => x.kind === 'radius');
    checkArrangement(t, pinned, 'drag 1 pinned', 'br');
  });

  test('A+B drag 1 pulled back to 304 x 420 (card left part + bottom-left corner): r 20 inward, r 12 outward', async (t) => {
    const p = await t.open(DEMO);
    await drag1Hold(p, 200);
    await startSampler(p);
    await paced(p, line([642, 459], [342, 447], 45), 700);
    await sleep(700);
    const fr = await stopSampler(p);
    await release(p);
    checkArrangement(t, lastRad(fr), 'pause 304 x 420', 'bl');
    checkFrames(t, fr, 'pull back');
  });

  test('A+B drag 2 (633,436 -> 173,108): r 20 inward, r 12 outward; the inward chip fades in without crossing r 12', async (t) => {
    const p = await t.open(DEMO);
    const fr = await drag2(p, line([633, 436], [173, 108], 62), 1000);
    await release(p);
    checkArrangement(t, lastRad(fr), 'drag 2', 'br');
    checkFrames(t, fr, 'drag 2');
    const moves = relocations(fr);
    // a relocation is a jump (old rect -> new rect) that restarts at opacity 0 and never lands on another live chip
    const first = fr.findIndex((f, i) => i > 0 && radOf(f).some((c) => moves.some((m) => m.id === c.id && c.x === m.to[0] && c.y === m.to[1]) && c.op < 0.9));
    t.ok(moves.length === 0 || first > 0, `relocated chips fade in (relocations ${JSON.stringify(moves)})`);
    // a chip that appears for the first time counts up from 0 (only a relocation skips it), the inward one included
    if (!(await p.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches))) {
      const num = (c) => +c.text.replace(/\D+/g, '');
      const seq = new Map();
      for (const f of fr) for (const c of radOf(f)) { if (!seq.has(c.id)) seq.set(c.id, []); seq.get(c.id).push(num(c)); }
      const fin = lastRad(fr);
      t.ok(fin.length === 2 && fin.every((c) => seq.has(c.id)), 'both radius chips sampled');
      for (const c of fin) {
        const v = seq.get(c.id);
        t.ok(v.some((x) => x < num(c)), `${c.text} counts up after it first appears (values ${JSON.stringify(v.filter((x, i) => i === 0 || x !== v[i - 1]))})`);
      }
    }
    const pinned = (await chipsSettled(p)).filter((x) => x.kind === 'radius');
    checkArrangement(t, pinned, 'drag 2 pinned', 'br');
  });

  test('A drag 2 at 20 / 60 / 200 steps and on a left-then-up path: same final arrangement, no overlaps', async (t) => {
    const A = [633, 436], B = [173, 108];
    const runs = [['20 steps', line(A, B, 20), 1000], ['60 steps', line(A, B, 60), 1000], ['200 steps', line(A, B, 200), 1000],
      ['left then up', [...line(A, [173, 436], 40), ...line([173, 436], B, 30)], 1200]];
    const rects = [];
    for (const [name, pts, ms] of runs) {
      const p = await t.open(DEMO);
      const fr = await drag2(p, pts, ms);
      await release(p);
      checkArrangement(t, lastRad(fr), name, 'br');
      checkFrames(t, fr, name);
      rects.push(lastRad(fr).map((c) => `${c.text}@${c.x},${c.y}`).sort().join(' '));
    }
    t.eq(new Set(rects).size, 1, `identical final rects for every speed / path: ${JSON.stringify(rects)}`);
  });

  test('A creation order does not matter: the outer box owns the inward spot at the top-left corner too (reverse drag)', async (t) => {
    const p = await t.open(DEMO);
    await setPage(p, `<style>body{margin:0;background:#fff}#o{position:absolute;left:100px;top:100px;width:300px;height:260px;border-radius:24px;background:#eef;padding:12px;box-sizing:border-box}
      #i{width:100%;height:100%;border-radius:12px;background:#dde}</style><div id=o><div id=i></div></div>`);
    await pressAt(p, [430, 390]);
    await startSampler(p);
    await paced(p, line([430, 390], [60, 60], 50), 900);
    await sleep(600);
    const fr = await stopSampler(p);
    await release(p);
    const rad = lastRad(fr), o = rad.find((c) => c.text === 'r 24'), i = rad.find((c) => c.text === 'r 12');
    t.ok(o && i, `both chips (${JSON.stringify(rad.map((c) => c.text))})`);
    // top-left corner of the outer box is (100,100): inward = down-right of it, outward = up-left of it
    t.ok(o && o.x >= 100 && o.y >= 100, `r 24 inward: ${JSON.stringify(o && [o.x, o.y])}`);
    t.ok(i && (i.x < 100 || i.y < 100), `r 12 outward: ${JSON.stringify(i && [i.x, i.y])}`);
    checkFrames(t, fr, 'nested boxes');
  });

  test('B a relocated callout chip leaves its old spot at once and fades in at the new one: no glide, no count-up replay', async (t) => {
    const p = await t.open(DEMO);
    await setPage(p, `<style>body{margin:0;background:#fff}div{position:absolute;left:100px;top:100px;width:200px;height:200px;border-radius:20px;background:#eef}</style><div></div>`);
    // br corner of the box is (300,300); start below-right of it and drag up-left: the selection is first only 50 px tall
    await pressAt(p, [330, 330]);
    await startSampler(p);
    await paced(p, line([330, 330], [200, 280], 20), 450);
    await sleep(250);
    const before = lastRad(await p.evaluate(() => window.__F));
    t.ok(before.length === 1 && before[0].y + before[0].h > 280, `outward while the selection is small: ${JSON.stringify(before)}`);
    await paced(p, line([200, 280], [150, 150], 25), 500);
    await sleep(400);
    const fr = await stopSampler(p);
    await release(p);
    const after = lastRad(fr)[0];
    t.ok(after && after.x + after.w <= 280 && after.y + after.h <= 280, `inward once it fits: ${JSON.stringify(after)}`);
    const moves = relocations(fr);
    t.eq(moves.length >= 1, true, `the chip relocated (${JSON.stringify(moves)})`);
    // the frame right after the jump: at the new rect, still (nearly) transparent, label already final
    let seen = false;
    const last = new Map();
    for (const f of fr) for (const c of radOf(f)) {
      const q = last.get(c.id);
      if (q && (q.x !== c.x || q.y !== c.y) && c.x === after.x && c.y === after.y) { seen = true; t.ok(c.op < 0.9, `fades in at the new spot (opacity ${c.op})`); t.eq(c.text, 'r 20', 'no count-up replay (label stays r 20)'); }
      last.set(c.id, c);
    }
    t.ok(seen, 'saw the relocation frame');
    checkFrames(t, fr, 'lone callout');
    const tr = await p.evaluate(() => document.querySelector('mikron-root').shadowRoot.querySelector('.mk-chip[data-kind=radius]').style.transition);
    t.eq(tr, '', 'no positional transition on the chip');
  });

  /** Brightest red+green+blue sum of the blueprint canvas in a css-px box (an I-beam stroke is brighter than hatch). */
  const peak = (p, x, y, w, h) => p.evaluate(([x, y, w, h]) => {
    const cv = document.querySelector('mikron-root').shadowRoot.querySelector('canvas');
    const k = cv.width / innerWidth;
    const d = cv.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))).data;
    let m = 0;
    for (let i = 0; i < d.length; i += 4) m = Math.max(m, d[i + 3] === 0 ? 0 : (d[i] + d[i + 1] + d[i + 2]) * (d[i + 3] / 255));
    return Math.round(m);
  }, [x, y, w, h]);

  test('C a padding chip dropped for a collision takes its I-beam with it (gutters), the card top 8 keeps chip and I-beam', async (t) => {
    const p = await t.open(DEMO);
    await pin(p, [38, 27], [642, 459], { pause: 200 });
    const c = await chipsSettled(p);
    t.ok(c.some((x) => x.kind === 'space' && x.text === '8' && Math.abs(x.x + x.w / 2 - (CARD.x + CARD.w / 2)) < 40), "the card's top 8 chip is still shown");
    // card left / right padding (8 px): the 8 chips are dropped (row 2's 16 chip owns the spot), so no I-beam either.
    // Scan the whole gutter column between the card's corner arcs: any stroke there is an orphan tick.
    const ctl = await peak(p, CARD.x + 1, 70, 6, 8); // hatch only: the control
    for (const [name, gx] of [['left', CARD.x + 1], ['right', CARD.x + CARD.w - 7]]) {
      const tick = await peak(p, gx, 72, 6, 336);
      t.ok(tick <= ctl + 40, `${name} gutter: no I-beam stroke (peak ${tick}, hatch-only peak ${ctl})`);
    }
    // the top 8: its I-beam is a vertical stroke at the card's centre x, 8 px tall under the card's top edge
    const top = await peak(p, CARD.x + CARD.w / 2 - 1, CARD.y + 1, 3, 7);
    t.ok(top > ctl + 150, `the card's top I-beam still draws (peak ${top} vs ${ctl})`);
  });
});
