/* Mikron website: turns the three copy-format samples into tabs. Without this script they follow one another. */
(function () {
  'use strict';
  const box = document.getElementById('formats');
  if (!box) return;
  const tabs = [...box.querySelectorAll('[role=tab]')];
  const panelOf = (tab) => document.getElementById(tab.getAttribute('aria-controls'));

  function select(tab, focus) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      panelOf(t).hidden = !on;
    }
    if (focus) tab.focus();
  }

  box.querySelector('.tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[role=tab]');
    if (tab) select(tab, false);
  });
  box.querySelector('.tabs').addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let next = null;
    if (step) next = tabs[(i + step + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    e.preventDefault();
    select(next, true);
  });

  box.classList.add('tabbed');
  select(tabs[0], false);
})();
