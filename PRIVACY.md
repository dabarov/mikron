# Mikron privacy policy

Effective date: 2026-11-21

Mikron is a Chrome extension that measures the layout of the web page you are looking at. It collects nothing. It does not send any data anywhere, and it contains no analytics, no advertising and no remote code.

## What Mikron reads

When you hold the modifier key (Shift by default) and drag on a page, Mikron reads the layout of that page inside your selection: the position and size of elements, their padding, gaps and corner radii, and a few computed styles such as fonts and colours. It also reads the text of elements to draw text bars and to include short labels in the copied spec. This happens in your browser, on your device, only while you are drawing or have a selection pinned. It is held in memory and discarded when you dismiss the selection, navigate away or close the tab. Mikron does not store it, log it or transmit it.

The popup reads the address of the active tab so it can show the site's name and offer a per-site off switch. That also stays on your device.

## What Mikron stores

Your settings are saved with `chrome.storage.sync`: whether Mikron is on, the sites where it is switched off, the modifier key, whether the hint is shown, snap on or off, and the copy format. They contain no page content. If you have Chrome Sync turned on, Chrome syncs these settings between your devices through your own Google account, under Chrome's own rules. Mikron has no access to that account and runs no server of its own.

## The clipboard

Mikron writes to the clipboard only when you ask it to: when you click **Copy** on a pinned selection, or press Cmd/Ctrl+C while a selection is pinned. The text it copies is the spec of your selection, which includes the page's host name and path and the text and styles of the measured elements. After that it is in your clipboard like anything else you copy, and what you paste it into is up to you. Mikron never reads the clipboard.

## What Mikron does not do

- It makes no network requests. The only thing it loads is its own font file, from inside the extension package.
- It does not collect, sell, share or transfer data to anyone.
- It uses no analytics, telemetry, crash reporting, cookies or advertising.
- It does not download or run code from elsewhere. All of its code is in the extension package and is the code published in the open-source repository.
- It does not track browsing history. It does not keep a list of the sites you visit.

## Permissions

- **Content script on all URLs (top frame only).** Mikron's only job is measuring the page you are on, so it has to be present on every page to respond to Shift + drag without a prior click. It stays idle until you start a gesture. It is not injected into frames inside a page.
- **`storage`.** Saves the settings described above.
- **`activeTab` and `scripting`.** Used only when you open the Mikron popup on a tab that was already open before Mikron was installed or updated. Chrome does not run a new content script in such tabs, so Mikron injects its own bundled script into that one tab so you can use it without reloading the page.

Mikron does not request host permissions beyond the content script above, and it does not request the `clipboardWrite` permission.

On first install Mikron opens a short welcome page that is bundled inside the extension. It loads nothing from the internet.

## Limited Use

The use of information received from Google APIs will adhere to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements. In particular, Mikron uses the information it reads only to provide its single purpose, measuring and describing page layout for you. It does not transfer it to anyone, does not use it for advertising or for credit decisions, and no person reads it.

## Open source

Mikron is open source under the Apache License 2.0. You can read every line of what it does at <https://github.com/dabarov/mikron>.

## Contact

Questions about this policy or about privacy: open an issue at <https://github.com/dabarov/mikron/issues>. To report a security problem privately, use <https://github.com/dabarov/mikron/security/advisories/new>.

## Changes

If this policy changes, the new version will be published at this address with a new effective date, and the change will be listed in `CHANGELOG.md`.
