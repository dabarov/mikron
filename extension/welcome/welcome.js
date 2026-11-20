(function () {
  'use strict';
  const S = globalThis.MikronSettings;
  const MOD = { shift: ['⇧ Shift', 'Shift'], alt: ['⌥ Alt', 'Alt'], ctrl: ['⌃ Ctrl', 'Ctrl'], meta: ['⌘ Cmd', 'Cmd'] };

  /** Keycaps and step titles follow the modifier chosen in the popup; a switched-off Mikron gets a note. */
  function render(s) {
    const [glyph, name] = MOD[s.modifier] || MOD.shift;
    document.querySelectorAll('[data-mod]').forEach((el) => (el.textContent = glyph));
    document.querySelectorAll('[data-mod-name]').forEach((el) => (el.textContent = name));
    document.getElementById('off').hidden = s.enabled;
  }

  S.load().then(render, () => {});
  S.subscribe(render);
})();
