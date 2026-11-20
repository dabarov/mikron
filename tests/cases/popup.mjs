// Toolbar popup: footer links, "How it works", typography, and the states of the real popup.
import { describe, test, launchSub } from '../lib/harness.mjs';
import { makeVariant, removeVariant } from '../lib/variants.mjs';
import { openRealPopup } from '../lib/realpopup.mjs';
import { sleep } from '../lib/mk.mjs';

const G = '/tests/fixtures/gesture.html';

async function popup(t, host = 'example.com') {
  const p = await t.open(`${t.ext.popupUrl}?host=${host}`, { raw: true });
  await p.waitForFunction(() => document.getElementById('enabled') && document.querySelector('#modifier button[aria-checked="true"]'));
  return p;
}

describe('popup', () => {
  test('footer: Say thanks (inline SVG heart, no emoji) and GitHub link out in a new tab; nothing else nags', async (t) => {
    const pp = await popup(t);
    const links = await pp.evaluate(() =>
      [...document.querySelectorAll('.foot a')].map((a) => ({ text: a.textContent.trim(), href: a.href, target: a.target, rel: a.rel, svg: !!a.querySelector('svg'), link: a.dataset.link || null })),
    );
    const thanks = links.find((l) => l.link === 'donate');
    const gh = links.find((l) => l.link === 'repo');
    t.eq([thanks.text, thanks.href, thanks.target, thanks.rel, thanks.svg], ['Say thanks', 'https://ko-fi.com/dabarov', '_blank', 'noopener noreferrer', true], 'Say thanks');
    t.eq([gh.text, gh.href, gh.target, gh.rel], ['GitHub', 'https://github.com/dabarov/mikron', '_blank', 'noopener noreferrer'], 'GitHub');
    t.ok(!/\p{Extended_Pictographic}/u.test(thanks.text) && !/[♥❤♡❤]/.test(thanks.text), 'no emoji or heart character in the text');
    t.eq(await pp.evaluate(() => document.querySelectorAll('.foot img, .foot iframe, [class*=badge], [role=dialog], dialog').length), 0, 'no badge / dialog / embed');
    // the on-page overlay has no donation link: the donate URL appears in no content script
    const leaked = await t.env.control.evaluate(async () => {
      const files = chrome.runtime.getManifest().content_scripts[0].js;
      const src = await Promise.all(files.map((f) => fetch(chrome.runtime.getURL(f)).then((r) => r.text())));
      return src.some((s) => /ko-fi|MikronLinks/.test(s));
    });
    t.eq(leaked, false, 'content scripts know nothing about donation links');
  });

  test('"Say thanks" opens the Ko-fi page in a new tab on click (and not before)', async (t) => {
    await t.env.ctx.route('https://ko-fi.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }));
    try {
      const pp = await popup(t);
      const before = t.env.ctx.pages().length;
      await sleep(300);
      t.eq(t.env.ctx.pages().length, before, 'nothing opened by itself');
      const [np] = await Promise.all([t.env.ctx.waitForEvent('page'), pp.click('.foot a[data-link="donate"]')]);
      t.pages.push(np);
      await np.waitForLoadState('domcontentloaded').catch(() => {});
      t.eq(np.url(), 'https://ko-fi.com/dabarov', 'opened URL');
    } finally {
      await t.env.ctx.unroute('https://ko-fi.com/**');
    }
  });

  test('"How it works" opens the welcome page in a new tab', async (t) => {
    const pp = await popup(t);
    const [np] = await Promise.all([t.env.ctx.waitForEvent('page'), pp.click('#howLink')]);
    t.pages.push(np);
    await np.waitForLoadState('domcontentloaded');
    t.eq(np.url(), t.ext.welcomeUrl, 'welcome URL');
    t.eq(await np.title(), 'Mikron', 'title');
  });

  test('typography: .mono text is regular weight on the system mono stack; only illustration chips use the bundled face', async (t) => {
    const pp = await popup(t, 'a-long-subdomain.example.com');
    const r = await pp.evaluate(() => {
      const info = (el) => {
        const cs = getComputedStyle(el);
        return { text: el.textContent.trim(), weight: cs.fontWeight, family: cs.fontFamily };
      };
      return {
        mono: [...document.querySelectorAll('.mono')].map(info),
        chips: [...document.querySelectorAll('.art .chip')].map(info),
        bundled: document.fonts.check('700 11px "Mikron Mono"'),
      };
    });
    t.ok(r.mono.length >= 2, `found .mono elements: ${r.mono.map((m) => m.text)}`);
    for (const m of r.mono) {
      t.eq(m.weight, '400', `weight of "${m.text}"`);
      t.ok(!/Mikron Mono/.test(m.family), `"${m.text}" must not use the bundled face (${m.family})`);
    }
    t.ok(r.mono.some((m) => m.text === 'a-long-subdomain.example.com') && r.mono.some((m) => m.text === '4px'), 'hostname and 4px are among them');
    t.eq(r.chips.length, 3, 'illustration chips');
    for (const c of r.chips) {
      t.eq(c.weight, '700', 'chip weight');
      t.ok(/^"?Mikron Mono"?,/.test(c.family), `chip family ${c.family}`);
    }
    t.eq(r.bundled, true, 'bundled face is available to the popup');
  });

  describe('real popup (chrome.action.openPopup; host access stands in for the activeTab grant of a real click)', () => {
    async function withPopup(t, visit, body, variant = { hostGrant: true }) {
      const dir = makeVariant(variant);
      const sub = await launchSub(t, dir);
      try {
        const p = await sub.env.ctx.newPage();
        sub.pages.push(p);
        await visit(sub, p);
        const pop = await openRealPopup(sub, p);
        try {
          await body(pop, sub);
        } finally {
          await pop.close();
        }
      } finally {
        await sub.close();
        removeVariant(dir);
      }
    }

    test('on a normal page: per-site switch shows the host, no blocked message', async (t) => {
      await withPopup(t, (sub, p) => p.goto(sub.url(G)), async (pop) => {
        t.eq(await pop.eval(`document.getElementById('siteGroup').hidden`), false, 'site group visible');
        t.eq(await pop.eval(`document.getElementById('host').textContent`), 'localhost', 'host');
        t.eq(await pop.eval(`document.getElementById('status').textContent`), 'Measure anything on the page', 'status');
      });
    });

    for (const [name, url] of [
      ['a browser page (chrome://version)', () => 'chrome://version'],
      ['a blank tab (about:blank)', () => 'about:blank'],
    ]) {
      test(`on ${name}: calm one-line state, per-site switch hidden, the rest still works`, async (t) => {
        await withPopup(t, (sub, p) => p.goto(url()), async (pop) => {
          t.eq(await pop.eval(`document.getElementById('status').textContent`), "Mikron can't run on this page", 'status line');
          t.eq(await pop.eval(`document.getElementById('siteGroup').hidden`), true, 'site group hidden');
          t.eq(await pop.eval(`document.getElementById('pop').classList.contains('is-blocked')`), true, 'blocked class');
          t.eq(await pop.eval(`!!document.querySelector('#modifier button') && !!document.getElementById('enabled') && !!document.querySelector('.foot a[data-link=donate]')`), true, 'settings and footer still there');
          t.eq(await pop.eval(`document.getElementById('status').getClientRects().length`), 1, 'one line');
        });
      });
    }

    test('a Chrome error page (a failed navigation): the same calm state', async (t) => {
      await withPopup(t, (sub, p) => p.goto('http://127.0.0.1:1/', { timeout: 5000 }).catch(() => {}), async (pop) => {
        t.eq(await pop.eval(`document.getElementById('status').textContent`), "Mikron can't run on this page", 'status line');
        t.eq(await pop.eval(`document.getElementById('siteGroup').hidden`), true, 'site group hidden');
      });
    });

    test('an http page the popup is not allowed to script (no access granted): injection is refused, calm state', async (t) => {
      await withPopup(
        t,
        (sub, p) => p.goto(sub.url(G)),
        async (pop) => {
          t.eq(await pop.eval(`document.getElementById('status').textContent`), "Mikron can't run on this page", 'status line');
          t.eq(await pop.eval(`document.getElementById('siteGroup').hidden`), true, 'site group hidden');
        },
        { autoInject: false, hostGrant: false },
      );
    });
  });
});
