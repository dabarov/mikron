# Mikron: Chrome Web Store listing

Everything below is ready to paste into the Chrome Web Store dashboard. Character counts are given where a limit applies. The name and summary come from `manifest.json`: edit them there, bump the version and upload a new package, because the dashboard cannot change them.

## Package fields (manifest.json)

### Name (`name`, maximum 75 characters)

`Mikron: Measure CSS Spacing, Padding, Sizes & Radius` (52 characters)

Chosen for search: it leads with the product name and uses the words people type when they look for this kind of tool (measure, CSS, spacing, padding, radius) as one plain phrase rather than a keyword list. Alternatives considered: `Mikron` (6), `Mikron: Measure Spacing, Sizes and Radii on Any Page` (52).

### Short name (`short_name`, maximum 12 characters)

`Mikron` (6 characters)

### Summary (`description`, maximum 132 characters, plain text)

`Measure any web page: hold Shift and drag to see padding, gaps, sizes and corner radius as a live blueprint, then copy the spec.` (128 characters)

The first three words say what it is for, the rest describes the gesture and the result, and nothing in it is a claim that is not literally true.

## Store listing tab

### Detailed description (plain text, no Markdown)

Paste everything between the two lines of dashes. The store shows line breaks as written and does not render Markdown, so the headings are plain capital letters.

```text
---------------- begin ----------------
Mikron shows the real spacing, sizes and corner radii of any web page. Hold Shift, drag a box over an area, and that part of the page is redrawn as a live blueprint with the measurements on it. One click copies them as a spec you can paste into a ticket, a pull request or an AI assistant.

Try it before you install: https://dabarov.github.io/mikron/

HOW TO USE
1. Hold Shift (you can choose Alt, Ctrl or Cmd in the settings). Move the mouse a little and the cursor becomes a crosshair.
2. With the mouse button down, drag over the area you care about. It snaps to 4 px steps and its size is shown as you drag.
3. Release to pin it. Click Copy, or press Cmd/Ctrl+C, to take the numbers with you.
4. Click elsewhere or press Esc to dismiss it.
A box smaller than 8 px is discarded. Scrolling keeps a pinned box attached to the content.

WHAT YOU SEE
- Grey bars: text, one bar per line.
- Grey plates: boxes, and leaf elements such as images, icons and controls.
- Hatched bands: padding, and the gaps between an element's children, each with its value in CSS px.
- Blue chips: the width and height of an element.
- Dark chips: the value measured at that band.
- An arc with "r 8": the corner radius of a box.
- Graph paper: a 4 px and 16 px grid under the outermost boxes.

THE COPIED SPEC
The Copy tab holds a spec of everything inside the box: size, padding, gap, radius, background, and font for text. Identical siblings are collapsed into one entry with a count. The settings offer three formats: Text, JSON, and For AI. For AI is the text spec with text colour and font family added, a one-sentence note above it and a reading key below, so an AI assistant or coding agent can use the numbers without further explanation. Illustrative example of the text format:

Mikron — 240 × 80 selection on example.com/pricing
Inside: div.card

button.btn "Start trial" — 120 × 40 · padding 0 16 · radius 8 · bg rgb(37, 99, 235) · font 14px/20px 500

Padding is listed in CSS order: top, right, bottom, left.

STAYS OUT OF YOUR WAY
Mikron only acts on modifier + drag. Typing, shortcuts, text fields, sliders, maps, code editors, canvas, video, draggable elements and scrollbars are left alone. If a page claims the mouse press for itself, Mikron backs off. A plain Shift+click still extends a text selection as usual. Touch input is ignored. A short default list of canvas-style design and document editors has Mikron switched off.

SETTINGS
Click the toolbar icon to:
- turn Mikron on or off, everywhere or for the current site
- choose the modifier key
- show or hide the hint next to the cursor
- turn the 4 px snap on or off
- choose the copy format: Text, JSON or For AI
A keyboard command (Alt+Shift+M by default, changeable at chrome://extensions/shortcuts) turns Mikron on or off.

PRIVACY
Mikron reads the layout only while you draw a box, and only on your device. It makes no network requests, has no analytics, and sends nothing anywhere. Settings are saved with Chrome's storage and sync through your own Chrome Sync if you have it on. The clipboard is written only when you press Copy. On the fifth spec you copy, a small "Rate Mikron" link appears once beside the Copy tab; it does nothing unless you click it. If you remove Mikron, Chrome opens one static page with the usual fixes and a feedback link; its address carries the version number and nothing else. The full policy is short: https://github.com/dabarov/mikron/blob/main/PRIVACY.md

LIMITS
Mikron works in the top frame; the inside of an iframe is drawn as one box. Canvas and video are one box with a size. Extensions cannot run on browser-internal pages or the web store.

OPEN SOURCE
Mikron is open source under the Apache License 2.0. Code, issues and the test suite: https://github.com/dabarov/mikron

Mikron is free. If it saved you some time and you want to say thanks, there is an optional link: https://ko-fi.com/dabarov
---------------- end ----------------
```

