/**
 * Mikron DOM scanner. Defines `M.scan(opts) -> Model`.
 *
 * Coordinate space: every Rect/number in the model is in ON-SCREEN px (transforms and CSS zoom are
 * already applied). Rect = getBoundingClientRect-space + (model.scrollX, model.scrollY). Layout px
 * (what the author wrote in CSS) = value / node.scale; `node.size` is the layout-px border-box size.
 * Gap `value` is the on-screen length of the gap band along its axis (divide by `scale` for CSS px).
 *
 * @typedef {{ x:number, y:number, w:number, h:number }} Rect
 * @typedef {{ t:number, r:number, b:number, l:number }} Sides
 *
 * @typedef {Object} Node
 * @property {number} id           stable per element (module-level WeakMap)
 * @property {number} parent       id of nearest included ancestor node, or -1
 * @property {number} depth        depth among included nodes (roots = 0)
 * @property {Element} el
 * @property {string} label        'button.btn-primary', 'div#app' (<= 40 chars, <= 2 classes)
 * @property {'container'|'atom'} kind
 * @property {string} display      computed display
 * @property {Rect} box            border box
 * @property {{w:number,h:number}} size  layout-px border-box size (box / scale)
 * @property {number} scale        box.w / el.offsetWidth (1 for SVG / unknown); transform+zoom factor
 * @property {boolean} rotated     a transform in the ancestor chain has a rotation/skew component
 * @property {Rect|null} clip      intersection of clipping ancestors on the containing-block chain
 * @property {boolean} hasBox      visible bg / border / (non-transparent) shadow
 * @property {{tl:number,tr:number,br:number,bl:number}} radius  used radii, clamped, on-screen px
 * @property {Sides} border
 * @property {Sides} padding
 * @property {Sides} margin
 * @property {Rect} content        content box
 * @property {{axis:'x'|'y', rect:Rect, value:number}[]} gaps   containers only
 * @property {{rect:Rect, fontSize:number}[]} texts   text line fragments (inline descendants included); fontSize on-screen px
 * @property {Rect[]} inlinePlates visible-box inline descendants' fragments (renderer: small skeleton plates)
 * @property {boolean} showSize    atom, or container with hasBox
 * @property {boolean} fixed       element/ancestor is position:fixed, or `opts.scroller` is set and node is not inside it
 * @property {string|null} text
 * @property {{size:number, lineHeight:string, weight:string, family:string}|null} font   layout px
 * @property {string|null} color
 * @property {string|null} background
 *
 * @typedef {Object} Model
 * @property {number} scrollX
 * @property {number} scrollY
 * @property {number} vw
 * @property {number} vh
 * @property {number} dpr
 * @property {Rect} region
 * @property {Node[]} nodes        pre-order; a parent always precedes its children
 * @property {boolean} truncated
 */
