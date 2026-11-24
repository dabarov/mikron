/* Web demo, part 1 of 2. Included as text by tools/build-site.mjs at the top of the bundle, before the
 * extension's content scripts and inside the same function, so the name `chrome` below is what they see.
 *
 * It stands in for the two things the scripts ask the extension for: a live runtime id (they shut down when it
 * is gone) and the bytes of the chip font, which the service worker serves in the real extension. There is no
 * chrome.storage here, so settings fall back to their defaults in memory, and nothing answers the "copied"
 * message, so the rating reminder never shows.
 */
const FONT_URL = new URL('fonts/GeistMono-Bold.woff2', document.currentScript.src).href;
let fontB64 = null;
function loadFont() {
  return (fontB64 ||= fetch(FONT_URL)
    .then((r) => {
      if (!r.ok) throw new Error('font ' + r.status);
      return r.arrayBuffer();
    })
    .then((buf) => {
      const u = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      return btoa(s);
    }));
}
const chrome = {
  runtime: {
    id: 'mikron-web-demo',
    lastError: undefined,
    sendMessage(msg) {
      if (msg && msg.mikron === 'font') {
        return loadFont().then(
          (b64) => ({ ok: true, b64 }),
          () => ({ ok: false }),
        );
      }
      return Promise.resolve(undefined);
    },
    onMessage: { addListener() {}, removeListener() {} },
  },
};
