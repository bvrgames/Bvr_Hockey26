# Third-party code and ideas

## INKWAVE — Jayden Davis, MIT License

Source: https://github.com/jaydendavisnc/inkwave (Copyright (c) 2026 Jayden Davis)

Used in BVR Hockey 26:

| where | what was taken |
|---|---|
| `tools/play.mjs`, `tools/smoke.mjs`, `tools/browser.mjs` | structure of the scripted headless play-through (`until` / `wait` / `eval` / `shot` steps), the smoke-test idea of booting with `?autostart&autopilot` and failing on console / page errors. Rewritten for Playwright (Chromium + WebKit) |
| `index.html` — `EV` event bus, `docs/EVENTS.md` | the pattern of a tiny `on` / `emit` bus (`on` returns an unsubscribe function) that gameplay emits into and FX / HUD / audio subscribe to, and documenting every event as a name · payload · emitter table (INKWAVE `src/core/ctx.js`, `docs/EVENTS.md`). Payloads, event set, network relay and statistics are our own |
| `index.html` — ice marks (`MARKS`, `markStroke`, `marksFlush`) | texture-space painting from INKWAVE `src/world/paint.js`: strokes are drawn as quads straight into a render-target texture in one draw call per frame, with the stroke shape evaluated as an SDF in the fragment shader (no CPU readback). Written anew for raw WebGL2; capsule shape, snow grain, wear model are our own |
| `index.html` — `spr`, `sprA` (secondary animation) | copied from INKWAVE `src/game/character.js`: damped spring, semi-implicit Euler with sub-steps, and the exact analytic damped spring (state `S[i]=x`, `S[i+1]=v`). The layering on top of our GLB clips (lean / bank / head lag / stick / dip, applied in model space in `skinPose`) is our own |
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

## Match sounds

Since 11.10.2026 the match sounds are the owner's own files in `assets/src/sfx/<папка>/` (originals, kept as they are).
`tools/prep-sfx.mjs` makes `assets/src/sfx-ready/*.wav` from them (loudness by LUFS, trimmed silence, seamless loops),
`npm run assets` encodes them to `assets/dist/sfx-*.m4a`. The licenses of the new files are on the owner.

Six of them are the earlier CC0 recordings (public domain, no attribution required), kept by the owner in the folders:

| file | source | author | license |
|---|---|---|---|
| `Силовой /hit.wav` | [Hockey - Huge Body Check Hit Into Boards](https://freesound.org/s/161996/) (Freesound 161996), 4.74–5.55 s | producerdan | CC0 |
| `сейв/save.wav` | [Impact Sounds](https://kenney.nl/assets/impact-sounds), `impactPunch_medium_001.ogg` | Kenney (kenney.nl) | CC0 |
| `Рефери/whistle.wav` | [Referee whistle sound.wav](https://freesound.org/s/538422/) (Freesound 538422) | Rosa-Orenes256 | CC0 |
| `Гол/horn.wav` | [Hockey arena goal horn with crowd applause](https://freesound.org/s/702099/) (Freesound 702099), 3.35–7.30 s | SEF7 | CC0 |
| `coin.wav` | [GAMEMisc_Designed, Coin, Pick-Up, Tonal, High Pitched, Digital_15](https://freesound.org/s/830033/) (Freesound 830033), 0–0.7 s | JW_Audio | CC0 |
| `Арена/crowd_loop.wav` | [Rogers Arena - NHL game atmosphere](https://freesound.org/s/706497/) (Freesound 706497), 33.0–43.5 s | SEF7 | CC0 |

Freesound files were taken from the site's HQ mp3 previews (the CC0 license covers the sound, not the file format).
