// Mikron-specific page helpers. Everything is observed through the DOM (the content script lives in
// an isolated world): <mikron-root data-state>, its open shadow root, computed styles, page probes.
import { sleep, until } from './harness.mjs';

export const KEY = { shift: 'Shift', alt: 'Alt', ctrl: 'Control', meta: 'Meta' };

export async function state(page) {
  return page.evaluate(() => {
    const h = document.querySelector('mikron-root');
    return h ? h.dataset.state : 'absent';
  });
}

/** Wait until data-state is one of `want` (string or array; 'absent' counts as idle when idleOk). */
export async function waitState(page, want, { timeout = 2000 } = {}) {
  const list = Array.isArray(want) ? want : [want];
  try {
    await page.waitForFunction(
      (l) => {
        const h = document.querySelector('mikron-root');
        const s = h ? h.dataset.state : 'absent';
        return l.includes(s) || (l.includes('idle') && s === 'absent');
      },
      list,
      { timeout, polling: 'raf' },
    );
  } catch (e) {
    const s = await state(page).catch(() => '?');
    throw new Error(`expected state ${list.join('|')} within ${timeout} ms, got "${s}"`);
  }
}

/** Assert that the state never becomes one of `bad` during `ms`. Returns the set of observed states. */
export async function watchStates(page, ms) {
  return page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const seen = new Set();
        const t0 = performance.now();
        const tick = () => {
          const h = document.querySelector('mikron-root');
          seen.add(h ? h.dataset.state : 'absent');
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else resolve([...seen]);
        };
        tick();
      }),
    ms,
  );
}

/** Snapshot of the overlay chrome. Rects are viewport coords. */
export async function ui(page) {
  return page.evaluate(() => {
    const h = document.querySelector('mikron-root');
    if (!h || !h.shadowRoot) return null;
    const sr = h.shadowRoot;
    const q = (s) => sr.querySelector(s);
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const vis = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.01;
    };
    const stage = q('.mk-stage'), marquee = q('.mk-marquee'), label = q('.mk-size-label'), copy = q('.mk-copy'), hint = q('.mk-hint');
    const bp = q('.mk-bp');
    return {
      state: h.dataset.state,
      parent: h.parentNode && h.parentNode.nodeName,
      stageOn: !!stage && stage.classList.contains('on') && !stage.classList.contains('out'),
      stageVisible: vis(stage),
      marquee: rect(marquee),
      label: label ? label.textContent : null,
      labelTitle: label ? label.getAttribute('title') : null,
      labelRect: rect(label),
      labelShown: !!label && label.classList.contains('show'),
      copyShown: !!copy && copy.classList.contains('show'),
      copyRect: rect(copy),
      copyText: copy ? copy.textContent.trim() : null,
      hintOn: !!hint && hint.classList.contains('on'),
      hintText: hint ? hint.textContent.replace(/\\s+/g, ' ').trim() : null,
      hintRect: rect(hint),
      hintHtml: hint ? hint.innerHTML : '',
      shieldOn: !!q('.mk-shield') && q('.mk-shield').classList.contains('on'),
      bpClip: bp ? bp.style.clipPath : null,
      bpVisible: bp ? bp.style.visibility : null,
      canvasCount: sr.querySelectorAll('canvas').length,
      chipCount: sr.querySelectorAll('.mk-chip').length,
      arcCount: sr.querySelectorAll('.mk-arcs g').length,
      elementCount: sr.querySelectorAll('*').length,
    };
  });
}

export async function chips(page) {
  return page.evaluate(() => {
    const h = document.querySelector('mikron-root');
    if (!h || !h.shadowRoot) return [];
    return [...h.shadowRoot.querySelectorAll('.mk-chip')].map((c) => {
      const r = c.getBoundingClientRect();
      return { kind: c.dataset.kind, text: c.textContent, x: r.x, y: r.y, w: r.width, h: r.height };
    });
  });
}

/** Radius callout dots (viewport centre) of the live arcs. */
export async function arcs(page) {
  return page.evaluate(() => {
    const h = document.querySelector('mikron-root');
    if (!h || !h.shadowRoot) return [];
    return [...h.shadowRoot.querySelectorAll('.mk-arcs g')].map((g) => {
      const c = g.querySelector('circle');
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, d: g.querySelector('path').getAttribute('d') };
    });
  });
}

/** Wait until chip texts stop changing (count-ups finished). */
export async function chipsSettled(page, { timeout = 3000, quiet = 160 } = {}) {
  const t0 = Date.now();
  let prev = null, since = Date.now();
  for (;;) {
    const c = await chips(page);
    const key = JSON.stringify(c.map((x) => [x.text, Math.round(x.x), Math.round(x.y)]));
    if (key !== prev) {
      prev = key;
      since = Date.now();
    } else if (Date.now() - since >= quiet) return c;
    if (Date.now() - t0 > timeout) return c;
    await sleep(30);
  }
}

