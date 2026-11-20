// Bundled chip font ("Mikron Mono" = Geist Mono Bold): loading, CSP independence, fallback, metrics.
import { describe, test } from '../lib/harness.mjs';
import { waitState, ui, drag, pin, chips, chipsSettled, isoEval, sleep, until } from '../lib/mk.mjs';

const DEMO = '/demo/index.html';
const FULL = [[90, 20], [630, 470]];
const BIG = [[60, 20], [664, 452]]; // snaps to 604 × 432, the size label of the full-card drag
// expected widths of the bundled-face chips (CSS px)
const REC = { '40 × 40': 55, '97 × 32': 54, '480 × 391': 67, two: 21, 'r 19': 34 };
const STRICT = encodeURIComponent("default-src 'none'; font-src 'none'; connect-src 'none'; img-src 'none'; style-src 'unsafe-inline'");

/** Everything the tests need to know about the live chips and the size label, read from the page. */
async function paint(p) {
  return p.evaluate(() => {
    const sr = document.querySelector('mikron-root').shadowRoot;
    const one = (el) => {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      const probe = document.createElement('canvas').getContext('2d');
      probe.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      return {
        text: el.textContent, kind: el.dataset.kind || 'label', family: cs.fontFamily, w: r.width, h: r.height,
        overflow: el.scrollWidth - el.clientWidth, advance: probe.measureText('0').width,
        pad: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight),
      };
    };
    return {
      chips: [...sr.querySelectorAll('.mk-chip')].map(one),
      label: one(sr.querySelector('.mk-size-label')),
      face: [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Mikron Mono').map((f) => ({ status: f.status, weight: f.weight })),
      check: document.fonts.check('700 11px "Mikron Mono"'),
    };
  });
}

const startsMikron = (f) => /^"?Mikron Mono"?\s*,/.test(f);

