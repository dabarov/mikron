// Generates extension/icons/icon{16,32,48,128}.png by rendering an SVG in Playwright's Chromium.
// Usage: node tools/make-icons.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(root + '/')('playwright');
const outDir = join(root, 'extension', 'icons');
mkdirSync(outDir, { recursive: true });

const BLUE = '#0a8cff';

/** Design lives on a 128 grid; small sizes get heavier strokes and fewer details. */
function svg(size) {
  const small = size <= 16;
  const mid = size <= 32;
  const sw = small ? 16 : mid ? 10 : 8; // marquee stroke
  const x1 = small ? 26 : 22, y1 = small ? 28 : 24, x2 = small ? 102 : 106, y2 = small ? 80 : 78;
  const handle = small ? 0 : 11; // corner handles
  const tickY = small ? 104 : 102;
  const tickSw = small ? 0 : mid ? 7 : 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1b1e"/><stop offset="1" stop-color="#0d0d0e"/></linearGradient>
  </defs>
  <rect x="1" y="1" width="126" height="126" rx="30" fill="url(#bg)"/>
  <rect x="1.5" y="1.5" width="125" height="125" rx="29.5" fill="none" stroke="#ffffff" stroke-opacity=".10" stroke-width="${small ? 0 : 2}"/>
  <rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" fill="${BLUE}" fill-opacity=".18" stroke="${BLUE}" stroke-width="${sw}" stroke-linejoin="miter"/>
  ${handle ? [[x1, y1], [x2, y1], [x1, y2], [x2, y2]].map(([x, y]) => `<rect x="${x - handle / 2}" y="${y - handle / 2}" width="${handle}" height="${handle}" rx="2" fill="#ffffff"/>`).join('') : ''}
  ${tickSw ? `<g stroke="${BLUE}" stroke-width="${tickSw}" stroke-linecap="butt"><path d="M${x1} ${tickY}H${x2}"/><path d="M${x1} ${tickY - 7}V${tickY + 7}"/><path d="M${x2} ${tickY - 7}V${tickY + 7}"/></g>` : `<rect x="${x1 - 6}" y="${tickY - 7}" width="${x2 - x1 + 12}" height="14" fill="${BLUE}"/>`}
</svg>`;
}

const browser = await chromium.launch({ channel: 'chromium' });
for (const size of [16, 32, 48, 128]) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`);
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(join(outDir, `icon${size}.png`), buf);
  await ctx.close();
}
await browser.close();
console.log('icons written to', outDir);
