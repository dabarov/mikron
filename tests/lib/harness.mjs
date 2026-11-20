// Minimal test harness: plain Node + Playwright, one shared browser, a fresh page per case.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { PROBE_SCRIPT } from './probe.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../..');
export const EXT = path.join(REPO, 'extension');
export const OUT = path.join(REPO, 'tests/.out');
export const VIEWPORT = { width: 718, height: 479 };

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  modifier: 'shift',
  showHint: true,
  snap: 4,
  copyFormat: 'text',
  disabledSites: ['figma.com', 'miro.com', 'excalidraw.com', 'tldraw.com', 'canva.com', 'docs.google.com'],
});

const cases = [];
let group = '';

/** Register a test case. opts: { timeout, skipErrorCheck, allowErrors: RegExp } */
export function test(name, fn, opts = {}) {
  cases.push({ name: group ? `${group} › ${name}` : name, fn, opts });
}
export function describe(name, body) {
  const prev = group;
  group = prev ? `${prev} › ${name}` : name;
  body();
  group = prev;
}

class AssertionError extends Error {}

function fmt(v) {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  } catch (_) {
    return String(v);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll fn() until it returns a truthy value; returns that value or throws with msg. */
export async function until(fn, { timeout = 2000, interval = 25, msg = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() - t0 > timeout) {
      throw new AssertionError(`timed out after ${timeout} ms waiting for ${msg}` + (last instanceof Error ? ` (last error: ${last.message})` : ` (last value: ${fmt(last)})`));
    }
    await sleep(interval);
  }
}

class Ctx {
  constructor(env, name) {
    this.env = env;
    this.name = name;
    this.pages = [];
    this.errors = [];
    this.notes = [];
    this.slug = name.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 90);
  }
  get ext() {
    return this.env.ext;
  }
  url(p, host = 'localhost') {
    return `http://${host}:${this.env.port}${p.startsWith('/') ? p : '/' + p}`;
  }
  /** Open a fresh tab on a repo-relative path. */
  async open(p, opts = {}) {
    const page = await this.env.ctx.newPage();
    this.pages.push(page);
    if (opts.viewport) await page.setViewportSize(opts.viewport);
    if (opts.reducedMotion || opts.colorScheme) await page.emulateMedia({ reducedMotion: opts.reducedMotion, colorScheme: opts.colorScheme });
    await page.addInitScript(PROBE_SCRIPT);
    await this.watchErrors(page);
    await page.goto(opts.raw ? p : this.url(p, opts.host), { waitUntil: 'load' });
    // content scripts are document_start; settings load asynchronously right after.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await sleep(opts.settle ?? 60);
    page.mouse._mkPos = { x: 0, y: 0 };
    return page;
  }
  async watchErrors(page) {
    const allow = this.opts && this.opts.allowErrors;
    const push = (kind, text) => {
      if (allow && allow.test(text)) return;
      this.errors.push(`${kind}: ${text}`);
    };
    try {
      const cdp = await this.env.ctx.newCDPSession(page);
      page._mkContexts = [];
      cdp.on('Runtime.executionContextCreated', (e) => page._mkContexts.push(e.context));
      await cdp.send('Runtime.enable');
      await cdp.send('Log.enable');
      cdp.on('Runtime.exceptionThrown', (e) => {
        const d = e.exceptionDetails || {};
        push('uncaught', (d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception');
      });
      cdp.on('Runtime.consoleAPICalled', (e) => {
        if (e.type === 'error' || e.type === 'assert') push('console.' + e.type, (e.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      });
      cdp.on('Log.entryAdded', (e) => {
        const en = e.entry || {};
        if (en.level === 'error') push('log.' + en.source, `${en.text} ${en.url || ''}`.trim());
      });
      page._mkCdp = cdp;
    } catch (e) {
      this.notes.push('could not attach CDP error watcher: ' + e.message);
    }
  }
  /** Replace the stored settings with DEFAULTS + patch (from an extension page). */
  async settings(patch = {}, { wait = 150 } = {}) {
    await this.env.setSettings({ ...DEFAULT_SETTINGS, ...patch });
    if (wait) await sleep(wait);
  }
  async readSettings() {
    return this.env.control.evaluate(() => new Promise((r) => chrome.storage.sync.get('mikron', (v) => r(v.mikron))));
  }
  ok(cond, msg = 'expected truthy') {
    if (!cond) throw new AssertionError(msg);
  }
  eq(actual, expected, msg = '') {
    const a = fmt(actual), e = fmt(expected);
    if (a !== e) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${e}, got ${a}`);
  }
  near(actual, expected, tol, msg = '') {
    if (!(typeof actual === 'number' && Math.abs(actual - expected) <= tol))
      throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${expected} ±${tol}, got ${fmt(actual)}`);
  }
  fail(msg) {
    throw new AssertionError(msg);
  }
  note(msg) {
    this.notes.push(msg);
  }
  async shot(page, label) {
    const file = path.join(OUT, `${this.slug}${label ? '__' + label : ''}.png`);
    await page.screenshot({ path: file });
    return path.relative(REPO, file);
  }
}

/** A free TCP port (for --remote-debugging-port). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Launch Chromium with an unpacked extension (fresh profile, headless) and wait for its service worker.
 * A fresh profile is a fresh install, so the extension opens its welcome tab; `keepWelcome: false` waits for
 * that tab and closes it, so the page under test is the only thing in front (a background tab would be
 * throttled: timers, rAF).
 * @returns {Promise<{ctx, sw, id, debugPort, welcome: string[]}>}
 */
export async function launchExtension(extDir, { viewport = VIEWPORT, deviceScaleFactor = 1, keepWelcome = false, args = [] } = {}) {
  const debugPort = await freePort();
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--remote-debugging-port=${debugPort}`, `--host-resolver-rules=MAP insecure.test 127.0.0.1`, ...args],
    viewport,
    deviceScaleFactor,
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const id = new URL(sw.url()).host;
  const welcome = [];
  if (!keepWelcome) {
    const isWelcome = (p) => p.url().startsWith(`chrome-extension://${id}/welcome/`);
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && !ctx.pages().some(isWelcome)) await sleep(50);
    await sleep(100);
    for (const p of ctx.pages().filter(isWelcome)) {
      welcome.push(p.url());
      await p.close();
    }
  }
  return { ctx, sw, id, debugPort, welcome };
}

