# Vendored third-party libraries

This folder bundles the following resources locally so that the application
makes no network request (CDN, Google Fonts…) when it loads.

## Icons — Lucide

- **Source:** [lucide-static](https://www.npmjs.com/package/lucide-static) v1.48.0
  (https://lucide.dev), a subset of 95 icons vendored in `js/icons.js`.
- **License:** ISC.

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

Some of the vendored icons (including `check`, `x`, `circle`, `circle-help`,
`chevron-left/right/up/down`, `clock`, `code`, `database`, `download`,
`external-link`, `info`, `lock`, `minus`, `monitor`, `moon`, `plus`, `search`,
`server`, `target`, `arrow-down`, `arrow-right`…) originally come from the
[Feather](https://feathericons.com) project and remain under a dual ISC/MIT
license; the full text, including the exact list and the corresponding MIT
license, is in the `LICENSE` file of the `lucide-static` package.

## Fonts — Geist Variable & Geist Mono Variable

- **Source:** [@fontsource-variable/geist](https://www.npmjs.com/package/@fontsource-variable/geist)
  and [@fontsource-variable/geist-mono](https://www.npmjs.com/package/@fontsource-variable/geist-mono),
  version 5.3.0 (original font: [Geist](https://vercel.com/font), Vercel).
- `latin` and `latin-ext` subsets, variable `wght` axis (100–900), normal style,
  in `fonts/geist-*-wght-normal.woff2` and declared in `css/fonts.css`.
- **License:** SIL Open Font License, Version 1.1. Full text in
  [`fonts/OFL.txt`](fonts/OFL.txt).
