import { describe, test } from '../lib/harness.mjs';
import { state, waitState, watchStates, ui, arm, drag, pin, resetProbe, count, events, sleep, until, KEY, isoEval } from '../lib/mk.mjs';

const G = '/tests/fixtures/gesture.html';

async function cannotMeasure(t, p, mod = 'shift') {
  await resetProbe(p);
  await p.mouse.move(100, 280);
  await p.keyboard.down(KEY[mod]);
  await sleep(280);
  await p.mouse.move(110, 290, { steps: 3 });
  await p.mouse.down();
  await p.mouse.move(300, 420, { steps: 8 });
  const seen = await watchStates(p, 120);
  await p.mouse.up();
  await p.keyboard.up(KEY[mod]);
  t.ok(!seen.some((s) => s === 'armed' || s === 'dragging' || s === 'pinned'), `states while disabled: ${seen}`);
  const ev = await events(p);
  const md = ev.find((e) => e.type === 'mousedown' && e.phase === 'c');
  t.ok(md && !md.prevented, 'page mousedown untouched');
  t.ok(ev.some((e) => e.type === 'mousemove'), 'page saw mousemove');
  t.ok(ev.some((e) => e.type === 'click'), 'page saw click');
}

async function popup(t, host = 'localhost') {
  const p = await t.open(`${t.ext.popupUrl}?host=${host}`, { raw: true });
  await p.waitForFunction(() => document.getElementById('enabled') && document.querySelector('#modifier button[aria-checked="true"]'));
  return p;
}

