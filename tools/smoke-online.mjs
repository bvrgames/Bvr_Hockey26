// Online smoke: host + guest in two headless browsers through tools/relay-mock.mjs (same protocol as server/worker.js).
// Checks that bus events reach the guest (snapshot field `e`), that the guest's match statistics — built only from those
// events — equal the host's, that match:end / match:summary arrive on both sides, and that neither page logs an error.
// usage: node tools/smoke-online.mjs [--browser chromium|webkit] [--real 15] [--headed]
import { startServer } from './serve.mjs';
import { startRelay } from './relay-mock.mjs';
import { openGame, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const name = opt('browser', 'chromium');
const REAL = +opt('real', 15);
const port = +opt('port', 8493), rport = +opt('relay', 8794);
const room = 'SMK' + Math.floor(Math.random() * 1e5);
const url = `http://127.0.0.1:${port}/index.html?room=${room}&srv=http://127.0.0.1:${rport}&seed=5`;

const srv = await startServer(port);
const relay = await startRelay(rport);
const fails = [];
const sides = [];
const snap = (g) => g.page.evaluate('({s:__hk.snap(), st:__hk.stats(), m:__hk.match(), net:{role:__hk.net().role, seen:__hk.net().evSeen||0}})');

try {
  const host = await openGame(name, { headed: args.includes('--headed') }); sides.push(['host', host]);
  await host.page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await host.page.waitForFunction('window.__hk && __hk.net().role==="host"', null, { timeout: 30000 });
  const guest = await openGame(name, { headed: args.includes('--headed') }); sides.push(['guest', guest]);
  await guest.page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await guest.page.waitForFunction('window.__hk && __hk.net().role==="guest"', null, { timeout: 30000 });
  await host.page.waitForFunction('__hk.net().peer', null, { timeout: 10000 });

  await host.page.evaluate('__hk.start()');
  // both humans "play": wander the stick toward the enemy goal and pass / shoot now and then (also exercises the
  // guest → host input path). Autopilot is off online by design, so without this the idle carriers never move.
  const BOT = `window.__smk=setInterval(function(){ var a=Math.random()*6.283; __hk.move(Math.cos(a)*0.9, Math.sin(a)*0.9);
    var r=Math.random(); __hk.press(r<0.45?'A':(r<0.6?'B':'Y')); }, 650);`;
  await host.page.evaluate(BOT); await guest.page.evaluate(BOT);
  await guest.page.waitForFunction('__hk.st()!=="menu"', null, { timeout: 10000 }).catch(() => fails.push('guest never left the menu (cfg not received)'));
  await host.page.waitForTimeout(REAL * 1000);

  // stop the host (no more snapshots), let the last ones arrive, compare the event-built statistics
  await host.page.evaluate('clearInterval(window.__smk); __hk.freeze()');
  await guest.page.evaluate('clearInterval(window.__smk)');
  await guest.page.waitForTimeout(1200);
  const H = await snap(host), Gs = await snap(guest);
  if (Gs.m.id !== H.m.id) fails.push(`match id differs: host ${H.m.id} guest ${Gs.m.id}`);
  if (Gs.m.role !== 'guest' || Gs.m.mode !== 'online') fails.push(`guest match meta ${Gs.m.mode}/${Gs.m.role}`);
  if (!(Gs.net.seen > 0)) fails.push('guest received no events');
  const keys = ['shots', 'sog', 'goals', 'passes', 'passesDone', 'saves', 'hits', 'pokes', 'takeaways', 'penalties', 'posts'];
  const diff = keys.filter((k) => H.s.stats[k][0] !== Gs.s.stats[k][0] || H.s.stats[k][1] !== Gs.s.stats[k][1]);
  if (diff.length) fails.push('guest stats ≠ host stats: ' + diff.map((k) => `${k} ${H.s.stats[k]} vs ${Gs.s.stats[k]}`).join(', '));
  if (H.s.stats.faceoffs !== Gs.s.stats.faceoffs) fails.push(`faceoffs ${H.s.stats.faceoffs} vs ${Gs.s.stats.faceoffs}`);
  console.log(`[${name} online] ${REAL} s · events host ${H.s.stats.events} / guest ${Gs.s.stats.events} (last seq seen ${Gs.net.seen})`);
  console.log('  stats: ' + keys.map((k) => `${k} ${H.s.stats[k].join(':')}`).join(' · '));

  // end the match on the host: both sides must build a summary with the same score
  await host.page.evaluate('__hk.setClock(0.3); __hk.unfreeze()');
  await host.page.waitForFunction('__hk.st()==="over"', null, { timeout: 10000 }).catch(() => fails.push('host match did not end'));
  await guest.page.waitForFunction('__hk.match().summary', null, { timeout: 5000 }).catch(() => fails.push('guest got no match:summary'));
  const H2 = await snap(host), G2 = await snap(guest);
  if (!H2.m.summary) fails.push('host has no match:summary');
  if (H2.m.summary && G2.m.summary) {
    if (H2.m.summary.score.join() !== G2.m.summary.score.join()) fails.push(`summary score host ${H2.m.summary.score} guest ${G2.m.summary.score}`);
    if (G2.m.summary.team !== 1) fails.push('guest summary is not from team 1 perspective');
    console.log(`  summary: host ${H2.m.summary.role} ${H2.m.summary.result} · guest ${G2.m.summary.role} ${G2.m.summary.result} · score ${H2.m.summary.score.join(':')}`);
  }
  for (const [who, g] of sides) {
    for (const e of g.logs.filter(isError)) fails.push(`${who} [${e.type}] ${e.text}`);
    for (const e of await g.page.evaluate('__hk.errors()')) fails.push(`${who} [window] ${e}`);
  }
} catch (e) {
  fails.push('runner error: ' + e.message.split('\n')[0]);
} finally {
  for (const [, g] of sides) await g.browser.close();
  relay.close(); srv.close();
}
if (fails.length) console.log('  FAIL:\n    ' + fails.join('\n    '));
console.log(fails.length ? '\nONLINE SMOKE FAIL' : '\nONLINE SMOKE OK');
process.exit(fails.length ? 1 : 0);
