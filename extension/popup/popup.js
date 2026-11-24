(function () {
  'use strict';
  const S = globalThis.MikronSettings;
  const $ = (id) => document.getElementById(id);

  const MOD_LABEL = { shift: '⇧ Shift', alt: '⌥ Alt', ctrl: '⌃ Ctrl', meta: '⌘ Cmd' };
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

  let settings = { ...S.DEFAULTS, disabledSites: S.DEFAULTS.disabledSites.slice() };
  let hostname = null; // current tab hostname if http(s)
  let blocked = false; // the active tab cannot run Mikron (browser page, Web Store, file:// without access)

  /** Entry in disabledSites that currently matches this hostname (exact or parent domain). */
  function matchingEntries() {
    const host = hostname.replace(/^www\./, '');
    return settings.disabledSites.filter((e) => host === e || host.endsWith('.' + e));
  }

  function setSeg(el, value) {
    el.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.value === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  function render() {
    $('enabled').checked = settings.enabled;
    $('status').textContent = blocked ? "Mikron can't run on this page" : settings.enabled ? 'Measure anything on the page' : 'Paused everywhere';
    $('pop').classList.toggle('is-off', !settings.enabled);
    $('pop').classList.toggle('is-blocked', blocked);

    const site = $('siteEnabled');
    $('siteGroup').hidden = !hostname || blocked;
    if (hostname && !blocked) {
      $('host').textContent = hostname;
      $('host').title = hostname;
      site.checked = !S.isSiteDisabled(settings, hostname);
      site.disabled = !settings.enabled;
    }

    setSeg($('modifier'), settings.modifier);
    setSeg($('copyFormat'), settings.copyFormat);
    $('showHint').checked = settings.showHint;
    $('snap').checked = settings.snap > 0;
    $('kModLabel').textContent = MOD_LABEL[settings.modifier] || MOD_LABEL.shift;
    $('kCopy').textContent = isMac ? '⌘C' : 'Ctrl+C';
  }

  async function patch(p) {
    settings = await S.save(p);
    render();
  }

  function bindSeg(el, key) {
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (b) patch({ [key]: b.dataset.value });
    });
    el.addEventListener('keydown', (e) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      const btns = [...el.querySelectorAll('button')];
      const i = btns.findIndex((b) => b.getAttribute('aria-checked') === 'true');
      const next = btns[(i + keys[e.key] + btns.length) % btns.length];
      next.focus();
      patch({ [key]: next.dataset.value });
    });
  }

  async function activeTab() {
    try {
      if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) return null;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch (_) {
      return null;
    }
  }

  const isWeb = (url) => /^https?:\/\//i.test(url || '');

  /** Does the tab's content script answer? (It is absent in tabs opened before install, and on pages it cannot run on.) */
  async function pingTab(tabId) {
    try {
      const reply = await Promise.race([chrome.tabs.sendMessage(tabId, { type: 'mikron:ping' }), new Promise((r) => setTimeout(r, 800))]);
      return !!(reply && reply.ok);
    } catch (_) {
      return false;
    }
  }

  /**
   * Make sure Mikron runs in the active tab. Opening the popup grants activeTab for it, which is what allows
   * injecting the manifest's content-script files into a tab that was open before the install.
   * @returns {Promise<boolean>} false when the page cannot be scripted
   */
  async function ensureContentScript(tab) {
    if (await pingTab(tab.id)) return true;
    if (tab.url && !isWeb(tab.url)) return false; // url is hidden when activeTab is not granted: try anyway
    try {
      const files = (chrome.runtime.getManifest().content_scripts || [])[0]?.js || [];
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
      return true;
    } catch (_) {
      return false;
    }
  }

  async function init() {
    settings = await S.load();
    // `?host=example.com` lets the popup be previewed as a plain file / in tests.
    const q = new URLSearchParams(location.search).get('host');
    const tab = q ? null : await activeTab();
    if (tab && tab.id != null) {
      blocked = !(await ensureContentScript(tab));
      hostname = isWeb(tab.url) ? new URL(tab.url).hostname.toLowerCase() : null;
    } else {
      hostname = q ? q.toLowerCase() : null;
    }

    $('enabled').addEventListener('change', (e) => patch({ enabled: e.target.checked }));
    $('showHint').addEventListener('change', (e) => patch({ showHint: e.target.checked }));
    $('snap').addEventListener('change', (e) => patch({ snap: e.target.checked ? 4 : 0 }));
    $('siteEnabled').addEventListener('change', (e) => {
      if (!hostname) return;
      const host = hostname.replace(/^www\./, '');
      let list = settings.disabledSites.slice();
      if (e.target.checked) {
        list = list.filter((entry) => !(host === entry || host.endsWith('.' + entry)));
      } else if (!list.includes(host)) {
        list.push(host);
      }
      patch({ disabledSites: list });
    });
    bindSeg($('modifier'), 'modifier');
    bindSeg($('copyFormat'), 'copyFormat');
    // Using the Rate link counts as having been asked: the one-time reminder on the page is not shown after it.
    $('rateLink').addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ mikron: 'rate-shown' }).catch(() => {});
      } catch (_) {}
    });

    S.subscribe((s) => {
      settings = s;
      render();
    });

    try {
      if (chrome.commands && chrome.commands.getAll) {
        const cmds = await chrome.commands.getAll();
        const c = cmds.find((x) => x.name === 'toggle-enabled');
        $('kToggle').textContent = (c && c.shortcut) || 'Not set';
      }
    } catch (_) {}

    render();
  }

  init();
})();
