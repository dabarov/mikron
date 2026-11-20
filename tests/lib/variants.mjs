// Throwaway copies of extension/ for cases that need a state the shared browser cannot be put in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXT } from './harness.mjs';

/**
 * @param {{autoInject?: boolean, hostGrant?: boolean}} o
 *  autoInject false: the content script matches nothing a test visits, so every tab behaves like one that was
 *    open before the install.
 *  hostGrant true: adds host_permissions to the COPY. Headless Chromium cannot click the toolbar icon, and
 *    chrome.action.openPopup() does not grant activeTab, so this stands in for the access that a real click
 *    grants on the active tab. The popup code under test is the unmodified popup.js.
 */
export function makeVariant({ autoInject = true, hostGrant = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikron-variant-'));
  fs.cpSync(EXT, dir, { recursive: true });
  const f = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!autoInject) m.content_scripts[0].matches = ['https://never.invalid/*'];
  if (hostGrant) m.host_permissions = ['<all_urls>'];
  fs.writeFileSync(f, JSON.stringify(m, null, 2));
  return dir;
}

export const removeVariant = (dir) => fs.rmSync(dir, { recursive: true, force: true });