### Category

Developer Tools (under Productivity).

### Language

English.

### Homepage URL

`https://dabarov.github.io/mikron/`

The project page, with the live demo. Until 1.1.0 this field was the repository address.

### Support URL

`https://github.com/dabarov/mikron/issues`

### Privacy policy URL

`https://github.com/dabarov/mikron/blob/main/PRIVACY.md`

### Mature content

Off.

### Screenshot captions (maximum 60 characters each)

The five screenshots in `store/assets/` (1280 × 800, 24-bit PNG without alpha, regenerated by `node tools/make-store-assets.mjs`) carry these captions in their top band, in this order.

1. `Hold Shift and drag: the page turns into a blueprint` (52 characters)
2. `Up close: padding, gaps, sizes and corner radii` (47 characters)
3. `Card grids on light pages, measured in place` (44 characters)
4. `Release to pin, then copy the spec as text` (42 characters)
5. `Settings: modifier key, hint, 4 px snap, copy format` (52 characters)

## Privacy practices tab

### Single purpose description

Mikron measures the page you are looking at. Hold Shift and drag over any area of a web page to see sizes, padding, gaps and corner radii drawn as a live blueprint, and copy them as a spec (text, JSON, or text prepared for an AI assistant).

### Permission justifications

**storage**

Saves the user's settings (on/off, the sites where Mikron is switched off, the modifier key, hint, 4 px snap and copy format) with chrome.storage.sync so they persist and apply in open tabs. Two more values are kept with chrome.storage.local, on the device only: the number of specs the user has copied and whether the one-time rating reminder was shown. They are used only to show that reminder once. No page content is stored and nothing is transmitted.

**activeTab**

Used only when the user opens the Mikron popup on a tab that was already open before the extension was installed or updated. Chrome does not run a new content script in such a tab, so the temporary access granted by the user's click on the toolbar icon lets Mikron start there without a page reload. It is not used for anything else.

**scripting**

Used together with activeTab for the same single case: chrome.scripting.executeScript injects Mikron's own bundled content script files into the one tab where the user opened the popup. It never injects code that is not in the package, and it is never called in the background on other tabs.

**Host access (content script on all URLs, top frame only)**

Mikron's only function is measuring the page the user is on, with a Shift + drag gesture that has to work on any site without a prior click. The content script is declared for all URLs, in the top frame only, so the gesture is available everywhere. It stays idle until the user holds the modifier key and drags. Then it reads layout and computed styles of the elements inside the selection, locally, to draw the overlay. Nothing is transmitted. There are no separate host_permissions.

### Remote code

Select: No, I am not using remote code. All code is in the package. There is no eval, no remotely hosted script and no WebAssembly. The only fetch call reads the extension's own bundled font file. chrome.runtime.setUninstallURL points at a static page of the project site (https://dabarov.github.io/mikron/uninstalled/?v=<version>); the extension loads nothing from it.

### Data usage

Tick none of the data-collection boxes. Mikron does not collect or transmit any user data. The copy count for the rating reminder never leaves the device, and the address of the page opened after an uninstall carries only the extension version. It reads page layout locally while the user draws a selection, keeps it in memory only, and discards it. Settings contain no personal data and stay in the user's own chrome.storage.sync. If a reviewer asks about "website content": the layout is read and used on the device only, never stored or sent, and PRIVACY.md says so.

