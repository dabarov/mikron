/* Mikron blueprint renderer (B1).
 * Turns a scanned DOM model into the hatched / graph-paper / chips / radius-callout drawing.
 * Contract: M.createBlueprint({ mount }) -> { setModel, update, freeze, clear, destroy }.
 *
 * Coordinate spaces used below:
 *   content coords  - what the model stores (viewport + model.scrollX/Y at scan time)
 *   layer coords    - content - model.scroll; everything inside .mk-layer lives here. The layer is
 *                     translated by (model.scroll - frame.scroll) so it tracks window scroll for free.
 *   viewport coords - frame.sel / frame.pointer; layer = viewport + (frame.scroll - model.scroll).
 */
(function () {
  'use strict';
  const M = (globalThis.__MIKRON__ ||= {});

  const FALLBACK = {
    accent: '#0a8cff', accentText: '#ffffff', line: '#2f9bff',
    border: 'rgba(56,152,255,0.90)', paper: '#131e29',
    plate: 'rgba(4,14,28,0.45)', plateLift: 'rgba(255,255,255,0.04)', atomPlate: 'rgba(255,255,255,0.10)',
    well: 'rgba(4,10,20,0.08)',
    bandTint: 'rgba(30,120,230,0.06)', hatch: 'rgba(20,128,255,0.5)',
    gridMinor: 'rgba(56,152,255,0.10)', gridMajor: 'rgba(56,152,255,0.22)',
    dash: 'rgba(56,152,255,0.70)', skeleton: 'rgba(255,255,255,0.15)',
    chipDarkBg: '#05080d',
    fontMono: 'ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
    fontMonoBundled: '"Mikron Mono", ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
    dur: { chipFade: 120, countUp: 450, arcDraw: 260 },
    ease: { out: 'cubic-bezier(0.2,0.8,0.2,1)' },
  };

  const CHIP_H = 16;
  const MAX_LIVE_CHIPS = 500;
  const MAX_CALLOUTS = 16;
  const LOD_HIDE = 66000;         // selection px² above which lod-1 chips are hidden ...
  const LOD_SHOW = 54000;         // ... and below which they come back (hysteresis)
  const LOD_FADE = 80;            // ms, lod-1 chips fade out instead of vanishing
  const MAX_COUNTUP_BATCH = 80;   // more chips than this revealed at once skip the count-up
  const ZERO = { t: 0, r: 0, b: 0, l: 0 };
  const SVGNS = 'http://www.w3.org/2000/svg';

  const mod = (a, n) => ((a % n) + n) % n;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  /** Midpoint of [a,b] restricted to [lo,hi]; falls back to the full span's midpoint. */
  function midSpan(a, b, lo, hi) {
    const l = Math.max(a, lo), h = Math.min(b, hi);
    return h > l ? (l + h) / 2 : (a + b) / 2;
  }

  /** @param {{mount: HTMLElement}} opts */
  function createBlueprint({ mount }) {
    const T = { ...FALLBACK, ...(M.tokens || {}) };
    const DUR = { ...FALLBACK.dur, ...(T.dur || {}) };
    const EASE_OUT = (T.ease && T.ease.out) || FALLBACK.ease.out;
    const doc = mount.ownerDocument;
    const win = doc.defaultView || window;

    // ---------------------------------------------------------------- DOM
    const style = doc.createElement('style');
    style.textContent = `
.mk-bp{position:absolute;inset:0;pointer-events:none;visibility:hidden}
.mk-layer{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}
.mk-bp-canvas{position:absolute;left:0;top:0;display:block;pointer-events:none}
.mk-arcs{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.mk-world{position:absolute;left:0;top:0;pointer-events:none}
.mk-chip{position:absolute;box-sizing:border-box;height:${CHIP_H}px;padding:0 5px;border-radius:4px;
  font:700 11px/${CHIP_H}px ${T.fontMono};text-align:center;white-space:nowrap;
  font-variant-numeric:tabular-nums;contain:layout paint style;pointer-events:none;
  background:${T.accent};color:${T.accentText};-webkit-font-smoothing:antialiased}
.mk-chip[data-kind="space"]{background:${T.chipDarkBg};color:${T.line}}
.mk-bp.mk-mm .mk-chip{font-family:${T.fontMonoBundled};padding:0}
`;
    const root = doc.createElement('div'); root.className = 'mk-bp';
    const layer = doc.createElement('div'); layer.className = 'mk-layer';
    const canvas = doc.createElement('canvas'); canvas.className = 'mk-bp-canvas';
    const svg = doc.createElementNS(SVGNS, 'svg'); svg.setAttribute('class', 'mk-arcs');
    const world = doc.createElement('div'); world.className = 'mk-world';
    layer.append(canvas, svg, world);
    root.append(layer);
    mount.append(style, root);

    // ---------------------------------------------------------------- state
    let model = null;
    let vw = 0, vh = 0, dpr = 1;
    let ctx = null;
    let hatchTile = null, gridTile = null, hatchPat = null, gridPat = null;
    let chips = [];                 // static chips, in placement order
    let chipsByKey = new Map();
    let hash = null;                // spatial hash of placed chip rects
    let groups = [];                // repeated-sibling groups: { members: [{id,x,y,x1,y1}], act, stamp }
    let atomRects = [];             // atom plates, layer coords (callout chips avoid covering them)
    let frameNo = 0;                // update counter: per-frame memo of each group's active member
    let lodHidden = false;          // lod-1 chips hidden (selection area hysteresis)
    let curSel = null;              // selection interior, layer coords (callout chips must stay inside)
    let candidates = [];            // radius callout candidates (layer coords)
    const callouts = new Map();     // node id -> callout
    const active = [];              // chips with a running count-up
    let liveEls = 0;
    let rafId = 0;
    let frozen = false, frozenSel = null;
    let lastFrame = null;
    let curDx = 0, curDy = 0, curClip = '';
    let charW = 0;
    let destroyed = false;
    let dprMql = null, ro = null;
    const reducedMql = win.matchMedia ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const reduced = () => !!(reducedMql && reducedMql.matches);

    // ---------------------------------------------------------------- size / dpr
    function readSize() {
      const w = mount.clientWidth || win.innerWidth || 0;
      const h = mount.clientHeight || win.innerHeight || 0;
      return { w, h };
    }

    function buildTiles() {
      const mk = (s) => { const c = doc.createElement('canvas'); c.width = c.height = s; return c; };
      // hatch: 45deg "/" lines, 8 css px horizontal pitch
      const hs = Math.max(2, Math.round(8 * dpr));
      hatchTile = mk(hs);
      let g = hatchTile.getContext('2d');
      g.strokeStyle = T.hatch; g.lineWidth = hs / 8 * 0.85; g.lineCap = 'butt';
      g.beginPath();
      // "/" lines: x + y = k*hs, extended past the tile so the corners stay seamless
      for (let k = 0; k <= 2; k++) { g.moveTo(k * hs + hs, -hs); g.lineTo(-hs, k * hs + hs); }
      g.stroke();
      // graph paper: 16 css px major, 4 css px minor
      const gs = Math.max(4, Math.round(16 * dpr));
      gridTile = mk(gs);
      g = gridTile.getContext('2d');
      const lm = Math.max(1, Math.round(dpr * 0.75));
      const lM = Math.max(1, Math.round(dpr));
      g.fillStyle = T.gridMinor;
      for (let i = 1; i < 4; i++) {
        const p = Math.round(gs * i / 4);
        g.fillRect(p, 0, lm, gs); g.fillRect(0, p, gs, lm);
      }
      g.fillStyle = T.gridMajor;
      g.fillRect(0, 0, lM, gs); g.fillRect(0, 0, gs, lM);
    }

    function sizeCanvas() {
      dpr = win.devicePixelRatio || 1;
      const s = readSize();
      vw = s.w; vh = s.h;
      canvas.width = Math.max(1, Math.round(vw * dpr));
      canvas.height = Math.max(1, Math.round(vh * dpr));
      canvas.style.width = vw + 'px';
      canvas.style.height = vh + 'px';
      ctx = canvas.getContext('2d');
      buildTiles();
      hatchPat = ctx.createPattern(hatchTile, 'repeat');
      gridPat = ctx.createPattern(gridTile, 'repeat');
    }

    function watchDpr() {
      if (!win.matchMedia) return;
      if (dprMql) dprMql.removeEventListener('change', onDprChange);
      dprMql = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
      dprMql.addEventListener('change', onDprChange);
    }
    function onDprChange() {
      if (destroyed) return;
      watchDpr();
      if (!model) return; // setModel re-sizes the (released) canvas
      sizeCanvas();
      drawCanvas();
    }

    sizeCanvas();
    watchDpr();
    if (typeof win.ResizeObserver === 'function') {
      ro = new win.ResizeObserver(() => {
        if (destroyed) return;
        const s = readSize();
        if (s.w === vw && s.h === vh) return;
        if (!model) return; // released canvas; setModel re-sizes it
        sizeCanvas();
        curClip = '';
        drawCanvas();
        if (lastFrame) update(lastFrame);
      });
      ro.observe(mount);
    }

    // ---------------------------------------------------------------- chip metrics
    // Measuring and painting use the same face: `bundled` is sampled once per setModel (syncFont) and drives
    // both the .mk-mm class (painting) and the metrics below. Bundled chips are round(text) + 8 wide
    // (4px sides); system-stack chips keep ceil(text) + 10.
    let bundled = false;
    function syncFont() {
      const want = !!(M.font && M.font.verify());
      if (want === bundled) return;
      bundled = want;
      charW = 0;
      root.classList.toggle('mk-mm', want);
    }
    function measureChar() {
      if (charW) return charW;
      try {
        const c = doc.createElement('canvas').getContext('2d');
        c.font = `700 11px ${bundled ? T.fontMonoBundled : T.fontMono}`;
        charW = c.measureText('0').width;
      } catch (_) { /* ignore */ }
      if (!(charW > 3 && charW < 12)) charW = 6.6;
      return charW;
    }
    const chipWidth = (text) => (bundled ? Math.round(text.length * measureChar() + 8) : Math.ceil(text.length * measureChar()) + 10);

    // ---------------------------------------------------------------- spatial hash
    /** Two chips of different members of one repeated-sibling group are never visible together. */
    function exclusive(a, b) {
      if (!a || !b) return false;
      for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) if (a[i].g === b[j].g && a[i].i !== b[j].i) return true;
      return false;
    }

    function makeHash() {
      const cells = new Map();
      const key = (cx, cy) => (cx + 4096) * 8192 + (cy + 4096);
      return {
        hit(x, y, w, h, tags) {
          const x0 = x - 2, y0 = y - 2, x1 = x + w + 2, y1 = y + h + 2;
          for (let cy = Math.floor(y0 / 64), ey = Math.floor(y1 / 64); cy <= ey; cy++) {
            for (let cx = Math.floor(x0 / 64), ex = Math.floor(x1 / 64); cx <= ex; cx++) {
              const arr = cells.get(key(cx, cy));
              if (!arr) continue;
              for (let i = 0; i < arr.length; i++) {
                const r = arr[i];
                if (x0 < r[0] + r[2] && x1 > r[0] && y0 < r[1] + r[3] && y1 > r[1] && !exclusive(tags, r[4])) return true;
              }
            }
          }
          return false;
        },
        add(x, y, w, h, tags) {
          const r = [x, y, w, h, tags];
          for (let cy = Math.floor(y / 64), ey = Math.floor((y + h) / 64); cy <= ey; cy++) {
            for (let cx = Math.floor(x / 64), ex = Math.floor((x + w) / 64); cx <= ex; cx++) {
              const k = key(cx, cy);
              const arr = cells.get(k);
              if (arr) arr.push(r); else cells.set(k, [r]);
            }
          }
        },
      };
    }

    // ---------------------------------------------------------------- geometry helpers
    function nodeClip(n) {
      if (!n.clip) return null;
      return { x: n.clip.x - model.scrollX, y: n.clip.y - model.scrollY, w: n.clip.w, h: n.clip.h };
    }

    /** Padding sides + gaps of a container as measurable bands, in layer coords. */
    function measuresFor(n) {
      const out = [];
      if (n.kind !== 'container' || n.rotated) return out;
      const sx = model.scrollX, sy = model.scrollY;
      const b = n.box, bx = b.x - sx, by = b.y - sy;
      const bd = n.border || ZERO, p = n.padding || ZERO;
      const cl = nodeClip(n);
      const xlo = cl ? Math.max(0, cl.x) : 0, xhi = cl ? Math.min(vw, cl.x + cl.w) : vw;
      const ylo = cl ? Math.max(0, cl.y) : 0, yhi = cl ? Math.min(vh, cl.y + cl.h) : vh;
      // padding I-beams sit on the centre line of the content box (clamped to the visible part)
      const c = n.content || b, cx = c.x - sx, cy = c.y - sy;
      const mx = midSpan(cx, cx + c.w, xlo, xhi);
      const my = midSpan(cy, cy + c.h, ylo, yhi);
      const sc = n.scale || 1;
      const push = (key, side, vert, v, a, s0, s1) => {
        const label = Math.round(v / sc);
        out.push({ key, side, vert, v, a, s0, s1, label });
      };
      if (p.t >= 0.5) { const y0 = by + bd.t; push('p:t', 't', true, p.t, mx, y0, y0 + p.t); }
      if (p.b >= 0.5) { const y1 = by + b.h - bd.b; push('p:b', 'b', true, p.b, mx, y1 - p.b, y1); }
      if (p.l >= 0.5) { const x0 = bx + bd.l; push('p:l', 'l', false, p.l, my, x0, x0 + p.l); }
      if (p.r >= 0.5) { const x1 = bx + b.w - bd.r; push('p:r', 'r', false, p.r, my, x1 - p.r, x1); }
      const gaps = n.gaps || [];
      for (let i = 0; i < gaps.length; i++) {
        const g = gaps[i], r = g.rect;
        const gx = r.x - sx, gy = r.y - sy;
        if (g.axis === 'y') {
          if (g.value < 0.5) continue;
          push('g:' + i, 'gap', true, g.value, midSpan(gx, gx + r.w, xlo, xhi), gy, gy + r.h);
        } else {
          if (g.value < 0.5) continue;
          push('g:' + i, 'gap', false, g.value, midSpan(gy, gy + r.h, ylo, yhi), gx, gx + r.w);
        }
      }
      return out;
    }

    let msCache = new WeakMap();
    let beamDrops = new Map();      // node id -> Set of measure keys whose outside chip was dropped (no I-beam either)
    function msOf(n) {
      let v = msCache.get(n);
      if (!v) { v = measuresFor(n); msCache.set(n, v); }
      return v;
    }

    // ---------------------------------------------------------------- canvas drawing
    function setPatternOrigin() {
      const sx = model.scrollX, sy = model.scrollY;
      const hk = 8 / hatchTile.width, gk = 16 / gridTile.width;
      hatchPat.setTransform(new DOMMatrix().translate(mod(-sx, 8), mod(-sy, 8)).scale(hk));
      gridPat.setTransform(new DOMMatrix().translate(mod(-sx, 16), mod(-sy, 16)).scale(gk));
    }

    function rr(x, y, w, h, r) {
      ctx.roundRect(x, y, w, h, [r.tl, r.tr, r.br, r.bl]);
    }
    const safeRadius = (n) => {
      const r = n.radius || {};
      return { tl: r.tl > 0 ? r.tl : 0, tr: r.tr > 0 ? r.tr : 0, br: r.br > 0 ? r.br : 0, bl: r.bl > 0 ? r.bl : 0 };
    };
    const NO_RADIUS = { tl: 0, tr: 0, br: 0, bl: 0 };

    function drawBands(rects) {
      ctx.fillStyle = T.bandTint;
      for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = hatchPat;
      for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
    }

    function drawCanvas() {
      if (!model || !ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, vw, vh);
      setPatternOrigin();
      const sx = model.scrollX, sy = model.scrollY;
      const nodes = model.nodes;
      const vis = [];
      // nested.get(id): the node has a visible-box ancestor; boxed.get(id): it or an ancestor has one
      const nested = new Map(), boxed = new Map();

      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i], b = n.box;
        const up = n.parent >= 0 && boxed.get(n.parent) === true;
        nested.set(n.id, up);
        boxed.set(n.id, up || (n.kind !== 'atom' && !!n.hasBox));
        const bx = b.x - sx, by = b.y - sy;
        if (bx > vw || by > vh || bx + b.w < 0 || by + b.h < 0) continue;
        vis.push(n);
      }

      /** Runs fn(n, bx, by, rad) for every visible node, inside the node's own clip. */
      const pass = (fn) => {
        for (const n of vis) {
          const b = n.box, clip = n.clip;
          if (clip) {
            ctx.save();
            ctx.beginPath(); ctx.rect(clip.x - sx, clip.y - sy, clip.w, clip.h); ctx.clip();
          }
          fn(n, b.x - sx, b.y - sy, n.rotated ? NO_RADIUS : safeRadius(n));
          if (clip) ctx.restore();
        }
      };

      // (1) plates, wells, skeleton bars, inline plates
      pass((n, bx, by, rad) => {
        const b = n.box, atom = n.kind === 'atom';
        if (atom || n.hasBox) {
          ctx.fillStyle = atom ? T.atomPlate : nested.get(n.id) ? T.plateLift : T.plate;
          ctx.beginPath(); rr(bx, by, b.w, b.h, rad); ctx.fill();
        }
        if (atom || n.rotated) return;
        const p = n.padding || ZERO, c = n.content;
        if (c && (p.t >= 0.5 || p.r >= 0.5 || p.b >= 0.5 || p.l >= 0.5)) {
          ctx.fillStyle = T.well; ctx.fillRect(c.x - sx, c.y - sy, c.w, c.h);
        }
        const texts = n.texts;
        if (texts && texts.length) {
          ctx.fillStyle = T.skeleton;
          for (const t of texts) {
            const r = t.rect;
            const h = Math.max(2, Math.round((t.fontSize || 14) * 0.58));
            ctx.beginPath();
            ctx.roundRect(r.x - sx, r.y - sy + (r.h - h) / 2, r.w, h, h / 2);
            ctx.fill();
          }
        }
        const ip = n.inlinePlates;
        if (ip && ip.length) {
          ctx.fillStyle = T.skeleton;
          for (const r of ip) {
            ctx.beginPath(); ctx.roundRect(r.x - sx, r.y - sy, r.w, r.h, Math.min(3, r.h / 2, r.w / 2)); ctx.fill();
          }
        }
      });

      // (2) graph paper, once, over the outermost visible boxes only
      ctx.fillStyle = gridPat;
      pass((n, bx, by, rad) => {
        if (n.kind === 'atom' || n.rotated || !n.hasBox || nested.get(n.id)) return;
        const b = n.box;
        ctx.save();
        ctx.beginPath(); rr(bx, by, b.w, b.h, rad); ctx.clip();
        ctx.fillRect(bx, by, b.w, b.h);
        ctx.restore();
      });

      // (3) hatched padding / gap bands and dashed content outlines
      ctx.setLineDash([]);
      pass((n, bx, by, rad) => {
        if (n.kind === 'atom' || n.rotated) return;
        const b = n.box, p = n.padding || ZERO, bd = n.border || ZERO, c = n.content;
        const hasPad = c && (p.t >= 0.5 || p.r >= 0.5 || p.b >= 0.5 || p.l >= 0.5);
        if (hasPad) {
          const cx = c.x - sx, cy = c.y - sy;
          // padding bands (padding box minus content box)
          const px = bx + bd.l, py = by + bd.t, pw = b.w - bd.l - bd.r, ph = b.h - bd.t - bd.b;
          if (pw > 0 && ph > 0) {
            const bmax = Math.max(bd.t, bd.r, bd.b, bd.l);
            const ir = {
              tl: Math.max(0, rad.tl - bmax), tr: Math.max(0, rad.tr - bmax),
              br: Math.max(0, rad.br - bmax), bl: Math.max(0, rad.bl - bmax),
            };
            ctx.save();
            ctx.beginPath(); rr(px, py, pw, ph, ir); ctx.rect(cx, cy, c.w, c.h);
            ctx.clip('evenodd');
            ctx.fillStyle = T.bandTint; ctx.fillRect(px, py, pw, ph);
            ctx.fillStyle = hatchPat; ctx.fillRect(px, py, pw, ph);
            ctx.restore();
          }
        }
        const gaps = n.gaps;
        if (gaps && gaps.length) {
          const rs = [];
          for (const g of gaps) rs.push({ x: g.rect.x - sx, y: g.rect.y - sy, w: g.rect.w, h: g.rect.h });
          drawBands(rs);
        }
        if (hasPad && c.w > 1 && c.h > 1) {
          ctx.strokeStyle = T.dash; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
          ctx.strokeRect(c.x - sx + 0.5, c.y - sy + 0.5, c.w - 1, c.h - 1);
          ctx.setLineDash([]);
        }
      });

      // (4) I-beams on top of every fill. Below 2x DPR the strokes are 1 device px wide and snapped
      // to whole device pixels so they stay crisp; at 2x and up the 1.5px strokes need no snapping.
      const crisp = dpr < 2;
      const lw = crisp ? 1 / dpr : 1.5, h2 = lw / 2;
      ctx.strokeStyle = T.line; ctx.lineWidth = lw; ctx.lineCap = 'butt';
      const edge = crisp ? (v) => Math.floor(v * dpr) / dpr : (v) => v;   // leading edge of the device pixel
      const mid = crisp ? (v) => Math.floor(v * dpr) / dpr + h2 : (v) => v; // its centre line
      pass((n) => {
        const ms = msOf(n);
        if (!ms.length) return;
        const drop = beamDrops.get(n.id);
        ctx.beginPath();
        for (const m of ms) {
          if (drop && drop.has(m.key)) continue;
          const a = mid(m.a), e0 = edge(m.s0), e1 = edge(m.s1);
          const t0 = mid(m.s0), t1 = mid(m.s1);
          const c0 = crisp ? edge(m.a - 3.5) : m.a - 3.5, c1 = crisp ? edge(m.a + 3.5) + lw : m.a + 3.5;
          if (m.vert) {
            ctx.moveTo(a, crisp ? e0 : m.s0); ctx.lineTo(a, crisp ? e1 + lw : m.s1);
            ctx.moveTo(c0, t0); ctx.lineTo(c1, t0);
            ctx.moveTo(c0, t1); ctx.lineTo(c1, t1);
          } else {
            ctx.moveTo(crisp ? e0 : m.s0, a); ctx.lineTo(crisp ? e1 + lw : m.s1, a);
            ctx.moveTo(t0, c0); ctx.lineTo(t0, c1);
            ctx.moveTo(t1, c0); ctx.lineTo(t1, c1);
          }
        }
        ctx.stroke();
      });
    }

    // ---------------------------------------------------------------- chip placement (setModel)
    const fmtDim = (v) => `${v[0]} × ${v[1]}`;
    const fmtNum = (v) => String(v[0]);
    const fmtRad = (v) => `r ${v[0]}`;

    function newChip(key, kind, vals, fmt) {
      const w = chipWidth(fmt(vals));
      return { key, kind, vals, fmt, w, x: 0, y: 0, lod: 0, tags: null, el: null, on: false, anim: false, fading: false, fa: null, t0: 0 };
    }

    function placeFirst(w, pts, tags) {
      for (let i = 0; i < pts.length; i += 2) {
        const x = Math.round(pts[i]), y = Math.round(pts[i + 1]);
        if (!hash.hit(x, y, w, CHIP_H, tags)) { hash.add(x, y, w, CHIP_H, tags); return [x, y]; }
      }
      return null;
    }

    /**
     * Repeated siblings (same parent, label without #id, rounded size and padding, >= 5 members) form a group.
     * Every node of a member's subtree is tagged with (group, member index); returns id -> tag list.
     * Only the group's active member shows chips (see activeOk), so a list of rows reads as one annotated row.
     */
    function computeGroups(nodes) {
      const keyed = new Map();
      const r = (v) => Math.round(v || 0);
      for (const n of nodes) {
        const sz = n.size || n.box, p = n.padding || ZERO;
        const key = `${n.parent}|${String(n.label).replace(/#[^.\[]*/, '')}|${r(sz.w)}x${r(sz.h)}|${r(p.t)},${r(p.r)},${r(p.b)},${r(p.l)}`;
        const g = keyed.get(key);
        if (g) g.push(n); else keyed.set(key, [n]);
      }
      const keep = new Set();
      for (const g of groups) if (g.act >= 0) keep.add(g.members[g.act].id);
      const sx = model.scrollX, sy = model.scrollY;
      const memberOf = new Map();
      groups = [];
      for (const list of keyed.values()) {
        if (list.length < 5) continue;
        const grp = { members: [], act: -1, stamp: -1 };
        list.forEach((n, i) => {
          const b = n.box, x = b.x - sx, y = b.y - sy;
          grp.members.push({ id: n.id, x, y, x1: x + b.w, y1: y + b.h });
          memberOf.set(n.id, { g: grp, i });
          if (keep.has(n.id)) grp.act = i; // the active row survives a rescan
        });
        groups.push(grp);
      }
      const tags = new Map();
      for (const n of nodes) { // parents precede children
        let t = n.parent >= 0 ? tags.get(n.parent) : undefined;
        const mo = memberOf.get(n.id);
        if (mo) t = t ? t.concat([mo]) : [mo];
        if (t) tags.set(n.id, t);
      }
      return tags;
    }

    /** Is every group this tag list belongs to currently showing the tagged member? */
    function activeOk(tags) {
      if (!tags) return true;
      for (let i = 0; i < tags.length; i++) {
        const g = tags[i].g;
        if (g.stamp !== frameNo) { g.stamp = frameNo; pickActive(g); }
        if (g.act !== tags[i].i) return false;
      }
      return true;
    }

    /**
     * Keep the active member while it is fully inside the selection, or while no other member is and a fair share
     * of it is still covered; else pick the first member fully inside, else the first one that mostly fills the
     * selection (wide rows can never be fully inside), else the first one touching it. A cut-off row left over
     * from the start of a drag hops once to the first fully visible row, then stays.
     */
    function pickActive(g) {
      const s = curSel, ms = g.members;
      if (!s) { g.act = -1; return; }
      const sw = s.x1 - s.x0, sh = s.y1 - s.y0;
      const cover = (m) => {
        const ow = Math.min(m.x1, s.x1) - Math.max(m.x, s.x0), oh = Math.min(m.y1, s.y1) - Math.max(m.y, s.y0);
        if (!(ow > 0 && oh > 0)) return 0;
        return (ow / Math.max(1, Math.min(m.x1 - m.x, sw))) * (oh / Math.max(1, Math.min(m.y1 - m.y, sh)));
      };
      const whole = (m) => m.x >= s.x0 && m.x1 <= s.x1 && m.y >= s.y0 && m.y1 <= s.y1;
      if (g.act >= 0) {
        const a = ms[g.act];
        if (whole(a)) return;
        if (cover(a) >= 0.15 && !ms.some((m, i) => i !== g.act && whole(m))) return;
      }
      let first = -1, mostly = -1, act = -1;
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i];
        const cv = cover(m);
        if (cv <= 0) continue;
        if (first < 0) first = i;
        if (whole(m)) { act = i; break; }
        if (mostly < 0 && cv >= 0.5) mostly = i;
      }
      g.act = act >= 0 ? act : mostly >= 0 ? mostly : first;
    }

    function placeChips(tagsOf) {
      hash = makeHash();
      beamDrops = new Map();
      const out = [];
      const sx = model.scrollX, sy = model.scrollY;
      const reg = model.region || { x: -1e5, y: -1e5, w: 2e5, h: 2e5 };
      const rx0 = reg.x - sx, ry0 = reg.y - sy, rx1 = rx0 + reg.w, ry1 = ry0 + reg.h;
      const inReg = (x, y, w) => x < rx1 && x + w > rx0 && y < ry1 && y + CHIP_H > ry0;
      const nodes = model.nodes;
      const byId = new Map();
      for (const n of nodes) byId.set(n.id, n);
      const isAncestor = (a, n) => {
        for (let id = n.parent, guard = 0; id >= 0 && guard < 256; guard++) {
          if (id === a.id) return true;
          const p = byId.get(id);
          if (!p) return false;
          id = p.parent;
        }
        return false;
      };
      /** Would a chip rect land on the box of a node that is neither an ancestor nor a descendant? */
      const hitsNeighbour = (n, x, y, w) => {
        for (const o of nodes) {
          if (o === n) continue;
          const ob = o.box, ox = ob.x - sx, oy = ob.y - sy;
          if (x < ox + ob.w && x + w > ox && y < oy + ob.h && y + CHIP_H > oy && !isAncestor(n, o) && !isAncestor(o, n)) return true;
        }
        return false;
      };

      // (1) dimension chips: atoms smallest-first, then containers largest-first
      const dims = [];
      for (const n of nodes) {
        if (!n.showSize) continue;
        const b = n.box, bx = b.x - sx, by = b.y - sy;
        if (bx > rx1 || by > ry1 || bx + b.w < rx0 || by + b.h < ry0) continue;
        if (n.kind !== 'atom' && b.h > vh && b.w >= 0.9 * vw) continue; // page wrapper
        dims.push(n);
      }
      dims.sort((a, b) => {
        const aa = a.kind === 'atom', ba = b.kind === 'atom';
        if (aa !== ba) return aa ? -1 : 1;
        const d = a.box.w * a.box.h - b.box.w * b.box.h;
        return aa ? d : -d;
      });
      const spNodes = nodes.filter((n) => n.kind === 'container' && !n.rotated);
      spNodes.sort((a, b) => b.depth - a.depth);
      // Chips of group members are placed after everything else: a hidden member's chips must never push out the
      // chips of a node that belongs to no group (its own chips are shown for the active member only).
      for (const grouped of [false, true]) {
        for (const n of dims) {
          if (!!tagsOf.get(n.id) !== grouped) continue;
          const b = n.box, bx = b.x - sx, by = b.y - sy;
          const sz = n.size || { w: b.w / (n.scale || 1), h: b.h / (n.scale || 1) };
          const chip = newChip(`${n.id}:dim:0`, 'dim', [Math.round(sz.w), Math.round(sz.h)], fmtDim);
          chip.tags = tagsOf.get(n.id) || null;
          const w = chip.w, cx = bx + b.w / 2 - w / 2, cy = by + b.h / 2 - CHIP_H / 2;
          let pts;
          if (n.kind === 'atom') {
            const pb = byId.get(n.parent);
            // strictly inside: a chip that only just touches the 4px margin reads as hanging off the row
            const inParent = (x, y) => !pb || (x > pb.box.x - sx - 4 && x + w < pb.box.x - sx + pb.box.w + 4
              && y > pb.box.y - sy - 4 && y + CHIP_H < pb.box.y - sy + pb.box.h + 4);
            pts = [];
            if (inParent(cx, by + b.h + 5)) pts.push(cx, by + b.h + 5);
            if (inParent(bx + b.w + 5, cy)) pts.push(bx + b.w + 5, cy);
            pts.push(cx, cy, cx, by - 5 - CHIP_H, bx - 5 - w, cy);
          } else {
            pts = [cx, by + b.h + 8];
            if (hitsNeighbour(n, cx, by + b.h + 8, w)) pts = [cx, by + b.h - 4 - CHIP_H, bx + b.w - 4 - w, by + 4];
          }
          const pos = placeFirst(w, pts, chip.tags);
          if (!pos || !inReg(pos[0], pos[1], w)) continue;
          chip.x = pos[0]; chip.y = pos[1];
          out.push(chip);
        }

        // (2) spacing chips, deepest nodes first (document order within a depth): an ancestor's padding chip
        // must not take a descendant's natural spot
        for (const n of spNodes) {
          if (!!tagsOf.get(n.id) !== grouped) continue;
          const b = n.box, bx = b.x - sx, by = b.y - sy;
          if (bx > rx1 || by > ry1 || bx + b.w < rx0 || by + b.h < ry0) continue;
          const ms = msOf(n);
          const cl = nodeClip(n);
          for (const m of ms) {
            if (m.label < 1) continue;
            const chip = newChip(`${n.id}:sp:${m.key}`, 'space', [m.label], fmtNum);
            if (m.label < 4) chip.lod = 1;
            chip.tags = tagsOf.get(n.id) || null;
            const w = chip.w, mid = (m.s0 + m.s1) / 2;
            let bxp, byp, slide, still = false;
            if (m.vert) {
              if (m.v >= 14 || m.side === 'gap') { bxp = m.a - w / 2; byp = mid - CHIP_H / 2; } // centred on the I-beam
              else if (m.side === 't') { bxp = m.a - w / 2; byp = by - 4 - CHIP_H; still = true; }
              else if (m.side === 'b') { bxp = m.a - w / 2; byp = by + b.h + 4; still = true; }
              slide = (k) => [bxp + k * (w + 6), byp];
            } else {
              if (m.v >= w + 4) { bxp = mid - w / 2; byp = m.a - CHIP_H / 2; }
              else if (m.side === 'l') { bxp = bx - 4 - w; byp = m.a - CHIP_H / 2; still = true; }
              else if (m.side === 'r') { bxp = bx + b.w + 4; byp = m.a - CHIP_H / 2; still = true; }
              else { bxp = mid - w / 2; byp = m.a + 20 - CHIP_H / 2; }
              slide = (k) => [bxp, byp + k * 22];
            }
            if (cl) { // the I-beam's anchor must be visible; the chip itself may sit outside the clip
              const ax = m.vert ? m.a : mid, ay = m.vert ? mid : m.a;
              if (ax < cl.x || ax > cl.x + cl.w || ay < cl.y || ay > cl.y + cl.h) continue;
            }
            const pts = [];
            // a padding chip outside its box must not slide: 22px from its I-beam it reads as unrelated, so drop it
            for (const k of still ? [0] : [0, 1, -1]) { const a = slide(k); pts.push(a[0], a[1]); }
            const pos = placeFirst(w, pts, chip.tags);
            if (!pos && still) { // dropped for a collision: the I-beam would be left without its number, so it goes too
              let set = beamDrops.get(n.id);
              if (!set) beamDrops.set(n.id, set = new Set());
              set.add(m.key);
            }
            if (!pos || !inReg(pos[0], pos[1], w)) continue;
            chip.x = pos[0]; chip.y = pos[1];
            out.push(chip);
          }
        }
      }
      return out;
    }

    // ---------------------------------------------------------------- chips: DOM + animation
    function setChipText(c, vals) { if (c.el) c.el.firstChild.nodeValue = c.fmt(vals); }

    function startChip(c, now, instant) {
      if (liveEls >= MAX_LIVE_CHIPS) return;
      const el = doc.createElement('div');
      el.className = 'mk-chip';
      el.dataset.kind = c.kind;
      el.style.left = c.x + 'px'; el.style.top = c.y + 'px'; el.style.width = c.w + 'px';
      c.el = el; c.on = true; liveEls++;
      if (reduced()) {
        el.textContent = c.fmt(c.vals);
        world.appendChild(el);
        return;
      }
      el.textContent = c.fmt(instant ? c.vals : c.vals.map(() => 0));
      world.appendChild(el);
      try { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.chipFade, easing: 'linear' }); } catch (_) { /* ignore */ }
      if (instant) return; // big batch: final text now, only the fade
      c.t0 = now; c.anim = true;
      active.push(c);
      ensureLoop();
    }

    function endChip(c) {
      if (c.fa) { try { c.fa.cancel(); } catch (_) { /* ignore */ } c.fa = null; }
      if (c.el) { c.el.remove(); c.el = null; liveEls--; }
      c.on = false; c.anim = false; c.fading = false;
    }

    /** Hide a revealed chip with a short fade; the same element is reused if it is revealed again meanwhile. */
    function fadeChip(c) {
      if (reduced() || !c.el) { endChip(c); return; }
      const el = c.el;
      c.on = false; c.anim = false; c.fading = true;
      try {
        c.fa = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LOD_FADE, easing: 'linear', fill: 'forwards' });
        c.fa.onfinish = () => { if (c.fading && c.el === el) endChip(c); };
      } catch (_) { endChip(c); }
    }

    function unfadeChip(c) {
      if (c.fa) { try { c.fa.cancel(); } catch (_) { /* ignore */ } c.fa = null; }
      c.fading = false; c.on = true;
    }

    function ensureLoop() {
      if (!rafId && !destroyed) rafId = win.requestAnimationFrame(tick);
    }

    function tick(now) {
      rafId = 0;
      if (destroyed) return;
      for (let i = active.length - 1; i >= 0; i--) {
        const c = active[i];
        if (!c.anim || !c.el) { active.splice(i, 1); continue; }
        const p = clamp01((now - c.t0) / DUR.countUp);
        if (p >= 1) { setChipText(c, c.vals); c.anim = false; active.splice(i, 1); continue; }
        const e = 1 - Math.pow(1 - p, 3);
        setChipText(c, c.vals.map((v) => Math.round(v * e)));
      }
      if (active.length) ensureLoop();
    }

    // ---------------------------------------------------------------- radius callouts
    const CORNERS = ['tl', 'tr', 'br', 'bl'];
    let parentOf = new Map();       // node id -> parent id (callout nesting)

    function buildCandidates(tagsOf) {
      const out = [];
      const sx = model.scrollX, sy = model.scrollY;
      for (const n of model.nodes) {
        if (!n.hasBox || n.rotated || !n.radius) continue;
        const b = n.box;
        if (Math.min(b.w, b.h) < 24) continue;
        const r = n.radius;
        // no giant arcs: > 64 px, or a pill-sized radius on a wide element, is not worth a callout
        const lim = Math.min(b.w, b.h) / 2;
        const ok = (v) => v >= 2 && v <= 64 && !(b.w > 120 && v >= lim);
        const rs = [ok(r.tl) ? r.tl : 0, ok(r.tr) ? r.tr : 0, ok(r.br) ? r.br : 0, ok(r.bl) ? r.bl : 0];
        if (!(rs[0] || rs[1] || rs[2] || rs[3])) continue;
        out.push({
          id: n.id, parent: n.parent, atom: n.kind === 'atom', scale: n.scale || 1,
          x: b.x - sx, y: b.y - sy, w: b.w, h: b.h,
          r: rs, clip: nodeClip(n), tags: tagsOf.get(n.id) || null,
        });
      }
      return out;
    }

    /** Geometry of a corner callout: arc path, dot, arc mid point, chip candidates. */
    function cornerGeom(c, ci) {
      const r = c.r[ci], { x, y, w, h } = c;
      let d, dot, dir;
      switch (ci) {
        case 0: d = `M${x},${y + r}A${r},${r} 0 0 1 ${x + r},${y}`; dot = [x + r, y + r]; dir = [-1, -1]; break;
        case 1: d = `M${x + w - r},${y}A${r},${r} 0 0 1 ${x + w},${y + r}`; dot = [x + w - r, y + r]; dir = [1, -1]; break;
        case 2: d = `M${x + w},${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}`; dot = [x + w - r, y + h - r]; dir = [1, 1]; break;
        default: d = `M${x + r},${y + h}A${r},${r} 0 0 1 ${x},${y + h - r}`; dot = [x + r, y + h - r]; dir = [-1, 1]; break;
      }
      const k = r * Math.SQRT1_2;
      return { r, d, dot, mid: [dot[0] + dir[0] * k, dot[1] + dir[1] * k], dir, len: Math.PI * r / 2 };
    }

    /**
     * Where a callout's chip goes: [x, y, inward]. `taken` = rects ({x, y, w}) already given to other callouts in this
     * pass (never their present spots: targets are computed for everybody first, then applied together).
     * `cur` = {x, y, inward} is the chip's present spot while the selection is being dragged (null otherwise): an inward
     * spot is kept while it stays valid, an outward / beside one is upgraded to the first valid inward spot, and is
     * kept while it stays free; only then is the full order tried.
     * mode 'full' = the order above (a lone callout); 'in' = inward spots only (the outer callout of a nested pair, which
     * owns the inward position); 'out' = outward / beside spots only, never inward (the inner callout of a pair).
     */
    function calloutChipSpot(g, w, selfId, selfTags, cur, mode, taken) {
      const [dx, dy] = g.dot, [mx, my] = g.mid, [ux, uy] = g.dir;
      const free = (x, y) => {
        x = Math.round(x); y = Math.round(y);
        if (curSel && (x < curSel.x0 || y < curSel.y0 || x + w > curSel.x1 || y + CHIP_H > curSel.y1)) return false;
        if (hash && hash.hit(x, y, w, CHIP_H, selfTags)) return false;
        for (let i = 0; i < taken.length; i++) {
          const c = taken[i];
          if (x - 2 < c.x + c.w && x + w + 2 > c.x && y - 2 < c.y + CHIP_H && y + CHIP_H + 2 > c.y) return false;
        }
        return true;
      };
      // another callout's chip sits close to this inward spot (nested corners): go to the other side of the arc
      const crowded = (x, y) => {
        for (let i = 0; i < taken.length; i++) {
          const c = taken[i];
          if (x - 14 < c.x + c.w && x + w + 14 > c.x && y - 14 < c.y + CHIP_H && y + CHIP_H + 14 > c.y) return true;
        }
        return false;
      };
      const onAtom = (x, y) => {
        for (let i = 0; i < atomRects.length; i++) {
          const a = atomRects[i];
          if (a.id !== selfId && x < a.x1 && x + w > a.x && y < a.y1 && y + CHIP_H > a.y) return true;
        }
        return false;
      };
      const inward = (x, y) => free(x, y) && !crowded(Math.round(x), Math.round(y)) && !onAtom(Math.round(x), Math.round(y));
      // k = 0 (smallest offset): inward (near corner of the chip 4px diagonally inside the dot), outward
      // (beyond the arc midpoint), then the two spots beside the arc; only then push inward/outward
      // further along the diagonal. Inward spots must not be crowded by another callout or cover an atom.
      const o0 = 4;
      const inK = (k) => { const o = k ? 4 + k * 9 : o0; return [ux > 0 ? dx - o - w : dx + o, uy > 0 ? dy - o - CHIP_H : dy + o]; };
      const outK = (k) => { const o = 4 + k * 9; return [ux > 0 ? mx + o : mx - o - w, uy > 0 ? my + o : my - o - CHIP_H]; };
      if (mode === 'in') {
        if (cur && cur.inward && inward(cur.x, cur.y)) return [cur.x, cur.y, true];
        for (let k = 0; k < 5; k++) { const [x, y] = inK(k); if (inward(x, y)) return [Math.round(x), Math.round(y), true]; }
        return null;
      }
      const beside = [
        [ux > 0 ? mx + o0 : mx - o0 - w, my - CHIP_H / 2],
        [mx - w / 2, uy > 0 ? my + o0 : my - o0 - CHIP_H],
      ];
      if (mode === 'out') {
        const [x0, y0] = outK(0);
        if (free(x0, y0)) return [Math.round(x0), Math.round(y0), false];
        for (const [x, y] of beside) if (free(x, y)) return [Math.round(x), Math.round(y), false];
        for (let k = 1; k < 5; k++) { const [x, y] = outK(k); if (free(x, y)) return [Math.round(x), Math.round(y), false]; }
        return null;
      }
      if (cur) {
        if (cur.inward && inward(cur.x, cur.y)) return [cur.x, cur.y, true];
        for (let k = 0; k < 5; k++) {
          const [x, y] = inK(k);
          if (inward(x, y)) return [Math.round(x), Math.round(y), true];
        }
        if (!cur.inward && free(cur.x, cur.y)) return [cur.x, cur.y, false];
      }
      const spots = [inK(0), outK(0), beside[0], beside[1]];
      for (let i = 0; i < spots.length; i++) {
        const [x, y] = spots[i];
        if (i === 0 ? inward(x, y) : free(x, y)) return [Math.round(x), Math.round(y), i === 0];
      }
      for (let k = 1; k < 5; k++) {
        const [inX, inY] = inK(k);
        if (inward(inX, inY)) return [Math.round(inX), Math.round(inY), true];
        const [outX, outY] = outK(k);
        if (free(outX, outY)) return [Math.round(outX), Math.round(outY), false];
      }
      // nothing clean: accept crowding / atom overlap rather than losing the chip
      for (const [x, y] of spots) if (free(x, y)) return [Math.round(x), Math.round(y), false];
      for (let k = 1; k < 5; k++) {
        const [inX, inY] = inK(k);
        if (free(inX, inY)) return [Math.round(inX), Math.round(inY), true];
      }
      return null;
    }

    function layoutCallout(co, cand) {
      co.cand = cand;
      const g = cornerGeom(cand, co.corner);
      co.geom = g;
      co.path.setAttribute('d', g.d);
      co.path.style.strokeDasharray = String(g.len);
      co.dot.setAttribute('cx', g.dot[0]); co.dot.setAttribute('cy', g.dot[1]);
      co.line.setAttribute('x1', g.dot[0]); co.line.setAttribute('y1', g.dot[1]);
      co.line.setAttribute('x2', g.mid[0]); co.line.setAttribute('y2', g.mid[1]);
    }

    /** Is callout `a` the outer one of the pair (ancestor, else the larger box, else the lower id)? */
    function isOuter(a, b) {
      const anc = (x, y) => {
        for (let id = y.cand.parent, guard = 0; id >= 0 && guard < 256; guard++) {
          if (id === x.id) return true;
          id = parentOf.get(id);
          if (id === undefined) return false;
        }
        return false;
      };
      if (anc(a, b)) return true;
      if (anc(b, a)) return false;
      const aa = a.cand.w * a.cand.h, ba = b.cand.w * b.cand.h;
      return aa !== ba ? aa > ba : a.id < b.id;
    }

    /**
     * Give every callout chip its spot. Callouts at one corner region (same corner, arc centres within 32px) are
     * ordered by nesting: the outer element's callout owns the inward position, the inner element's the outward one,
     * whichever was created first. All targets are computed first (each avoids the others' *targets*, never their
     * present spots), then applied together, so no two live chips can overlap at any frame.
     * live: the selection is being dragged (sticky spots, relocations fade in); false: a rescan (silent re-anchor).
     */
    function placeCalloutChips(now, live) {
      const list = [];
      for (const co of callouts.values()) if (co.geom) list.push(co);
      if (!list.length) return;
      for (const co of list) co.role = 0;                   // 0 lone, 1 outer of a pair, 2 inner of a pair
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (a.corner !== b.corner) continue;
          if (Math.hypot(a.geom.dot[0] - b.geom.dot[0], a.geom.dot[1] - b.geom.dot[1]) > 32) continue;
          const [out, inn] = isOuter(a, b) ? [a, b] : [b, a];
          inn.role = 2;
          if (out.role === 0) out.role = 1;
        }
      }
      const taken = [], target = new Map();
      const run = (co, mode) => {
        const label = Math.round(co.geom.r / co.cand.scale);
        const w = chipWidth(`r ${label}`), cc = co.chip;
        const cur = live && cc ? { x: cc.x, y: cc.y, inward: co.inward } : null;
        const spot = calloutChipSpot(co.geom, w, co.id, co.cand.tags, cur, mode, taken);
        if (!spot) return;
        taken.push({ x: spot[0], y: spot[1], w });
        target.set(co, { spot, w, label });
      };
      for (const co of list) { if (co.role === 0) run(co, 'full'); else if (co.role === 1) run(co, 'in'); }
      for (const co of list) if (co.role === 2) run(co, 'out');
      for (const co of list) if (co.role === 1 && !target.has(co)) run(co, 'full');
      for (const co of list) if (!target.has(co)) run(co, 'full');
      for (const co of list) {
        const t = target.get(co);
        if (!t) { if (co.chip) { endChip(co.chip); co.chip = null; co.fresh = false; } continue; } // no spot yet: a first chip still counts up when it appears
        applyCalloutChip(co, t, now, live);
      }
    }

    /** Create the chip, or relocate it: no glide - it leaves its old spot at once and fades in at the new one. */
    function applyCalloutChip(co, t, now, live) {
      const { spot, w, label } = t;
      co.inward = spot[2];
      if (!co.chip) {
        co.chip = newChip(`${co.id}:radius`, 'radius', [label], fmtRad);
        co.chip.x = spot[0]; co.chip.y = spot[1];
        startChipAt(co.chip, co.fresh && !reduced(), now);
        co.fresh = false;
        return;
      }
      co.fresh = false;
      const c = co.chip;
      if (c.x === spot[0] && c.y === spot[1] && c.w === w) return;
      const moved = c.x !== spot[0] || c.y !== spot[1];
      c.vals = [label]; c.w = w; c.x = spot[0]; c.y = spot[1];
      if (!c.el) return;
      c.el.style.left = c.x + 'px'; c.el.style.top = c.y + 'px'; c.el.style.width = w + 'px';
      if (!c.anim) setChipText(c, c.vals); // a running count-up simply continues; it is never replayed
      if (moved && live && !reduced()) {
        try {
          if (c.rl) c.rl.cancel();
          c.rl = c.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.chipFade, easing: 'linear' });
        } catch (_) { /* ignore */ }
      }
    }

    function startChipAt(c, animate, now) {
      if (animate) { startChip(c, now); return; }
      startChip(c, now);
      if (c.anim) { c.anim = false; setChipText(c, c.vals); }
    }

    function createCallout(cand, ci, now) {
      const g = doc.createElementNS(SVGNS, 'g');
      const path = doc.createElementNS(SVGNS, 'path');
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', T.line);
      path.setAttribute('stroke-width', '1.5'); path.setAttribute('stroke-linecap', 'round');
      const line = doc.createElementNS(SVGNS, 'line');
      line.setAttribute('stroke', T.line); line.setAttribute('stroke-opacity', '0.45');
      line.setAttribute('stroke-width', '1'); line.setAttribute('stroke-dasharray', '2 3');
      const dot = doc.createElementNS(SVGNS, 'circle');
      dot.setAttribute('r', '1.75'); dot.setAttribute('fill', T.line);
      g.append(line, path, dot);
      svg.appendChild(g);
      const co = { id: cand.id, corner: ci, g, path, line, dot, chip: null, geom: null, cand, inward: false, role: 0, fresh: true };
      callouts.set(cand.id, co);
      layoutCallout(co, cand);
      if (!reduced()) {
        try {
          path.animate([{ strokeDashoffset: co.geom.len }, { strokeDashoffset: 0 }], { duration: DUR.arcDraw, easing: EASE_OUT });
          const f = [{ opacity: 0 }, { opacity: 1 }];
          dot.animate(f, { duration: DUR.arcDraw, easing: 'linear' });
          line.animate(f, { duration: DUR.arcDraw, easing: 'linear' });
        } catch (_) { /* ignore */ }
      }
    }

    function removeCallout(co) {
      co.g.remove();
      if (co.chip) { endChip(co.chip); co.chip = null; }
      callouts.delete(co.id);
    }

    function clearCallouts() { for (const co of Array.from(callouts.values())) removeCallout(co); }

    const eligible = [];
    function updateCallouts(x0, y0, x1, y1, px, py, now) {
      eligible.length = 0;
      curSel = { x0, y0, x1, y1 };
      let atoms = 0;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        // quick reject: candidate box doesn't overlap the selection at all
        if (c.x > x1 || c.y > y1 || c.x + c.w < x0 || c.y + c.h < y0) continue;
        if (c.tags && !activeOk(c.tags)) continue; // a repeated sibling other than the active one
        const own = callouts.get(c.id);
        const cur = own ? own.corner : -1;
        let best = -1, bd = Infinity, curD = -1;
        const cl = c.clip;
        for (let ci = 0; ci < 4; ci++) {
          const r = c.r[ci];
          if (!(r >= 2)) continue;
          const cx = ci === 0 || ci === 3 ? c.x : c.x + c.w;
          const cy = ci < 2 ? c.y : c.y + c.h;
          const ax0 = ci === 0 || ci === 3 ? cx : cx - r, ax1 = ax0 + r;
          const ay0 = ci < 2 ? cy : cy - r, ay1 = ay0 + r;
          if (ax0 < x0 || ay0 < y0 || ax1 > x1 || ay1 > y1) continue;
          if (cl && (ax0 < cl.x || ay0 < cl.y || ax1 > cl.x + cl.w || ay1 > cl.y + cl.h)) continue;
          const d = (cx - px) * (cx - px) + (cy - py) * (cy - py);
          if (ci === cur) curD = d;
          if (d < bd) { bd = d; best = ci; }
        }
        if (best < 0) continue;
        // sticky corner: keep the current one unless another is clearly nearer (distance < 0.6 x)
        if (curD >= 0 && best !== cur && !(bd < 0.36 * curD)) { best = cur; bd = curD; }
        if (c.atom) atoms++;
        eligible.push({ c, ci: best, d: bd });
      }
      // atoms get a callout only when no container corner qualifies and at most two atoms do
      let list = eligible;
      if (atoms && (atoms < eligible.length || atoms > 2)) list = eligible.filter((e) => !e.c.atom);
      if (list.length > MAX_CALLOUTS) { list = list.slice().sort((a, b) => a.d - b.d).slice(0, MAX_CALLOUTS); }
      const want = new Map();
      for (const e of list) want.set(e.c.id, e);
      for (const co of Array.from(callouts.values())) {
        const e = want.get(co.id);
        if (!e || e.ci !== co.corner) removeCallout(co);
      }
      for (const e of list) if (!callouts.has(e.c.id)) createCallout(e.c, e.ci, now);
      placeCalloutChips(now, true);
    }

    // ---------------------------------------------------------------- public API
    function setModel(m) {
      if (destroyed) return;
      const prev = chipsByKey;
      model = m;
      syncFont(); // before any chip width is computed; retained chips get their new width/face in the loop below
      if (!ctx || !canvas.width || mount.clientWidth !== vw || mount.clientHeight !== vh) {
        const s = readSize();
        if (s.w !== vw || s.h !== vh || !ctx || !canvas.width) sizeCanvas();
      }
      msCache = new WeakMap();
      const tagsOf = computeGroups(m.nodes);
      atomRects = [];
      for (const n of m.nodes) {
        if (n.kind !== 'atom') continue;
        const b = n.box, x = b.x - m.scrollX, y = b.y - m.scrollY;
        atomRects.push({ id: n.id, x, y, x1: x + b.w, y1: y + b.h });
      }
      const fresh = placeChips(tagsOf);
      // carry revealed state across rescans (same key => same chip, no replay)
      chipsByKey = new Map();
      for (const c of fresh) {
        const old = prev.get(c.key);
        if (old && old.fading) endChip(old); // mid fade-out: let it go, the next update reveals it afresh
        else if (old) {
          c.el = old.el; c.on = old.on; c.anim = old.anim; c.t0 = old.t0;
          prev.delete(c.key);
          if (c.el) {
            if (c.el.style.left !== c.x + 'px') c.el.style.left = c.x + 'px';
            if (c.el.style.top !== c.y + 'px') c.el.style.top = c.y + 'px';
            if (c.el.style.width !== c.w + 'px') c.el.style.width = c.w + 'px';
            if (c.anim) { const i = active.indexOf(old); if (i >= 0) active[i] = c; }
            else setChipText(c, c.vals);
          }
        }
        chipsByKey.set(c.key, c);
      }
      for (const old of prev.values()) endChip(old);
      chips = fresh;
      // radius callouts: keep those whose node survives, re-anchored to the new geometry
      candidates = buildCandidates(tagsOf);
      parentOf = new Map();
      for (const n of m.nodes) parentOf.set(n.id, n.parent);
      const byId = new Map();
      for (const c of candidates) byId.set(c.id, c);
      for (const co of Array.from(callouts.values())) {
        const c = byId.get(co.id);
        if (c && c.r[co.corner] >= 2) layoutCallout(co, c);
        else removeCallout(co);
      }
      placeCalloutChips(performance.now(), false);
      drawCanvas();
      curDx = curDy = NaN; curClip = '';
      if (lastFrame) update(lastFrame);
    }

    function update(frame) {
      if (destroyed) return;
      lastFrame = frame;
      if (!model || !frame || !frame.sel) return;
      const sel = frame.sel;
      const dx = (frame.scrollX || 0) - model.scrollX, dy = (frame.scrollY || 0) - model.scrollY;
      if (dx !== curDx || dy !== curDy) {
        curDx = dx; curDy = dy;
        layer.style.transform = dx || dy ? `translate3d(${-dx}px,${-dy}px,0)` : '';
      }
      // clip to the selection, inside the marquee's 1px border
      const top = Math.max(0, sel.y + 1), left = Math.max(0, sel.x + 1);
      const right = Math.max(0, vw - (sel.x + sel.w - 1)), bottom = Math.max(0, vh - (sel.y + sel.h - 1));
      const clip = `inset(${top}px ${right}px ${bottom}px ${left}px)`;
      if (clip !== curClip) { curClip = clip; root.style.clipPath = clip; }
      if (root.style.visibility !== 'visible') root.style.visibility = 'visible';

      // selection interior in layer coords
      const x0 = sel.x + dx + 1, y0 = sel.y + dy + 1, x1 = sel.x + sel.w + dx - 1, y1 = sel.y + sel.h + dy - 1;
      const now = performance.now();
      frameNo++;
      curSel = { x0, y0, x1, y1 };
      // large selection: tiny spacing chips (lod 1) are noise; hysteresis keeps them from flickering at the edge
      const area = sel.w * sel.h;
      if (area > LOD_HIDE) lodHidden = true; else if (area < LOD_SHOW) lodHidden = false;
      const reveal = [];
      for (let i = 0; i < chips.length; i++) {
        const c = chips[i];
        const geo = c.x < x1 && c.x + c.w > x0 && c.y < y1 && c.y + CHIP_H > y0;
        const inside = geo && !(lodHidden && c.lod) && (!c.tags || activeOk(c.tags));
        if (inside) {
          if (c.fading) unfadeChip(c);
          else if (!c.on) reveal.push(c);
        } else if (c.on) {
          if (geo && lodHidden && c.lod && (!c.tags || activeOk(c.tags))) fadeChip(c); else endChip(c);
        } else if (c.fading && !geo) endChip(c);
      }
      const instant = reveal.length > MAX_COUNTUP_BATCH;
      for (const c of reveal) startChip(c, now, instant);

      if (frozen) {
        const cs = frozenSel;
        if (cs && (Math.abs(cs.x - (sel.x + (frame.scrollX || 0))) > 0.5 || Math.abs(cs.y - (sel.y + (frame.scrollY || 0))) > 0.5
          || Math.abs(cs.w - sel.w) > 0.5 || Math.abs(cs.h - sel.h) > 0.5)) {
          frozen = false; frozenSel = null; // a new selection started without clear()
        }
      }
      if (!frozen) {
        const p = frame.pointer || { x: sel.x + sel.w, y: sel.y + sel.h };
        updateCallouts(x0, y0, x1, y1, p.x + dx, p.y + dy, now);
      }
    }

    function freeze() {
      frozen = true;
      if (lastFrame && lastFrame.sel) {
        const s = lastFrame.sel;
        frozenSel = { x: s.x + (lastFrame.scrollX || 0), y: s.y + (lastFrame.scrollY || 0), w: s.w, h: s.h };
      }
    }

    function clear() {
      model = null; lastFrame = null; frozen = false; frozenSel = null;
      for (const c of chips) endChip(c);
      chips = []; chipsByKey = new Map(); candidates = []; atomRects = []; groups = []; hash = null; lodHidden = false;
      active.length = 0; beamDrops = new Map();
      clearCallouts();
      curSel = null;
      canvas.width = canvas.height = 0; // release the backing store; setModel re-sizes it
      if (rafId) { win.cancelAnimationFrame(rafId); rafId = 0; }
      root.style.visibility = 'hidden';
      layer.style.transform = ''; curDx = curDy = 0; curClip = '';
    }

    function destroy() {
      if (destroyed) return;
      clear();
      destroyed = true;
      if (ro) ro.disconnect();
      if (dprMql) dprMql.removeEventListener('change', onDprChange);
      root.remove(); style.remove();
    }

    return { setModel, update, freeze, clear, destroy };
  }

  M.createBlueprint = createBlueprint;
})();
