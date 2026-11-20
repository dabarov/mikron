/* Mikron service worker: opens the welcome page on first install, keeps the badge in sync, serves the
   font bytes and handles the toggle command. */
importScripts('shared/settings.js');

const { load, save, subscribe } = globalThis.MikronSettings;

async function syncBadge(settings) {
  try {
    const s = settings || (await load());
    await chrome.action.setBadgeText({ text: s.enabled ? '' : 'OFF' });
    if (!s.enabled) {
      await chrome.action.setBadgeBackgroundColor({ color: '#6b6b70' });
      if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
    }
  } catch (_) {}
}

chrome.runtime.onInstalled.addListener((details) => {
  syncBadge();
  // Only a fresh install shows the welcome page; updates and browser upgrades stay silent.
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
});

/** The bundled chip font, as base64, for content scripts. A content-script fetch of the packaged file needs
 *  web_accessible_resources (and fails without it); the worker can read its own package freely, and the
 *  message path is not subject to the page's CSP. */
let fontReply = null;
function loadFont() {
  return (fontReply ||= fetch(chrome.runtime.getURL('fonts/GeistMono-Bold.woff2'))
    .then((r) => {
      if (!r.ok) throw new Error('font ' + r.status);
      return r.arrayBuffer();
    })
    .then((buf) => {
      const u = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      return btoa(s);
    })
    .catch((e) => {
      fontReply = null;
      throw e;
    }));
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.mikron !== 'font' || sender.id !== chrome.runtime.id) return false;
  loadFont().then(
    (b64) => sendResponse({ ok: true, b64 }),
    () => sendResponse({ ok: false }),
  );
  return true;
});

chrome.runtime.onStartup.addListener(() => syncBadge());

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-enabled') return;
  const s = await load();
  const next = await save({ enabled: !s.enabled });
  syncBadge(next);
});

subscribe((s) => syncBadge(s));

// The worker may be started by any event; make sure the badge is right.
syncBadge();
