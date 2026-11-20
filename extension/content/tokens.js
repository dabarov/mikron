/** Mikron design tokens, shared by the overlay chrome (B2) and the blueprint renderer (B1). */
(function () {
  'use strict';
  const M = (globalThis.__MIKRON__ ||= {});

  M.tokens = {
    accent: '#0a8cff', // blue chips, Copy tab, size label
    accentText: '#ffffff',
    line: '#2f9bff', // I-beams, radius arcs, dark-chip text
    border: 'rgba(56,152,255,0.90)', // marquee 1px border
    paper: '#131e29', // marquee fill ("blueprint paper")
    plate: 'rgba(4,14,28,0.45)', // fill of a visible-box node with no visible-box ancestor
    plateLift: 'rgba(255,255,255,0.04)', // fill of visible-box containers nested inside another visible box
    atomPlate: 'rgba(255,255,255,0.10)', // fill of atoms
    well: 'rgba(4,10,20,0.08)', // content box of a padded container
    bandTint: 'rgba(30,120,230,0.06)', // padding/gap band background under the hatch
    hatch: 'rgba(20,128,255,0.5)', // 45deg "/" lines, 1px, 8px pitch
    gridMinor: 'rgba(56,152,255,0.10)', // 4px graph-paper lines
    gridMajor: 'rgba(56,152,255,0.22)', // 16px graph-paper lines
    dash: 'rgba(56,152,255,0.70)', // 1px dashed content-box outlines
    skeleton: 'rgba(255,255,255,0.15)', // text bars + inline plates
    chipDarkBg: '#05080d',
    hintBg: '#101010',
    hintBorder: 'rgba(255,255,255,0.12)',
    keycapBg: '#303033',
    fontMono: 'ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace', // system fallback stack
    fontMonoBundled: '"Mikron Mono", ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace', // used only while content/font.js reports the bundled face ready
    fontSans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Segoe UI", system-ui, sans-serif',
    dur: { hintIn: 110, hintOut: 100, chipFade: 120, countUp: 450, copyIn: 120, dismiss: 150, arcDraw: 260, follow: 12, hintFollow: 15 },
    ease: { out: 'cubic-bezier(0.2,0.8,0.2,1)' },
  };
})();
