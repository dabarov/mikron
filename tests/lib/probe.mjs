// Page-side probe injected into the MAIN world before any page script.
// Records what the *page* sees (listeners on `document`, i.e. after Mikron's window-capture listeners)
// plus every DOM mutation outside Mikron's shadow tree.
export const PROBE_SCRIPT = `(() => {
  if (window.__mk) return;
  const TYPES = ['pointerdown','pointerup','pointermove','pointerover','pointerout','pointerenter','pointerleave','pointercancel',
    'mousedown','mouseup','mousemove','mouseover','mouseout','mouseenter','mouseleave','click','dblclick','auxclick',
    'contextmenu','keydown','keyup','dragstart','selectstart','copy','wheel','gotpointercapture','lostpointercapture'];
  const desc = (n) => {
    if (!n) return '';
    if (n === document) return '#document';
    if (n === window) return '#window';
    if (n.nodeType !== 1) return n.nodeName;
    return n.localName + (n.id ? '#' + n.id : '');
  };
  const mk = window.__mk = { ev: [], mut: [], on: true };
  mk.reset = () => { mk.ev.length = 0; mk.mut.length = 0; };
  mk.count = (type, phase) => mk.ev.filter((e) => e.type === type && (!phase || e.phase === phase)).length;
  mk.types = (phase) => [...new Set(mk.ev.filter((e) => !phase || e.phase === phase).map((e) => e.type))];
  for (const t of TYPES) {
    for (const cap of [true, false]) {
      document.addEventListener(t, (e) => {
        if (!mk.on) return;
        mk.ev.push({ type: e.type, phase: cap ? 'c' : 'b', t: performance.now(), target: desc(e.target),
          shift: !!e.shiftKey, alt: !!e.altKey, ctrl: !!e.ctrlKey, meta: !!e.metaKey, key: e.key,
          x: e.clientX, y: e.clientY, buttons: e.buttons, trusted: e.isTrusted, prevented: e.defaultPrevented });
      }, cap);
    }
  }
  const mo = new MutationObserver((list) => {
    for (const m of list) {
      const rec = { type: m.type, target: desc(m.target), t: performance.now() };
      if (m.type === 'attributes') rec.attr = m.attributeName;
      if (m.type === 'childList') {
        rec.added = [...m.addedNodes].map((n) => n.nodeType === 1 ? desc(n) + (n.hasAttribute && n.hasAttribute('data-mikron') ? '[data-mikron]' : '') : n.nodeName);
        rec.removed = [...m.removedNodes].map((n) => n.nodeType === 1 ? desc(n) + (n.hasAttribute && n.hasAttribute('data-mikron') ? '[data-mikron]' : '') : n.nodeName);
      }
      mk.mut.push(rec);
    }
  });
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})();`;
