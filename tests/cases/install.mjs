// Install-time behaviour and the permission set: the welcome tab opens once on a fresh install, nothing is
// injected behind the user's back, the popup injects into the active tab on demand, and copy needs no
// clipboardWrite.
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, EXT, launchSub } from '../lib/harness.mjs';
import { openRealPopup } from '../lib/realpopup.mjs';
import { makeVariant, removeVariant } from '../lib/variants.mjs';
import { state, waitState, ui, pin, readClipboard, writeClipboard, copyCenter, sleep, until } from '../lib/mk.mjs';

const G = '/tests/fixtures/gesture.html';
const DEMO = '/demo/index.html';
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

const welcomePages = (t) => t.env.ctx.pages().filter((p) => p.url().startsWith(t.ext.welcomeUrl));

describe('install and permissions', () => {
  test('manifest: exact permission set, no host_permissions, no clipboardWrite, content script on <all_urls>', async (t) => {
    t.eq(manifest.permissions, ['storage', 'activeTab', 'scripting'], 'permissions');
    t.ok(!('host_permissions' in manifest) && !('optional_host_permissions' in manifest), 'no host permissions');
    t.ok(!JSON.stringify(manifest).includes('clipboardWrite'), 'no clipboardWrite');
    t.eq(manifest.content_scripts.map((c) => c.matches), [['<all_urls>']], 'content script matches');
    t.eq(manifest.content_scripts[0].all_frames, false, 'top frame only');
    t.ok(!('key' in manifest), 'no key');
    t.ok(manifest.description.length <= 132, `description is ${manifest.description.length} chars`);
    t.eq(manifest.short_name, 'Mikron', 'short_name');
    t.eq(manifest.action.default_title, 'Mikron', 'action title');
    t.eq(manifest.homepage_url, 'https://github.com/dabarov/mikron', 'homepage');
    // what the browser actually loaded
    const live = await t.env.control.evaluate(() => chrome.runtime.getManifest());
    t.eq(live.permissions, ['storage', 'activeTab', 'scripting'], 'loaded permissions');
    t.ok(!live.host_permissions, 'loaded host_permissions');
    const granted = await t.env.control.evaluate(() => chrome.permissions.getAll());
    t.eq(granted.permissions.filter((x) => x !== 'activeTab').sort(), ['scripting', 'storage'], 'granted API permissions');
  });

  test('a fresh install opens the welcome page once; a restarted worker does not open it again', async (t) => {
    const sub = await launchSub(t, EXT, { keepWelcome: true });
    try {
      await until(() => welcomePages(sub).length === 1, { msg: 'welcome tab', timeout: 4000 });
      await sleep(600);
      t.eq(welcomePages(sub).length, 1, 'one welcome tab after install');
      const [w] = welcomePages(sub);
      t.eq(new URL(w.url()).pathname, '/welcome/welcome.html', 'welcome path');
      // stop the worker, then wake it with a message (the font request is what content scripts send)
      const cdp = await sub.env.ctx.newCDPSession(w);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await sleep(400);
      const reply = await w.evaluate(() => chrome.runtime.sendMessage({ mikron: 'font' }));
      t.ok(reply && reply.ok, 'worker woke and answered');
      await sleep(800);
      t.eq(welcomePages(sub).length, 1, 'still one welcome tab after the worker restarted');
    } finally {
      await sub.close();
    }
  }, { timeout: 40000 });

  test('onInstalled: install opens the welcome page; update and chrome_update open nothing', async (t) => {
    const sub = await launchSub(t, EXT, { keepWelcome: false });
    try {
      const count = () => sub.env.ctx.pages().filter((p) => p.url().startsWith(sub.ext.welcomeUrl)).length;
      t.eq(count(), 0, 'welcome closed by the launcher');
      const fire = (reason) =>
        sub.ext.sw.evaluate((r) => {
          const L = chrome.runtime.onInstalled;
          if (!L.dispatch) throw new Error('no dispatch');
          L.dispatch({ reason: r });
        }, reason);
      await fire('update');
      await fire('chrome_update');
      await fire('shared_module_update');
      await sleep(600);
      t.eq(count(), 0, 'nothing for update / chrome_update');
      await fire('install');
      await until(() => count() === 1, { msg: 'welcome tab for a simulated install', timeout: 3000 });
    } finally {
      await sub.close();
    }
  }, { timeout: 40000 });

  test('nothing is injected into open tabs behind the user: a tab without the content script stays without it', async (t) => {
    const dir = makeVariant({ autoInject: false });
    const sub = await launchSub(t, dir);
    try {
      const p = await sub.open(G);
      await sleep(500);
      t.eq(await p.evaluate(() => !!document.querySelector('mikron-root') || !!window.__MIKRON__), false, 'no overlay host');
      await p.bringToFront();
      const ping = await sub.ext.sw.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return 'no tab';
        try { return await chrome.tabs.sendMessage(tab.id, { type: 'mikron:ping' }); } catch (e) { return 'no receiver'; }
      });
      t.eq(ping, 'no receiver', 'ping');
    } finally {
      await sub.close();
      removeVariant(dir);
    }
  }, { timeout: 40000 });

  test('opening the popup on a tab without the content script injects it; Shift+drag then works without a reload', async (t) => {
    const dir = makeVariant({ autoInject: false, hostGrant: true });
    const sub = await launchSub(t, dir);
    try {
      const p = await sub.open(G);
      await sleep(300);
      t.eq(await state(p), 'absent', 'no Mikron before the popup');
      const pop = await openRealPopup(sub, p);
      try {
        t.eq(await pop.eval(`document.getElementById('siteGroup').hidden`), false, 'per-site switch shown');
        t.eq(await pop.eval(`document.getElementById('host').textContent`), 'localhost', 'host');
        t.ok(!/can't run/.test(await pop.eval(`document.getElementById('status').textContent`)), 'no blocked message');
      } finally {
        await pop.close();
      }
      await p.bringToFront();
      const ping = await sub.ext.sw.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return chrome.tabs.sendMessage(tab.id, { type: 'mikron:ping' });
      });
      t.eq(ping, { ok: true, state: 'idle' }, 'content script answers after the popup');
      await p.bringToFront();
      const u = await pin(p, [100, 280], [300, 420]);
      t.ok(u.label, 'selection pinned after popup injection');
      await p.reload();
      await sleep(300);
      t.eq(await state(p), 'absent', 'a reload of such a tab is back to no content script (control)');
    } finally {
      await sub.close();
      removeVariant(dir);
    }
  }, { timeout: 40000 });

  describe('copy without clipboardWrite', () => {
    async function copyFlow(t, host, viaKey) {
      const p = await t.open(DEMO, { host });
      const secure = await p.evaluate(() => isSecureContext);
      await pin(p, [90, 20], [630, 470], { pause: 150 });
      const reader = await t.open(G); // a secure localhost tab to read the clipboard from
      await writeClipboard(reader, 'sentinel');
      await p.bringToFront();
      if (viaKey) await p.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+KeyC`);
      else {
        const [x, y] = await copyCenter(p);
        await p.mouse.click(x, y);
      }
      await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copied state', timeout: 1500 });
      await reader.bringToFront();
      const txt = await readClipboard(reader);
      t.ok(/^Mikron — 540 × 452 selection on /.test(txt), `clipboard: ${txt.slice(0, 60)}`);
      t.ok(txt.includes('span.name "Atlas"'), 'spec lists the neutral demo content');
      return secure;
    }
    test('Copy click on a secure origin (localhost)', async (t) => {
      t.eq(await copyFlow(t, 'localhost', false), true, 'secure context');
    });
    test('Copy click on plain http (insecure context)', async (t) => {
      t.eq(await copyFlow(t, 'insecure.test', false), false, 'secure context');
      const p = t.pages.find((x) => x.url().includes('insecure.test'));
      t.eq(await p.evaluate(() => typeof navigator.clipboard), 'undefined', 'no async clipboard API there, so the copy event path did the work');
    });
    test('Cmd/Ctrl+C on plain http (insecure context)', async (t) => {
      t.eq(await copyFlow(t, 'insecure.test', true), false, 'secure context');
    });
  });
});
