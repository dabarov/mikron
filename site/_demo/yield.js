/* Web demo, part 2 of 2. Included as text by tools/build-site.mjs between content/ui.js and content/main.js.
 *
 * A visitor who already has Mikron installed gets the real extension on this page, and this copy steps aside so
 * there is only ever one overlay. The extension's listeners were registered first (document_start), so when both
 * arm on the same event its <mikron-root> is already in the page by the time this copy would create its own.
 * The observer covers the other order (the extension started in this tab later, from its toolbar icon).
 */
(function () {
  const M = globalThis.__MIKRON__;
  const create = M.createUI;
  let obs = null;
  let mine = null;
  function stepAside() {
    try {
      obs && obs.disconnect();
    } catch (_) {}
    obs = null;
    try {
      M.teardown && M.teardown();
    } catch (_) {}
    document.documentElement.dataset.mikronDemo = 'extension';
  }
  M.createUI = function () {
    if (document.querySelector('mikron-root')) {
      queueMicrotask(stepAside);
      throw new Error('Mikron is installed: the page copy steps aside');
    }
    const ui = create();
    mine = ui.host;
    document.documentElement.dataset.mikronDemo = 'page';
    obs = new MutationObserver(() => {
      const roots = document.querySelectorAll('mikron-root');
      if (roots.length > 1 || (roots.length === 1 && roots[0] !== mine)) stepAside();
    });
    obs.observe(document.documentElement, { childList: true });
    return ui;
  };
})();
