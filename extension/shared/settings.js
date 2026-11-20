/**
 * MikronSettings — shared by content scripts, the popup and the service worker.
 * Plain script (no modules). Never throws when chrome.storage is unavailable:
 * it falls back to an in-memory store so callers can use it unconditionally.
 */
(function () {
  'use strict';

  const KEY = 'mikron';

  const DEFAULTS = Object.freeze({
    enabled: true,
    modifier: 'shift', // 'shift' | 'alt' | 'ctrl' | 'meta'
    showHint: true,
    snap: 4, // 0 = off
    copyFormat: 'text', // 'text' | 'json'
    disabledSites: Object.freeze([
      'figma.com',
      'miro.com',
      'excalidraw.com',
      'tldraw.com',
      'canva.com',
      'docs.google.com',
    ]),
  });

  const MODIFIERS = ['shift', 'alt', 'ctrl', 'meta'];
  const FORMATS = ['text', 'json'];

  /** Fallback store when chrome.storage is missing (plain file, tests). */
  let memory = {};
  const memListeners = new Set();

  function area() {
    try {
      // Reading chrome.runtime.id also throws/undefined on an orphaned content script.
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync && chrome.runtime && chrome.runtime.id) {
        return chrome.storage.sync;
      }
    } catch (_) {}
    return null;
  }

  /** Fresh defaults object (mutable copy; disabledSites is a new array). */
  function defaults() {
    return { ...DEFAULTS, disabledSites: DEFAULTS.disabledSites.slice() };
  }

  /** Merge a stored (possibly partial / corrupt) value over DEFAULTS and sanitise. */
  function normalize(stored) {
    const s = { ...defaults(), ...(stored && typeof stored === 'object' ? stored : {}) };
    s.enabled = !!s.enabled;
    s.showHint = !!s.showHint;
    if (!MODIFIERS.includes(s.modifier)) s.modifier = DEFAULTS.modifier;
    if (!FORMATS.includes(s.copyFormat)) s.copyFormat = DEFAULTS.copyFormat;
    const snap = Number(s.snap);
    s.snap = Number.isFinite(snap) && snap >= 0 ? snap : DEFAULTS.snap;
    s.disabledSites = Array.isArray(s.disabledSites)
      ? s.disabledSites.filter((x) => typeof x === 'string' && x).map((x) => x.toLowerCase())
      : DEFAULTS.disabledSites.slice();
    return s;
  }

  function getStored() {
    const a = area();
    if (!a) return Promise.resolve(memory);
    return new Promise((resolve) => {
      try {
        a.get(KEY, (res) => {
          void chrome.runtime.lastError; // swallow
          resolve((res && res[KEY]) || {});
        });
      } catch (_) {
        resolve(memory);
      }
    });
  }

  function setStored(value) {
    const a = area();
    if (!a) {
      memory = value;
      memListeners.forEach((cb) => cb(normalize(memory)));
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      try {
        a.set({ [KEY]: value }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch (_) {
        memory = value;
        resolve();
      }
    });
  }

  /** @returns {Promise<object>} DEFAULTS merged with the persisted settings. */
  async function load() {
    return normalize(await getStored());
  }

  /** Shallow-merge `patch` into the persisted settings. @returns {Promise<object>} */
  async function save(patch) {
    const next = normalize({ ...(await getStored()), ...(patch || {}) });
    await setStored(next);
    return next;
  }

  /** Calls cb(settings) on every change. @returns {() => void} unsubscribe */
  function subscribe(cb) {
    let onChanged = null;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        onChanged = (changes, areaName) => {
          if (areaName !== 'sync' || !changes[KEY]) return;
          try {
            cb(normalize(changes[KEY].newValue));
          } catch (_) {}
        };
        chrome.storage.onChanged.addListener(onChanged);
      }
    } catch (_) {
      onChanged = null;
    }
    const mem = (s) => {
      try {
        cb(s);
      } catch (_) {}
    };
    if (!area()) memListeners.add(mem);
    return function unsubscribe() {
      memListeners.delete(mem);
      try {
        if (onChanged) chrome.storage.onChanged.removeListener(onChanged);
      } catch (_) {}
      onChanged = null;
    };
  }

  /** True if hostname === entry or is a subdomain of it. */
  function isSiteDisabled(settings, hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
    const list = (settings && settings.disabledSites) || [];
    return list.some((entry) => {
      const e = String(entry).toLowerCase().replace(/^www\./, '');
      return !!e && (host === e || host.endsWith('.' + e));
    });
  }

  globalThis.MikronSettings = { DEFAULTS, load, save, subscribe, isSiteDisabled };
})();
