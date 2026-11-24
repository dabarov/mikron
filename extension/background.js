/* Mikron service worker: opens the welcome page on first install, keeps the badge in sync, serves the
   font bytes, handles the toggle command, counts copied specs for the one-time rating reminder and sets the
   page Chrome opens after an uninstall. */
importScripts('shared/settings.js', 'shared/links.js');

const { load, save, subscribe } = globalThis.MikronSettings;
const LINKS = globalThis.MikronLinks;

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
/**
 * One-time rating reminder. Content scripts report every copied spec; the reply is `ask: true` from the
 * RATE_AFTER-th copy on, until a tab reports that it showed the reminder (or the Rate link was used), and never
 * again after that. Only the two values below are kept, in chrome.storage.local, on this device.
 */
const STATS_KEY = 'mikronStats';
const RATE_AFTER = 5;
let statsQueue = Promise.resolve();
/** Run fn(stats) -> [nextStats | null, result] one at a time, so concurrent messages cannot lose an update. */
function withStats(fn) {
  const run = statsQueue.then(async () => {
    const got = await chrome.storage.local.get(STATS_KEY);
    const cur = got && got[STATS_KEY] && typeof got[STATS_KEY] === 'object' ? got[STATS_KEY] : {};
    const st = { copies: Math.max(0, Number(cur.copies) || 0), rateAsked: !!cur.rateAsked };
    const [next, result] = fn(st);
    if (next) await chrome.storage.local.set({ [STATS_KEY]: next });
    return result;
  });
  statsQueue = run.catch(() => {});
  return run;
}
const noteCopy = () => withStats((st) => (st.rateAsked ? [null, false] : [{ ...st, copies: st.copies + 1 }, st.copies + 1 >= RATE_AFTER]));
const noteRateAsked = () => withStats((st) => (st.rateAsked ? [null, true] : [{ ...st, rateAsked: true }, true]));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  switch (msg.mikron) {
    case 'font':
      loadFont().then(
        (b64) => sendResponse({ ok: true, b64 }),
        () => sendResponse({ ok: false }),
      );
      return true;
    case 'copied':
      noteCopy().then(
        (ask) => sendResponse({ ask }),
        () => sendResponse({ ask: false }),
      );
      return true;
    case 'rate-shown':
      noteRateAsked().catch(() => {});
      return false;
    case 'rate': {
      // The address is fixed here; nothing from the message decides where the tab goes.
      noteRateAsked().catch(() => {});
      const tab = sender.tab;
      chrome.tabs.create({ url: LINKS.rate, ...(tab && tab.index != null ? { index: tab.index + 1, windowId: tab.windowId } : {}) }).catch(() => {});
      return false;
    }
    default:
      return false;
  }
});

chrome.runtime.onStartup.addListener(() => syncBadge());

/** After an uninstall Chrome opens this page: a static page of the project site with the usual fixes and a
 *  link to a feedback form. The address carries the version that was removed and nothing else. */
function syncUninstallUrl() {
  try {
    const p = chrome.runtime.setUninstallURL(`${LINKS.uninstalled}?v=${encodeURIComponent(chrome.runtime.getManifest().version)}`);
    if (p && p.catch) p.catch(() => {});
  } catch (_) {}
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-enabled') return;
  const s = await load();
  const next = await save({ enabled: !s.enabled });
  syncBadge(next);
});

subscribe((s) => syncBadge(s));

// The worker may be started by any event; make sure the badge and the uninstall page are right.
syncBadge();
syncUninstallUrl();
