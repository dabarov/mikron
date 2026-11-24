/**
 * Mikron clipboard spec. Defines `M.formatSpec(model, selRect, opts) -> string`.
 * `opts.format`: 'text' (default) | 'json' (JSON string) | 'prompt' (the text spec with text colour and font
 * family added, wrapped in a short note and a reading key, for pasting into an AI assistant). Never throws;
 * all numbers are layout px (on-screen value / node.scale).
 */
(function () {
  'use strict';
  const M = (globalThis.__MIKRON__ ||= {});

  const MAX_LINES = 200;
  const EPS = 0.5;

  const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  /** Rounded to <= 2 decimals, no trailing zeros, no "-0". */
  const num = (v) => String(Math.round(fin(v) * 100) / 100 + 0);
  const int = (v) => Math.round(fin(v));

  /** CSS 4-value shorthand collapse of [a,b,c,d] (top,right,bottom,left order). */
  function shorthand(a, b, c, d) {
    const [A, B, C, D] = [a, b, c, d].map(num);
    if (A === B && B === C && C === D) return A;
    if (A === C && B === D) return `${A} ${B}`;
    if (B === D) return `${A} ${B} ${C}`;
    return `${A} ${B} ${C} ${D}`;
  }

  /** Sub-pixel noise (0.05) reads as 0 in the spec. */
  const quiet = (v) => (Math.abs(v) < EPS ? 0 : v);
  const sidesLayout = (s, k) => (s ? [fin(s.t) / k, fin(s.r) / k, fin(s.b) / k, fin(s.l) / k].map(quiet) : [0, 0, 0, 0]);
  const hasAny = (arr) => arr.some((v) => Math.round(v * 100) !== 0);

  function visibleRect(n) {
    const b = n.box;
    if (!n.clip) return b;
    const l = Math.max(b.x, n.clip.x), t = Math.max(b.y, n.clip.y);
    const r = Math.min(b.x + b.w, n.clip.x + n.clip.w), bt = Math.min(b.y + b.h, n.clip.y + n.clip.h);
    return { x: l, y: t, w: Math.max(0, r - l), h: Math.max(0, bt - t) };
  }
  function intersects(a, s) {
    return a.x < s.x + s.w && a.x + a.w > s.x && a.y < s.y + s.h && a.y + a.h > s.y;
  }
  function inside(a, s) {
    return a.x >= s.x - EPS && a.y >= s.y - EPS && a.x + a.w <= s.x + s.w + EPS && a.y + a.h <= s.y + s.h + EPS;
  }

  /** `bg` value: colours pass through; images / gradients are summarised (never cut mid-token). */
  function bgText(v) {
    const s = String(v);
    const u = s.indexOf('url('), g = s.search(/-gradient\(/), i = s.search(/image-set\(/);
    const first = Math.min(...[u, g, i].map((x) => (x < 0 ? Infinity : x)));
    if (first === Infinity) return s;
    if (first === g) return 'gradient';
    if (first === i) return 'image';
    let t = s.slice(u + 4).replace(/^\s*["']?/, '');
    t = t.slice(0, t.search(/["')]|$/));
    if (/^data:/i.test(t)) return 'image';
    t = t.split(/[?#]/)[0].replace(/\/+$/, '');
    let name = t.slice(t.lastIndexOf('/') + 1);
    try { name = decodeURIComponent(name); } catch (_) { /* keep raw */ }
    return name ? `image(${name})` : 'image';
  }

  /** Builds the plain description of a node (layout px), independent of output format. */
  function describe(n, partial) {
    const k = n.scale > 0 ? n.scale : 1;
    const padding = sidesLayout(n.padding, k);
    const r = n.radius || { tl: 0, tr: 0, br: 0, bl: 0 };
    const radius = [fin(r.tl) / k, fin(r.tr) / k, fin(r.br) / k, fin(r.bl) / k].map(quiet);
    const gx = new Set(), gy = new Set();
    for (const g of n.gaps || []) {
      const raw = fin(g.value) / k;
      if (Math.abs(raw) < EPS) continue;
      const v = Math.round(raw * 100) / 100;
      (g.axis === 'x' ? gx : gy).add(v);
    }
    const sz = n.size || { w: fin(n.box && n.box.w) / k, h: fin(n.box && n.box.h) / k };
    return {
      label: String(n.label || '?'),
      text: n.text || null,
      size: [int(sz.w), int(sz.h)],
      showSize: !!n.showSize || hasAny(padding) || gx.size > 0 || gy.size > 0,
      padding: hasAny(padding) ? padding : null,
      radius: hasAny(radius) ? radius : null,
      gx: [...gx].sort((a, b) => a - b),
      gy: [...gy].sort((a, b) => a - b),
      font: n.text && n.font ? n.font : null,
      color: n.text ? n.color || null : null,
      background: n.hasBox && n.background ? bgText(n.background) : null,
      partial,
      children: [],
      count: 1,
      wrap: false,
      _own: !!n.text,
    };
  }

  /** Font family as written in the prompt format: quoted when it has anything but word characters. */
  const familyText = (f) => (/^[\w-]+$/.test(f) ? f : `"${String(f).replace(/"/g, '')}"`);

  /** One spec line. `rich` (prompt format) adds the text colour and the font family. */
  function lineOf(d, rich) {
    const parts = [];
    if (d.showSize) parts.push(`${d.size[0]} × ${d.size[1]}`);
    if (d.padding) parts.push(`padding ${shorthand(...d.padding)}`);
    if (d.gx.length || d.gy.length) {
      const x = d.gx.map(num).join(', '), y = d.gy.map(num).join(', ');
      parts.push(`gap ${d.gx.length && d.gy.length ? `${x} / ${y}` : x || y}`);
    }
    if (d.radius) parts.push(`radius ${shorthand(...d.radius)}`);
    if (d.background) parts.push(`bg ${d.background}`);
    if (rich && d.color) parts.push(`color ${d.color}`);
    if (d.font) {
      const f = d.font;
      parts.push((`font ${num(f.size)}px/${f.lineHeight || 'normal'} ${f.weight || ''}`.trim() + (rich && f.family ? ' ' + familyText(f.family) : '')));
    }
    const name = (d.text ? `${d.label} "${String(d.text).replace(/"/g, '\\"')}"` : d.label) + (d.count > 1 ? ` ×${d.count}` : '');
    return name + (parts.length ? ' — ' + parts.join(' · ') : '') + (d.partial ? ' (partial)' : '');
  }

  /** Pass-through: nothing of its own to say, exactly one child -> replaced by the child. */
  function isPassThrough(d) {
    return !d.showSize && !d.padding && !d.radius && !d.background && !d.gx.length && !d.gy.length && !d._own;
  }

  /** Structural identity of a subtree for run-collapsing: the rendered lines with quoted text ignored. */
  function sigOf(d) {
    if (d._sig === undefined) {
      d._sig = lineOf({ ...d, text: null, count: 1 }) + '{' + d.children.map(sigOf).join('|') + '}';
    }
    return d._sig;
  }

  /** Runs of consecutive sibling subtrees with identical signatures -> the first, with `count`. */
  function dedupe(list) {
    const out = [];
    for (const d of list) {
      const p = out[out.length - 1];
      if (p && sigOf(p) === sigOf(d)) { p.count += d.count; continue; }
      out.push(d);
    }
    return out;
  }

  function collapse(d) {
    d.children = dedupe(d.children.map(collapse).filter(Boolean));
    if (isPassThrough(d)) {
      if (d.children.length === 1) return d.children[0];
      if (d.children.length === 0) return null;     // empty wrapper with nothing visible
    }
    return d;
  }

  function buildTree(model, sel) {
    const nodes = Array.isArray(model && model.nodes) ? model.nodes : [];
    const byId = new Map();
    for (const n of nodes) if (n) byId.set(n.id, n);
    const made = new Map();
    const roots = [];
    for (const n of nodes) {
      if (!n || !n.box) continue;
      const vis = visibleRect(n);
      if (!(vis.w > 0 && vis.h > 0) || !intersects(vis, sel)) continue;
      const clipped = vis.w < n.box.w - EPS || vis.h < n.box.h - EPS;
      const d = describe(n, clipped || !inside(n.box, sel));
      // full-page wrapper: contains the selection, is much larger than it, says nothing of its own
      d.wrap = !d._own && sel.w > 0 && sel.h > 0 && inside(sel, n.box) && n.box.w * n.box.h > 2 * sel.w * sel.h;
      made.set(n.id, d);
      // nearest ancestor that is itself part of the selection
      let p = byId.get(n.parent), guard = 0;
      while (p && !made.has(p.id) && guard++ < 1000) p = byId.get(p.parent);
      (p && made.get(p.id) ? made.get(p.id).children : roots).push(d);
    }
    const finish = (list) => dedupe(list.map(collapse).filter(Boolean));
    // peel leading wrappers (outermost first) into a context path
    let list = roots;
    const context = [];
    for (let guard = 0; guard < 200; guard++) {
      const i = list.findIndex((d) => d.wrap && d.children.length);
      if (i < 0) break;
      context.push(list[i].label);
      list = list.slice(0, i).concat(list[i].children, list.slice(i + 1));
    }
    let tree = finish(list);
    if (!tree.length && context.length) { context.length = 0; tree = finish(roots); }   // nothing left below the wrappers
    // anonymous wrappers (bare tag, no id/class/attribute) say nothing
    const named = context.filter((l) => !/^[a-z][a-z0-9-]*$/i.test(l));
    return { tree, context: named.slice(-4) };
  }

  function flatten(ds, depth, lines, rich) {
    for (const d of ds) {
      lines.push('  '.repeat(depth) + lineOf(d, rich));
      flatten(d.children, depth + 1, lines, rich);
    }
  }

  /** How to read the lines of the spec; closes the prompt format so the reader needs no other context. */
  const PROMPT_KEY = [
    'How to read the spec:',
    '- One line per element. Indentation is DOM nesting. The name is the tag with its #id and .classes, then the visible text in quotes.',
    '- "W × H" is the border-box size of the whole element.',
    '- padding and radius are in CSS shorthand order (top right bottom left; radius starts at the top-left corner).',
    '- gap is the space between the element\'s children ("x / y" when the two axes differ).',
    '- font is size/line-height, weight and family. bg and color are computed values.',
    '- "×N" after a name means N identical siblings in a row. "(partial)" means the selection cut through the element.',
  ].join('\n');

  /** A code fence longer than any run of backticks in the body. */
  function fenceFor(body) {
    let longest = 0;
    for (const m of body.match(/`+/g) || []) longest = Math.max(longest, m.length);
    return '`'.repeat(Math.max(3, longest + 1));
  }

  function toJson(d) {
    const o = { label: d.label, size: d.size };
    if (d.count > 1) o.count = d.count;
    if (d.padding) o.padding = d.padding.map((v) => Math.round(v * 100) / 100);
    if (d.radius) o.radius = d.radius.map((v) => Math.round(v * 100) / 100);
    if (d.gx.length || d.gy.length) {
      o.gap = {};
      if (d.gx.length) o.gap.x = d.gx;
      if (d.gy.length) o.gap.y = d.gy;
    }
    if (d.text) o.text = d.text;
    if (d.font) o.font = { size: d.font.size, lineHeight: d.font.lineHeight, weight: d.font.weight, family: d.font.family };
    if (d.color) o.color = d.color;
    if (d.background) o.background = d.background;
    if (d.partial) o.partial = true;
    o.children = d.children.map(toJson);
    return o;
  }

  function where() {
    try {
      const l = globalThis.location;
      return l ? `${l.host}${l.pathname === '/' ? '' : l.pathname}` : '';
    } catch (_) { return ''; }
  }

  /**
   * @param {import('./scan.js').Model} model
   * @param {{x:number,y:number,w:number,h:number}} selRect document-coords selection
   * @param {{format?:'text'|'json'}} [opts]
   * @returns {string}
   */
  M.formatSpec = function formatSpec(model, selRect, opts) {
    try {
      const sel = {
        x: fin(selRect && selRect.x), y: fin(selRect && selRect.y),
        w: Math.max(0, fin(selRect && selRect.w)), h: Math.max(0, fin(selRect && selRect.h)),
      };
      const { tree, context } = buildTree(model || {}, sel);
      const loc = where();
      const sizeTxt = `${int(sel.w)} × ${int(sel.h)}`;
      if (opts && opts.format === 'json') {
        const json = JSON.stringify({ selection: [int(sel.w), int(sel.h)], page: loc, ...(context.length ? { context } : {}), ...(model && model.truncated ? { truncated: true } : {}), children: tree.map(toJson) }, null, 2);
        // keep flat number arrays on one line: [8, 8, 8, 8]
        return json.replace(/\[([^[\]{}"]*?)\]/g, (m, inner) => (inner.trim() ? '[' + inner.split(',').map((x) => x.trim()).join(', ') + ']' : '[]'));
      }
      const prompt = !!opts && opts.format === 'prompt';
      const lines = [];
      flatten(tree, 0, lines, prompt);
      if (prompt) {
        let body = lines.length ? lines : ['(no measurable elements)'];
        if (lines.length > MAX_LINES) body = lines.slice(0, MAX_LINES).concat(`… ${lines.length - MAX_LINES} more`);
        const text = body.join('\n');
        const fence = fenceFor(text);
        return [
          'UI spec measured from a rendered web page with Mikron. Sizes are in CSS px and come from the live layout, so treat them as exact.',
          '',
          ...(loc ? [`Page: ${loc}`] : []),
          `Selection: ${sizeTxt}`,
          ...(context.length ? [`Inside: ${context.join(' › ')}`] : []),
          ...(model && model.truncated ? ['Note: page too large to measure completely; some elements are missing.'] : []),
          '',
          fence + 'text',
          text,
          fence,
          '',
          PROMPT_KEY,
        ].join('\n');
      }
      const head = `Mikron — ${sizeTxt} selection${loc ? ' on ' + loc : ''}` + (context.length ? `\nInside: ${context.join(' › ')}` : '')
        + (model && model.truncated ? '\nNote: page too large to measure completely; some elements are missing.' : '');
      if (!lines.length) return head + '\n\n(no measurable elements)';
      let body = lines;
      if (lines.length > MAX_LINES) body = lines.slice(0, MAX_LINES).concat(`… ${lines.length - MAX_LINES} more`);
      return head + '\n\n' + body.join('\n');
    } catch (e) {
      return 'Mikron — spec unavailable';
    }
  };
})();