describe('settings & shell', () => {
  test('disable globally live: no measuring, page untouched; re-enable live without reload', async (t) => {
    const p = await t.open(G);
    await t.settings({ enabled: false });
    await cannotMeasure(t, p);
    await t.settings({ enabled: true });
    await pin(p, [100, 280], [300, 420]);
  });

  test('disabling while pinned dismisses the selection', async (t) => {
    const p = await t.open(G);
    await pin(p, [100, 280], [300, 420]);
    await t.settings({ enabled: false }, { wait: 0 });
    await waitState(p, 'idle');
  });

  test('disabling while armed disarms (hint and crosshair gone)', async (t) => {
    const p = await t.open(G);
    await arm(p, { at: [200, 300] });
    await t.settings({ enabled: false }, { wait: 0 });
    await waitState(p, 'idle');
    t.ok(!(await ui(p)).hintOn, 'hint hidden');
    await p.keyboard.up('Shift');
  });

  test('per-site disable (localhost) leaves 127.0.0.1 working; live re-enable', async (t) => {
    const p = await t.open(G);
    const q = await t.open(G, { host: '127.0.0.1' });
    await t.settings({ disabledSites: ['localhost'] });
    await cannotMeasure(t, p);
    await pin(q, [100, 280], [300, 420]);
    await t.settings({ disabledSites: [] });
    await pin(p, [100, 280], [300, 420]);
  });

  test('isSiteDisabled matches exact host, subdomains and www., not look-alikes', async (t) => {
    const r = await t.env.control.evaluate(() => {
      const s = { disabledSites: ['figma.com', 'docs.google.com'] };
      const f = (h) => MikronSettings.isSiteDisabled(s, h);
      return [f('figma.com'), f('www.figma.com'), f('a.b.figma.com'), f('notfigma.com'), f('figma.com.evil.io'), f('docs.google.com'), f('google.com'), f('FIGMA.COM')];
    });
    t.eq(r, [true, true, true, false, false, true, false, true]);
  });

  test('modifier change applies live (Shift stops, Alt starts, back to Shift)', async (t) => {
    const p = await t.open(G);
    await t.settings({ modifier: 'alt' });
    await cannotMeasure(t, p, 'shift');
    await pin(p, [100, 280], [300, 420], { mod: 'alt' });
    await p.keyboard.press('Escape');
    await waitState(p, 'idle');
    await t.settings({ modifier: 'shift' });
    await sleep(200);
    await pin(p, [120, 280], [320, 420]);
  });

  test('modifier "ctrl" (macOS): Ctrl+drag measures and no contextmenu reaches the page', async (t) => {
    await t.settings({ modifier: 'ctrl' });
    const p = await t.open(G);
    await resetProbe(p);
    await pin(p, [100, 280], [300, 420], { mod: 'ctrl' });
    t.eq(await count(p, 'contextmenu'), 0, 'contextmenu reached the page');
  });

  test('snap setting change applies live', async (t) => {
    const p = await t.open(G);
    await t.settings({ snap: 0 });
    let u = await pin(p, [101, 281], [204, 332]);
    t.eq(u.label, '103 × 51');
    await p.keyboard.press('Escape');
    await t.settings({ snap: 4 });
    await sleep(200);
    u = await pin(p, [101, 281], [204, 332]);
    t.eq(u.label, '104 × 52');
  });

  test('showHint turned off while armed hides the pill immediately', async (t) => {
    const p = await t.open(G);
    await arm(p, { at: [200, 300] });
    await t.settings({ showHint: false }, { wait: 0 });
    await until(async () => !(await ui(p)).hintOn, { msg: 'hint hidden', timeout: 1000 });
    t.eq(await state(p), 'armed', 'still armed (crosshair)');
    await p.keyboard.up('Shift');
  });

  test('popup controls write settings and reflect them after reopening', async (t) => {
    const pp = await popup(t);
    t.eq(await pp.evaluate(() => [document.getElementById('enabled').checked, document.getElementById('siteEnabled').checked, document.getElementById('host').textContent]), [true, true, 'localhost'], 'initial');
    await pp.click('#modifier button[data-value="alt"]');
    await pp.click('#copyFormat button[data-value="json"]');
    await pp.click('label:has(#showHint)');
    await pp.click('label:has(#snap)');
    await until(async () => {
      const s = await t.readSettings();
      return s.modifier === 'alt' && s.copyFormat === 'json' && s.showHint === false && s.snap === 0;
    }, { msg: 'settings persisted' }).catch(async (e) => t.fail(`${e.message}: ${JSON.stringify(await t.readSettings())}`));
    t.eq(await pp.evaluate(() => document.getElementById('kModLabel').textContent), '⌥ Alt', 'legend follows modifier');
    await pp.close();
    t.env.lastSettings = null;
    const p2 = await popup(t);
    const r = await p2.evaluate(() => ({
      mod: document.querySelector('#modifier button[aria-checked="true"]').dataset.value,
      fmt: document.querySelector('#copyFormat button[aria-checked="true"]').dataset.value,
      hint: document.getElementById('showHint').checked,
      snap: document.getElementById('snap').checked,
    }));
    t.eq(r, { mod: 'alt', fmt: 'json', hint: false, snap: false }, 'reopened popup');
  });

  test('popup master switch off: status text, site switch disabled, badge OFF; on again clears badge', async (t) => {
    const pp = await popup(t);
    await pp.click('label:has(#enabled)');
    await until(async () => (await t.readSettings()).enabled === false, { msg: 'enabled=false stored' });
    t.eq(await pp.evaluate(() => document.getElementById('status').textContent), 'Paused everywhere');
    t.eq(await pp.evaluate(() => document.getElementById('siteEnabled').disabled), true, 'site switch disabled');
    await until(() => t.env.control.evaluate(() => chrome.action.getBadgeText({})).then((b) => b === 'OFF'), { msg: 'badge OFF' });
    await pp.click('label:has(#enabled)');
    await until(() => t.env.control.evaluate(() => chrome.action.getBadgeText({})).then((b) => b === ''), { msg: 'badge cleared' });
    t.env.lastSettings = null;
  });

  test('popup site switch edits disabledSites and the open tab follows live', async (t) => {
    const page = await t.open(G);
    const pp = await popup(t, 'localhost');
    await pp.click('label:has(#siteEnabled)');
    await until(async () => (await t.readSettings()).disabledSites.includes('localhost'), { msg: 'localhost disabled' });
    t.env.lastSettings = null;
    await sleep(150);
    await page.bringToFront();
    await cannotMeasure(t, page);
    await pp.click('label:has(#siteEnabled)');
    await until(async () => !(await t.readSettings()).disabledSites.includes('localhost'), { msg: 'localhost re-enabled' });
    await sleep(150);
    await pin(page, [100, 280], [300, 420]);
  });

  test('popup re-renders when settings change elsewhere', async (t) => {
    const pp = await popup(t);
    await t.settings({ modifier: 'meta', copyFormat: 'json' }, { wait: 0 });
    await until(() => pp.evaluate(() => document.querySelector('#modifier button[aria-checked="true"]').dataset.value === 'meta'), { msg: 'popup shows meta' });
  });

  test('popup keyboard: arrow keys move the modifier segmented control', async (t) => {
    const pp = await popup(t);
    await pp.focus('#modifier button[aria-checked="true"]');
    await pp.keyboard.press('ArrowRight');
    await until(async () => (await t.readSettings()).modifier === 'alt', { msg: 'modifier alt' });
    await pp.keyboard.press('ArrowLeft');
    await pp.keyboard.press('ArrowLeft');
    await until(async () => (await t.readSettings()).modifier === 'meta', { msg: 'modifier wraps to meta' });
    t.env.lastSettings = null;
  });

  test('corrupt stored settings fall back to defaults (modifier, snap)', async (t) => {
    await t.env.control.evaluate(() => new Promise((r) => chrome.storage.sync.set({ mikron: { modifier: 'hyper', snap: 'lots', enabled: 1, disabledSites: 'nope' } }, r)));
    t.env.lastSettings = null;
    const p = await t.open(G);
    const u = await pin(p, [101, 281], [204, 332]);
    t.eq(u.label, '104 × 52', 'snap falls back to 4');
  });

  test('popup without an http(s) host hides the per-site switch; shortcut legend shows the command', async (t) => {
    const pp = await t.open(t.ext.popupUrl, { raw: true });
    await pp.waitForFunction(() => document.querySelector('#modifier button[aria-checked="true"]'));
    t.eq(await pp.evaluate(() => document.getElementById('siteGroup').hidden), true, 'site group hidden');
    t.ok(/M/.test(await pp.evaluate(() => document.getElementById('kToggle').textContent)), 'toggle shortcut shown');
  });

  test('toggle-enabled command is registered with Alt+Shift+M', async (t) => {
    const cmds = await t.env.control.evaluate(() => chrome.commands.getAll());
    const c = cmds.find((x) => x.name === 'toggle-enabled');
    t.ok(c, 'command registered');
    t.ok(/M/.test(c.shortcut || ''), `shortcut: ${c.shortcut}`);
  });

  test('mikron:ping answers {ok:true, state} with the live state', async (t) => {
    const p = await t.open(G);
    // no `tabs` permission, so tabs cannot be found by URL: ask the active tab (the page just opened)
    const ping = async () => {
      await p.bringToFront();
      return t.env.control.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return chrome.tabs.sendMessage(tab.id, { type: 'mikron:ping' });
      });
    };
    t.eq(await ping(), { ok: true, state: 'idle' }, 'idle');
    await pin(p, [100, 280], [300, 420]);
    t.eq(await ping(), { ok: true, state: 'pinned' }, 'pinned');
  });

  test('running the content script twice in a tab is idempotent (one host, still works, no errors)', async (t) => {
    // The popup injects only when the ping gets no answer, but main.js must cope with a second copy anyway.
    const p = await t.open(G);
    await pin(p, [100, 280], [300, 420]);
    // executeScript needs activeTab (a real popup click), so run the same files a second time in the
    // content-script world by hand.
    const sources = await t.env.control.evaluate(async () => {
      const files = chrome.runtime.getManifest().content_scripts[0].js;
      return Promise.all(files.map((f) => fetch(chrome.runtime.getURL(f)).then((r) => r.text())));
    });
    for (const src of sources) await isoEval(p, src);
    await sleep(300);
    t.eq(await p.evaluate(() => document.querySelectorAll('mikron-root').length), 1, 'hosts');
    t.eq(await state(p), 'pinned', 'pinned selection survives');
    await p.keyboard.press('Escape');
    await waitState(p, 'idle');
    await resetProbe(p);
    await pin(p, [120, 260], [320, 440]);
    t.eq(await count(p, 'click'), 0, 'click swallowed once (no duplicate state machines)');
  });

  test('badge follows enabled from storage (no popup involved)', async (t) => {
    await t.settings({ enabled: false }, { wait: 0 });
    await until(() => t.env.control.evaluate(() => chrome.action.getBadgeText({})).then((b) => b === 'OFF'), { msg: 'badge OFF' });
    await t.settings({ enabled: true }, { wait: 0 });
    await until(() => t.env.control.evaluate(() => chrome.action.getBadgeText({})).then((b) => b === ''), { msg: 'badge cleared' });
  });
});
