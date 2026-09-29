// Loading time on a phone-like connection: Chromium with CDP network emulation + CPU throttling, served like Vercel
// (tools/serve.mjs { vercel: true }: brotli, ETag / 304, Cache-Control from vercel.json).
// Measures, from navigation start, on what the player sees:
//   · menu   — the start menu is shown and the game script has run (window.__hk exists, #start visible)
//   · match  — after pressing Start: the match is on screen with the player models (state face/play, skin ready)
// plus requests, bytes over the wire, and the same for a repeat visit (warm cache).
// telegram-web-app.js is stubbed locally (browser.mjs) — in Telegram it is one more blocking request.
// usage: node tools/load.mjs [--root dir] [--net 4g,3g] [--cpu 4] [--runs 2] [--json out.json] [--label name]
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from './serve.mjs';
import { openGame, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ROOT = opt('root', null), CPU = +opt('cpu', 4), RUNS = +opt('runs', 2), LABEL = opt('label', ROOT ? ROOT : 'current');
const port = +opt('port', 8506);
const NETS = {
  '4g':  { latency: 100, downloadThroughput: 10e6 / 8, uploadThroughput: 5e6 / 8 },     // ~10 Mbit/s, RTT 100 ms
  '3g':  { latency: 400, downloadThroughput: 400e3 / 8, uploadThroughput: 400e3 / 8 },  // Chrome "Slow 3G"
  'wifi': { latency: 20, downloadThroughput: 50e6 / 8, uploadThroughput: 20e6 / 8 },
};
const nets = opt('net', '4g,3g').split(',');
const srv = await startServer(port, { vercel: true, ...(ROOT ? { root: resolve(ROOT) } : {}) });
const url = `http://127.0.0.1:${port}/index.html`;
const MENU = `(function(){ var s=document.getElementById('start'); return (window.__hk && s && getComputedStyle(s).display!=='none') ? performance.now() : 0; })()`;
const MATCH = `(function(){ try{ var st=__hk.st(); return (st==='face'||st==='play') && __hk.snap().skin ? performance.now() : 0; }catch(e){ return 0; } })()`;

async function visit(g, cdp, reqs) {
  reqs.length = 0;
  await g.page.goto(url + '?menu', { waitUntil: 'commit', timeout: 600000 });
  const menu = await (await g.page.waitForFunction(MENU, null, { timeout: 600000, polling: 50 })).jsonValue();
  const t0 = await g.page.evaluate(() => { document.getElementById('go').click(); return performance.now(); });
  const match = await (await g.page.waitForFunction(MATCH, null, { timeout: 600000, polling: 50 })).jsonValue();
  await g.page.waitForTimeout(300);
  const boot = await g.page.evaluate('__hk.boot ? __hk.boot() : null');
  const done = reqs.filter((r) => r.done);
  return { boot, menu: Math.round(menu), match: Math.round(match - t0), total: Math.round(match), requests: reqs.length,
           kb: Math.round(done.reduce((a, r) => a + r.bytes, 0) / 1024), list: reqs.map((r) => ({ url: r.url.replace(/^https?:\/\/[^/]+/, ''), kb: +(r.bytes / 1024).toFixed(1), st: r.status })) };
}

const out = [], fails = [];
try {
  for (const net of nets) {
    for (let run = 0; run < RUNS; run++) {
      const g = await openGame('chromium', { w: 800, h: 384, mobile: true, dpr: 2.625, noRoute: true });
      const cdp = await g.context.newCDPSession(g.page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: ['*telegram.org*'] });   // offline stand-in for Telegram's script
      await cdp.send('Network.emulateNetworkConditions', { offline: false, ...NETS[net] });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
      const reqs = [], byId = new Map();
      cdp.on('Network.requestWillBeSent', (e) => { if (/^data:|telegram\.org/.test(e.request.url)) return; const r = { url: e.request.url, bytes: 0, done: false }; byId.set(e.requestId, r); reqs.push(r); });
      cdp.on('Network.responseReceived', (e) => { const r = byId.get(e.requestId); if (r) r.status = e.response.status; });
      cdp.on('Network.loadingFinished', (e) => { const r = byId.get(e.requestId); if (r) { r.bytes = e.encodedDataLength; r.done = true; } });
      const cold = await visit(g, cdp, reqs);
      const warm = await visit(g, cdp, reqs);         // same context: HTTP cache kept
      out.push({ label: LABEL, net, run, cold, warm });
      if (cold.boot) console.log(`  boot (cold): ${JSON.stringify(cold.boot)}`);
      console.log(`${LABEL} · ${net} · run ${run + 1}: cold menu ${cold.menu} ms, match +${cold.match} ms, ${cold.requests} req ${cold.kb} KB · warm menu ${warm.menu} ms, match +${warm.match} ms, ${warm.requests} req ${warm.kb} KB`);
      for (const e of g.logs.filter(isError).filter((l) => !/telegram\.org|ERR_BLOCKED/.test(l.text))) fails.push(`[${e.type}] ${e.text}`);
      await g.browser.close();
    }
  }
} catch (e) {
  fails.push('runner error: ' + e.message.split('\n')[0]);
} finally { srv.close(); }
if (out.length) {
  const med = (a) => { const v = [...a].sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
  console.log(`\nmedians (${LABEL}, CPU ×${CPU}):`);
  for (const net of nets) {
    const R = out.filter((o) => o.net === net); if (!R.length) continue;
    const m = (f) => med(R.map(f));
    console.log(`  ${net.padEnd(4)} cold: menu ${m((o) => o.cold.menu)} ms · match +${m((o) => o.cold.match)} ms · ${R[0].cold.requests} req, ${R[0].cold.kb} KB   warm: menu ${m((o) => o.warm.menu)} ms · match +${m((o) => o.warm.match)} ms · ${R[0].warm.requests} req, ${R[0].warm.kb} KB`);
  }
  console.log('  requests (cold): ' + out[0].cold.list.map((r) => `${r.url} ${r.kb} KB`).join(' · '));
  console.log('  requests (warm): ' + out[0].warm.list.map((r) => `${r.url} ${r.st} ${r.kb} KB`).join(' · '));
}
const jf = opt('json', null); if (jf) writeFileSync(jf, JSON.stringify(out, null, 1));
if (fails.length) console.log('FAIL:\n  ' + fails.join('\n  '));
process.exit(fails.length ? 1 : 0);
