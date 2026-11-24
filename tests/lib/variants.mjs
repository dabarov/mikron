// Throwaway copies of extension/ for cases that need a state the shared browser cannot be put in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXT } from './harness.mjs';

/**
 * @param {{autoInject?: boolean, hostGrant?: boolean, storeUrl?: string, siteUrl?: string}} o
 *  autoInject false: the content script matches nothing a test visits, so every tab behaves like one that was
 *    open before the install.
 *  hostGrant true: adds host_permissions to the COPY. Headless Chromium cannot click the toolbar icon, and
 *    chrome.action.openPopup() does not grant activeTab, so this stands in for the access that a real click
 *    grants on the active tab. The popup code under test is the unmodified popup.js.
 *  storeUrl: replaces the store address in the COPY's shared/links.js, so a case can follow the Rate link to a
 *    local page instead of the real Chrome Web Store.
 *  siteUrl: the same for the project site address (the page Chrome opens after an uninstall lives under it).
 */
export function makeVariant({ autoInject = true, hostGrant = false, storeUrl = '', siteUrl = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikron-variant-'));
  fs.cpSync(EXT, dir, { recursive: true });
  const f = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!autoInject) m.content_scripts[0].matches = ['https://never.invalid/*'];
  if (hostGrant) m.host_permissions = ['<all_urls>'];
  fs.writeFileSync(f, JSON.stringify(m, null, 2));
  for (const [name, value] of [['STORE', storeUrl], ['SITE', siteUrl]]) {
    if (!value) continue;
    const lf = path.join(dir, 'shared/links.js');
    const src = fs.readFileSync(lf, 'utf8');
    const out = src.replace(new RegExp(`const ${name} = '[^']*';`), `const ${name} = ${JSON.stringify(value)};`);
    if (out === src) throw new Error(`makeVariant: ${name} address not found in shared/links.js`);
    fs.writeFileSync(lf, out);
  }
  return dir;
}

export const removeVariant = (dir) => fs.rmSync(dir, { recursive: true, force: true });
