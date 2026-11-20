/**
 * Mikron overlay host + chrome (hint pill, marquee, size label, Copy tab).
 * The blueprint itself is rendered by B1 into `blueprintMount`.
 */
(function () {
  'use strict';
  const M = (globalThis.__MIKRON__ ||= {});

  const PLATFORM = (typeof navigator !== 'undefined' && (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent)) || '';
  const IS_MAC = /Mac|iPhone|iPad/i.test(PLATFORM);
  const IS_WIN = /Win/i.test(PLATFORM);

  const SVG_SHIFT =
    '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"><path d="M6 1.2 11 6.3H8.1v4.3H3.9V6.3H1z"/></svg>';
  const SVG_COPY =
    '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round"><rect x="4" y="4" width="6.6" height="6.6" rx="1.2"/><path d="M8 4V2.6C8 1.8 7.5 1.4 6.8 1.4H2.6C1.9 1.4 1.4 1.9 1.4 2.6V6.8c0 .7.4 1.2 1.2 1.2H4"/></svg>';
  const SVG_CHECK =
    '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 6.4 5 9l4.8-5.6"/></svg>';

  /** Keycap content per modifier: [icon html, label]. */
  function modifierKey(mod) {
    switch (mod) {
      case 'alt':
        return ['<span class="mk-glyph">⌥</span>', IS_MAC ? 'Option' : 'Alt'];
      case 'ctrl':
        return ['<span class="mk-glyph">⌃</span>', 'Ctrl'];
      case 'meta':
        return IS_MAC
          ? ['<span class="mk-glyph">⌘</span>', 'Cmd']
          : IS_WIN
            ? ['<span class="mk-glyph">⊞</span>', 'Win']
            : ['', 'Meta'];
      default:
        return [SVG_SHIFT, 'Shift'];
    }
  }

  const reducedMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(reducedMq && reducedMq.matches);

  M.createUI = function createUI() {
    const T = M.tokens || {};
    const dur = { hintIn: 160, hintOut: 100, copyIn: 120, dismiss: 150, ...T.dur };
    const ease = (T.ease && T.ease.out) || 'cubic-bezier(0.2,0.8,0.2,1)';
    const copyEase = 'cubic-bezier(0,0,.58,1)';
    const sans = T.fontSans || 'system-ui, sans-serif';
    const mono = T.fontMono || 'ui-monospace, monospace';
    const monoBundled = T.fontMonoBundled || `"Mikron Mono", ${mono}`;
    const accent = T.accent || '#0a8cff';

    // ---- host -------------------------------------------------------------------------------
    const host = document.createElement('mikron-root');
    const hostCss = [
      ['all', 'initial'],
      ['display', 'block'],
      ['position', 'fixed'],
      ['inset', '0'],
      ['width', 'auto'],
      ['height', 'auto'],
      ['max-width', 'none'],
      ['max-height', 'none'],
      ['margin', '0'],
      ['padding', '0'],
      ['border', '0'],
      ['background', 'transparent'],
      ['overflow', 'visible'],
      ['pointer-events', 'none'],
      ['z-index', '2147483647'],
      ['forced-color-adjust', 'none'],
      ['color-scheme', 'dark'],
      ['visibility', 'visible'],
      ['opacity', '1'],
      ['transform', 'none'],
      ['filter', 'none'],
    ];
    for (const [k, v] of hostCss) host.style.setProperty(k, v, 'important');
    try {
      host.setAttribute('popover', 'manual');
    } catch (_) {}
    host.dataset.state = 'idle';

    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
*{box-sizing:border-box}
.mk-shield{position:absolute;inset:0;pointer-events:none;cursor:crosshair;touch-action:none}
.mk-shield.on{pointer-events:auto}
.mk-stage{position:absolute;inset:0;pointer-events:none;opacity:0;visibility:hidden}
.mk-stage.on{opacity:1;visibility:visible}
.mk-stage.on.out{opacity:0;transition:opacity ${dur.dismiss}ms ${ease}}
.mk-stage.out .mk-copy{pointer-events:none}
.mk-marquee{position:absolute;left:0;top:0;width:0;height:0;border:1px solid ${T.border || 'rgba(56,152,255,.9)'};background:${T.paper || '#131e29'} radial-gradient(circle,rgba(255,255,255,.05) 1px,transparent 1px) 0 0/24px 24px;will-change:transform}
.mk-bp-mount{position:fixed;inset:0;pointer-events:none}
.mk-size-label{position:absolute;left:0;top:0;height:16px;padding:0 5px;text-align:center;border-radius:4px;background:${accent};color:${T.accentText || '#fff'};font:700 11px/16px ${mono};font-variant-numeric:tabular-nums;white-space:nowrap;opacity:0;transition:opacity 100ms linear;pointer-events:none}
.mk-size-label.show{opacity:1}
.mk-size-label.mm{font-family:${monoBundled};padding:0}
.mk-copy{position:absolute;left:0;top:0;height:22px;margin:0;padding:0 8px;border:0;border-radius:0;background:${accent};color:${T.accentText || '#fff'};font:500 12px/22px ${sans};letter-spacing:0;display:flex;align-items:center;overflow:hidden;white-space:nowrap;cursor:pointer;
  opacity:0;visibility:hidden;pointer-events:none;scale:1;transform-origin:100% 100%;
  transition:opacity ${dur.copyIn}ms ${copyEase},scale 80ms ${ease},background-color 80ms linear,visibility 0s linear ${dur.copyIn}ms;-webkit-tap-highlight-color:transparent;outline:none}
.mk-copy.show{opacity:1;visibility:visible;pointer-events:auto;transition:opacity ${dur.copyIn}ms ${copyEase},scale 80ms ${ease},background-color 80ms linear,visibility 0s}
.mk-copy.show:hover{background:#2b9bff}
.mk-copy.show:active{background:#1c86e6}
.mk-copy-in{transition:scale 80ms ${ease}}
.mk-copy.show:active .mk-copy-in{scale:.97}
.mk-copy-in{display:flex;align-items:center;gap:6px;white-space:nowrap}
.mk-copy-in svg{flex:none;display:block}
.mk-hint{position:absolute;left:0;top:0;height:auto;padding:3px;display:flex;align-items:center;background:${T.hintBg || '#141414'};border:1px solid ${T.hintBorder || 'rgba(255,255,255,.09)'};border-radius:9px;box-shadow:0 6px 20px rgba(0,0,0,.35);font:500 12.5px/1 ${sans};color:#fff;white-space:nowrap;pointer-events:none;user-select:none;
  opacity:0;visibility:hidden;filter:blur(4px);translate:0 2px;
  transition:opacity ${dur.hintOut}ms linear,filter ${dur.hintOut}ms linear,translate ${dur.hintOut}ms linear,visibility 0s linear ${dur.hintOut}ms}
.mk-hint.on{opacity:1;visibility:visible;filter:blur(0);translate:0 0;
  transition:opacity ${dur.hintIn}ms ${ease},filter ${dur.hintIn}ms ${ease},translate ${dur.hintIn}ms ${ease},visibility 0s}
.mk-key{height:21px;padding:0 7px;border-radius:6px;background:${T.keycapBg || '#2b2b2d'};box-shadow:inset 0 1px 0 rgba(255,255,255,.14);display:flex;align-items:center;gap:5px;color:#fff}
.mk-key svg{display:block;flex:none}
.mk-glyph{font:500 12px/1 ${sans}}
.mk-plus{margin:0 8px 0 7px;color:#e6e6e6}
@media (prefers-reduced-motion: reduce){
  .mk-hint,.mk-hint.on{translate:none!important}
  .mk-copy-in{scale:none!important}
  .mk-hint,.mk-hint.on,.mk-copy,.mk-copy.show{filter:none!important;scale:none!important;transition:opacity 80ms linear,visibility 0s linear 80ms!important}
  .mk-hint.on,.mk-copy.show{transition:opacity 80ms linear,visibility 0s!important}
  .mk-size-label{transition-duration:60ms}
}`;

    const shield = el('div', 'mk-shield');
    const stage = el('div', 'mk-stage');
    const marquee = el('div', 'mk-marquee');
    const bpMount = el('div', 'mk-bp-mount');
    const sizeLabel = el('div', 'mk-size-label');
    const copyBtn = el('button', 'mk-copy');
    copyBtn.type = 'button';
    copyBtn.setAttribute('aria-label', 'Copy measured spec');
    const copyIn = el('span', 'mk-copy-in');
    copyBtn.append(copyIn);
    stage.append(marquee, bpMount, sizeLabel, copyBtn);
    const hint = el('div', 'mk-hint');
    root.append(style, shield, stage, hint);

    function el(tag, cls) {
      const e = document.createElement(tag);
      e.className = cls;
      return e;
    }

    // ---- state ------------------------------------------------------------------------------
    let destroyed = false;
    let lastRect = null;
    let lastLabel = '';
    let labelMM = false; // label currently painted and measured with the bundled face
    let labelW = 0;
    let copyShown = false;
    let copied = false;
    let copyW = 64;
    let copiedTimer = 0;
    let fadeTimer = 0;
    let fadeRes = null;
    let hintMod = '';
    let hw = 0;
    let hh = 0;
    let vw = document.documentElement.clientWidth;
    let vh = document.documentElement.clientHeight;

    const onResize = () => {
      vw = document.documentElement.clientWidth;
      vh = document.documentElement.clientHeight;
    };
    window.addEventListener('resize', onResize, { passive: true });

    function setCopyIdle() {
      copyIn.innerHTML = SVG_COPY + '<span>Copy</span>';
    }
    setCopyIdle();

    // Events on the Copy tab are intercepted and acted on by main.js at window capture (so page
    // capture-phase listeners never see them); hover / :active styling is pure CSS and unaffected.

    // ---- hint pill --------------------------------------------------------------------------
    function setModifier(mod) {
      if (mod === hintMod) return;
      hintMod = mod;
      const [icon, label] = modifierKey(mod);
      hint.innerHTML = `<span class="mk-key">${icon}<span>${label}</span></span><span class="mk-plus">+ drag</span>`;
      hw = 0;
    }

    function placeHint(x, y) {
      if (!hw) {
        hw = hint.offsetWidth || 120;
        hh = hint.offsetHeight || 29;
      }
      let px = x + 16;
      let py = y + 16;
      if (px + hw > vw - 6) px = x - 16 - hw;
      if (py + hh > vh - 6) py = y - 16 - hh;
      hint.style.transform = `translate(${Math.round(px * 2) / 2}px,${Math.round(py * 2) / 2}px)`;
    }

    function showHint(x, y, mod) {
      hint.style.removeProperty('transition');
      setModifier(mod || 'shift');
      placeHint(x, y);
      hint.classList.add('on');
    }
    function moveHint(x, y) {
      placeHint(x, y);
    }
    function hideHint(opts) {
      if (opts && opts.instant) {
        // modifier released: gone at once, no blurred fade
        hint.style.setProperty('transition', 'none', 'important');
        hint.classList.remove('on');
        // restore after the next style recalc (rAF callbacks run before it, so wait one frame more)
        requestAnimationFrame(() => requestAnimationFrame(() => hint.style.removeProperty('transition')));
      } else hint.classList.remove('on');
    }

    // ---- marquee / label / copy -------------------------------------------------------------
    const snap = (v) => {
      const d = window.devicePixelRatio || 1;
      return Math.round(v * d) / d;
    };

    /** Right-aligned to the marquee, above it (or inside its corner when there is no room), always fully on screen. */
    function placeCopy(r) {
      if (!r) return;
      const top = Math.max(r.y, 0); // visible top
      const inside = top < 26;
      let y = inside ? top + 1 : r.y - 21;
      y = Math.max(0, Math.min(y, vh - 22));
      const right = Math.min(inside ? r.x + r.w - 1 : r.x + r.w, vw);
      const x = Math.max(0, right - copyW);
      copyBtn.style.translate = `${snap(x)}px ${snap(y)}px`; // not `transform`: the pressed `scale` must not shrink the offset
    }

    let measureCtx = null;
    let measureMM = null;
    /** Label width from its text (no layout read in the drag loop): 11px bold mono. Bundled face: round(text) + 8
     *  (4px sides); system stack: ceil(text) + 10. `mm` selects the face, and is
     *  the same flag that styles the label (see showMarquee), so measuring and painting cannot disagree. */
    function measureLabel(text, mm) {
      try {
        if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
        if (measureMM !== mm) {
          measureMM = mm;
          measureCtx.font = `700 11px ${mm ? monoBundled : mono}`;
        }
        const w = measureCtx.measureText(text).width;
        return mm ? Math.round(w + 8) : Math.ceil(w) + 10;
      } catch (_) {
        return text.length * 7 + 10;
      }
    }

    function resetAll() {
      if (fadeTimer) {
        clearTimeout(fadeTimer);
        fadeTimer = 0;
      }
      const res = fadeRes;
      fadeRes = null;
      stage.style.transitionDuration = '';
      stage.style.transitionTimingFunction = '';
      stage.classList.remove('on', 'out');
      sizeLabel.classList.remove('show');
      hideCopy();
      lastRect = null;
      if (res) res();
    }

    function showMarquee(r, label, note) {
      if (fadeTimer) resetAll(); // a new selection cancels a pending fade instantly
      if (!stage.classList.contains('on')) stage.classList.add('on');
      marquee.style.transform = `translate(${r.x}px,${r.y}px)`;
      marquee.style.width = r.w + 'px';
      marquee.style.height = r.h + 'px';
      marquee.style.backgroundPosition = `${(((-r.x % 24) + 24) % 24)}px ${(((-r.y % 24) + 24) % 24)}px`;
      const mm = !!(M.font && M.font.ready());
      if (label !== lastLabel || mm !== labelMM) {
        sizeLabel.textContent = label;
        if (note) sizeLabel.title = note;
        else sizeLabel.removeAttribute('title');
        lastLabel = label;
        if (mm !== labelMM) {
          labelMM = mm;
          sizeLabel.classList.toggle('mm', mm);
        }
        labelW = measureLabel(label, mm);
        sizeLabel.style.width = labelW + 'px';
      }
      let ly = r.y + r.h + 8;
      if (vh - ly < 10) ly = r.y + r.h - 22; // less than 10px of the label would show: fully inside, 6px above the bottom edge
      sizeLabel.style.transform = `translate(${snap(r.x + r.w / 2 - labelW / 2)}px,${snap(ly)}px)`;
      sizeLabel.classList.add('show');
      lastRect = r;
      if (copyShown) placeCopy(r);
    }

    function hideMarquee() {
      resetAll();
    }

    function showCopy() {
      copyShown = true;
      copyBtn.style.width = '';
      copyW = Math.ceil(copyBtn.getBoundingClientRect().width) || copyW;
      copyBtn.style.width = copyW + 'px'; // whole pixels, so the right edge stays crisp too
      placeCopy(lastRect);
      copyBtn.classList.add('show');
    }

    /** Animate the Copy tab's width while swapping its content (labelHtml). */
    function swapCopy(html) {
      const w0 = Math.ceil(copyBtn.getBoundingClientRect().width);
      copyIn.innerHTML = html;
      copyBtn.style.width = 'auto';
      const w1 = Math.ceil(copyBtn.getBoundingClientRect().width);
      copyW = w1 || copyW;
      placeCopy(lastRect);
      if (reduced() || !w0 || w0 === w1) return;
      copyBtn.style.width = w0 + 'px';
      void copyBtn.offsetWidth;
      copyBtn.style.transition = `width 160ms ${ease}`;
      copyBtn.style.width = w1 + 'px';
      setTimeout(() => {
        copyBtn.style.transition = '';
      }, 200);
    }

    function setCopied() {
      if (!copyShown) return;
      clearTimeout(copiedTimer);
      if (!copied) {
        copied = true;
        copyBtn.style.setProperty('transition', '', '');
        swapCopy(SVG_CHECK + '<span>Copied</span>');
      }
      copiedTimer = setTimeout(() => {
        if (destroyed) return;
        copied = false;
        swapCopy(SVG_COPY + '<span>Copy</span>');
      }, 1400);
    }

    function hideCopy() {
      copyShown = false;
      copyBtn.classList.remove('show');
      clearTimeout(copiedTimer);
      if (copied) {
        copied = false;
        setCopyIdle();
        copyBtn.style.width = '';
      }
    }

    function fadeOutAll() {
      return new Promise((resolve) => {
        if (!stage.classList.contains('on')) {
          resolve();
          return;
        }
        if (fadeTimer) clearTimeout(fadeTimer);
        const ms = reduced() ? 100 : dur.dismiss;
        stage.style.transitionDuration = ms + 'ms';
        stage.style.transitionTimingFunction = reduced() ? 'linear' : ''; // reduced motion: short plain fade
        stage.classList.add('out');
        fadeRes = resolve;
        fadeTimer = setTimeout(() => {
          fadeTimer = 0;
          fadeRes = null;
          stage.classList.remove('on', 'out');
          stage.style.transitionDuration = '';
          stage.style.transitionTimingFunction = '';
          sizeLabel.classList.remove('show');
          hideCopy();
          lastRect = null;
          resolve();
        }, ms + 30);
      });
    }

    // ---- host / top layer -------------------------------------------------------------------
    function ensureTop() {
      if (destroyed) return;
      try {
        let modal = null;
        try {
          modal = document.querySelector(':modal');
        } catch (_) {}
        try {
          host.hidePopover();
        } catch (_) {}
        const target = modal || document.documentElement;
        if (host.parentNode !== target) target.appendChild(host);
        host.style.setProperty('zoom', String(1 / (document.documentElement.currentCSSZoom || 1)), 'important');
        try {
          host.showPopover();
        } catch (_) {}
        onResize();
      } catch (_) {}
    }

    function setState(state) {
      host.dataset.state = state;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(copiedTimer);
      clearTimeout(fadeTimer);
      window.removeEventListener('resize', onResize);
      try {
        host.hidePopover();
      } catch (_) {}
      host.remove();
      if (fadeRes) fadeRes();
    }

    // Created lazily by main on first arm; attach right away.
    document.documentElement.appendChild(host);
    ensureTop();

    return {
      host,
      shield,
      copyEl: copyBtn,
      blueprintMount: bpMount,
      setState,
      setModifier,
      showHint,
      moveHint,
      hideHint,
      showMarquee,
      hideMarquee,
      showCopy,
      setCopied,
      hideCopy,
      fadeOutAll,
      ensureTop,
      destroy,
    };
  };
})();
