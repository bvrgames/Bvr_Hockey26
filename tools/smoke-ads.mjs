// AdsGram ads test: the game in a browser with a fake Telegram, a fake AdsGram SDK (window.Adsgram) and a fake API
// (Playwright routes). Checks: the SDK is set up only in Telegram (outside — nothing; an automated browser without the
// fake SDK — 'off', never the real script), both block ids from ADS_CFG; the video after a match only on leaving the
// result screen («Main menu» / «Again»), after every `every`-th finished match against the computer from the player's
// `from`-th one (shipped: 2 and 2, the same in the checks below) and 3 minutes after the last one; never in
// training, in a match with a friend, with «No ads»; the game's
// sound is paused during the video and back after it; an SDK error, a video that never answers, an SDK that throws —
// the game goes on at once; the rewarded video: the button on the result screen, the coins only from the server
// (/v1/profile ad.n), «later» when they do not come, a failed video can be retried, the button is gone at the daily
// limit; the shop: «No ads» for stars (confirm → POST /v1/shop/noads → «Owned»), not enough stars → «top up».
// The server side (Reward URL secret, daily limit, a repeated call, the purchase) is in tools/smoke-api.mjs.
// usage: node tools/smoke-ads.mjs [--browser chromium|webkit] [--port 8496] [--verbose]
import { startServer } from './serve.mjs';
import { openGame, fakeTelegram, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const browserName = opt('browser', 'chromium'), port = +opt('port', 8496), VERBOSE = args.includes('--verbose');
const fails = [], ok = (c, m) => { if (!c) fails.push(m); else if (VERBOSE) console.log('ok  ', m); };
const API = 'http://api.test';

// the fake AdsGram SDK: window.__ads.mode — 'done' (the video ends, 300 ms), 'error' (no video), 'skip' (closed before
// the end), 'hang' (never answers), 'manual' (the test calls __ads.end(r)); shows are recorded with the game's sound state
const FAKE_SDK = `
window.__ads={inits:[], shows:[], mode:'done', initThrows:false, end:null};
window.Adsgram={init:function(o){
  if(__ads.initThrows) throw new Error('init');
  __ads.inits.push(o);
  return {show:function(){
    __ads.shows.push({block:o.blockId, sndOff:window.__hk ? __hk.ads().sndOff : null, layer:window.__hk ? __hk.ads().layer : null});
    var m=__ads.mode;
    return new Promise(function(res, rej){
      __ads.end=function(r){ __ads.end=null; if(r && r.error===false && r.done) res(r); else rej(r); };
      if(m==='done') setTimeout(function(){ __ads.end && __ads.end({done:true, state:'destroy', error:false, description:'adv'}); }, 300);
      else if(m==='error') setTimeout(function(){ __ads.end && __ads.end({done:false, state:'load', error:true, description:'no ads'}); }, 30);
      else if(m==='skip') setTimeout(function(){ __ads.end && __ads.end({done:false, state:'destroy', error:false, description:'skipped'}); }, 100);
    });
  }};
}};`;

// the fake API: the profile is P (changed by the test), purchases and matches answer from it
let P;
const profile0 = () => ({ user: { id: 1, name: 'T' }, coins: 40, stars: 200, totals: { m: 5, w: 3, d: 1, l: 1, g: 9, ga: 5, streak: 1, best: 2, online: 0 },
  inventory: [], equipped: null, day: { coins: 0, cap: 100 }, packs: [{ id: 's50', stars: 50, price: 50 }], coinPacks: [{ id: 'c100', coins: 100, stars: 20 }],
  ad: { n: 0, max: 5, coins: 20 }, noadsPrice: 100 });
const apiCalls = [];
async function routeApi(page) {
  await page.route(/^http:\/\/api\.test\//, async (r) => {
    const u = new URL(r.request().url()), m = r.request().method(), path = u.pathname;
    apiCalls.push(m + ' ' + path);
    const json = (status, body) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: JSON.stringify(body) });
    if (m === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST' } });
    if (path === '/v1/profile') return json(200, P);
    if (path === '/v1/shop/noads') {
      if (P.inventory.includes('noads')) return json(409, { reason: 'owned', balance: { coins: P.coins, stars: P.stars } });
      if (P.stars < 100) return json(402, { reason: 'stars', need: 100, have: P.stars });
      P.stars -= 100; P.inventory.push('noads');
      return json(200, { item: 'noads', stars: 100, balance: { coins: P.coins, stars: P.stars }, inventory: P.inventory });
    }
    if (path === '/v1/match') return json(409, { reason: 'duplicate' });
    return json(403, { reason: 'forbidden' });
  });
}

