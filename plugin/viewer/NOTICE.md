# Third-party code in the task-flow viewer

Parts of this folder come from **FluidPlan** (https://github.com/morganhub/fluidplan),
commit `755d1b24ccb09aa8d3663774e0a83d99d24cdc4c`, by way of the task-flow panel
this viewer replaced (see the project's HISTORY.md):

- `js/dom.js`, `icons.js`, `ui.js`, `i18n.js` — from `engine/public/js/`
- `css/tokens.css`, `base.css`, `components.css`, `fonts.css` — from `engine/public/css/`

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

The Lucide icons in `js/icons.js` (ISC, some also MIT via Feather) and the
Geist and Geist Mono fonts in `fonts/` (SIL Open Font License 1.1) keep their
own licenses, reproduced in `THIRD_PARTY.md` and `fonts/OFL.txt`.