Tick all three certifications:

1. I do not sell or transfer user data to third parties, outside of the approved use cases.
2. I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
3. I do not use or transfer user data to determine creditworthiness or for lending purposes.

All three are true because no data leaves the device.

### Trader or non-trader declaration

The owner decides this. Mikron is free, has no paid features and no ads, and the only money-related element is an optional "say thanks" link to a tip page. Google says each publisher must make its own determination, and its documents do not say whether a tip link counts. If you declare non-trader, EU consumers are told consumer-protection rights do not apply to contracts with you. If you declare trader, your name, address and phone number are shown publicly on the listing.

## Test instructions for the reviewer

No account, login or setup is needed. To see Mikron work in about 20 seconds:

1. Open any ordinary web page with some content, such as a news article, a documentation page or a product page (http or https; Chrome does not allow extensions on chrome:// pages or the Web Store).
2. Hold the Shift key for a moment and move the mouse a little. The cursor becomes a crosshair and a small "Shift + drag" hint follows it.
3. Press the mouse button and drag over a button, card or paragraph, then release. The area is redrawn as a blueprint: text as bars, padding as hatched bands with numbers, a blue W × H chip on boxes, and a radius callout on rounded corners.
4. Click Copy on the pinned selection (or press Cmd/Ctrl+C) and paste into any text field to see the spec.
5. Press Esc, or click elsewhere, to dismiss it.
6. Click the toolbar icon to open the popup: it has the on/off switch, a per-site switch, the modifier key, hint, 4 px snap and copy format (Text, JSON, For AI). Alt+Shift+M turns Mikron on or off. On the fifth copied spec a small "Useful? Rate Mikron" link appears once beside the Copy tab; it opens the store review page only if clicked.
7. If the page was open before the extension was installed, open the popup on that tab first (this uses activeTab and scripting), or reload the page.

Mikron makes no network requests. You can confirm that in the extension's service worker DevTools (chrome://extensions, "Inspect views") or by reading the source.

## YouTube promo video

### Title (maximum 70 characters)

`Mikron: measure CSS spacing, padding, sizes and radius on any web page` (70 characters)

### Description

```text
Measure any web page: hold Shift and drag to see padding, gaps, sizes and corner radius as a live blueprint, then copy the spec.
Get Mikron: {{STORE_URL}} | Source code: https://github.com/dabarov/mikron

What you see in the video:
- Hold Shift, drag, release: the selection is pinned
- Padding and gaps as hatched bands with values in CSS px
- Width and height chips, and corner radius callouts
- Copy the spec as text or JSON and paste it into a ticket

Mikron is free and open source (Apache License 2.0). It makes no network requests and collects no data. Privacy policy: https://github.com/dabarov/mikron/blob/main/PRIVACY.md

If it helps and you want to say thanks: https://ko-fi.com/dabarov

All music and sound in this video is original, generated or licence-free. The page shown is a fictional demo page.
```

### Tags

mikron, chrome extension, measure web page, page measurement, css spacing, padding and margin, border radius, front end development, web design, developer tools, design handoff, pixel perfect

### Settings

- Category: Science & Technology
- Audience: No, it's not made for kids
- Visibility: Public (embedding of Unlisted videos is not documented)
- Licence: Standard YouTube Licence
- Music: use only original, generated or licence-free audio. If any track needs attribution, add the credit to the description.

## GitHub repository "About"

### Description (maximum 120 characters)

`Chrome extension: Shift-drag over any page to measure CSS spacing, padding, sizes and radius, then copy the spec.` (113 characters)

### Website

`https://dabarov.github.io/mikron/` (the project page links to the store listing and has the live demo).

### Topics (12, lowercase, hyphenated)

`chrome-extension`, `manifest-v3`, `web-development`, `frontend`, `css`, `design-tools`, `developer-tools`, `measurement`, `spacing`, `pixel-perfect`, `javascript`, `open-source`
