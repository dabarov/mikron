# Contributing to Mikron

Thanks for wanting to help. Mikron is a small extension with a narrow purpose: measure what is on the page you are looking at. Bug reports, fixes, tests and well-scoped improvements are welcome.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). By contributing code you agree that it is licensed under the [Apache License 2.0](LICENSE), the same as the rest of the project.

## Reporting a bug

Open an issue with the **Bug report** form. The most useful reports include a public page where the problem happens (or the smallest HTML and CSS that shows it), your Chrome version (from `chrome://version`), your operating system, the steps you took, what you expected and what happened. A screenshot helps. Please check that nothing private is visible in it.

For security problems, do not open a public issue. See [SECURITY.md](SECURITY.md).

## Suggesting a change

Open an issue with the **Feature request** form before writing a lot of code, so we can agree on the shape of it. Mikron will stay free of network requests, analytics and remote code, and new permissions need a strong reason.

## Load the extension unpacked

There is no build step.

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension/` folder.
3. After editing a file, click the reload button on Mikron's card, then reload the page you are testing on.

Content scripts do not run on `file://` pages unless you allow it for the extension, so serve the repository to try the demo pages:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/demo/index.html` (a dark card) or `http://localhost:8000/demo/light.html` (a light page with a card grid).

## Run the tests

The tests need Node.js and use Playwright with its own Chromium. Install once:

```
npm install
npx playwright install chromium
```

Run the whole suite (it takes a few minutes; it launches Chromium with the unpacked extension and serves the pages in `tests/fixtures/` and `demo/` from a local server):

```
npm test
```

Pass a part of a test name to run a subset:

```
node tests/run.mjs arming
```

The project website is in `site/`. `npm run site` builds it into `dist/site/`; its live demo is generated from `extension/`, so a change to the content scripts changes the demo too, and `tests/cases/site.mjs` covers it.

Tests live in `tests/cases/`, one file per area, registered with `test(name, fn)` and `describe(name, body)` from `tests/lib/harness.mjs`. Fixture pages are in `tests/fixtures/`. The `hygiene` file must stay last because its final case reloads the extension. A bug fix should come with a test that fails without it. If a change needs a new fixture page, add it to `tests/fixtures/`.

## Code conventions

These are the conventions the code already follows. Please match them.

- Plain JavaScript, no build step, no bundler, no TypeScript, no runtime dependencies. The only dev dependency is Playwright.
- Scripts are classic scripts, not ES modules. Each content script is an immediately invoked function with `'use strict'`. Content scripts share state through the `globalThis.__MIKRON__` namespace, and settings through `globalThis.MikronSettings`. The order of the files is set in `extension/manifest.json`.
- Two-space indentation, single quotes, semicolons, `const` and `let` (never `var`), arrow functions for callbacks.
- A short block comment at the top of each file says what it is for. Comments explain why, not what.
- The extension must never throw into the page. Calls into `chrome.*` and into page DOM that can fail (an orphaned content script, a closed shadow root, a missing API) are wrapped in `try`/`catch` and fall back quietly.
- Mikron must stay out of the page's way: do not add listeners or styles that act before the user starts a gesture, and clean up everything on dismiss and on teardown. The overlay lives in a shadow root on the `mikron-root` element and is excluded from scans.
- No network requests, no `eval`, no remotely hosted code, no analytics. The extension must work under any page Content Security Policy.
- Measurements are in CSS px, with transforms and zoom divided out.
- Keep permissions minimal. Anything that adds a permission or host access must be explained in the pull request, and `PRIVACY.md` and the store text must be updated in the same change.
- Keep the README and `CHANGELOG.md` in step with user-visible changes.

## Pull requests

1. Fork the repository and create a branch.
2. Make a focused change and add or update tests.
3. Run `npm test`, and try the change by hand in the unpacked extension.
4. Add a line under "Unreleased" in `CHANGELOG.md` for anything a user would notice.
5. Open a pull request and fill in the template. Describe what changed and why.

Small, single-purpose pull requests are reviewed faster than large ones.
