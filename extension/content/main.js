/**
 * Mikron interaction layer: boot, settings, gesture state machine, rAF loop, scan/copy, teardown.
 * Pointer-event based; coexists with the page by only acting on a modifier-drag.
 */
(function () {
  'use strict';
  const M = (globalThis.__MIKRON__ ||= {});

  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch (_) {
      return false;
    }
  };

  if (M.booted) {
    if (alive()) return;
    try {
      M.teardown && M.teardown();
    } catch (_) {}
  }
  M.booted = true;
  try {
    document.querySelectorAll('mikron-root, style[data-mikron]').forEach((n) => n.remove());
  } catch (_) {}

  // ---- constants ------------------------------------------------------------------------------
  const MODS = {
    shift: { key: 'Shift', flag: 'shiftKey' },
    alt: { key: 'Alt', flag: 'altKey' },
    ctrl: { key: 'Control', flag: 'ctrlKey' },
    meta: { key: 'Meta', flag: 'metaKey' },
  };
  const FLAGS = ['shiftKey', 'altKey', 'ctrlKey', 'metaKey'];
  const IGNORE_SEL =
    'input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=application],canvas,.monaco-editor,.ace_editor,.CodeMirror,.cm-editor,' +
    '.leaflet-container,.maplibregl-map,.mapboxgl-map,.ol-viewport,.gm-style,[draggable="true"],video,audio,[role=slider],[role=scrollbar],[role=separator]';
  const FOCUSABLE_SEL =
    'a[href],area[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable]:not([contenteditable=false])';
  const HOLD_MS = 250; // modifier must be held this long before the visible armed state
  const ARM_MOVE = 4; // px of pointer travel for the visible armed state
  const HOLD_MS_EDIT = 500; // ...while an editable element has focus (a capital letter must not flash the hint)
  const ARM_MOVE_EDIT = 16;
  const DRAG_START = 6; // px from the anchor before a press becomes a drag
  const MIN_SIZE = 8;
  const KEY_QUIET_MS = 1000; // while typing in an editable, the armed state stays off this long after a key
  const IS_MAC = /Mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
  const reducedMq = matchMedia('(prefers-reduced-motion: reduce)');

  // ---- state ----------------------------------------------------------------------------------
  let settings = null;
  let enabledHere = false;
  let modName = 'shift';
  let destroyed = false;

  let ui = null;
  let unFont = null;
  let bp = null;
  let cursorStyle = null;

  let modDown = false;
  let modSince = 0;
  let modPt = null; // pointer reference for the arming travel, taken once the hold has elapsed
  let lastKeyAt = -1e9; // last non-modifier keydown
  let escUp = false; // swallow the keyup of the Esc that dismissed a selection
  let lastScanMs = 0;
  let tainted = false;
  let visibleArmed = false;
  let suppressed = false; // pointer is over a target where the gesture is ignored
  let armTimer = 0;
  const last = { x: 0, y: 0, has: false };

  let cand = null; // press that may become a drag
  let mode = 'idle'; // idle | dragging | pinned
  let sess = null; // { scroller, pointerId, anchorC, corner, sel, selC }
  let curModel = null;
  let lastScanAt = 0;
  let rescanTimer = 0;
  let rescanDebounce = 0;
  let scrollDirty = false;
  let gen = 0;

  let eatClicks = false;
  let eatAll = false;
  let flagTimer = 0;
  let eatTimer = 0; // safety net: a swallowed press whose pointerup never reached this document
  let hintOn = false;
  const hintPos = { x: 0, y: 0 };
  let curState = 'idle';
  let lastCopied = null;
  let forceCopy = false;
  let pendingText = null;
  let didCopy = false;

  let raf = 0;
  let lastTs = 0;

  const now = () => performance.now();

  // ---- listener registry ----------------------------------------------------------------------
  const listeners = [];
  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }

  /** Cheap per-event guard; tears everything down when the extension context is gone. */
  function guard() {
    if (destroyed) return false;
    if (alive()) return true;
    teardown();
    return false;
  }

  function swallow(e) {
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  }

  // ---- ui / blueprint -------------------------------------------------------------------------
  function ensureUI() {
    if (ui) return true;
    try {
      ui = M.createUI();
      startFont();
      ui.setModifier && ui.setModifier(modName);
      on(ui.shield, 'lostpointercapture', onLostCapture);
    } catch (_) {
      ui = null;
    }
    return !!ui;
  }

  /** First arm: fetch the bundled chip font (nothing font-related runs before this). When it becomes ready while a
   *  selection is live, rescan so blueprint.setModel re-lays every chip out with the new face in one go. */
  function startFont() {
    if (!M.font) return;
    try {
      unFont && unFont();
      unFont = M.font.onChange(() => {
        if (!destroyed && mode !== 'idle' && sess) scheduleRescanThrottled();
      });
      M.font.load();
    } catch (_) {}
  }

  function ensureBlueprint() {
    if (bp || !ui || typeof M.createBlueprint !== 'function') return;
    try {
      bp = M.createBlueprint({ mount: ui.blueprintMount });
    } catch (_) {
      bp = null;
    }
  }

  function bpCall(name, arg) {
    if (!bp) return;
    try {
      bp[name](arg);
    } catch (_) {}
  }

  function setCursor(onOff) {
    if (onOff) {
      if (!cursorStyle) {
        if (document.getElementsByTagName('*').length > 5000) return;
        cursorStyle = document.createElement('style');
        cursorStyle.setAttribute('data-mikron', '');
        cursorStyle.textContent = '*,*::before,*::after{cursor:crosshair!important}';
        document.documentElement.appendChild(cursorStyle);
      }
      cursorStyle.disabled = false;
    } else if (cursorStyle) {
      cursorStyle.disabled = true;
    }
  }

  function syncState() {
    const s = mode === 'dragging' ? 'dragging' : mode === 'pinned' ? 'pinned' : (visibleArmed && !suppressed) || cand ? 'armed' : 'idle';
    curState = s;
    if (ui) ui.setState(s);
  }

  /** Derive crosshair + hint from the arming flags. */
  function refreshVisuals() {
    const crosshair = visibleArmed && mode !== 'dragging' && enabledHere && !suppressed;
    if (mode !== 'dragging') setCursor(crosshair);
    const wantHint = crosshair && !!settings && settings.showHint && mode !== 'pinned' && !cand;
    if (wantHint && ui && !hintOn) {
      hintOn = true;
      hintPos.x = last.x;
      hintPos.y = last.y;
      ui.showHint(last.x, last.y, modName);
    } else if (!wantHint && hintOn) {
      hintOn = false;
      if (ui) ui.hideHint({ instant: !modDown });
    }
    syncState();
  }

  // ---- scanning -------------------------------------------------------------------------------
  function readScroll(sc) {
    if (sc && sc.isConnected) return { x: sc.scrollLeft, y: sc.scrollTop };
    return { x: window.scrollX, y: window.scrollY };
  }

  function doScan(sc) {
    if (typeof M.scan !== 'function') return null;
    const t0 = now();
    try {
      const opts = { ignore: ui && ui.host, scroll: readScroll(sc) };
      if (sc && sc.isConnected) opts.scroller = sc;
      return M.scan(opts) || null;
    } catch (_) {
      return null;
    } finally {
      lastScanMs = now() - t0;
    }
  }

  function rescanNow() {
    rescanTimer = 0;
    rescanDebounce = 0;
    if (mode === 'idle' || !sess) return;
    const m = doScan(sess.scroller);
    lastScanAt = now();
    if (m) {
      curModel = m;
      bpCall('setModel', m);
      scrollDirty = true;
      startLoop();
    }
  }
  function scheduleRescanThrottled() {
    if (rescanTimer) return;
    const gap = Math.max(80, 4 * lastScanMs);
    rescanTimer = setTimeout(rescanNow, Math.max(0, gap - (now() - lastScanAt)));
  }
  function scheduleRescanDebounced() {
    clearTimeout(rescanDebounce);
    rescanDebounce = setTimeout(rescanNow, 120);
  }

  // ---- selection geometry ---------------------------------------------------------------------
  const dprRound = (v) => {
    const d = window.devicePixelRatio || 1;
    return Math.round(v * d) / d;
  };

  function computeSel() {
    const sc = readScroll(sess.scroller);
    const ax = sess.anchorC.x - sc.x;
    const ay = sess.anchorC.y - sc.y;
    const cx = sess.corner.x;
    const cy = sess.corner.y;
    const snap = Number(settings && settings.snap) || 0;
    let w = Math.abs(cx - ax);
    let h = Math.abs(cy - ay);
    if (snap > 0) {
      w = Math.round(w / snap) * snap;
      h = Math.round(h / snap) * snap;
    } else {
      w = Math.round(w);
      h = Math.round(h);
    }
    const x1 = cx >= ax ? ax + w : ax - w;
    const y1 = cy >= ay ? ay + h : ay - h;
    sess.sel = { x: dprRound(Math.min(ax, x1)), y: dprRound(Math.min(ay, y1)), w, h };
    return sc;
  }

  const labelOf = (s) => `${s.w} × ${s.h}` + (curModel && curModel.truncated ? ' · partial' : '');
  const LABEL_NOTE = 'Page too large to measure completely; some elements are missing from the blueprint and the copied spec.';

  /** One drawing pass for the selection chrome + blueprint. */
  function frame() {
    if (!sess || !ui) return;
    let sc;
    if (mode === 'dragging') {
      sc = computeSel();
    } else {
      sc = readScroll(sess.scroller);
      const c = sess.selC;
      sess.sel = { x: dprRound(c.x - sc.x), y: dprRound(c.y - sc.y), w: c.w, h: c.h };
    }
    ui.showMarquee(sess.sel, labelOf(sess.sel), curModel && curModel.truncated ? LABEL_NOTE : '');
    bpCall('update', {
      sel: sess.sel,
      pointer: { x: sess.corner.x, y: sess.corner.y },
      scrollX: sc.x,
      scrollY: sc.y,
    });
  }

  // ---- rAF loop -------------------------------------------------------------------------------
  function startLoop() {
    if (raf || destroyed) return;
    lastTs = 0;
    raf = requestAnimationFrame(tick);
  }

  function tick(ts) {
    raf = 0;
    if (!guard()) return;
    const dt = lastTs ? Math.min(64, ts - lastTs) : 16;
    lastTs = ts;
    const red = reducedMq.matches;
    const fd = (M.tokens && M.tokens.dur) || {};
    const followMs = fd.follow ?? 12;
    const hintFollowMs = fd.hintFollow ?? 15;
    let more = false;
    try {
      if (hintOn && ui) {
        const k = red ? 1 : 1 - Math.exp(-dt / hintFollowMs);
        hintPos.x += (last.x - hintPos.x) * k;
        hintPos.y += (last.y - hintPos.y) * k;
        if (Math.abs(last.x - hintPos.x) < 0.25) hintPos.x = last.x;
        if (Math.abs(last.y - hintPos.y) < 0.25) hintPos.y = last.y;
        ui.moveHint(hintPos.x, hintPos.y);
        if (hintPos.x !== last.x || hintPos.y !== last.y) more = true;
      }
      if (mode === 'dragging' && sess) {
        const k = red ? 1 : 1 - Math.exp(-dt / followMs);
        const c = sess.corner;
        c.x += (last.x - c.x) * k;
        c.y += (last.y - c.y) * k;
        if (Math.abs(last.x - c.x) < 0.25) c.x = last.x;
        if (Math.abs(last.y - c.y) < 0.25) c.y = last.y;
        frame();
        more = true;
      } else if (mode === 'pinned' && scrollDirty) {
        scrollDirty = false;
        frame();
      }
    } catch (_) {}
    if (more) raf = requestAnimationFrame(tick);
  }

  // ---- arming ---------------------------------------------------------------------------------
  function othersHeld(e) {
    const f = MODS[modName].flag;
    return FLAGS.some((x) => x !== f && e[x]);
  }

  function beginModifier(e, since) {
    modDown = true;
    modSince = since;
    tainted = e ? othersHeld(e) : false;
    suppressed = false;
    modPt = null;
    clearTimeout(armTimer);
    armTimer = setTimeout(checkArm, Math.max(0, HOLD_MS - (now() - since)) + 5);
  }

  function onModUp() {
    modDown = false;
    tainted = false;
    visibleArmed = false;
    suppressed = false;
    modPt = null;
    clearTimeout(armTimer);
    refreshVisuals();
  }

  function checkArm() {
    armTimer = 0;
    if (!guard() || visibleArmed || !modDown || tainted || !enabledHere || cand || mode === 'dragging') return;
    if (now() - modSince < HOLD_MS) return;
    if (!last.has) return;
    if (!modPt) {
      modPt = { x: last.x, y: last.y }; // travel counts from the moment the hold has elapsed
      return;
    }
    const editing = editableFocus();
    if (editing && now() - modSince < HOLD_MS_EDIT) {
      clearTimeout(armTimer);
      armTimer = setTimeout(checkArm, HOLD_MS_EDIT - (now() - modSince) + 5);
      return;
    }
    if (Math.hypot(last.x - modPt.x, last.y - modPt.y) < (editing ? ARM_MOVE_EDIT : ARM_MOVE)) return;
    if (now() - lastKeyAt < KEY_QUIET_MS && editableFocus()) return; // typing with a drifting mouse
    visibleArmed = true;
    if (!ensureUI()) {
      visibleArmed = false;
      return;
    }
    ui.ensureTop();
    refreshVisuals();
    startLoop();
  }

  /** Modifier truth from a pointer event (key events can be lost). */
  function syncMod(e) {
    const m = MODS[modName];
    const held = !!e[m.flag];
    if (modDown && !held) {
      if (!cand && mode !== 'dragging') onModUp();
      else modDown = false;
    } else if (!modDown && held && !othersHeld(e) && enabledHere) {
      beginModifier(e, now() - HOLD_MS); // keydown was missed: treat as held long enough
    } else if (modDown && held && othersHeld(e) && !tainted) {
      tainted = true;
      refreshVisuals();
    }
  }

  function trackPointer(e) {
    last.x = e.clientX;
    last.y = e.clientY;
    last.has = true;
  }

  // ---- gesture --------------------------------------------------------------------------------
  function openOrClosedRoot(el) {
    try {
      return (chrome.dom && chrome.dom.openOrClosedShadowRoot && chrome.dom.openOrClosedShadowRoot(el)) || null;
    } catch (_) {
      return null;
    }
  }

  /** composedPath() stops at a closed shadow root's host; look through it at the press point. */
  function closedRootIgnored(host, x, y) {
    try {
      let el = host;
      for (let depth = 0; depth < 4; depth++) {
        const root = openOrClosedRoot(el);
        if (!root) break;
        const inner = root.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
      }
      if (el === host) return false;
      for (let n = el; n && n !== host; n = n.parentElement) {
        if (n.matches(IGNORE_SEL)) return true;
      }
      return !!el.isContentEditable;
    } catch (_) {
      return false;
    }
  }

  function pathIgnored(path, x, y) {
    for (let i = 0; i < path.length; i++) {
      const n = path[i];
      if (n.nodeType === 1) {
        try {
          if (n.matches(IGNORE_SEL)) return true;
        } catch (_) {}
      }
    }
    const t = path[0];
    if (t && t.nodeType === 1) {
      if (t.isContentEditable) return true;
      if (x != null && openOrClosedRoot(t) && closedRootIgnored(t, x, y)) return true;
    }
    return false;
  }

  function findScroller(start) {
    const area = innerWidth * innerHeight;
    let n = start && start.nodeType === 1 ? start : null;
    while (n && n !== document.documentElement) {
      try {
        const cs = getComputedStyle(n);
        const scrollable =
          (/(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) ||
          (/(auto|scroll|overlay)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1);
        if (scrollable && n.clientWidth * n.clientHeight >= 0.8 * area) return n;
      } catch (_) {}
      n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
    }
    return null;
  }

  function pointInSel(x, y) {
    const s = sess && sess.sel;
    return !!s && x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h;
  }

  function clearEat() {
    clearTimeout(flagTimer);
    clearTimeout(eatTimer);
    eatClicks = false;
    eatAll = false;
  }

  function clearFlagsSoon() {
    clearTimeout(flagTimer);
    flagTimer = setTimeout(() => {
      eatClicks = false;
      eatAll = false;
      clearTimeout(eatTimer);
    }, 0);
  }

  function armEatTimer() {
    clearTimeout(eatTimer);
    eatTimer = setTimeout(function check() {
      if (cand || mode === 'dragging') eatTimer = setTimeout(check, 2000); // still a live gesture
      else eatAll = false;
    }, 2000);
  }

  function onPointerDown(e) {
    if (!guard()) return;
    clearEat();
    if (e.pointerType === 'touch') return;
    trackPointer(e);
    const path = e.composedPath();
    if (ui && path.includes(ui.copyEl)) return;
    if (e.isPrimary) syncMod(e);

    let swallowed = false;
    if (mode === 'pinned') {
      const inside = pointInSel(e.clientX, e.clientY);
      dismiss();
      if (inside) {
        // A press inside the pinned rect never reaches the hidden page content (the whole sequence is eaten);
        // it may still become the anchor of a new drag.
        eatAll = true;
        armEatTimer();
        swallowed = true;
        swallow(e);
      }
    }

    if (!e.isPrimary || e.button !== 0 || !enabledHere || !modDown || tainted || othersHeld(e)) return;
    if (pathIgnored(path, e.clientX, e.clientY)) return;
    const de = document.documentElement;
    if (e.clientX >= de.clientWidth || e.clientY >= de.clientHeight) return; // scrollbar
    if (!ensureUI()) return;
    ui.ensureTop();
    cand = {
      id: e.pointerId,
      ax: e.clientX,
      ay: e.clientY,
      scroller: findScroller(path[0]),
      path: path.filter((n) => n.nodeType === 1),
      swallowed,
      down: e, // the page may claim the press with preventDefault() + stopPropagation(); the flag outlives dispatch
      md: null, // the compat mousedown, seen at window capture
      mdBubbled: false, // ...and whether it also reached window's bubble phase (the page did not stop it)
      pagePrevented: false,
    };
    refreshVisuals();
  }

  /** The page's own bubble-phase view of the press: a widget that claimed pointerdown owns the gesture. */
  function onPointerDownBubble(e) {
    if (!guard() || !cand || e.pointerId !== cand.id) return;
    if (e.defaultPrevented) {
      cand = null;
      refreshVisuals();
    }
  }

  function startDrag(e) {
    const c = cand;
    cand = null;
    const sc = readScroll(c.scroller);
    // Scan before any DOM/style write of this drag.
    const model = doScan(c.scroller);
    gen++;
    ensureBlueprint();
    bpCall('clear');
    curModel = model;
    sess = {
      scroller: c.scroller,
      pointerId: c.id,
      anchorC: { x: c.ax + sc.x, y: c.ay + sc.y },
      corner: { x: c.ax, y: c.ay },
      sel: null,
      selC: null,
    };
    mode = 'dragging';
    ui.ensureTop();
    try {
      ui.shield.setPointerCapture(c.id);
    } catch (_) {}
    ui.shield.classList.add('on');
    if (model) bpCall('setModel', model);
    lastScanAt = now();
    refreshVisuals();
    frame();
    startLoop();
  }

  function releaseShield() {
    if (!ui) return;
    try {
      ui.shield.releasePointerCapture(sess ? sess.pointerId : 0);
    } catch (_) {}
    ui.shield.classList.remove('on');
  }

  function finishDrag(x, y, cancel) {
    if (mode !== 'dragging' || !sess) return;
    sess.corner.x = x;
    sess.corner.y = y;
    last.x = x;
    last.y = y;
    const sc = computeSel();
    releaseShield();
    eatClicks = true;
    clearFlagsSoon();
    const s = sess.sel;
    if (cancel || s.w < MIN_SIZE || s.h < MIN_SIZE) {
      dismiss();
      return;
    }
    sess.selC = { x: s.x + sc.x, y: s.y + sc.y, w: s.w, h: s.h };
    mode = 'pinned';
    scrollDirty = false;
    ui.ensureTop();
    frame();
    bpCall('freeze');
    ui.showCopy();
    refreshVisuals();
  }

  function dismiss() {
    const wasMode = mode;
    if (wasMode === 'idle' && !cand) return;
    if (wasMode === 'dragging') releaseShield();
    mode = 'idle';
    cand = null;
    sess = null;
    clearTimeout(rescanTimer);
    clearTimeout(rescanDebounce);
    rescanTimer = rescanDebounce = 0;
    if (wasMode === 'idle') {
      refreshVisuals();
      return;
    }
    const myGen = gen;
    const b = bp;
    if (ui) {
      ui.fadeOutAll().then(() => {
        if (gen === myGen && mode === 'idle' && b) {
          try {
            b.clear();
          } catch (_) {}
        }
      });
    }
    refreshVisuals();
  }

  function extendSelection(x, y) {
    try {
      const sel = getSelection();
      if (!sel || !sel.anchorNode) return;
      let node = null;
      let off = 0;
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (p) {
          node = p.offsetNode;
          off = p.offset;
        }
      } else if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        if (r) {
          node = r.startContainer;
          off = r.startOffset;
        }
      }
      if (node) sel.extend(node, off);
    } catch (_) {}
  }

  /** What the browser would have done on mousedown, for a press whose default we suppressed. */
  function emulateFocus(c) {
    try {
      for (const n of c.path) {
        if (n.matches(FOCUSABLE_SEL) && !n.disabled) {
          n.focus({ preventScroll: true });
          if (document.activeElement === n || n.getRootNode().activeElement === n) return;
        }
      }
      const a = document.activeElement;
      if (a && a !== document.body && a !== document.documentElement) a.blur();
    } catch (_) {}
  }

  function holdsPointerCapture(c) {
    for (const n of c.path) {
      try {
        if (n.hasPointerCapture && n.hasPointerCapture(c.id)) return true;
      } catch (_) {}
    }
    return false;
  }

  function onPointerMove(e) {
    if (!guard()) return;
    if (e.pointerType === 'touch' || !e.isPrimary) return;
    trackPointer(e);
    if (mode === 'dragging') {
      if (e.pointerId === sess.pointerId) {
        if (!(e.buttons & 1)) finishDrag(e.clientX, e.clientY, false);
        else startLoop();
      }
      swallow(e);
      return;
    }
    if (cand) {
      if (e.pointerId === cand.id) {
        if (!(e.buttons & 1)) {
          cand = null;
          refreshVisuals();
        } else if (Math.hypot(e.clientX - cand.ax, e.clientY - cand.ay) >= DRAG_START) {
          if (!cand.swallowed && cand.down.defaultPrevented) {
            // the page claimed the press (and hid it from our bubble listener): it owns the gesture
            cand = null;
            refreshVisuals();
          } else if (holdsPointerCapture(cand)) {
            // the page's widget captured the pointer on pointerdown (sortable, scrubber): it owns the gesture
            cand = null;
            refreshVisuals();
          } else {
            startDrag(e);
            swallow(e);
          }
        }
      }
      return;
    }
    syncMod(e);
    if (modDown && !tainted) {
      const ig = pathIgnored(e.composedPath(), e.clientX, e.clientY);
      if (ig !== suppressed) {
        suppressed = ig;
        if (visibleArmed) refreshVisuals();
      }
    }
    if (modDown && !visibleArmed) checkArm();
    if (hintOn) startLoop();
  }

  function onPointerUp(e) {
    if (!guard()) return;
    if (e.pointerType === 'touch' || !e.isPrimary) return;
    trackPointer(e);
    if (mode === 'dragging' && sess && e.pointerId === sess.pointerId) {
      finishDrag(e.clientX, e.clientY, false);
      if (eatAll) swallow(e); // the page never saw this press (it began inside a pinned selection)
      return;
    }
    if (cand && e.pointerId === cand.id) {
      const c = cand;
      cand = null;
      if (!c.swallowed && c.mdBubbled && !c.pagePrevented) {
        // we suppressed the mousedown default (selection / focus): emulate it. Not when the page prevented it
        // itself, nor when the event never reached our bubble listener (page stopPropagation: either it prevented
        // the default, or the browser's own default already ran; see the branch below).
        extendSelection(e.clientX, e.clientY);
        emulateFocus(c);
      } else if (!c.swallowed && c.md && !c.mdBubbled && !c.md.defaultPrevented) {
        // the page stopped the mousedown before our bubble listener: the browser's own focus change already ran
        // (nothing prevented it), but its selection extension was blocked by our selectstart prevention
        extendSelection(e.clientX, e.clientY);
      }
      refreshVisuals();
    }
    if (eatAll) swallow(e);
    clearFlagsSoon();
  }

  function onPointerCancel(e) {
    if (!guard()) return;
    clearEat();
    if (mode === 'dragging' && sess && e.pointerId === sess.pointerId) finishDrag(last.x, last.y, false);
    else if (cand && e.pointerId === cand.id) {
      cand = null;
      refreshVisuals();
    }
  }

  function onLostCapture() {
    if (!guard()) return;
    if (mode === 'dragging') finishDrag(last.x, last.y, false);
  }

  // events the page must not see while measuring
  function onHoverEvent(e) {
    if (!guard()) return;
    if (mode === 'dragging') e.stopImmediatePropagation();
  }
  function onEat(e) {
    if (!guard()) return;
    if (e.type === 'click' && e.detail === 0) return; // keyboard / programmatic activation is never ours to eat
    if (eatAll || eatClicks) swallow(e);
  }
  function onEatAllOnly(e) {
    if (!guard()) return;
    if (eatAll) swallow(e);
  }
  function onMouseDownCapture(e) {
    if (!guard() || eatAll) return;
    if (cand && e.button === 0) cand.md = e;
  }
  /** Bubble phase, after the page: note that we were reached and whether it already prevented the press, then suppress the default. */
  function onMouseDownBubble(e) {
    if (!guard() || eatAll) return;
    if (cand && e.button === 0 && cand.md === e) {
      cand.mdBubbled = true;
      cand.pagePrevented = e.defaultPrevented;
    }
    if ((cand || mode === 'dragging') && e.cancelable) e.preventDefault();
  }
  function onPreventIfBusy(e) {
    if (!guard()) return;
    if (cand || mode === 'dragging' || eatAll) e.preventDefault();
  }
  function onContextMenu(e) {
    if (!guard()) return;
    if (eatAll || ((cand || mode === 'dragging') && IS_MAC && modName === 'ctrl')) swallow(e);
  }

  // ---- keyboard -------------------------------------------------------------------------------
  function onKeyDown(e) {
    if (!guard()) return;
    if (e.key !== MODS[modName].key) lastKeyAt = now();
    if (e.key === 'Escape' && mode !== 'idle') {
      e.preventDefault();
      e.stopImmediatePropagation();
      escUp = true;
      if (mode === 'dragging') {
        releaseShield();
        eatClicks = true;
        clearFlagsSoon();
      }
      dismiss();
      return;
    }
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === MODS[modName].key) {
      if (e.repeat || !enabledHere) return;
      if (!modDown) beginModifier(e, now());
      return;
    }
    if (modDown && !tainted) {
      tainted = true;
      if (visibleArmed) {
        visibleArmed = false;
        refreshVisuals();
      }
    }
  }

  function onKeyUp(e) {
    if (!guard()) return;
    if (escUp && e.key === 'Escape') {
      escUp = false;
      swallow(e);
      return;
    }
    if (e.key === MODS[modName].key && modDown) {
      if (cand || mode === 'dragging') {
        modDown = false;
        visibleArmed = false;
        clearTimeout(armTimer);
        refreshVisuals();
      } else onModUp();
    }
  }

  function onWheel(e) {
    if (!guard()) return;
    if (mode === 'dragging' && sess && sess.scroller && sess.scroller.isConnected) {
      // the shield takes the wheel; hand the delta to the element scroller it would otherwise have scrolled
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? sess.scroller.clientHeight : 1;
      try {
        sess.scroller.scrollBy(e.deltaX * k, e.deltaY * k);
      } catch (_) {}
    }
    if (modDown && !tainted && mode !== 'dragging') {
      tainted = true;
      if (visibleArmed) {
        visibleArmed = false;
        refreshVisuals();
      }
    }
  }

  // ---- scroll / lifecycle ---------------------------------------------------------------------
  function onScroll(e) {
    if (destroyed || (mode !== 'dragging' && mode !== 'pinned') || !sess) return;
    scrollDirty = true;
    startLoop();
    const t = e.target;
    if (t === document || t === sess.scroller) scheduleRescanThrottled();
    else scheduleRescanDebounced();
  }
  function onResizeWin() {
    if (destroyed) return;
    if (mode === 'pinned' || mode === 'dragging') {
      scrollDirty = true;
      startLoop();
      scheduleRescanDebounced();
    }
  }

  function resetInput() {
    cand = null;
    modDown = false;
    tainted = false;
    visibleArmed = false;
    suppressed = false;
    escUp = false;
    modPt = null;
    clearTimeout(armTimer);
    if (mode === 'dragging') {
      releaseShield();
      dismiss();
    }
    refreshVisuals();
  }

  function onBlur(e) {
    if (e.target === window && guard()) resetInput();
  }
  function onHide(e) {
    if (!guard()) return;
    if (e.type === 'pagehide') {
      resetInput();
      dismiss();
    } else if (document.visibilityState === 'hidden') {
      resetInput(); // a pinned selection survives a tab switch (paste the spec elsewhere, come back)
    }
  }
  function onBeforePrint() {
    if (!guard() || mode === 'idle') return;
    dismiss();
    if (ui) ui.hideMarquee(); // no fade: the print snapshot is taken right after this handler
  }
  function onNavigate(e) {
    if (!guard() || mode === 'idle') return;
    if (e.type === 'navigate') {
      try {
        const d = new URL(e.destination.url);
        if (d.origin + d.pathname + d.search === location.origin + location.pathname + location.search) return;
      } catch (_) {}
    }
    dismiss();
  }

  // ---- copy -----------------------------------------------------------------------------------
  function buildSpec() {
    const s = sess && sess.selC;
    if (s && curModel && typeof M.formatSpec === 'function') {
      try {
        const out = M.formatSpec(curModel, { x: s.x, y: s.y, w: s.w, h: s.h }, { format: (settings && settings.copyFormat) || 'text' });
        if (typeof out === 'string' && out) return out;
      } catch (_) {}
    }
    const w = s ? s.w : 0;
    const h = s ? s.h : 0;
    return `Mikron — ${w} × ${h} selection on ${location.host}${location.pathname}`;
  }

  function editableFocus() {
    const a = document.activeElement;
    return !!a && a.nodeType === 1 && (a.matches('input,textarea,select,[contenteditable]:not([contenteditable=false])') || a.isContentEditable);
  }

  function onCopyEvent(e) {
    if (!guard() || mode !== 'pinned' || !e.clipboardData) return;
    if (!forceCopy) {
      const sel = getSelection();
      if ((sel && !sel.isCollapsed) || editableFocus()) return;
    }
    const text = pendingText != null ? pendingText : buildSpec();
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
    e.stopImmediatePropagation();
    didCopy = true;
    lastCopied = text;
    if (ui) ui.setCopied();
  }

  async function copyAction() {
    if (mode !== 'pinned') return;
    const text = buildSpec();
    pendingText = text;
    forceCopy = true;
    didCopy = false;
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {}
    forceCopy = false;
    pendingText = null;
    if (ok && didCopy) return;
    try {
      await navigator.clipboard.writeText(text);
      lastCopied = text;
      if (ui) ui.setCopied();
    } catch (_) {}
  }

  /**
   * Events on the Copy tab are handled here, at window capture, so page capture-phase listeners
   * (click-outside menus) never see them.
   */
  function onCopyTabEvent(e) {
    if (!ui || destroyed || !e.composedPath().includes(ui.copyEl)) return;
    if (!guard()) return;
    e.stopImmediatePropagation();
    if (e.type === 'mousedown') e.preventDefault(); // never steal focus / clear the page selection
    else if (e.type === 'click') {
      e.preventDefault();
      copyAction();
    }
  }

  // ---- settings -------------------------------------------------------------------------------
  function applySettings(s) {
    if (destroyed || !s) return;
    const prevMod = modName;
    settings = s;
    modName = MODS[s.modifier] ? s.modifier : 'shift';
    const was = enabledHere;
    try {
      enabledHere = !!s.enabled && !MikronSettings.isSiteDisabled(s, location.hostname);
    } catch (_) {
      enabledHere = !!s.enabled;
    }
    if (!enabledHere && (was || mode !== 'idle' || cand || visibleArmed || modDown)) {
      resetInput();
      dismiss();
    } else if (prevMod !== modName) {
      resetInput();
    }
    if (ui && ui.setModifier) ui.setModifier(modName);
    if (!s.showHint && hintOn) refreshVisuals();
  }

  // ---- teardown -------------------------------------------------------------------------------
  let unsub = null;
  let onMsg = null;

  function teardown() {
    if (destroyed) return;
    destroyed = true;
    for (const [t, type, fn, opts] of listeners) {
      try {
        t.removeEventListener(type, fn, opts);
      } catch (_) {}
    }
    listeners.length = 0;
    clearTimeout(armTimer);
    clearTimeout(rescanTimer);
    clearTimeout(rescanDebounce);
    clearTimeout(flagTimer);
    clearTimeout(eatTimer);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    try {
      unsub && unsub();
    } catch (_) {}
    try {
      onMsg && chrome.runtime.onMessage.removeListener(onMsg);
    } catch (_) {}
    try {
      unFont && unFont();
      M.font && M.font.dispose();
    } catch (_) {}
    try {
      bp && bp.destroy();
    } catch (_) {}
    try {
      ui && ui.destroy();
    } catch (_) {}
    try {
      cursorStyle && cursorStyle.remove();
    } catch (_) {}
    ui = bp = cursorStyle = null;
    mode = 'idle';
    sess = cand = null;
    curState = 'idle';
    M.booted = false;
  }
  M.teardown = teardown;

  // ---- boot -----------------------------------------------------------------------------------
  const CAP = { capture: true };
  const CAPP = { capture: true, passive: true };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) on(window, t, onCopyTabEvent, CAP);
  on(window, 'pointerdown', onPointerDown, CAP);
  on(window, 'pointermove', onPointerMove, CAP);
  on(window, 'pointerup', onPointerUp, CAP);
  on(window, 'pointercancel', onPointerCancel, CAP);
  for (const t of ['pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'mousemove'])
    on(window, t, onHoverEvent, CAP);
  on(window, 'mousedown', onEatAllOnly, CAP);
  on(window, 'mousedown', onMouseDownCapture, CAP);
  on(window, 'mousedown', onMouseDownBubble);
  on(window, 'pointerdown', onPointerDownBubble);
  on(window, 'mouseup', onEatAllOnly, CAP);
  for (const t of ['click', 'auxclick', 'dblclick']) on(window, t, onEat, CAP);
  on(window, 'dragstart', onPreventIfBusy, CAP);
  on(window, 'selectstart', onPreventIfBusy, CAP);
  on(window, 'contextmenu', onContextMenu, CAP);
  on(window, 'keydown', onKeyDown, CAP);
  on(window, 'keyup', onKeyUp, CAP);
  on(window, 'wheel', onWheel, CAPP);
  on(window, 'scroll', onScroll, CAPP);
  on(window, 'resize', onResizeWin, CAPP);
  on(window, 'copy', onCopyEvent, CAP);
  on(window, 'blur', onBlur, CAP);
  on(window, 'pagehide', onHide, CAP);
  on(window, 'beforeprint', onBeforePrint, CAP);
  on(window, 'popstate', onNavigate, CAP);
  on(window, 'hashchange', onNavigate, CAP);
  on(document, 'visibilitychange', onHide, CAP);
  try {
    if (window.navigation && window.navigation.addEventListener) on(window.navigation, 'navigate', onNavigate);
  } catch (_) {}

  try {
    onMsg = (msg, _sender, send) => {
      if (msg && msg.type === 'mikron:ping') {
        try {
          send({ ok: true, state: curState });
        } catch (_) {}
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(onMsg);
  } catch (_) {
    onMsg = null;
  }

  try {
    MikronSettings.load().then(applySettings, () => {});
    unsub = MikronSettings.subscribe(applySettings);
  } catch (_) {}

  M.debug = {
    get state() {
      return curState;
    },
    get selection() {
      return sess && sess.sel ? { ...sess.sel } : null;
    },
    get lastCopied() {
      return lastCopied;
    },
  };
})();
