// The neutral demo card: fictional products, abstract glyphs, and the exact measurements the recordings and
// screenshots rely on.
import { describe, test } from '../lib/harness.mjs';

describe('demo page', () => {
  test('demo/index.html: fictional rows and exact geometry (viewport 718 × 479)', async (t) => {
    const p = await t.open('/demo/index.html');
    const m = await p.evaluate(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
      const cs = (el) => getComputedStyle(el);
      const card = document.getElementById('card');
      const head = card.querySelector('.card-head');
      const titles = card.querySelector('.titles');
      const list = card.querySelector('.list');
      const rows = [...list.querySelectorAll('.row')];
      return {
        card: r(card), cardPad: cs(card).padding, cardRadius: cs(card).borderRadius,
        headPad: cs(head).padding, titlesGap: cs(titles).rowGap,
        titleToSub: titles.querySelector('p').getBoundingClientRect().top - titles.querySelector('h2').getBoundingClientRect().bottom,
        headToList: list.getBoundingClientRect().top - head.getBoundingClientRect().bottom,
        listRadius: cs(list).borderRadius,
        rows: rows.map((row) => ({
          pad: cs(row).padding, gap: cs(row).columnGap,
          status: r(row.querySelector('.status')), statusClass: row.querySelector('.status').className,
          icon: r(row.querySelector('.icon')), iconRadius: cs(row.querySelector('.icon')).borderRadius,
          name: row.querySelector('.name').textContent, state: row.querySelector('.state').textContent, stateClass: row.querySelector('.state').className,
          btn: r(row.querySelector('.btn')), btnText: row.querySelector('.btn').textContent,
          svgKids: [...row.querySelectorAll('.icon svg *')].map((e) => e.localName),
        })),
        images: document.querySelectorAll('img, image, use, foreignObject').length,
        text: document.body.innerText,
      };
    });
    t.eq(m.card, [119, 44, 480, 391], 'card x, y, w, h');
    t.eq([m.cardPad, m.cardRadius], ['8px', '20px'], 'card padding, radius');
    t.eq(m.headPad, '16px 16px 0px', 'header padding');
    t.eq([m.titlesGap, m.titleToSub], ['4px', 4], 'title/subtitle gap');
    t.eq(m.headToList, 20, 'header to list');
    t.eq(m.listRadius, '12px', 'list radius');
    t.eq(m.rows.map((x) => [x.name, x.state, x.btnText]), [['Atlas', 'Connected', 'Disconnect'], ['Relay', 'Connection lost', 'Reconnect'], ['Ledger', 'Not connected', 'Connect'], ['Courier', 'Not connected', 'Connect']], 'rows');
    t.eq(m.rows.map((x) => x.stateClass), ['state', 'state bad', 'state', 'state'], 'state classes');
    t.eq(m.rows.map((x) => x.statusClass), ['status ok', 'status bad', 'status', 'status'], 'status bar classes');
    for (const [i, x] of m.rows.entries()) {
      t.eq([x.pad, x.gap], ['16px', '12px'], `row ${i} padding, gap`);
      t.eq(x.status.slice(2), [3, 40], `row ${i} status bar`);
      t.eq([x.icon.slice(2), x.iconRadius], [[40, 40], '10px'], `row ${i} icon tile`);
      t.eq(x.btn.slice(2), [97, 32], `row ${i} button`);
      t.ok(x.svgKids.length && x.svgKids.every((k) => ['circle', 'rect', 'path'].includes(k)), `row ${i} icon is plain geometry: ${x.svgKids}`);
    }
    t.eq(m.images, 0, 'no raster images, <use> or foreignObject');
    t.ok(!/figma|linear|notion|gmail|google|slack/i.test(m.text), 'no third-party product names on the page');
  });
});
