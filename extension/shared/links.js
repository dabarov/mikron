/**
 * MikronLinks: the one place the project's outbound URLs are defined. Plain script (no modules).
 * In a page, every <a data-link="repo|issues|donate"> gets its href, target and rel from here.
 */
(function () {
  'use strict';
  const REPO = 'https://github.com/dabarov/mikron';
  const LINKS = Object.freeze({
    repo: REPO,
    issues: REPO + '/issues',
    donate: 'https://ko-fi.com/dabarov',
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