(function () {
  'use strict';
  const M = (globalThis.__MIKRON__ ||= {});

  // Ids survive across scans (and across a double evaluation of this file).
  const ids = (M._ids ||= new WeakMap());
  M._nextId ||= 1;

  const SKIP = new Set(['script', 'style', 'meta', 'link', 'head', 'noscript', 'template', 'title', 'base', 'datalist', 'param', 'source', 'track', 'area']);
  const REPLACED = new Set(['img', 'svg', 'video', 'canvas', 'picture', 'iframe', 'object', 'embed']);
  const FORM = new Set(['input', 'select', 'textarea', 'progress', 'meter']);
  const CONTROL_TAGS = new Set(['button', 'a', 'summary']);
  const CONTROL_ROLES = new Set(['button', 'switch', 'checkbox', 'radio', 'slider', 'tab', 'link', 'menuitem']);
  const VIS_OPTS = { contentVisibilityAuto: true, opacityProperty: true, checkOpacity: true };
  const BIG = 2000;

  /** @type {null | Record<string, any>} state of the scan in progress (scan is not re-entrant) */
  let st = null;

  // ---------------------------------------------------------------------------------- colour / shadow

  const alphaCache = new Map();
  /** Alpha of a computed CSS colour string. */
  function alphaOf(c) {
    if (!c || c === 'transparent') return 0;
    let a = alphaCache.get(c);
    if (a !== undefined) return a;
    a = 1;
    const slash = c.indexOf('/');
    if (slash >= 0) {
      const t = c.slice(slash + 1, c.lastIndexOf(')')).trim();
      a = t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t);
    } else if (c.startsWith('rgba(') || c.startsWith('hsla(')) {
      const parts = c.slice(c.indexOf('(') + 1, c.lastIndexOf(')')).split(',');
      if (parts.length >= 4) a = parseFloat(parts[3]);
    }
    if (Number.isNaN(a)) a = 1;
    if (alphaCache.size > 500) alphaCache.clear();
    alphaCache.set(c, a);
    return a;
  }

  const shadowCache = new Map();
  const COLOR_RE = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\([^)]*\)|#[0-9a-f]{3,8}\b|transparent/i;
  /** True when at least one box-shadow layer is actually visible (Tailwind's `0 0 #0000` rings are not). */
  function shadowVisible(s) {
    let v = shadowCache.get(s);
    if (v !== undefined) return v;
    v = false;
    let depth = 0, start = 0;
    const layers = [];
    for (let i = 0; i <= s.length; i++) {
      const ch = s[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (i === s.length || (ch === ',' && depth === 0)) { layers.push(s.slice(start, i)); start = i + 1; }
    }
    for (const layer of layers) {
      const m = COLOR_RE.exec(layer);
      const alpha = m ? alphaOf(m[0].toLowerCase()) : 1;
      if (alpha <= 0.02) continue;
      const rest = m ? layer.replace(m[0], ' ') : layer;
      const nums = (rest.match(/-?[\d.]+(?:px)?/g) || []).map(parseFloat);
      const [x = 0, y = 0, blur = 0, spread = 0] = nums;
      if (blur > 0 || spread !== 0 || x !== 0 || y !== 0) { v = true; break; }
    }
    if (shadowCache.size > 300) shadowCache.clear();
    shadowCache.set(s, v);
    return v;
  }

  /** "Visible box": same rule as strongBox (a lone hairline border is not a box). */
  function computeHasBox(style) {
    return strongBox(style);
  }

  /** Background / shadow, or a border on >= 3 sides. A lone hairline (table row separator) is not a "chip". */
  function strongBox(style) {
    if (alphaOf(style.backgroundColor) > 0.02 || style.backgroundImage !== 'none') return true;
    const bs = style.boxShadow;
    if (bs !== 'none' && shadowVisible(bs)) return true;
    let n = 0;
    if (style.borderTopWidth !== '0px' && alphaOf(style.borderTopColor) > 0.02) n++;
    if (style.borderBottomWidth !== '0px' && alphaOf(style.borderBottomColor) > 0.02) n++;
    if (style.borderLeftWidth !== '0px' && alphaOf(style.borderLeftColor) > 0.02) n++;
    if (style.borderRightWidth !== '0px' && alphaOf(style.borderRightColor) > 0.02) n++;
    return n >= 3;
  }

  // ---------------------------------------------------------------------------------- transforms

  const tCache = new Map();
  /** @returns {[boolean, number]} [has rotation/skew/3d, uniform scale] for a computed transform string */
  function parseTransform(str) {
    let r = tCache.get(str);
    if (r) return r;
    r = [false, 1];
    try {
      const m = new DOMMatrixReadOnly(str);
      const rot = Math.abs(m.b) > 1e-6 || Math.abs(m.c) > 1e-6 ||
        (!m.is2D && (Math.abs(m.m13) > 1e-6 || Math.abs(m.m23) > 1e-6 || Math.abs(m.m31) > 1e-6 || Math.abs(m.m32) > 1e-6));
      const s = (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2;
      r = [rot, s > 0 ? s : 1];
    } catch (_) { /* keep default */ }
    if (tCache.size > 200) tCache.clear();
    tCache.set(str, r);
    return r;
  }

  // ---------------------------------------------------------------------------------- small helpers

  function overlaps(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }
  function isEmpty(c) { return c.right <= c.left || c.bottom <= c.top; }
  function isect(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
      left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
    };
  }
  const px = (s) => parseFloat(s) || 0;
  const r1 = (n) => Math.round(n * 1000) / 1000;

  function idOf(el) {
    let id = ids.get(el);
    if (!id) { id = M._nextId++; ids.set(el, id); }
    return id;
  }

  const BAD_CLASS_PREFIX = /^(?:css-|sc-|jsx-|svelte-|ng-|_|js-|__|data-v-|styled|emotion|chakra-|mui|Mui)/;
  // Utility-framework classes (Tailwind / Bootstrap): they describe styling, not what the element is.
  const UTILITY_EXACT = new Set(['flex', 'grid', 'block', 'inline', 'hidden', 'relative', 'absolute', 'fixed', 'sticky', 'truncate', 'uppercase', 'italic', 'underline']);
  const UTILITY_PREFIX = /^(?:flex-|grid-|col-|row-|p-|px-|py-|pt-|pb-|pl-|pr-|m-|mx-|my-|mt-|mb-|ml-|mr-|w-|h-|min-|max-|text-|font-|leading-|tracking-|bg-|overflow-|duration-|ease-|backdrop-|items-|justify-|content-|self-|gap-|space-|z-|top-|left-|right-|bottom-|inset-|opacity-|cursor-|select-|order-|object-|aspect-|sr-|d-|align-)/;
  const UTILITY_WORD = /^(?:border|rounded|shadow|transition|ring|outline)(?:$|-)/;
  /** Short mixed-case alphabetic tokens (styled-components hashes: bMdVsj, gCqUYN) vs clean camel/Pascal words (NavBar). */
  /** True when a mixed-case token splits into real-looking words (every word >= 2 letters with a vowel). */
  function cleanWords(c) {
    const words = c.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) || [];
    return words.every((w) => w.length >= 2 && /[aeiouy]/i.test(w));
  }
  function hashLikeAlpha(c) {
    return /^[A-Za-z]{5,8}$/.test(c) && /[A-Z]/.test(c.slice(1)) && !cleanWords(c);
  }
  function goodClass(c) {
    if (!c || c.length > 24 || c.length < 2) return false;
    if (UTILITY_EXACT.has(c) || UTILITY_PREFIX.test(c) || UTILITY_WORD.test(c)) return false;
    if (hashLikeAlpha(c)) return false;
    if (/[:[\]/\\.()%!@#,]/.test(c)) return false;          // tailwind variants / arbitrary values
    if (BAD_CLASS_PREFIX.test(c)) return false;
    if (/\d{3,}/.test(c)) return false;
    if (/__(?=[\w-]*\d)[\w-]{4,}$/.test(c)) return false;     // CSS-modules hash suffix (Button_root__x3F2a)
    if (c.length >= 6 && /\d/.test(c) && /[a-z]/i.test(c) && /^[a-z0-9]+$/i.test(c) && !/^[a-z]+\d{1,2}$/i.test(c)) return false; // hash-like
    if (/^[A-Za-z0-9]{8,}$/.test(c) && /[A-Z]/.test(c) && /[a-z]/.test(c) && !/^[A-Z][a-z]+(?:[A-Z][a-z]+)*$/.test(c) && !cleanWords(c)) return false;
    return true;
  }
  function goodId(id) {
    return !!id && id.length <= 20 && !/\d{3,}/.test(id) && !/^[:_]/.test(id) && !/[\s:]/.test(id);
  }
  /** Short selector-ish name: tag + #id + up to 2 classes, <= 40 chars. */
  function labelOf(el, tag) {
    let s = tag;
    const id = el.id;
    if (typeof id === 'string' && goodId(id)) s += '#' + id;
    const cls = el.getAttribute('class');
    let n = 0;
    if (cls) {
      const parts = cls.split(/\s+/);
      for (let i = 0; i < parts.length && n < 2; i++) {
        if (goodClass(parts[i]) && s.length + parts[i].length + 1 <= 40) { s += '.' + parts[i]; n++; }
      }
    }
    if (s === tag) {
      // nothing else identifies it: a short test hook / accessible name is better than a bare tag
      const tid = el.getAttribute('data-testid');
      const al = el.getAttribute('aria-label');
      if (tid && tid.length <= 24 && !/[\s"\]]/.test(tid)) s += `[data-testid=${tid}]`;
      else if (al && al.trim() && al.length <= 24 && !/["\n\r\]]/.test(al)) s += `[aria-label="${al}"]`;
    }
    return s.length > 40 ? s.slice(0, 39) + '…' : s;
  }

  function isControl(el, tag) {
    if (CONTROL_TAGS.has(tag)) return true;
    const role = el.getAttribute('role');
    return !!role && CONTROL_ROLES.has(role);
  }

  /** Flattened-tree children: shadow root content for hosts, assigned nodes for slots. */
  function childList(el) {
    let root = el.shadowRoot;
    if (!root && el.localName.includes('-')) {
      try { root = globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) || null; } catch (_) { root = null; }
    }
    if (root) return root.childNodes;
    if (el.localName === 'slot') {
      const a = el.assignedNodes({ flatten: true });
      return a.length ? a : el.childNodes;
    }
    return el.childNodes;
  }

  function newCol(isRoot) {
    return { boxes: [], texts: [], plates: [], hasText: false, str: '', anyBox: false, isRoot };
  }

  // ---------------------------------------------------------------------------------- radii

  function resolveRadius(tok, ref) {
    if (tok.endsWith('%')) return (parseFloat(tok) / 100) * ref;
    return parseFloat(tok) || 0;
  }
  function cornerRadius(s, lw, lh) {
    if (s === '0px') return 0;
    const p = s.split(' ');
    const h = resolveRadius(p[0], lw);
    const v = p.length > 1 ? resolveRadius(p[1], lh) : (p[0].endsWith('%') ? resolveRadius(p[0], lh) : h);
    return Math.max(0, Math.min(h, v));
  }
  /** Used radii on-screen px: % resolved, overlap factor applied, then scaled. lw/lh are layout px. */
  function computeRadius(style, lw, lh, scale) {
    const a = style.borderTopLeftRadius, b = style.borderTopRightRadius,
      c = style.borderBottomRightRadius, d = style.borderBottomLeftRadius;
    if (a === '0px' && b === '0px' && c === '0px' && d === '0px') return { tl: 0, tr: 0, br: 0, bl: 0 };
    let tl = cornerRadius(a, lw, lh), tr = cornerRadius(b, lw, lh),
      br = cornerRadius(c, lw, lh), bl = cornerRadius(d, lw, lh);
    let f = 1;
    if (tl + tr > 0) f = Math.min(f, lw / (tl + tr));
    if (bl + br > 0) f = Math.min(f, lw / (bl + br));
    if (tl + bl > 0) f = Math.min(f, lh / (tl + bl));
    if (tr + br > 0) f = Math.min(f, lh / (tr + br));
    f *= scale;
    return { tl: r1(tl * f), tr: r1(tr * f), br: r1(br * f), bl: r1(bl * f) };
  }

  // ---------------------------------------------------------------------------------- walking

  /** Own overflow clip (padding box minus scrollbars) in viewport px, or null if the element does not clip. */
  function ownClipOf(el, style, rect, scale) {
    const ox = style.overflowX, oy = style.overflowY;
    const clips = ox !== 'visible' || oy !== 'visible';
    const contain = style.contain;
    const paint = contain !== 'none' && (contain.includes('paint') || contain.includes('content') || contain.includes('strict'));
    const cp = style.clipPath !== 'none';
    if (!clips && !paint && !cp) return null;
    if (!clips && !paint) return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    const bl = px(style.borderLeftWidth) * scale, br = px(style.borderRightWidth) * scale;
    const bt = px(style.borderTopWidth) * scale, bb = px(style.borderBottomWidth) * scale;
    let sbw = 0, sbh = 0;
    if ((ox === 'auto' || ox === 'scroll' || oy === 'auto' || oy === 'scroll') && el.clientWidth > 0) {
      // classic scrollbars: offset - client - borders (layout px)
      const dw = el.offsetWidth - el.clientWidth - (bl + br) / scale;
      const dh = el.offsetHeight - el.clientHeight - (bt + bb) / scale;
      if (dw > 2) sbw = dw * scale;
      if (dh > 2) sbh = dh * scale;
    }
    return { left: rect.left + bl, top: rect.top + bt, right: rect.right - br - sbw, bottom: rect.bottom - bb - sbh };
  }

  const LONG_LIST = 64;
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return r.width < 0.01 || r.height < 0.01 ? null : r;
  };
  /**
   * Long flat sibling list: when the element children's tops are non-decreasing (sampled), binary-search the
   * first child that reaches the far region and return its index in `list`; the caller stops once a child
   * starts below the region. Returns -1 when the list does not look like a top-to-bottom flow.
   */
  function firstReaching(list) {
    const els = [];
    for (let i = 0; i < list.length; i++) if (list[i].nodeType === 1) els.push(i);
    const m = els.length;
    if (m <= LONG_LIST) return -1;
    const at = (k) => rectOf(list[els[k]]);
    let prev = -Infinity, seen = 0;
    for (let j = 0; j < 16; j++) {
      const r = at(Math.round((j * (m - 1)) / 15));
      if (!r) continue;
      if (r.top < prev - 0.5) return -1;
      prev = r.top;
      seen++;
    }
    if (seen < 3) return -1;
    const top = st.big.top;
    let lo = 0, hi = m;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      let r = null;
      for (let k = mid; k < Math.min(m, mid + 8) && !r; k++) r = at(k);
      if (!r) return -1;
      if (r.bottom > top) hi = mid; else lo = mid + 1;
    }
    return els[Math.max(0, lo - 4)];
  }

  function walkChildren(parent, pstyle, ctx, col, hidden) {
    const list = childList(parent);
    let from = 0, ordered = false;
    if (list.length > LONG_LIST) {
      const f = firstReaching(list);
      if (f >= 0) { from = f; ordered = true; }
    }
    for (let i = from; i < list.length; i++) {
      if (st.stop) return;
      const n = list[i];
      const t = n.nodeType;
      if (t === 1) {
        if (ordered) {
          const r = rectOf(n);
          if (r && r.top >= st.big.bottom) return;
        }
        walkEl(n, ctx, col);
      } else if (t === 3 && !hidden) onText(n, pstyle, ctx, col);
    }
  }

  function onText(tn, pstyle, ctx, col) {
    const d = tn.data;
    if (!/\S/.test(d)) return;
    col.hasText = true;
    if (col.str.length < 200) col.str += ' ' + d;
    if (col.isRoot || col.texts.length >= 300) return;
    const range = st.range;
    range.selectNodeContents(tn);
    const rects = range.getClientRects();
    const fs = (parseFloat(pstyle.fontSize) || 16) * ctx.scale;
    const clip = ctx.clip;
    const last = () => col.texts[col.texts.length - 1];
    const gap = 0.6 * fs + 1;   // word space between inline fragments on one line (+1px rounding slack)
    for (let i = 0; i < rects.length && col.texts.length < 300; i++) {
      const r = rects[i];
      if (r.width < 1 || r.height <= 0) continue;
      let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
      if (clip) {
        if (left < clip.left) left = clip.left;
        if (top < clip.top) top = clip.top;
        if (right > clip.right) right = clip.right;
        if (bottom > clip.bottom) bottom = clip.bottom;
      }
      if (right - left < 2 || bottom <= top) continue;
      const reg = st.region;
      if (!(left < reg.right && right > reg.left && top < reg.bottom && bottom > reg.top)) continue;
      const p = last();
      if (p && Math.abs(p.top - top) <= 2 && Math.abs(p.bottom - bottom) <= 2 && Math.abs(p.fs - fs) < 0.5 &&
          left <= p.right + gap && right >= p.left - gap) {
        if (left < p.left) p.left = left;
        if (right > p.right) p.right = right;
        continue;
      }
      col.texts.push({ left, top, right, bottom, fs });
    }
  }

  /** @returns {object} child context (reuses `ctx` when nothing changes) */
  function makeCtx(ctx, o) {
    return {
      parentId: o.parentId, depth: o.depth, clip: o.clip, posClip: o.posClip,
      fa: o.fa, out: o.out, rotated: o.rotated, tscale: o.tscale, scale: o.scale,
    };
  }

  function walkEl(el, ctx, col) {
    if (el === st.ignore) return;
    const tag = el.localName;
    if (SKIP.has(tag)) return;
    if ((++st.visited & 31) === 0 && performance.now() > st.deadline) { st.stop = true; st.truncated = true; }
    if (st.stop) return;

    // Cheap reject first: a box that paints (non-zero area) and lies outside the far region never matters.
    // Zero-area boxes (display:none / contents, collapsed wrappers) keep their own paths below.
    const rect = el.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (w >= 0.01 && h >= 0.01 && !overlaps(rect, st.big)) return;

    const style = getComputedStyle(el);
    const display = style.display;
    if (display === 'none') return;
    if (display === 'contents') { walkChildren(el, style, ctx, col, false); return; }
    if (style.opacity === '0') return;
    if (el.checkVisibility && !el.checkVisibility(VIS_OPTS)) return;

    const position = style.position;
    const abs = position === 'absolute' || position === 'fixed';
    if (abs && style.clip !== 'auto') return;                           // sr-only (clip: rect(0 0 0 0))
    if (w <= 1 && h <= 1 && style.overflowX !== 'visible') return;       // sr-only (1x1, overflow hidden)

    const replaced = REPLACED.has(tag);
    const hidden = style.visibility === 'hidden';

    // ---- inline elements: never nodes; their text/plates go to the nearest included block ancestor
    if (display === 'inline' && !replaced) {
      const zero = w < 0.01 || h < 0.01;
      let asAtom = false;
      let hb = false;
      if (!zero && !hidden) {
        hb = computeHasBox(style);
        if (hb && isControl(el, tag) && el.getClientRects().length === 1) asAtom = true;
      }
      if (!asAtom) {
        if (!zero && !overlaps(rect, st.big)) return;
        if (hb) {
          col.anyBox = true;
          if (col.plates.length < 60 && !col.isRoot) {
            const rs = el.getClientRects();
            for (let i = 0; i < rs.length && col.plates.length < 60; i++) {
              const r = isect(rs[i], ctx.clip);
              if (r.right - r.left >= 1 && r.bottom > r.top && overlaps(r, st.region)) col.plates.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
            }
          }
        }
        walkChildren(el, style, ctx, col, hidden);
        return;
      }
    }

    // ---- block-level path
    const zero = w < 0.01 || h < 0.01;
    const inflow = !abs && style.cssFloat === 'none';
    if (!zero && !hidden && inflow) col.boxes.push(rect);
    const hasBox = (zero || hidden) ? false : computeHasBox(style);
    if (hasBox) col.anyBox = true;

    // transform / scale
    let rotated = ctx.rotated, tscale = ctx.tscale;
    const tr = style.transform;
    if (tr !== 'none') {
      const t = parseTransform(tr);
      if (t[0]) rotated = true;
      tscale *= t[1];
    }
    if (style.rotate !== 'none') rotated = true;
    let scale = 1;
    let lw = w, lh = h;      // layout-px border-box size
    if (!zero) {
      const ow = el.offsetWidth;
      if (rotated) {
        // the bounding rect is the AABB of a rotated box: use the transform's scale + unrotated layout size
        scale = Math.abs(tscale - 1) < 1e-3 ? 1 : tscale;
        if (ow > 0) { lw = ow; lh = el.offsetHeight; } else { lw = w / scale; lh = h / scale; }
      } else {
        if (ow > 0 && Math.abs(w - ow) > 1) scale = w / ow;
        if (Math.abs(scale - 1) < 1e-3) scale = 1;
        lw = w / scale; lh = h / scale;
      }
    }

    // clip chain (containing-block based)
    const incoming = position === 'fixed' ? null : position === 'absolute' ? ctx.posClip : ctx.clip;
    // zero-area boxes never paint and must not prune: their children decide (fixed ones reset the clip)
    if (incoming && !zero && (isEmpty(incoming) || !overlaps(rect, incoming))) return;
    const own = ownClipOf(el, style, rect, scale);
    const childClip = own ? isect(incoming, own) : incoming;
    const childPos = (position !== 'static' || tr !== 'none') ? childClip : ctx.posClip;
    const fa = ctx.fa || position === 'fixed';
    const isScroller = el === st.scroller;
    const out = isScroller ? false : ctx.out;

    const visible = incoming ? isect(rect, incoming) : rect;
    const inRegion = !zero && !hidden && overlaps(visible, st.region);

    const passCtx = () => (childClip === ctx.clip && childPos === ctx.posClip && fa === ctx.fa && out === ctx.out &&
      rotated === ctx.rotated && tscale === ctx.tscale)
      ? ctx
      : makeCtx(ctx, { parentId: ctx.parentId, depth: ctx.depth, clip: childClip, posClip: childPos, fa, out, rotated, tscale, scale: ctx.scale });

    if (!inRegion) {
      if (!zero && !hidden) {
        if (own) return;                                   // clipped to a box that lies outside the region
        if (!overlaps(rect, st.big)) return;
      }
      // Out-of-region block: its descendants still attach to the nearest included ancestor, but its own
      // text/boxes must not leak into that ancestor's texts / gaps -> throwaway collector. (Hidden or
      // zero-area wrappers are transparent: their visible descendants report to the ancestor.)
      walkChildren(el, style, passCtx(), (hidden || zero) ? col : newCol(true), hidden);
      return;
    }

    // ---- classification
    let kind = 'container';
    let spec = false;       // decide after walking the children
    let bigCtl = false;
    if (replaced || FORM.has(tag)) kind = 'atom';
    else if (hasBox && isControl(el, tag)) {
      if (lh <= 64 && lw <= 480) kind = 'atom'; else { spec = true; bigCtl = true; }
    } else if (hasBox && (lw <= 2 || lh <= 2 || ((lh <= 48 && lw <= 320) && strongBox(style)))) spec = true;

    if (st.nodes.length >= st.maxNodes) { st.stop = true; st.truncated = true; return; }

    const sx = st.sx, sy = st.sy;
    const bl = px(style.borderLeftWidth) * scale, brr = px(style.borderRightWidth) * scale;
    const bt = px(style.borderTopWidth) * scale, bb = px(style.borderBottomWidth) * scale;
    const pl = px(style.paddingLeft) * scale, pr = px(style.paddingRight) * scale;
    const pt = px(style.paddingTop) * scale, pb = px(style.paddingBottom) * scale;
    let cw = w - bl - brr - pl - pr, ch = h - bt - bb - pt - pb;
    const oy = style.overflowY, ox = style.overflowX;
    if (own && (ox === 'auto' || ox === 'scroll' || oy === 'auto' || oy === 'scroll')) {
      cw -= Math.max(0, rect.right - brr - own.right);
      ch -= Math.max(0, rect.bottom - bb - own.bottom);
    }
    const id = idOf(el);
    const box = { x: rect.left + sx, y: rect.top + sy, w, h };
    const node = {
      id, parent: ctx.parentId, depth: ctx.depth, el,
      label: labelOf(el, tag), kind, display, box,
      size: { w: lw, h: lh }, scale, rotated,
      clip: incoming ? { x: incoming.left + sx, y: incoming.top + sy, w: incoming.right - incoming.left, h: incoming.bottom - incoming.top } : null,
      hasBox,
      radius: computeRadius(style, lw, lh, scale),
      border: { t: bt, r: brr, b: bb, l: bl },
      padding: { t: pt, r: pr, b: pb, l: pl },
      margin: {
        t: px(style.marginTop) * scale, r: px(style.marginRight) * scale,
        b: px(style.marginBottom) * scale, l: px(style.marginLeft) * scale,
      },
      content: { x: box.x + bl + pl, y: box.y + bt + pt, w: Math.max(0, cw), h: Math.max(0, ch) },
      gaps: [], texts: [], inlinePlates: [],
      showSize: false,
      fixed: fa || ctx.out,   // the scroller itself does not move when it scrolls -> counts as outside
      text: null, font: null, color: null, background: null,
    };
    const idx = st.nodes.length;
    st.nodes.push(node);

    let ncol = null;
    if (kind === 'container') {
      ncol = newCol(false);
      const cctx = makeCtx(ctx, { parentId: id, depth: ctx.depth + 1, clip: childClip, posClip: childPos, fa, out, rotated, tscale, scale });
      walkChildren(el, style, cctx, ncol, false);
      if (spec && !ncol.anyBox && (!bigCtl || ncol.texts.length <= 1)) {
        // small leaf / big-but-simple control: becomes an atom, drop what we collected below it
        st.nodes.length = idx + 1;
        kind = node.kind = 'atom';
        ncol = null;
      }
    }

    if (kind === 'container') finishContainer(node, el, style, ncol, display);
    else node.text = atomText(el, tag);

    node.showSize = kind === 'atom' || hasBox;
    if (kind === 'container') {
      const s = ncol.str.replace(/\s+/g, ' ').trim();
      node.text = s ? (s.length > 60 ? s.slice(0, 59) + '…' : s) : null;
    }
    if (node.text) {
      node.font = {
        size: px(style.fontSize), lineHeight: style.lineHeight, weight: style.fontWeight,
        family: (style.fontFamily.split(',')[0] || '').trim().replace(/^["']|["']$/g, ''),
      };
      node.color = style.color;
    }
    if (hasBox) {
      if (alphaOf(style.backgroundColor) > 0.02) node.background = style.backgroundColor;
      else if (style.backgroundImage !== 'none') node.background = style.backgroundImage.slice(0, 200);
    }
  }

  function atomText(el, tag) {
    let s = '';
    try {
      if (tag === 'select') s = el.selectedOptions?.[0]?.textContent || '';
      else if (tag === 'input' || tag === 'textarea') {
        s = el.type === 'password' ? '' : (el.value || '');
        if (!s && tag === 'input' && el.type !== 'password') s = el.getAttribute('placeholder') || '';
      } else if (tag !== 'svg' && tag !== 'canvas' && tag !== 'video' && tag !== 'iframe') {
        s = (el.textContent || '').slice(0, 400);
      }
      s = s.replace(/\s+/g, ' ').trim();
      if (!s) s = el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || '';
      if (!s && tag === 'svg') s = el.getAttribute('aria-label') || '';
      s = s.replace(/\s+/g, ' ').trim();
    } catch (_) { s = ''; }
    if (!s) return null;
    return s.length > 60 ? s.slice(0, 59) + '…' : s;
  }

  const rectOut = (l, t, r, b) => ({ x: l + st.sx, y: t + st.sy, w: r - l, h: b - t });

  /** Fills gaps / texts / inlinePlates of a container from what its children reported. */
  function finishContainer(node, el, style, col, display) {
    const sx = st.sx, sy = st.sy;
    for (const t of col.texts) {
      node.texts.push({ rect: rectOut(t.left, t.top, t.right, t.bottom), fontSize: t.fs });
    }
    for (const p of col.plates) node.inlinePlates.push(rectOut(p.left, p.top, p.right, p.bottom));
    if (col.hasText || col.boxes.length < 2) return;

    const c = node.content;
    const cl = c.x - sx, ct = c.y - sy, cr = cl + c.w, cb = ct + c.h;
    const spaced = /flex|grid/.test(display) && /^space-/.test(style.justifyContent);
    const items = col.boxes.slice().sort((a, b) => (a.top - b.top) || (a.left - b.left));
    const lines = [];
    for (const b of items) {
      const ln = lines[lines.length - 1];
      if (ln) {
        const ov = Math.min(ln.bottom, b.bottom) - Math.max(ln.top, b.top);
        if (ov > 0.5 * Math.min(ln.bottom - ln.top, b.bottom - b.top)) {
          ln.items.push(b);
          if (b.top < ln.top) ln.top = b.top;
          if (b.bottom > ln.bottom) ln.bottom = b.bottom;
          continue;
        }
      }
      lines.push({ top: b.top, bottom: b.bottom, items: [b] });
    }
    const gaps = node.gaps;
    const add = (axis, l, t, r, b) => {
      // clamp to the content box; keep the on-screen length along the axis as `value`
      const L = Math.max(l, cl), T = Math.max(t, ct), R = Math.min(r, cr), B = Math.min(b, cb);
      if (R <= L || B <= T) return;
      gaps.push({ axis, rect: rectOut(L, T, R, B), value: axis === 'x' ? r - l : b - t });
    };
    for (let i = 0; i < lines.length && gaps.length < 300; i++) {
      const ln = lines[i];
      if (!spaced && ln.items.length > 1) {
        ln.items.sort((a, b) => a.left - b.left);
        for (let k = 1; k < ln.items.length; k++) {
          const g = ln.items[k].left - ln.items[k - 1].right;
          if (g >= 0.5 && g <= 160) add('x', ln.items[k - 1].right, ln.top, ln.items[k].left, ln.bottom);
        }
      }
      if (i > 0) {
        const g = ln.top - lines[i - 1].bottom;
        if (g >= 0.5 && g <= 160) add('y', cl, lines[i - 1].bottom, cr, ln.top);
      }
    }
  }

  /**
   * Scan the page.
   * @param {{ ignore?: Element, margin?: number, maxNodes?: number, budgetMs?: number,
   *           scroll?: {x:number,y:number}, scroller?: Element }} [opts]
   * @returns {Model}
   */
  M.scan = function scan(opts) {
    opts = opts || {};
    const t0 = performance.now();
    const de = document.documentElement;
    const body = document.body;
    const sx = opts.scroll ? opts.scroll.x : (window.scrollX || 0);
    const sy = opts.scroll ? opts.scroll.y : (window.scrollY || 0);
    const vw = de.clientWidth || window.innerWidth;
    const vh = de.clientHeight || window.innerHeight;
    const m = opts.margin ?? 300;
    let scroller = opts.scroller instanceof Element ? opts.scroller : null;
    if (scroller === de || scroller === body) scroller = null;

    const model = {
      scrollX: sx, scrollY: sy, vw, vh, dpr: window.devicePixelRatio || 1,
      region: { x: sx - m, y: sy - m, w: vw + 2 * m, h: vh + 2 * m },
      nodes: [], truncated: false,
    };
    if (!body) return model;

    st = {
      nodes: model.nodes, sx, sy,
      region: { left: -m, top: -m, right: vw + m, bottom: vh + m },
      big: { left: -m - BIG, top: -m - BIG, right: vw + m + BIG, bottom: vh + m + BIG },
      maxNodes: opts.maxNodes ?? 1500,
      deadline: t0 + (opts.budgetMs ?? 40),
      ignore: opts.ignore || null,
      scroller,
      range: document.createRange(),
      visited: 0, stop: false, truncated: false,
    };
    try {
      const ctx = {
        parentId: -1, depth: 0, clip: null, posClip: null, fa: false, out: !!scroller,
        rotated: false, tscale: 1, scale: 1,
      };
      walkChildren(body, null, ctx, newCol(true), false);
      model.truncated = st.truncated;
    } catch (_) {
      model.truncated = true;          // e.g. RangeError on absurdly deep DOMs: return what we have
    } finally {
      st.range.detach?.();
      st = null;
    }
    return model;
  };
})();
