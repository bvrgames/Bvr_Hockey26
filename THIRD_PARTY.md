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

## Match sounds — CC0 (public domain), no attribution required

The match sounds are cut from the recordings below by `tools/prep-sfx.mjs` (cut points, trim, loudness, crossfade
loop) into `assets/src/sfx/*.wav`, then encoded by `npm run assets` to `assets/dist/sfx-*.m4a`. All sources are
released under **Creative Commons Zero 1.0** (https://creativecommons.org/publicdomain/zero/1.0/) — free to use,
modify and ship commercially without credit. The authors are listed here anyway, as thanks.

| sound | file | source | author | license |
|---|---|---|---|---|
| stick — stick on the puck (pass, pickup, poke) | `stick.wav` | [Ice Hockey Practice round](https://freesound.org/s/416981/) (Freesound 416981), 15.16–15.30 s | simonlabelle | CC0 |
| shot_wrist — wrist shot | `shot_wrist.wav` | [Ice Hockey Practice round](https://freesound.org/s/416981/) (Freesound 416981), 87.67–88.05 s | simonlabelle | CC0 |
| shot_slap — slap shot | `shot_slap.wav` | [Ice Hockey Practice round](https://freesound.org/s/416981/) (Freesound 416981), 209.01–209.52 s | simonlabelle | CC0 |
| hit — body check into the boards | `hit.wav` | [Hockey - Huge Body Check Hit Into Boards](https://freesound.org/s/161996/) (Freesound 161996), 4.74–5.55 s | producerdan | CC0 |
| save — puck into the goalie's pad | `save.wav` | [Impact Sounds](https://kenney.nl/assets/impact-sounds), `impactPunch_medium_001.ogg` | Kenney (kenney.nl) | CC0 |
| post — puck off the post | `post.wav` | [Impact Sounds](https://kenney.nl/assets/impact-sounds), `impactMetal_light_003.ogg` | Kenney (kenney.nl) | CC0 |
| whistle — referee's whistle | `whistle.wav` | [Referee whistle sound.wav](https://freesound.org/s/538422/) (Freesound 538422) | Rosa-Orenes256 | CC0 |
| horn — arena goal horn | `horn.wav` | [Hockey arena goal horn with crowd applause](https://freesound.org/s/702099/) (Freesound 702099), 3.35–7.30 s | SEF7 | CC0 |
| coin — coin chime | `coin.wav` | [GAMEMisc_Designed, Coin, Pick-Up, Tonal, High Pitched, Digital_15](https://freesound.org/s/830033/) (Freesound 830033), 0–0.7 s | JW_Audio | CC0 |
| ui — menu click | `ui.wav` | [UI Audio](https://kenney.nl/assets/ui-audio), `click5.ogg` | Kenney (kenney.nl) | CC0 |
| swap — player switch whoosh | `swap.wav` | [Swishes Sound Pack](https://opengameart.org/content/swishes-sound-pack), `swish-11.wav` | artisticdude (OpenGameArt) | CC0 |
| crowd_loop — arena crowd, seamless loop | `crowd_loop.wav` | [Rogers Arena - NHL game atmosphere](https://freesound.org/s/706497/) (Freesound 706497), 33.0–43.5 s | SEF7 | CC0 |

Freesound files were taken from the site's HQ mp3 previews (the CC0 license covers the sound, not the file format).