const srv = await startServer(port);
const url = (q = '') => `http://127.0.0.1:${port}/index.html?nomusic&api=${encodeURIComponent(API)}${q}`;
async function open({ tg = true, sdk = true } = {}) {
  const g = await openGame(browserName, { w: 844, h: 390, mobile: true, tg: tg ? fakeTelegram({ fullscreen: true }) + (sdk ? FAKE_SDK : '') : null });
  await routeApi(g.page);
  await g.page.goto(url(), { waitUntil: 'load', timeout: 120000 });
  await g.page.waitForFunction('window.__hk && __hk.ads', null, { timeout: 60000 });
  return g;
}
const ads = (page, o) => page.evaluate((x) => __hk.ads(x), o || null);
// a finished match against the computer: the result screen and its match:summary (test: true — nothing is sent)
let mid = 0;
async function finish(page, { result = 'win' } = {}) {
  const id = (0xab000000 + (++mid)).toString(16) + 'cd';
  await page.evaluate(([id, result]) => {
    __hk.result(id);
    __hk.ev.emit('match:summary', { v: 1, id, mode: 'ai', role: 'solo', team: 0, score: result === 'win' ? [2, 1] : [0, 1], result, test: true });
  }, [id, result]);
  return id;
}
const click = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); return !!e; }, sel);
const waitFor = (page, fn, arg, ms = 5000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);

