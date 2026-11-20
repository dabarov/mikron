/* Mikron bundled monospace face ("Mikron Mono" = Geist Mono Bold, latin subset, SIL OFL 1.1; see fonts/OFL.txt).
 *
 * Why not @font-face: Chrome ignores @font-face inside a shadow root, and a rule injected into the page would
 * be subject to the page's CSP `font-src`. Instead the bytes come from the service worker (a content-script
 * fetch of the packaged file would need web_accessible_resources, and fails without it) and are registered with
 * `new FontFace(name, ArrayBuffer)`, a binary source that no CSP directive applies to.
 *
 * Nothing runs until load() is called (the first time the overlay is created). While the face is not ready
 * every consumer uses the system stack (tokens.fontMono) for BOTH measuring and painting; consumers sample
 * ready() at one well-defined point (blueprint.setModel, ui.showMarquee) so the two never disagree.
 * Failure of any kind leaves the extension on the system stack, silently.
 */
(function () {
  'use strict';
  const M = (globalThis.__MIKRON__ ||= {});

  const FAMILY = 'Mikron Mono';
  const WEIGHT = '700';
  let state = 'idle'; // idle | loading | ready | failed
  let face = null;
  let gen = 0; // bumped whenever ready() flips
  const listeners = new Set();

  function set(next) {
    if (state === next) return;
    const was = state === 'ready';
    state = next;
    if ((state === 'ready') !== was) {
      gen++;
      for (const fn of Array.from(listeners)) {
        try { fn(state === 'ready'); } catch (_) { /* ignore */ }
      }
    }
  }

  function decode(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }

  async function run() {
    try {
      const res = await chrome.runtime.sendMessage({ mikron: 'font' });
      if (state !== 'loading') return; // disposed meanwhile
      if (!res || !res.ok || typeof res.b64 !== 'string') throw new Error('no font');
      const f = new FontFace(FAMILY, decode(res.b64), { weight: WEIGHT, style: 'normal' });
      await f.load();
      if (state !== 'loading') return;
      document.fonts.add(f);
      face = f;
      set('ready');
    } catch (_) {
      if (state === 'loading') set('failed');
    }
  }

  M.font = {
    family: FAMILY,
    /** Start loading (idempotent; a failed load is not retried within this page's lifetime). */
    load() {
      if (state !== 'idle' || !globalThis.FontFace || !document.fonts) return;
      state = 'loading';
      run();
    },
    /** True while the face is registered and usable. */
    ready: () => state === 'ready',
    /** Cheap sanity check (page script may have called document.fonts.clear()); flips to failed when gone. */
    verify() {
      if (state === 'ready') {
        let ok = false;
        try { ok = !!face && document.fonts.has(face); } catch (_) { /* ignore */ }
        if (!ok) set('failed');
      }
      return state === 'ready';
    },
    generation: () => gen,
    /** cb(isReady) after the ready state flips. Returns an unsubscribe function. */
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    /** Remove the face from the page (teardown). */
    dispose() {
      listeners.clear();
      try { if (face) document.fonts.delete(face); } catch (_) { /* ignore */ }
      face = null;
      state = 'failed';
    },
  };
})();
