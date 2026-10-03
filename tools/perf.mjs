// Frame-time breakdown under a throttled CPU (a stand-in for a slow Android phone): the page's own ?debug meter
// (__hk.perf) — sim, net, pose (skinning + springs), draw (WebGL calls), marks (ice), ovl (2D overlay), hud (input + DOM),
// wait (rest of the frame interval: GPU / compositor / vsync) and gpu (readPixels probe every 20th frame).
// Chromium only (CPU throttling is a CDP feature). The GPU is the Mac's, not throttled: this finds CPU costs.
//   --net solo   one page, autopilot match (the host's work: full simulation)
//   --net guest  host (not throttled) + guest (throttled) through relay-mock: the guest's work
// Profiles (04.10, before/after for the optimisation tasks): --profile iphone — WebKit 844×390 @3, no throttle, q1 (what
// an iPhone starts with); --profile android — Chromium 800×360 @2.625, CPU ×6 and ×20, q0 (a weak Android; ×20 — closer to what a real one spends on DOM: the 03.10 panel had hud 1.2–3 ms). Each row adds the
// page's own rAF intervals: p90 of the frame interval and janks (frames over 20 ms) per second. --q auto — no #q, the
// game's own automatic quality (dynamic resolution on). WebKit has no CPU throttling (rate 1 only).
// usage: node tools/perf.mjs [--profile iphone|android] [--browser chromium|webkit] [--rates 1,4,6] [--q 0|auto]
//                            [--net solo|guest] [--secs 8] [--w 800 --h 360 --dpr 2.625] [--query "&x=1"] [--json out.json]
import { writeFileSync } from 'node:fs';
import { startServer } from './serve.mjs';
import { startRelay } from './relay-mock.mjs';
import { openGame, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const PROFILES = { iphone: { browser: 'webkit', rates: '1', q: '1', w: 844, h: 390, dpr: 3 },
  android: { browser: 'chromium', rates: '6,20', q: '0', w: 800, h: 360, dpr: 2.625 } };
const PF = PROFILES[opt('profile', '')] || {};
const BROWSER = opt('browser', PF.browser || 'chromium');
const RATES = opt('rates', PF.rates || '1,4,6').split(',').map(Number);
const Q = opt('q', PF.q || '0'), NETM = opt('net', 'solo'), SECS = +opt('secs', 8);
const W = +opt('w', PF.w || 800), H = +opt('h', PF.h || 360), DPR = +opt('dpr', PF.dpr || 2.625), EXTRA = opt('query', '');
const port = +opt('port', 8503), rport = +opt('relay', 8796);
const KEYS = ['frame', 'p90', 'jank', 'fps', 'cpu', 'wait', 'gpu', 'sim', 'net', 'pose', 'draw', 'marks', 'ovl', 'hud', 'draws', 'tris'];

const srv = await startServer(port);
const relay = NETM === 'guest' ? await startRelay(rport) : null;
const pages = [], fails = [], rows = [];
const BOT = `window.__pf=setInterval(function(){ var a=Math.random()*6.283; __hk.move(Math.cos(a)*0.9, Math.sin(a)*0.9);
  var r=Math.random(); __hk.press(r<0.45?'A':(r<0.6?'B':'Y')); }, 650);`;

async function measure(page, secs) {
  await page.evaluate('__hk.perf(true)');
  await page.waitForTimeout(1500);                       // settle after the throttle change
  // the page's own frame intervals (rAF), independent of the game's meter
  await page.evaluate(`window.__pfFr=[]; (function f(t){ if(window.__pfLast) window.__pfFr.push(t-window.__pfLast); window.__pfLast=t; window.__pfRaf=requestAnimationFrame(f); })(performance.now())`);
  const out = [];
  for (let t = 0; t < secs * 2; t++) { await page.waitForTimeout(500); const o = await page.evaluate('__hk.perf()'); if (o) out.push(o); }
  const fr = await page.evaluate('(cancelAnimationFrame(window.__pfRaf), window.__pfFr.slice(1))');
  const sorted = fr.slice().sort((a, b) => a - b), dur = fr.reduce((a, b) => a + b, 0) / 1000 || 1;
  const avg = { p90: sorted.length ? +sorted[Math.floor(sorted.length * 0.9)].toFixed(1) : null, jank: +(fr.filter((x) => x > 20).length / dur).toFixed(1) };
  for (const k of KEYS) { if (k === 'p90' || k === 'jank') continue; const v = out.map((o) => o[k]).filter((x) => typeof x === 'number'); avg[k] = v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null; }
  avg.q = out.length ? out[out.length - 1].q : null; avg.cw = out.length ? out[out.length - 1].cw + '×' + out[out.length - 1].ch : '';
  avg.dpr = out.length ? out[out.length - 1].dpr : null;
  return avg;
}

try {
  const q = Q === 'auto' ? '' : `#q${Q}`;
  let page;
  if (NETM === 'guest') {
    const room = 'PRF' + Math.floor(Math.random() * 1e5);
    const url = `http://127.0.0.1:${port}/index.html?room=${room}&srv=http://127.0.0.1:${rport}&seed=3&debug${EXTRA}${q}`;
    const host = await openGame('chromium', { w: 1280, h: 720 }); pages.push(['host', host]);
    await host.page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await host.page.waitForFunction('window.__hk && __hk.net().role==="host"', null, { timeout: 30000 });
    const guest = await openGame(BROWSER, { w: W, h: H, mobile: true, dpr: DPR }); pages.push(['guest', guest]);
    await guest.page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await guest.page.waitForFunction('window.__hk && __hk.net().role==="guest"', null, { timeout: 30000 });
    await host.page.waitForFunction('__hk.net().peer', null, { timeout: 10000 });
    await host.page.evaluate('__hk.start()');
    await host.page.evaluate(BOT); await guest.page.evaluate(BOT);
    await guest.page.waitForFunction('__hk.st()!=="menu"', null, { timeout: 10000 });
    page = guest.page;
  } else {
    const g = await openGame(BROWSER, { w: W, h: H, mobile: true, dpr: DPR }); pages.push(['solo', g]);
    await g.page.goto(`http://127.0.0.1:${port}/index.html?autostart=600&autopilot&seed=3&debug${EXTRA}${q}`, { waitUntil: 'load', timeout: 120000 });
    await g.page.waitForFunction('window.__hk && __hk.st()!=="menu"', null, { timeout: 30000 });
    page = g.page;
  }
  const cdp = BROWSER === 'chromium' ? await page.context().newCDPSession(page) : null;
  console.log(`perf · ${BROWSER} · ${NETM} · q${Q} · ${W}×${H} @${DPR} · ${SECS} s per rate (Mac GPU${cdp ? ', CPU throttled' : ''})`);
  console.log(['rate', ...KEYS].map((k) => k.padStart(6)).join(' '));
  for (const rate of RATES) {
    if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    const a = await measure(page, SECS);
    rows.push({ rate, ...a });
    console.log([`×${rate}`, ...KEYS.map((k) => (a[k] === null ? '—' : k === 'tris' ? Math.round(a[k] / 1000) + 'k' : String(a[k])))].map((s) => s.padStart(6)).join(' ') + `   ${a.cw} q${a.q} dpr ${a.dpr}`);
  }
  if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  for (const [who, g] of pages) {
    for (const e of g.logs.filter(isError)) fails.push(`${who} [${e.type}] ${e.text}`);
    for (const e of await g.page.evaluate('__hk.errors()')) fails.push(`${who} [window] ${e}`);
  }
} catch (e) {
  fails.push('runner error: ' + e.message.split('\n')[0]);
} finally {
  for (const [, g] of pages) await g.browser.close();
  if (relay) relay.close();
  srv.close();
}
const jf = opt('json', null); if (jf) writeFileSync(jf, JSON.stringify(rows, null, 1));
if (fails.length) console.log('FAIL:\n  ' + fails.join('\n  '));
process.exit(fails.length ? 1 : 0);