try {
  // ---------- outside Telegram: no SDK, nothing shown, «Main menu» works as before
  {
    const g = await open({ tg: false });
    await g.page.waitForTimeout(2600);
    let a = await ads(g.page);
    ok(a.st === null, `outside Telegram: the SDK is not loaded (${a.st})`);
    await finish(g.page); await finish(g.page);
    ok(await click(g.page, '#oMenu') && (await ads(g.page)).state === 'menu', 'outside Telegram: «Main menu» leaves at once');
    ok(!(await g.page.evaluate(() => [...document.scripts].some((s) => /adsgram/.test(s.src)))), 'outside Telegram: no AdsGram script on the page');
    await g.browser.close();
  }
  // ---------- an automated browser in Telegram without the fake SDK: 'off', the real script is never requested
  {
    const g = await open({ sdk: false });
    const req = []; g.page.on('request', (q) => { if (/adsgram/.test(q.url())) req.push(q.url()); });
    await waitFor(g.page, () => __hk.ads().st !== null, null, 6000);
    ok((await ads(g.page)).st === 'off' && req.length === 0, `no SDK in an automated browser: off, no request ${JSON.stringify(req)}`);
    await finish(g.page); await finish(g.page);
    ok(await click(g.page, '#oMenu') && (await ads(g.page)).state === 'menu', 'no SDK: «Main menu» leaves at once');
    await g.browser.close();
  }

  // ---------- the video after a match
  {
    P = profile0();
    const g = await open(), { page } = g;
    ok(await waitFor(page, () => __hk.ads().st === 'ok', null, 8000), 'the SDK is ready after the menu');
    await waitFor(page, () => __hk.ads().rw !== null, null, 8000);
    // the shipped setting: never after the player's very first match (for the AdsGram moderation it was 1 and 1)
    let a = await ads(page, { n: 5, t: 0, prof: 0 });
    await finish(page);
    ok(!(await ads(page)).due, `shipped ADS_CFG: the player's first finished match → no video`);
    await page.evaluate(() => __hk.result(null));
    // the rules below: every 2nd match, not after the player's first one
    a = await ads(page, { n: 0, t: 0, prof: 10, cfg: { every: 2, from: 2 } });
    ok(a.rw && a.rw.max === 5 && a.price === 100 && !a.noads, `the profile gives the video limit and the «No ads» price ${JSON.stringify(a)}`);
    // match 1: not yet (every 2nd)
    await finish(page);
    ok(!(await ads(page)).due, '1st finished match: no video yet');
    await click(page, '#oMenu');
    ok((await page.evaluate(() => __ads.shows.length)) === 0 && (await ads(page)).state === 'menu', 'match 1 → menu without a video');
    // match 2: the video on «Main menu», the result screen stays until it ends, the sound is paused meanwhile
    await page.evaluate(() => { __ads.mode = 'manual'; });
    await finish(page);
    ok((await ads(page)).due, '2nd finished match: the video is due');
    await click(page, '#oMenu');
    await page.waitForTimeout(150);
    let sh = await page.evaluate(() => __ads.shows.slice());
    a = await ads(page);
    ok(sh.length === 1 && sh[0].block === 'int-51931' && sh[0].sndOff === true && a.busy && a.state === 'over' && a.layer === 'result',
      `match 2 → the interstitial int-51931, the result screen waits, the sound is paused ${JSON.stringify([sh, a])}`);
    await click(page, '#oMenu'); await click(page, '#oAgain');
    ok((await page.evaluate(() => __ads.shows.length)) === 1 && (await ads(page)).state === 'over', 'taps during the video do nothing');
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
    ok((await ads(page)).sndOff === true, 'the app coming back during the video does not turn the sound on');
    await page.evaluate(() => __ads.end({ done: true, state: 'destroy', error: false, description: 'adv' }));
    await page.waitForTimeout(100);
    a = await ads(page);
    ok(a.state === 'menu' && !a.busy && a.sndOff === false && a.n === 0 && Date.now() - a.t < 5000, `after the video: menu, the sound back, the counter reset ${JSON.stringify(a)}`);
    const inits = await page.evaluate(() => __ads.inits);
    ok(inits.length === 1 && inits[0].blockId === 'int-51931' && inits[0].debug === false, `init: the block id from ADS_CFG, debug off outside the test bot ${JSON.stringify(inits)}`);
    // matches 3, 4: a 2nd match again, but sooner than 3 minutes
    await page.evaluate(() => { __ads.mode = 'done'; });
    await finish(page); await click(page, '#oMenu');
    await finish(page);
    ok(!(await ads(page)).due, '2 matches but less than 3 minutes since the last video: not due');
    await click(page, '#oMenu');
    ok((await page.evaluate(() => __ads.shows.length)) === 1, 'no video sooner than 3 minutes');
    // 3 minutes later: «Again» shows it, then the rematch starts
    await ads(page, { t: Date.now() - 181000 });
    await finish(page);
    await click(page, '#oAgain');
    ok(await waitFor(page, () => __hk.ads().state !== 'over', null, 5000), '«Again» after the video starts the rematch');
    a = await ads(page);
    ok((await page.evaluate(() => __ads.shows.length)) === 2 && a.state !== 'menu' && a.sndOff === false, `3 minutes later «Again» → the video, then the match ${JSON.stringify(a)}`);
    await page.evaluate(() => __hk.result(null));
    // not after a match that was not finished: an aborted match emits no summary
    await ads(page, { n: 5, t: 0 });
    await page.evaluate(() => { __hk.result('ffff0001'); });
    ok(!(await ads(page)).due, 'a result screen with no finished match behind it: not due');
    await click(page, '#oMenu');
    // a match with a friend
    await finish(page);
    await ads(page, { online: true });
    ok(!(await ads(page)).due, 'a match with a friend: never');
    const nf = await page.evaluate(() => __ads.shows.length);
    await click(page, '#oMenu');
    ok((await page.evaluate(() => __ads.shows.length)) === nf, 'a match with a friend → menu without a video');
    await ads(page, { online: false });
    // training
    await ads(page, { train: true });
    await finish(page);
    ok(!(await ads(page)).due && (await ads(page)).btn === null, 'training: no video and no button');
    await ads(page, { train: false }); await page.evaluate(() => __hk.result(null));
    // the player's first match
    await ads(page, { n: 5, t: 0, prof: 0 });
    await finish(page);
    ok(!(await ads(page)).due, "the player's first match: no video");
    await click(page, '#oMenu');
    ok((await page.evaluate(() => __ads.shows.length)) === 2, 'first match → menu without a video');
    // SDK errors: no video → straight on, the counter stays; a video that never answers → on after maxMs
    await ads(page, { n: 5, t: 0, prof: 10 });
    await page.evaluate(() => { __ads.mode = 'error'; });
    await finish(page);
    let t0 = Date.now();
    await click(page, '#oMenu');
    ok(await waitFor(page, () => __hk.ads().state === 'menu', null, 2000), 'SDK error: the menu at once');
    a = await ads(page);
    ok(Date.now() - t0 < 1500 && a.sndOff === false && a.n === 6, `SDK error: no delay, sound back, the counter kept ${JSON.stringify(a)}`);
    await page.evaluate(() => { __ads.mode = 'hang'; }); await ads(page, { cfg: { maxMs: 800 } });
    await finish(page); t0 = Date.now();
    await click(page, '#oMenu');
    ok(await waitFor(page, () => __hk.ads().state === 'menu', null, 4000) && (await ads(page)).sndOff === false, `a video that never answers: on after maxMs (${Date.now() - t0} ms)`);
    await ads(page, { cfg: { maxMs: 120000 } });

    // ---------- the rewarded video
    await page.evaluate(() => { __ads.mode = 'manual'; }); await ads(page, { cfg: { waitMs: 2500 } });
    await ads(page, { n: 0, t: Date.now() });
    await finish(page);
    a = await ads(page);
    ok(a.btn && /\+\s*20/.test(a.btn), `the result screen: «Video: +20» ${JSON.stringify(a.btn)}`);
    await click(page, '#oAdRw');
    await page.waitForTimeout(100);
    sh = await page.evaluate(() => __ads.shows.slice(-1)[0]);
    ok(sh.block === '51932' && sh.sndOff === true && (await ads(page)).rs === 'show', `reward: the block 51932, the sound paused ${JSON.stringify(sh)}`);
    await page.evaluate(() => __ads.end({ done: true, state: 'destroy', error: false, description: 'reward' }));
    await page.waitForTimeout(400);
    a = await ads(page);
    ok(a.rs === 'wait' && a.sndOff === false && (await page.evaluate(() => __hk.coins().coins)) === 40, `reward: waits for the server, no coins from the client ${JSON.stringify(a)}`);
    P.ad.n = 1; P.coins = 60;     // the server got AdsGram's Reward URL call
    ok(await waitFor(page, () => __hk.ads().rs === 'done', null, 5000), 'reward: the server paid → done');
    a = await ads(page);
    ok(/\+\s*20/.test(a.btn) && (await page.evaluate(() => __hk.coins().coins)) === 60, `reward: «For the video: +20», balance 60 from the server ${JSON.stringify(a.btn)}`);
    const np = await page.evaluate(() => __ads.shows.length);
    await click(page, '#oAdRw');
    ok((await page.evaluate(() => __ads.shows.length)) === np, 'reward: the button does nothing once paid');
    // the server never pays → «later»
    await click(page, '#oMenu'); await finish(page);
    await click(page, '#oAdRw'); await page.waitForTimeout(50);
    await page.evaluate(() => __ads.end({ done: true, state: 'destroy', error: false, description: 'reward' }));
    ok(await waitFor(page, () => __hk.ads().rs === 'later', null, 6000), 'reward: no coins from the server in time → «later»');
    // skipped → the button again; failed → «did not load», can retry
    await click(page, '#oMenu'); await finish(page);
    await click(page, '#oAdRw'); await page.waitForTimeout(50);
    await page.evaluate(() => __ads.end({ done: false, state: 'destroy', error: false, description: 'skipped' }));
    await page.waitForTimeout(50);
    ok((await ads(page)).rs === null, 'reward: skipped → the button as it was');
    await page.evaluate(() => { __ads.mode = 'error'; });
    await click(page, '#oAdRw');
    ok(await waitFor(page, () => __hk.ads().rs === 'fail', null, 2000) && /\+\s*20/.test((await ads(page)).btn), 'reward: SDK error → «did not load», can retry');
    // the daily limit: the button is gone
    P.ad.n = 5;
    await ads(page, { fetch: true });
    await waitFor(page, () => __hk.ads().rw && __hk.ads().rw.n === 5, null, 5000);
    await click(page, '#oMenu'); await finish(page);
    ok((await ads(page)).btn === null, 'reward: no button at the daily limit');
    // a match with a friend: no reward button either
    P.ad.n = 0; await ads(page, { fetch: true }); await waitFor(page, () => __hk.ads().rw.n === 0, null, 5000);
    await ads(page, { online: true }); await page.evaluate(() => __hk.result(null));
    await finish(page);
    ok((await ads(page)).btn === null, 'reward: no button in a match with a friend');
    await ads(page, { online: false }); await page.evaluate(() => __hk.result(null));

    // ---------- «No ads» in the shop
    await page.evaluate(() => __hk.menu('shop'));
    await page.waitForTimeout(150);
    const card = '#start section.cur .mshc[data-pack="noads"]';
    ok(/100/.test(await page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', card)), 'shop: «No ads» for 100 stars');
    await click(page, card);
    ok(await click(page, '#start section.cur [data-act="cyes"]'), 'shop: «No ads» asks to confirm');
    ok(await waitFor(page, () => __hk.ads().noads === true, null, 5000), 'shop: bought → noads');
    const st = await page.evaluate((s) => ({ card: (document.querySelector(s) || {}).textContent, q: (document.querySelector('#start section.cur .mshq') || {}).textContent, stars: __hk.coins().stars }), card);
    ok(st.card.includes(await page.evaluate(() => __hk.T('shOwned'))) && st.q.includes(await page.evaluate(() => __hk.T('shNoAdsDone'))) && st.stars === 100 && apiCalls.includes('POST /v1/shop/noads'), `shop: «Owned», «Ads are off», 100 stars left ${JSON.stringify(st)}`);
    // «No ads» works: a due video is not shown, the rewarded video stays
    await page.evaluate(() => __hk.menu('main'));
    await ads(page, { n: 5, t: 0 });
    await page.evaluate(() => { __ads.mode = 'done'; });
    const n0 = await page.evaluate(() => __ads.shows.length);
    await finish(page);
    a = await ads(page);
    ok(!a.due && a.btn && /\+\s*20/.test(a.btn), `«No ads»: no video after the match, the rewarded video stays ${JSON.stringify(a)}`);
    await click(page, '#oMenu');
    ok((await page.evaluate(() => __ads.shows.length)) === n0, '«No ads»: menu without a video');
    // a reload: «No ads» comes from the server
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('window.__hk && __hk.ads', null, { timeout: 60000 });
    ok(await waitFor(page, () => __hk.ads().noads === true && __hk.ads().st === 'ok', null, 8000), '«No ads» after a restart (server inventory)');
    const errs = g.logs.filter(isError).filter((l) => !/api\.test|favicon|status of 40[39]/.test(l.text));
    ok(errs.length === 0, `no page errors ${JSON.stringify(errs.slice(0, 3))}`);
    await g.browser.close();
  }
  // ---------- not enough stars for «No ads»; an SDK whose init throws
  {
    P = profile0(); P.stars = 60;
    const g = await open(), { page } = g;
    await waitFor(page, () => __hk.ads().price === 100, null, 8000);
    await page.evaluate(() => __hk.menu('shop')); await page.waitForTimeout(150);
    await click(page, '#start section.cur .mshc[data-pack="noads"]');
    const q = await page.evaluate(() => ({ t: (document.querySelector('#start section.cur .mshq') || {}).textContent, top: !!document.querySelector('#start section.cur .mshq [data-act="topup"]') }));
    ok(q.t.includes((await page.evaluate(() => __hk.T('shNo'))).split(':')[0]) && q.top && !apiCalls.slice(-3).includes('POST /v1/shop/noads'), `shop: 60 stars → «not enough», «top up» ${JSON.stringify(q)}`);
    await page.evaluate(() => { __hk.menu('main'); __ads.initThrows = true; });
    await ads(page, { n: 5, t: 0, prof: 10 });
    await finish(page);
    await click(page, '#oMenu');
    ok(await waitFor(page, () => __hk.ads().state === 'menu', null, 2000) && (await ads(page)).sndOff === false, 'SDK init throws: the menu at once, the sound on');
    const errs = g.logs.filter(isError).filter((l) => !/api\.test|favicon|status of 40[39]/.test(l.text));
    ok(errs.length === 0, `no page errors ${JSON.stringify(errs.slice(0, 3))}`);
    await g.browser.close();
  }
} catch (e) {
  fails.push('runner error: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | '));
} finally {
  srv.close();
}
if (fails.length) { console.log(`smoke-ads (${browserName}): FAIL`); for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log(`smoke-ads (${browserName}): OK`);
