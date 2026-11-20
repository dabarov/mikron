// Open the REAL toolbar popup (chrome.action.openPopup) and talk to it over raw CDP.
// Playwright does not surface popup targets as pages, but the browser lists them on the debugging port.
// Opening it this way is what grants activeTab for the active tab, exactly as a click on the icon does.
import { sleep } from './harness.mjs';

async function targets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}

/** Minimal CDP client for one target. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('cdp connect failed'));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { res, rej } = pending.get(d.id);
      pending.delete(d.id);
      d.error ? rej(new Error(d.error.message)) : res(d.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      pending.set(++id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
      return r.result.value;
    },
    close: () => ws.close(),
  };
}

/**
 * Bring `page` to the front and open the real popup over it.
 * @returns {Promise<{eval:(js:string)=>Promise<any>, screenshot:(file:string)=>Promise<void>, close:()=>Promise<void>}>}
 */
export async function openRealPopup(t, page) {
  const { port, sw, id } = { port: t.ext.debugPort, sw: t.ext.sw, id: t.ext.id };
  await page.bringToFront();
  const known = new Set((await targets(port)).map((x) => x.id));
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.action.openPopup({ windowId: tab.windowId });
  });
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    target = (await targets(port)).find((x) => !known.has(x.id) && x.url.startsWith(`chrome-extension://${id}/popup/popup.html`));
    if (!target) await sleep(50);
  }
  if (!target) throw new Error('the popup did not open');
  const cdp = await connect(target.webSocketDebuggerUrl);
  const api = {
    eval: (js) => cdp.eval(js),
    async screenshot(file, { scale = 2 } = {}) {
      const { fs } = await import('node:fs').then((fs) => ({ fs }));
      const m = await cdp.send('Page.getLayoutMetrics');
      const w = Math.ceil(m.cssContentSize.width), h = Math.ceil(m.cssContentSize.height);
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale } });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    async close() {
      cdp.close();
      try {
        await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
      } catch (_) {}
    },
  };
  // wait until the popup has finished its async init (settings loaded and the first render done)
  for (let i = 0; i < 80; i++) {
    if (await api.eval(`!!document.querySelector('#modifier button[aria-checked="true"]')`).catch(() => false)) break;
    await sleep(50);
  }
  return api;
}