export async function cursor(page, sel = 'body') {
  return page.evaluate((s) => getComputedStyle(document.querySelector(s)).cursor, sel);
}

export async function cursorStyleInfo(page) {
  return page.evaluate(() => [...document.querySelectorAll('style[data-mikron]')].map((s) => ({ disabled: s.sheet ? s.sheet.disabled : null, text: s.textContent })));
}

// ---- input -------------------------------------------------------------------------------------

export async function move(page, x, y, steps = 1) {
  await page.mouse.move(x, y, { steps });
}

/** Hold the modifier long enough and move the pointer so the visible armed state appears. */
export async function arm(page, { mod = 'shift', at = [200, 200], wait = true } = {}) {
  await page.mouse.move(at[0], at[1]);
  await page.keyboard.down(KEY[mod]);
  await sleep(290);
  await page.mouse.move(at[0] + 6, at[1] + 6, { steps: 2 });
  await page.mouse.move(at[0] + 10, at[1] + 10, { steps: 2 });
  if (wait) await waitState(page, 'armed');
}

/**
 * Modifier + press + drag. Options:
 *  mod: modifier name; steps: pointer move steps; release: mouse up at the end;
 *  keepMod: keep the modifier held afterwards; armFirst: show the visible armed state first;
 *  pause: ms to wait at the end point before releasing (lets the eased corner settle).
 */
export async function drag(page, from, to, { mod = 'shift', steps = 12, release = true, keepMod = false, armFirst = false, pause = 0 } = {}) {
  if (armFirst) {
    await arm(page, { mod, at: [from[0] - 10, from[1] - 10] });
    await page.mouse.move(from[0], from[1], { steps: 2 });
  } else {
    await page.mouse.move(from[0], from[1]);
    if (mod) await page.keyboard.down(KEY[mod]);
  }
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  if (pause) await sleep(pause);
  if (release) await page.mouse.up();
  if (mod && !keepMod) await page.keyboard.up(KEY[mod]);
}

/** Drag + wait for pinned + settled chips. */
export async function pin(page, from, to, opts = {}) {
  await drag(page, from, to, opts);
  await waitState(page, 'pinned');
  return ui(page);
}

export async function resetProbe(page) {
  await page.evaluate(() => window.__mk.reset());
}
export async function events(page, filter) {
  return page.evaluate(() => window.__mk.ev);
}
export async function count(page, type, phase) {
  return page.evaluate(([t, p]) => window.__mk.count(t, p), [type, phase]);
}
export async function types(page, phase) {
  return page.evaluate((p) => window.__mk.types(p), phase);
}

export async function readClipboard(page) {
  return page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch (e) {
      return 'ERR:' + e.message;
    }
  });
}
export async function writeClipboard(page, text) {
  return page.evaluate(async (t) => {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (e) {
      return 'ERR:' + e.message;
    }
  }, text);
}

/** Copy tab centre in viewport coords. */
export async function copyCenter(page) {
  const u = await ui(page);
  return [u.copyRect.x + u.copyRect.w / 2, u.copyRect.y + u.copyRect.h / 2];
}

export async function rect(page, selector) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);
}

export function overlaps(a, b, pad = 0) {
  return a.x < b.x + b.w - pad && a.x + a.w > b.x + pad && a.y < b.y + b.h - pad && a.y + a.h > b.y + pad;
}

/** Evaluate an expression in Mikron's isolated world via CDP (diagnostics only). */
export async function isoEval(page, expression) {
  const ctx = (page._mkContexts || []).filter((c) => c.auxData && c.auxData.type === 'isolated' && String(c.origin).startsWith('chrome-extension://')).pop();
  if (!ctx) throw new Error('Mikron isolated world not found');
  const r = await page._mkCdp.send('Runtime.evaluate', { expression, contextId: ctx.id, returnByValue: true });
  return r.result.value;
}

/** Event listeners on window/document as registered from Mikron's isolated world. */
export async function mikronListeners(page) {
  const ctx = (page._mkContexts || []).filter((c) => c.auxData && c.auxData.type === 'isolated' && String(c.origin).startsWith('chrome-extension://')).pop();
  const out = {};
  for (const name of ['window', 'document']) {
    const { result } = await page._mkCdp.send('Runtime.evaluate', { expression: name, contextId: ctx.id });
    const { listeners } = await page._mkCdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    out[name] = listeners.length;
  }
  return out;
}

export { sleep, until };
