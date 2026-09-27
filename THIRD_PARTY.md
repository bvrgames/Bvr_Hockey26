# Third-party code and ideas

## INKWAVE — Jayden Davis, MIT License

Source: https://github.com/jaydendavisnc/inkwave (Copyright (c) 2026 Jayden Davis)

Used in BVR Hockey 26:

| where | what was taken |
|---|---|
| `tools/play.mjs`, `tools/smoke.mjs`, `tools/browser.mjs` | structure of the scripted headless play-through (`until` / `wait` / `eval` / `shot` steps), the smoke-test idea of booting with `?autostart&autopilot` and failing on console / page errors. Rewritten for Playwright (Chromium + WebKit) |
| `index.html` — `TEST` block, `__hk.freeze / unfreeze / step` | URL flags `?autostart` / `?autopilot` and deterministic freeze + fixed-60 Hz stepping for audits; the seeded RNG is mulberry32 as in INKWAVE's `src/core/ctx.js` |

MIT License text:

```
MIT License

Copyright (c) 2026 Jayden Davis

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
