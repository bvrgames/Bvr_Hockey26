// Frame-time breakdown under a throttled CPU (a stand-in for a slow Android phone): the page's own ?debug meter
// (__hk.perf) — sim, net, pose (skinning + springs), draw (WebGL calls), marks (ice), ovl (2D overlay), hud (input + DOM),
// wait (rest of the frame interval: GPU / compositor / vsync) and gpu (readPixels probe every 20th frame).
// Chromium only (CPU throttling is a CDP feature). The GPU is the Mac's, not throttled: this finds CPU costs.
//   --net solo   one page, autopilot match (the host's work: full simulation)
//   --net guest  host (not throttled) + guest (throttled) through relay-mock: the guest's work
// usage: node tools/perf.mjs [--rates 1,4,6] [--q 0] [--net solo|guest] [--secs 8] [--w 800 --h 360 --dpr 2.625]
//                            [--query "&x=1"] [--json out.json]
import { writeFileSync } from 'node:fs';
import { startServer } from './serve.mjs';
import { startRelay } from './relay-mock.mjs';
import { openGame, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const RATES = opt('rates', '1,4,6').split(',').map(Number);
const Q = opt('q', '0'), NETM = opt('net', 'solo'), SECS = +opt('secs', 8);
const W = +opt('w', 800), H = +opt('h', 360), DPR = +opt('dpr', 2.625), EXTRA = opt('query', '');
const port = +opt('port', 8503), rport = +opt('relay', 8796);
const KEYS = ['frame', 'fps', 'cpu', 'wait', 'gpu', 'sim', 'net', 'pose', 'draw', 'marks', 'ovl', 'hud', 'draws', 'tris'];

const srv = await startServer(port);
const relay = NETM === 'guest' ? await startRelay(rport) : null;
const pages = [], fails = [], rows = [];
const BOT = `window.__pf=setInterval(function(){ var a=Math.random()*6.283; __hk.move(Math.cos(a)*0.9, Math.sin(a)*0.9);
  var r=Math.random(); __hk.press(r<0.45?'A':(r<0.6?'B':'Y')); }, 650);`;

async function measure(page, secs) {
  await page.evaluate('__hk.perf(true)');
  await page.waitForTimeout(1500);                       // settle after the throttle change
  const out = [];
  for (let t = 0; t < secs * 2; t++) { await page.waitForTimeout(500); const o = await page.evaluate('__hk.perf()'); if (o) out.push(o); }
  const avg = {};
  for (const k of KEYS) { const v = out.map((o) => o[k]).filter((x) => typeof x === 'number'); avg[k] = v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null; }
  avg.q = out.length ? out[out.length - 1].q : null; avg.cw = out.length ? out[out.length - 1].cw + '×' + out[out.length - 1].ch : '';
  return avg;
}

try {
  const q = `#q${Q}`;
  let page;
  if (NETM === 'guest') {
    const room = 'PRF' + Math.floor(Math.random() * 1e5);
    const url = `http://127.0.0.1:${port}/index.html?room=${room}&srv=http://127.0.0.1:${rport}&seed=3&debug${EXTRA}${q}`;
    const host = await openGame('chromium', { w: 1280, h: 720 }); pages.push(['host', host]);
    await host.page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await host.page.waitForFunction('window.__hk && __hk.net().role==="host"', null, { timeout: 30000 });
    const guest = await openGame('chromium', { w: W, h: H, mobile: true, dpr: DPR }); pages.push(['guest', guest]);
    await guest.page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await guest.page.waitForFunction('window.__hk && __hk.net().role==="guest"', null, { timeout: 30000 });
    await host.page.waitForFunction('__hk.net().peer', null, { timeout: 10000 });
    await host.page.evaluate('__hk.start()');
    await host.page.evaluate(BOT); await guest.page.evaluate(BOT);
    await guest.page.waitForFunction('__hk.st()!=="menu"', null, { timeout: 10000 });
    page = guest.page;
  } else {
    const g = await openGame('chromium', { w: W, h: H, mobile: true, dpr: DPR }); pages.push(['solo', g]);
    await g.page.goto(`http://127.0.0.1:${port}/index.html?autostart=600&autopilot&seed=3&debug${EXTRA}${q}`, { waitUntil: 'load', timeout: 120000 });
    await g.page.waitForFunction('window.__hk && __hk.st()!=="menu"', null, { timeout: 30000 });
    page = g.page;
  }
  const cdp = await page.context().newCDPSession(page);
  console.log(`perf · ${NETM} · q${Q} · ${W}×${H} @${DPR} · ${SECS} s per rate (Mac GPU, CPU throttled)`);
  console.log(['rate', ...KEYS].map((k) => k.padStart(6)).join(' '));
  for (const rate of RATES) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    const a = await measure(page, SECS);
    rows.push({ rate, ...a });
    console.log([`×${rate}`, ...KEYS.map((k) => (a[k] === null ? '—' : k === 'tris' ? Math.round(a[k] / 1000) + 'k' : String(a[k])))].map((s) => s.padStart(6)).join(' ') + `   ${a.cw}`);
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
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