async function watchCsp(p) {
  await p.evaluate(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}

/** Make the extension's font load fail (reject the message, return junk bytes) before the first arm. */
async function breakFont(p, how) {
  const code =
    how === 'reject'
      ? `chrome.runtime.sendMessage = () => Promise.reject(new Error('no worker'))`
      : how === 'junk'
        ? `chrome.runtime.sendMessage = () => Promise.resolve({ ok: true, b64: 'AAECAwQFBgcICQ==' })`
        : `chrome.runtime.sendMessage = () => Promise.resolve({ ok: false })`;
  await isoEval(p, `(() => { ${code}; return true; })()`);
}

describe('bundled font', () => {
  test('nothing font-related happens at page load; the first arm starts the load', async (t) => {
    const p = await t.open(DEMO);
    t.eq(await p.evaluate(() => [...document.fonts].length), 0, 'no FontFace on the page before arming');
    t.eq(await isoEval(p, 'JSON.stringify([__MIKRON__.font.ready(), __MIKRON__.font.generation()])'), '[false,0]');
    await p.mouse.move(40, 460);
    await p.keyboard.down('Shift');
    await sleep(280);
    await p.mouse.move(50, 466, { steps: 3 });
    await waitState(p, 'armed');
    await until(() => isoEval(p, '__MIKRON__.font.ready()'), { msg: 'font ready after the first arm' });
    t.eq(await p.evaluate(() => [...document.fonts].map((f) => f.family.replace(/"/g, ''))), ['Mikron Mono']);
    await p.keyboard.up('Shift');
  });

  test('first arm + drag on the demo: chips and size label are painted with Mikron Mono', async (t) => {
    const p = await t.open(DEMO);
    await pin(p, ...FULL);
    const c = await chipsSettled(p);
    t.ok(c.length > 10, `chips (${c.length})`);
    const r = await paint(p);
    t.eq(r.face, [{ status: 'loaded', weight: '700' }], 'one loaded 700 face');
    t.ok(r.check, 'document.fonts.check("700 11px \\"Mikron Mono\\"")');
    t.ok(r.chips.every((x) => startsMikron(x.family)), 'every chip family starts with Mikron Mono: ' + [...new Set(r.chips.map((x) => x.family))].join(' | '));
    t.ok(startsMikron(r.label.family), 'size label family: ' + r.label.family);
    t.ok(r.chips.every((x) => x.h === 16), 'chip height stays 16 px');
  });

  test('chip and label widths match the design widths (±1 px) and nothing overflows its box', async (t) => {
    const p = await t.open(DEMO);
    await pin(p, ...BIG);
    await chipsSettled(p);
    const r = await paint(p);
    t.ok(r.chips.every((x) => startsMikron(x.family)), 'bundled face active');
    const w = (txt) => r.chips.find((x) => x.text === txt);
    for (const txt of ['40 × 40', '97 × 32', '480 × 391']) {
      t.ok(w(txt), `${txt} chip present`);
      t.near(w(txt).w, REC[txt], 1, `${txt} width`);
    }
    const two = r.chips.filter((x) => x.kind === 'space' && /^\d\d$/.test(x.text));
    t.ok(two.length >= 4, `two-digit chips (${two.length})`);
    for (const x of two) t.near(x.w, REC.two, 1, `"${x.text}" width`);
    t.eq((await ui(p)).label, '604 × 432');
    t.near(r.label.w, 67, 1, 'size label 604 × 432 width');
    const over = [...r.chips, r.label].filter((x) => x.overflow > 0);
    t.eq(over.map((x) => [x.text, x.overflow]), [], 'chips / label whose text overflows');
    t.ok(Math.abs(r.chips[0].advance - 6.6) < 0.05, `advance ${r.chips[0].advance}`);
  });

  test('radius chips match the design width and do not overflow', async (t) => {
    const p = await t.open(DEMO);
    await pin(p, ...FULL);
    await chipsSettled(p);
    const r = await paint(p);
    const rad = r.chips.filter((x) => x.kind === 'radius');
    t.ok(rad.length > 0, 'radius chips present');
    for (const x of rad) {
      t.near(x.w, /^r \d$/.test(x.text) ? 28 : 34, 1, `"${x.text}" width`);
      t.eq(x.overflow <= 0, true, `"${x.text}" overflow`);
    }
  });

  test('strict CSP via <meta> (default-src none): font still loads, no violation, no console error', async (t) => {
    const p = await t.open('/tests/fixtures/csp-strict.html');
    await watchCsp(p);
    await pin(p, [20, 20], [440, 260]);
    await chipsSettled(p);
    const r = await paint(p);
    t.ok(r.check && r.face.length === 1, 'font registered under the strict policy');
    t.ok(r.chips.length > 0 && r.chips.every((x) => startsMikron(x.family)), 'chips painted with the bundled face');
    t.ok(startsMikron(r.label.family), 'label painted with the bundled face');
    t.eq(await p.evaluate(() => window.__csp), [], 'securitypolicyviolation events');
  });

  test('strict CSP via header (font-src none, connect-src none) on the demo page', async (t) => {
    const p = await t.open(`${DEMO}?csp=${STRICT}`);
    const resp = await p.reload({ waitUntil: 'load' });
    t.ok(/font-src 'none'/.test(resp.headers()['content-security-policy'] || ''), 'policy in force: ' + resp.headers()['content-security-policy']);
    await sleep(100);
    await watchCsp(p);
    await pin(p, ...FULL);
    await chipsSettled(p);
    const r = await paint(p);
    t.ok(r.check && r.face.length === 1, 'font registered');
    t.ok(r.chips.every((x) => startsMikron(x.family)), 'chips painted with the bundled face');
    t.eq(await p.evaluate(() => window.__csp), [], 'securitypolicyviolation events');
  });

  for (const how of ['reject', 'junk', 'refused']) {
    test(`fallback (${how}): chips and label use the system stack and are sized for it`, async (t) => {
      const p = await t.open(DEMO);
      await breakFont(p, how);
      await pin(p, ...BIG);
      await chipsSettled(p);
      await sleep(150);
      const r = await paint(p);
      t.eq(r.face, [], 'no Mikron Mono face registered');
      t.ok(r.chips.length > 10, 'chips present');
      t.ok(r.chips.every((x) => !/Mikron/.test(x.family)), 'chips use the system stack: ' + r.chips[0].family);
      t.ok(!/Mikron/.test(r.label.family), 'label uses the system stack');
      for (const x of [...r.chips, r.label]) {
        // the pre-bundling metrics: ceil(len × advance) + 10 with 5 px side padding, measured in the chip's own font
        t.eq(x.w, Math.ceil(x.text.length * x.advance) + 10, `"${x.text}" width for the system stack`);
        t.ok(x.overflow <= 0, `"${x.text}" overflows by ${x.overflow}`);
      }
    });
  }

  test('font arriving while a selection is pinned re-lays every chip out coherently', async (t) => {
    const p = await t.open(DEMO);
    await isoEval(p, `(() => { const o = chrome.runtime.sendMessage.bind(chrome.runtime); globalThis.__hold = new Promise((r) => (globalThis.__rel = r)); chrome.runtime.sendMessage = async (m) => { await globalThis.__hold; return o(m); }; return true; })()`);
    await pin(p, ...FULL);
    await chipsSettled(p);
    const before = await paint(p);
    t.ok(before.chips.length > 10 && before.chips.every((x) => !/Mikron/.test(x.family)), 'system stack while the font is pending');
    for (const x of [...before.chips, before.label]) t.eq(x.w, Math.ceil(x.text.length * x.advance) + 10, `pending: "${x.text}" width`);
    await isoEval(p, '(globalThis.__rel(), true)');
    await until(async () => (await paint(p)).chips.every((x) => startsMikron(x.family)), { timeout: 3000, msg: 'chips switch to the bundled face' });
    await chipsSettled(p);
    const after = await paint(p);
    t.eq(after.chips.length, before.chips.length, 'same chip set');
    for (const x of after.chips) {
      t.ok(startsMikron(x.family), `"${x.text}" painted with the bundled face`);
      t.eq(x.w, Math.round(x.text.length * x.advance + 8), `"${x.text}" width follows the bundled metrics`);
      t.ok(x.overflow <= 0, `"${x.text}" overflow`);
    }
    t.ok(startsMikron(after.label.family) && after.label.w === Math.round(after.label.text.length * after.label.advance + 8), 'label switched with its width');
  });

  test('the extension makes no request to an external host for the font', async (t) => {
    const seen = [];
    const on = (req) => seen.push(req.url());
    t.env.ctx.on('request', on);
    try {
      const p = await t.open(DEMO);
      await pin(p, ...FULL);
      await chipsSettled(p);
      await sleep(200);
    } finally {
      t.env.ctx.off('request', on);
    }
    const bad = seen.filter((u) => !/^(http:\/\/(localhost|127\.0\.0\.1):\d+\/|chrome-extension:\/\/|data:|blob:|about:)/.test(u));
    t.eq(bad, [], 'requests outside localhost / the extension');
    t.ok(!seen.some((u) => /\.woff2?(\?|$)/.test(u) && !/^chrome-extension:/.test(u)), 'no font file fetched over the network');
  });
});
