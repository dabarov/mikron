/**
 * MikronLinks: the one place the project's outbound URLs are defined. Plain script (no modules); also loaded
 * by the service worker. In a page, every <a data-link="repo|issues|donate|store|rate"> gets its href, target
 * and rel from here.
 */
(function () {
  'use strict';
  const REPO = 'https://github.com/dabarov/mikron';
  const STORE = 'https://chromewebstore.google.com/detail/mikron-measure-css-spacin/ijpekfklopidjlpghniabhgglndlochd';
  const SITE = 'https://dabarov.github.io/mikron/';
  const LINKS = Object.freeze({
    repo: REPO,
    issues: REPO + '/issues',
    donate: 'https://ko-fi.com/dabarov',
    store: STORE,
    rate: STORE + '/reviews',
    site: SITE,
    uninstalled: SITE + 'uninstalled/',
  });

  function wire(root) {
    root.querySelectorAll('a[data-link]').forEach((a) => {
      const href = LINKS[a.dataset.link];
      if (!href) return;
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });
  }

  globalThis.MikronLinks = LINKS;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => wire(document));
    else wire(document);
  }
})();
