// The Rate link in the popup and the one-time rating reminder beside the Copy tab.
import { describe, test, launchSub } from '../lib/harness.mjs';
import { makeVariant, removeVariant } from '../lib/variants.mjs';
import { state, ui, pin, copyCenter, overlaps, count, resetProbe, sleep, until } from '../lib/mk.mjs';

const DEMO = '/demo/index.html';
const FULL = [[90, 20], [630, 470]];
const REVIEWS = 'https://chromewebstore.google.com/detail/mikron-measure-css-spacin/ijpekfklopidjlpghniabhgglndlochd/reviews';
const center = (r) => [r.x + r.w / 2, r.y + r.h / 2];

/** Click Copy and wait until the worker has counted it. */
async function copyOnce(t, p, expectCopies) {
  const [x, y] = await copyCenter(p);
  await p.mouse.click(x, y);
  await until(async () => /Copied/.test((await ui(p)).copyText), { msg: 'Copied state', timeout: 1500 });
  if (expectCopies != null) await until(async () => ((await t.readStats()) || {}).copies === expectCopies, { msg: `copy count ${expectCopies}`, timeout: 1500 });
}

describe('rating', () => {
  test('popup: the Rate link points at the store review page and opens in a new tab', async (t) => {
    const pp = await t.env.ctx.newPage();
    t.pages.push(pp);
    await pp.goto(`${t.ext.popupUrl}?host=example.com`);
    const a = await pp.evaluate(() => {
      const el = document.getElementById('rateLink');
      return { href: el.href, target: el.target, rel: el.rel, text: el.textContent.trim() };
    });
    t.eq(a, { href: REVIEWS, target: '_blank', rel: 'noopener noreferrer', text: 'Rate' });
    const order = await pp.evaluate(() => [...document.querySelectorAll('.foot .flink')].map((x) => x.textContent.trim()));
    t.eq(order, ['How it works', 'Say thanks', 'Rate', 'GitHub'], 'footer links');
    const fits = await pp.evaluate(() => {
      const f = document.querySelector('.foot').getBoundingClientRect();
      return [...document.querySelectorAll('.foot .flink')].every((x) => {
        const r = x.getBoundingClientRect();
        return r.left >= f.left - 0.5 && r.right <= f.right + 0.5 && r.height < 24;
      });
    });
    t.ok(fits, 'footer links fit on one line');
  });

  test('popup: using the Rate link spends the reminder', async (t) => {
    await t.stats({ copies: 2, rateAsked: false });
    const pp = await t.env.ctx.newPage();
    t.pages.push(pp);
    await pp.goto(`${t.ext.popupUrl}?host=example.com`);
    // keep the test off the real store: the click is delivered, the navigation is not
    await pp.evaluate(() => document.addEventListener('click', (e) => e.preventDefault(), true));
    await pp.click('#rateLink');
    await until(async () => ((await t.readStats()) || {}).rateAsked === true, { msg: 'rateAsked stored', timeout: 1500 });
    t.eq((await t.readStats()).copies, 2, 'count untouched');
  });

  test('the reminder appears beside the Copy tab on the 5th copy, and only that once', async (t) => {
    await t.stats({ copies: 0, rateAsked: false });
    const p = await t.open(DEMO);
    await pin(p, ...FULL, { pause: 150 });
    for (let i = 1; i <= 4; i++) {
      await copyOnce(t, p, i);
      t.ok(!(await ui(p)).rateShown, `no reminder after copy ${i}`);
    }
    t.eq(await t.readStats(), { copies: 4, rateAsked: false }, 'stats before the 5th copy');
    await copyOnce(t, p, 5);
    await until(async () => (await ui(p)).rateShown, { msg: 'reminder shown', timeout: 1500 });
    await until(async () => ((await t.readStats()) || {}).rateAsked === true, { msg: 'rateAsked stored', timeout: 1500 });
    const u = await ui(p);
    t.eq(u.rateText, 'Useful? Rate Mikron', 'label');
    t.eq(u.rateRect.h, 22, 'same height as the Copy tab');
    t.near(u.rateRect.y, u.copyRect.y, 0.5, 'on the Copy tab row');
    t.near(u.rateRect.x + u.rateRect.w, u.copyRect.x - 6, 1, '6 px left of the Copy tab');
    t.ok(!overlaps(u.rateRect, u.copyRect), 'does not cover the Copy tab');
    t.ok(u.rateRect.x >= 0, 'on screen');
    t.eq(await state(p), 'pinned', 'still pinned');

    // × hides it; the selection stays and the page sees nothing of the click
    await resetProbe(p);
    await p.mouse.click(...center(u.rateXRect));
    await until(async () => !(await ui(p)).rateShown, { msg: 'reminder hidden', timeout: 1000 });
    t.eq(await state(p), 'pinned', 'still pinned after ×');
    for (const ty of ['pointerdown', 'mousedown', 'mouseup', 'click']) t.eq(await count(p, ty, 'c'), 0, `page capture saw no ${ty}`);

    // never again: same selection, and a new one
    await copyOnce(t, p);
    await sleep(250);
    t.ok(!(await ui(p)).rateShown, 'not shown on a later copy');
    await p.keyboard.press('Escape');
    await pin(p, ...FULL, { pause: 150 });
    await copyOnce(t, p);
    await sleep(250);
    t.ok(!(await ui(p)).rateShown, 'not shown on a new selection');
    t.eq(await t.readStats(), { copies: 5, rateAsked: true }, 'counting stops once asked');
  });

  test('clicking the reminder opens the review page in the next tab and hides the reminder', async (t) => {
    // a copy of the extension whose store address is a local page, in its own browser
    const store = t.url('/tests/fixtures/static.html?store');
    const dir = makeVariant({ storeUrl: store });
    const sub = await launchSub(t, dir);
    try {
      const stats = () => sub.ext.sw.evaluate(() => chrome.storage.local.get('mikronStats').then((v) => v.mikronStats || null));
      await sub.ext.sw.evaluate(() => chrome.storage.local.set({ mikronStats: { copies: 4, rateAsked: false } }));
      const p = await sub.open(DEMO);
      await pin(p, ...FULL, { pause: 150 });
      const [x, y] = await copyCenter(p);
      await p.mouse.click(x, y);
      await until(async () => (await ui(p)).rateShown, { msg: 'reminder shown', timeout: 2000 });
      const u = await ui(p);
      const [opened] = await Promise.all([sub.env.ctx.waitForEvent('page', { timeout: 3000 }), p.mouse.click(...center(u.rateGoRect))]);
      t.pages.push(opened);
      await opened.waitForLoadState('domcontentloaded');
      t.eq(opened.url(), store + '/reviews', 'opened tab');
      const order = sub.env.ctx.pages().map((x) => x.url());
      t.eq(order.indexOf(opened.url()), order.indexOf(p.url()) + 1, `opened right after the tab it came from: ${order.join(' | ')}`);
      await p.bringToFront();
      await until(async () => !(await ui(p)).rateShown, { msg: 'reminder hidden', timeout: 1000 });
      t.eq(await state(p), 'pinned', 'selection kept');
      t.eq(await stats(), { copies: 5, rateAsked: true }, 'stats');
    } finally {
      await sub.close();
      removeVariant(dir);
    }
  }, { timeout: 30000 });

  test('the reminder goes away with the selection and with Cmd/Ctrl+C copies it is counted the same', async (t) => {
    await t.stats({ copies: 4, rateAsked: false });
    const p = await t.open(DEMO);
    await pin(p, ...FULL, { pause: 150 });
    await p.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
    await until(async () => (await ui(p)).rateShown, { msg: 'reminder shown after a keyboard copy', timeout: 1500 });
    await p.keyboard.press('Escape');
    await until(async () => {
      const u = await ui(p);
      return !u.rateShown && !u.copyShown;
    }, { msg: 'reminder gone with the selection', timeout: 1500 });
    await pin(p, ...FULL, { pause: 150 });
    t.ok(!(await ui(p)).rateShown, 'a new selection starts without it');
  });

  test('near the left edge the reminder moves to the right of the Copy tab', async (t) => {
    await t.stats({ copies: 4, rateAsked: false });
    const p = await t.open(DEMO);
    await pin(p, [8, 60], [120, 200], { pause: 150 });
    await copyOnce(t, p, 5);
    await until(async () => (await ui(p)).rateShown, { msg: 'reminder shown', timeout: 1500 });
    // the Copy tab changes width as it goes Copied -> Copy; compare once it is back and at rest
    await until(async () => /^Copy$/.test((await ui(p)).copyText), { msg: 'revert to Copy', timeout: 2500 });
    await sleep(260);
    const u = await ui(p);
    t.near(u.rateRect.x, u.copyRect.x + u.copyRect.w + 6, 1, '6 px right of the Copy tab');
    t.ok(!overlaps(u.rateRect, u.copyRect), 'does not cover the Copy tab');
  });
});
