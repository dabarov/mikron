#!/usr/bin/env node
/**
 * package.mjs: builds dist/mikron-<version>.zip from the contents of extension/ (manifest.json at the ZIP root).
 *
 *   node tools/package.mjs                      # -> dist/mikron-<version>.zip
 *   node tools/package.mjs --src DIR --out DIR  # other source / output folder (used by the tests)
 *
 * Refuses to build when the manifest has a `key` field, references a file that is missing, or has a
 * description over 132 characters (the Chrome Web Store limit). Dotfiles and OS junk are left out, files go in
 * in a fixed order with a fixed timestamp, so the same sources always give the same bytes.
 * Uses the system `zip`; no npm dependencies.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const SRC = path.resolve(opt('--src', path.join(ROOT, 'extension')));
const OUT = path.resolve(opt('--out', path.join(ROOT, 'dist')));

const JUNK = /^(\.|Thumbs\.db$|desktop\.ini$|__MACOSX$|.*~$|.*\.(orig|rej|swp|tmp)$)/i;

function fail(msgs) {
  for (const m of [].concat(msgs)) console.error(`package: ${m}`);
  process.exit(1);
}

function readManifest() {
  const file = path.join(SRC, 'manifest.json');
  if (!fs.existsSync(file)) fail(`no manifest.json in ${SRC}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(`manifest.json is not valid JSON: ${e.message}`);
  }
}

/** Every package-relative path the manifest points at (globs in web_accessible_resources are skipped). */
function referencedFiles(m) {
  const refs = new Set();
  const add = (p) => typeof p === 'string' && p && !/[*?]/.test(p) && refs.add(p);
  Object.values(m.icons || {}).forEach(add);
  const a = m.action || m.browser_action || m.page_action || {};
  add(a.default_popup);
  if (typeof a.default_icon === 'string') add(a.default_icon);
  else Object.values(a.default_icon || {}).forEach(add);
  add(m.background && m.background.service_worker);
  add(m.options_page);
  add(m.options_ui && m.options_ui.page);
  for (const cs of m.content_scripts || []) [...(cs.js || []), ...(cs.css || [])].forEach(add);
  for (const w of m.web_accessible_resources || []) (w.resources || []).forEach(add);
  return [...refs];
}

/** Relative files that packaged HTML pages load (script src, stylesheet href, img src). */
function htmlReferences(files) {
  const out = [];
  for (const f of files.filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const [, url] of html.matchAll(/<(?:script|img|link)\b[^>]*?\b(?:src|href)="([^"#?]+)[^"]*"/gi)) {
      if (/^([a-z]+:)?\/\//i.test(url) || /^[a-z]+:/i.test(url)) continue;
      out.push({ from: f, file: path.posix.normalize(path.posix.join(path.posix.dirname(f), url)) });
    }
  }
  return out;
}

function walk(dir, rel = '') {
  const out = [];
  const names = fs.readdirSync(path.join(dir, rel)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const n of names) {
    if (JUNK.test(n)) continue;
    const r = rel ? `${rel}/${n}` : n;
    const st = fs.statSync(path.join(dir, r));
    if (st.isDirectory()) out.push(...walk(dir, r));
    else if (st.isFile()) out.push(r);
  }
  return out;
}

const manifest = readManifest();
const files = walk(SRC);
const errors = [];

if ('key' in manifest) errors.push('manifest.json contains a "key" field (the store assigns the key; remove it)');
if (typeof manifest.description !== 'string' || !manifest.description) errors.push('manifest.json has no description');
else if (manifest.description.length > 132) errors.push(`description is ${manifest.description.length} characters (limit 132)`);
if (typeof manifest.name === 'string' && manifest.name.length > 75) errors.push(`name is ${manifest.name.length} characters (limit 75)`);
if (typeof manifest.short_name === 'string' && manifest.short_name.length > 12) errors.push(`short_name is ${manifest.short_name.length} characters (limit 12)`);
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || '')) errors.push(`invalid version "${manifest.version}"`);
for (const f of referencedFiles(manifest)) if (!files.includes(f.replace(/^\.?\//, ''))) errors.push(`manifest references a missing file: ${f}`);
for (const r of htmlReferences(files)) if (!files.includes(r.file)) errors.push(`${r.from} loads a missing file: ${r.file}`);
if (errors.length) fail(errors);

const zipCheck = spawnSync('zip', ['-v'], { encoding: 'utf8' });
if (zipCheck.error || zipCheck.status !== 0) fail('the system `zip` command is required');

fs.mkdirSync(OUT, { recursive: true });
const zipPath = path.join(OUT, `mikron-${manifest.version}.zip`);
fs.rmSync(zipPath, { force: true });

// Stage with a fixed mtime so the archive does not depend on when the files were last saved.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mikron-pkg-'));
const FIXED = new Date('2020-01-01T00:00:00Z');
const order = ['manifest.json', ...files.filter((f) => f !== 'manifest.json')];
for (const f of order) {
  const dst = path.join(stage, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(SRC, f), dst);
  fs.utimesSync(dst, FIXED, FIXED);
}
const z = spawnSync('zip', ['-X', '-D', '-9', '-q', zipPath, '-@'], { cwd: stage, input: order.join('\n') + '\n', encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
fs.rmSync(stage, { recursive: true, force: true });
if (z.status !== 0) fail(`zip failed: ${z.stderr || z.stdout}`);

let total = 0;
for (const f of order) {
  const n = fs.statSync(path.join(SRC, f)).size;
  total += n;
  console.log(`${String(n).padStart(8)}  ${f}`);
}
const zsize = fs.statSync(zipPath).size;
console.log(`\n${order.length} files, ${total} bytes unpacked`);
console.log(`${path.relative(process.cwd(), zipPath) || zipPath}  ${zsize} bytes`);
