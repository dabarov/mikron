# Changelog

All notable changes to Mikron are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-21

First public release.

### Added

- Hold Shift (or Alt, Ctrl or Cmd) and drag on any web page to draw a marquee. Inside it the page is drawn as a live blueprint.
- Text is drawn as skeleton bars, one per line. Visible boxes and leaf elements such as images and controls are drawn as plates.
- Padding and the gaps between an element's children are drawn as hatched bands with the measured value in CSS px.
- Boxes get a `W × H` chip. Rounded corners get an arc and a radius callout.
- A 4 px / 16 px grid is drawn under the outermost visible boxes.
- Selections snap to 4 px steps (can be turned off).
- Release to pin the selection. Click elsewhere or press Esc to dismiss it. A pinned selection follows the content when the page scrolls.
- A Copy tab on the pinned selection copies a spec of everything measured, as text or JSON. Cmd/Ctrl+C copies it too, unless text is selected on the page or an editable field has focus.
- A toolbar popup with settings: on/off, an on/off switch for the current site, the modifier key, the cursor hint, 4 px snap, and copy format. Settings are saved with `chrome.storage.sync` and apply immediately in open tabs.
- A keyboard command, Alt+Shift+M by default, that turns Mikron on or off. The toolbar badge shows `OFF` while it is off.
- A short default list of sites where Mikron is off, covering canvas-style design and document editors. The list can be edited by switching the site on in the popup.
- Stays out of the way: it ignores typing, text fields, sliders, maps, code editors, canvas, video, audio, draggable elements and scrollbars. It backs off when the page claims the press, and it does nothing for touch input or non-primary buttons.
- Works in open and, for custom elements, closed shadow roots, and across zoom levels, device pixel ratios and right-to-left pages.
- Content script runs in the top frame of every page and works under any page Content Security Policy.
- Chip text uses a bundled copy of Geist Mono Bold (SIL Open Font License 1.1).
- No network requests, no analytics, no remote code.

[Unreleased]: https://github.com/dabarov/mikron/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/dabarov/mikron/releases/tag/v1.0.0
