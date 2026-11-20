// tools/package.mjs: the store ZIP. Built from extension/, unpacked, and loaded as the extension.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, test, REPO, EXT, launchSub } from '../lib/harness.mjs';
import { state, waitState, ui, pin, readClipboard, writeClipboard, copyCenter, until } from '../lib/mk.mjs';

const TOOL = path.join(REPO, 'tools/package.mjs');
const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const lines = (dir) => (spawnSync('unzip', ['-Z1', dir], { encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean);

/** A copy of extension/ with a manifest edit applied. */
function brokenCopy(edit) {
  const dir = tmp('mikron-pkgsrc-');
  fs.cpSync(EXT, dir, { recursive: true });
  const f = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  edit(m, dir);
  fs.writeFileSync(f, JSON.stringify(m));
  return dir;
}

describe('packaging', () => {
  test('builds mikron-<version>.zip with manifest.json at the root, deterministic order, no junk, same bytes twice', async (t) => {
    const out1 = tmp('mikron-pkg1-'), out2 = tmp('mikron-pkg2-');
    const src = tmp('mikron-pkgsrc-');
    fs.cpSync(EXT, src, { recursive: true });
    fs.writeFileSync(path.join(src, '.DS_Store'), 'x');
    fs.mkdirSync(path.join(src, '.hidden'));
    fs.writeFileSync(path.join(src, '.hidden/a.txt'), 'x');
    fs.writeFileSync(path.join(src, 'popup/Thumbs.db'), 'x');
    const a = run(['--src', src, '--out', out1]);
    t.eq(a.status, 0, a.stderr);
    const zip = path.join(out1, `mikron-${manifest.version}.zip`);
    const names = lines(zip);
    t.eq(names[0], 'manifest.json', 'manifest first');
    t.ok(!names.some((n) => /(^|\/)(\.|Thumbs\.db)/.test(n)), `junk in zip: ${names.filter((n) => /(^|\/)\./.test(n))}`);
    t.ok(names.every((n) => !n.endsWith('/')), 'no directory entries');
    t.eq(names.slice(1), [...names.slice(1)].sort(), 'rest sorted');
    const onDisk = [];
    const walk = (d, r = '') => fs.readdirSync(path.join(d, r)).forEach((n) => {
      const x = r ? `${r}/${n}` : n;
      fs.statSync(path.join(d, x)).isDirectory() ? walk(d, x) : onDisk.push(x);
    });
    walk(EXT);
    t.eq([...names].sort(), onDisk.sort(), 'zip holds exactly the files of extension/');
    t.ok(/welcome\/welcome\.html/.test(a.stdout) && /manifest\.json/.test(a.stdout), 'prints the file list');
    t.ok(new RegExp(`mikron-${manifest.version}\\.zip\\s+\\d+ bytes`).test(a.stdout), 'prints the zip size');
    run(['--src', src, '--out', out2]);
    const h = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    t.eq(h(path.join(out2, `mikron-${manifest.version}.zip`)), h(zip), 'reproducible bytes');
  });

  test('refuses a manifest with a key, a missing file, a long description, or a page loading a missing script', async (t) => {
    const cases = [
      [(m) => (m.key = 'abc'), /"key"/],
      [(m) => (m.description = 'x'.repeat(133)), /133 characters/],
      [(m) => (m.icons['48'] = 'icons/nope.png'), /missing file: icons\/nope\.png/],
      [(m) => m.content_scripts[0].js.push('content/ghost.js'), /missing file: content\/ghost\.js/],
      [(m) => (m.background.service_worker = 'sw-gone.js'), /missing file: sw-gone\.js/],
      [(m, dir) => fs.writeFileSync(path.join(dir, 'welcome/welcome.html'), '<script src="gone.js"></script>'), /loads a missing file: welcome\/gone\.js/],
    ];
    for (const [edit, re] of cases) {
      const src = brokenCopy(edit);
      const out = tmp('mikron-pkgout-');
      const r = run(['--src', src, '--out', out]);
      t.ok(r.status !== 0, `exit status for ${re}`);
      t.ok(re.test(r.stderr), `message for ${re}: ${r.stderr.trim()}`);
      t.eq(fs.readdirSync(out), [], `no zip left behind for ${re}`);
    }
    const exact = brokenCopy((m) => (m.description = 'x'.repeat(132)));
    t.eq(run(['--src', exact, '--out', tmp('mikron-pkgout-')]).status, 0, '132 characters is allowed');
  });

  test('the real extension/ builds; unpacking the ZIP and loading it arms, drags, pins and copies', async (t) => {
    const out = tmp('mikron-pkgreal-');
    const r = run(['--out', out]);
    t.eq(r.status, 0, r.stderr);
    const unpack = tmp('mikron-unzip-');
    const u = spawnSync('unzip', ['-q', path.join(out, `mikron-${manifest.version}.zip`), '-d', unpack], { encoding: 'utf8' });
    t.eq(u.status, 0, u.stderr);
    t.ok(fs.existsSync(path.join(unpack, 'manifest.json')), 'manifest at the root of the unpacked ZIP');
    const sub = await launchSub(t, unpack);
    try {
      const p = await sub.open('/demo/index.html');
      const reader = await sub.open('/tests/fixtures/gesture.html');
      await writeClipboard(reader, 'sentinel');
      await p.bringToFront();
      const u1 = await pin(p, [90, 20], [630, 470], { pause: 150 });
      t.eq(await state(p), 'pinned', 'pinned');
      t.ok(/540 × 452/.test(u1.label), `label ${u1.label}`);
      const [x, y] = await copyCenter(p);
      await p.mouse.click(x, y);
      await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copied', timeout: 1500 });
      await reader.bringToFront();
      t.ok((await readClipboard(reader)).startsWith('Mikron — 540 × 452'), 'spec on the clipboard');
      await p.bringToFront();
      await p.keyboard.press('Escape');
      await waitState(p, 'idle');
      // and the bundled font, which the worker serves from inside the package
      const ready = await p.evaluate(() => document.fonts.check('700 11px "Mikron Mono"'));
      t.eq(ready, true, 'bundled font loaded from the unpacked ZIP');
    } finally {
      await sub.close();
    }
  }, { timeout: 40000 });
});