/**
 * A second, independent browser (own profile, own extension copy) for a case that must start from a different
 * state than the shared one. Returns a case context (t.open, t.ok ...) bound to it; errors and pages are shared
 * with the parent case so its checks and failure screenshot still apply. Call `close()` when done.
 */
export async function launchSub(parent, extDir, opts = {}) {
  const l = await launchExtension(extDir, opts);
  const id = l.id;
  const env = {
    ctx: l.ctx,
    port: parent.env.port,
    server: parent.env.server,
    ext: { id, sw: l.sw, debugPort: l.debugPort, popupUrl: `chrome-extension://${id}/popup/popup.html`, welcomeUrl: `chrome-extension://${id}/welcome/welcome.html` },
    control: null,
    lastSettings: null,
  };
  for (const host of ['localhost', '127.0.0.1']) {
    await l.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://${host}:${parent.env.port}` });
  }
  const t = new Ctx(env, parent.name + ' (second browser)');
  t.opts = parent.opts;
  t.errors = parent.errors;
  t.pages = parent.pages;
  t.notes = parent.notes;
  t.close = () => l.ctx.close().catch(() => {});
  t.welcomeSeen = l.welcome;
  return t;
}

async function makeEnv() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.rmSync(path.join(OUT, f), { force: true });
  const server = await startServer(REPO);
  const { ctx, sw, id, debugPort } = await launchExtension(EXT);
  const env = {
    ctx,
    port: server.port,
    server,
    ext: { id, sw, debugPort, popupUrl: `chrome-extension://${id}/popup/popup.html`, welcomeUrl: `chrome-extension://${id}/welcome/welcome.html` },
    control: null,
    lastSettings: null,
  };
  env.openControl = async () => {
    env.control = await ctx.newPage();
    await env.control.goto(`${env.ext.popupUrl}?host=control.invalid`);
  };
  for (const host of ['localhost', '127.0.0.1']) {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://${host}:${server.port}` });
  }
  await env.openControl();
  env.setSettings = async (s) => {
    const key = JSON.stringify(s);
    if (env.lastSettings === key) return;
    await env.control.evaluate((v) => new Promise((r) => chrome.storage.sync.set({ mikron: v }, () => r())), s);
    env.lastSettings = key;
  };
  env.refreshSw = async () => {
    const list = ctx.serviceWorkers().filter((w) => w.url().includes(id));
    env.ext.sw = list[list.length - 1] || (await ctx.waitForEvent('serviceworker', { timeout: 10000 }));
    return env.ext.sw;
  };
  await env.setSettings({ ...DEFAULT_SETTINGS });
  return env;
}

export async function runAll({ filter } = {}) {
  const selected = cases.filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()));
  const t0 = Date.now();
  const env = await makeEnv();
  const results = [];
  for (const c of selected) {
    const t = new Ctx(env, c.name);
    t.opts = c.opts;
    const started = Date.now();
    let error = null;
    try {
      await t.settings({}, { wait: 0 });
      // the control page must survive (a test may reload the extension)
      if (env.control.isClosed()) await env.openControl();
      await Promise.race([
        c.fn(t),
        new Promise((_, rej) => setTimeout(() => rej(new AssertionError(`case timed out after ${c.opts.timeout || 20000} ms`)), c.opts.timeout || 20000)),
      ]);
      if (!c.opts.skipErrorCheck && t.errors.length) {
        throw new AssertionError(`console errors / uncaught exceptions:\n      ${t.errors.slice(0, 6).join('\n      ')}`);
      }
    } catch (e) {
      error = e;
    }
    let shot = '';
    if (error) {
      const live = t.pages.filter((p) => !p.isClosed());
      const page = live[live.length - 1];
      if (page) {
        try {
          shot = await t.shot(page, 'FAIL');
        } catch (_) {}
      }
    }
    for (const p of t.pages) {
      try {
        if (!p.isClosed()) await p.close();
      } catch (_) {}
    }
    const ms = Date.now() - started;
    const res = { name: c.name, ok: !error, ms, error, shot, notes: t.notes };
    results.push(res);
    const line = `${res.ok ? 'PASS' : 'FAIL'}  ${c.name}  (${ms} ms)`;
    console.log(line);
    if (!res.ok) {
      const msg = error instanceof AssertionError ? error.message : error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n      ') : String(error);
      console.log(`      ${msg}`);
      if (shot) console.log(`      screenshot: ${shot}`);
    }
    for (const n of t.notes) console.log(`      note: ${n}`);
  }
  try {
    await env.ctx.close();
  } catch (_) {}
  await env.server.close();
  const failed = results.filter((r) => !r.ok);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${results.length} cases, ${results.length - failed.length} passed, ${failed.length} failed in ${secs} s`);
  if (failed.length) {
    console.log('Failed:');
    for (const f of failed) console.log(`  - ${f.name}`);
  }
  fs.writeFileSync(
    path.join(OUT, 'results.json'),
    JSON.stringify(results.map((r) => ({ name: r.name, ok: r.ok, ms: r.ms, error: r.error ? String(r.error.message || r.error) : null, shot: r.shot, notes: r.notes })), null, 2),
  );
  return failed.length;
}
