# Third-party code in the task-flow panel

Parts of this folder come from **FluidPlan** (https://github.com/morganhub/fluidplan),
commit `755d1b24ccb09aa8d3663774e0a83d99d24cdc4c`, and have been adapted for the
task-flow panel since:

- `fsutil.mjs` — from `engine/lib/fsutil.mjs`
- `public/js/dom.js`, `icons.js`, `ui.js`, `i18n.js` — from `engine/public/js/`
- `public/css/tokens.css`, `base.css`, `components.css`, `fonts.css` — from `engine/public/css/`
- the local-server protections in `server.mjs` (loopback only, Host and Origin
  checks, body limit, next free port) — after `engine/server.mjs`
- `tests/support/browser.mjs` in this repository (the headless-browser driver
  of the panel smoke test) — from `engine/lib/browser.mjs`

FluidPlan is distributed under the MIT License:

```
MIT License

Copyright (c) 2026 morganhub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The Lucide icons in `public/js/icons.js` (ISC, some also MIT via Feather) and the
Geist and Geist Mono fonts in `public/fonts/` (SIL Open Font License 1.1) keep their
own licenses, reproduced in `public/THIRD_PARTY.md` and `public/fonts/OFL.txt`.
