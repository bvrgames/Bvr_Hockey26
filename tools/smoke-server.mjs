// Server-mode smoke (phase 3.2): the match runs on the server, both players are followers (snapshots + prediction).
// Two headless browsers join one room with a plain link (server mode is the default since phase 3.5) against
//   · --target wrangler (default): `wrangler dev` on server/ — the real Worker + Durable Object in local workerd;
//   · --target mock: tools/relay-mock.mjs, which runs the same server/room-sim.js in Node.
// Checks: the room really is in server mode on both sides, the host does not simulate (it follows snapshots), bus
// events reach both, both players' statistics (built only from server events) are equal, match:end / match:summary with
// the same score on both, a rematch from the host restarts the match on both, no page errors.
// usage: node tools/smoke-server.mjs [--target wrangler|mock] [--browser chromium|webkit] [--real 15] [--headed]
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { startRelay } from './relay-mock.mjs';
import { openGame, isError } from './browser.mjs';
import { startWrangler } from './wrangler-dev.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const name = opt('browser', 'chromium'), TARGET = opt('target', 'wrangler');
const REAL = +opt('real', 15);
const port = +opt('port', 8504), rport = +opt('relay', 8797);
const room = 'SRV' + Math.floor(Math.random() * 1e5);
const url = `http://127.0.0.1:${port}/index.html?room=${room}&srv=http://127.0.0.1:${rport}&seed=5`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const srv = await startServer(port);
  const fails = [], sides = [];
  let backend = null;
  const snap = (g) => g.page.evaluate('({s:__hk.snap(), st:__hk.stats(), m:__hk.match(), net:{role:__hk.net().role, srv:!!__hk.net().srv, seen:__hk.net().evSeen||0}, ni:__hk.netInfo()})');
  try {
    backend = TARGET === 'mock' ? await startRelay(rport) : await startWrangler(rport);
    const host = await openGame(name, { headed: args.includes('--headed') }); sides.push(['host', host]);
    await host.page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await host.page.waitForFunction('window.__hk && __hk.net().role==="host"', null, { timeout: 30000 });
    const guest = await openGame(name, { headed: args.includes('--headed') }); sides.push(['guest', guest]);
    // the guest asks for the host scheme, but the room's mode comes from the server (hello srv:1)
    await guest.page.goto(url + '&net=host', { waitUntil: 'load', timeout: 120000 });
    await guest.page.waitForFunction('window.__hk && __hk.net().role==="guest"', null, { timeout: 30000 });
    await host.page.waitForFunction('__hk.net().peer', null, { timeout: 10000 });
    for (const [who, g] of sides) if (!(await g.page.evaluate('!!__hk.net().srv'))) fails.push(`${who}: room is not in server mode (old Worker?)`);

    await host.page.evaluate('__hk.start()');
    const BOT = `window.__smk=setInterval(function(){ var a=Math.random()*6.283; __hk.move(Math.cos(a)*0.9, Math.sin(a)*0.9);
      var r=Math.random(); __hk.press(r<0.45?'A':(r<0.6?'B':'Y')); }, 650);`;
    await host.page.evaluate(BOT); await guest.page.evaluate(BOT);
    for (const [who, g] of sides) await g.page.waitForFunction('__hk.st()!=="menu"', null, { timeout: 10000 }).catch(() => fails.push(`${who} never left the menu (no cfg from the server)`));
    await host.page.waitForTimeout(REAL * 1000);

    await host.page.evaluate('clearInterval(window.__smk)'); await guest.page.evaluate('clearInterval(window.__smk)');
    // no freeze on the server: compare what both have seen up to the same event number
    await host.page.waitForTimeout(1500);
    const H = await snap(host), Gs = await snap(guest);
    if (H.m.id !== Gs.m.id || !H.m.id) fails.push(`match id: host ${H.m.id} guest ${Gs.m.id}`);
    for (const [who, S] of [['host', H], ['guest', Gs]]) {
      if (!(S.net.seen > 0)) fails.push(`${who}: received no events`);
      if (!(S.ni.buf > 0)) fails.push(`${who}: no snapshots in the buffer (does not follow the server)`);
      if (S.m.mode !== 'online' || S.m.net !== 'server') fails.push(`${who} match meta ${S.m.mode}/${S.m.net}`);
      if (!(S.s.ice && S.s.ice.strokes > 0)) fails.push(`${who}: no skate marks`);
    }
    if (!(H.s.passes + H.s.shots > 0)) fails.push('nobody passed or shot in the whole match');
    const keys = ['shots', 'sog', 'goals', 'passes', 'passesDone', 'saves', 'hits', 'pokes', 'takeaways', 'penalties', 'posts'];
    console.log(`[${name} server/${TARGET}] ${REAL} s · events host ${H.s.stats.events} / guest ${Gs.s.stats.events} (seq ${H.net.seen} / ${Gs.net.seen}) · score ${H.s.score.join(':')}`);
    console.log('  stats: ' + keys.map((k) => `${k} ${H.s.stats[k].join(':')}`).join(' · '));
    if (H.net.seen === Gs.net.seen) {
      const diff = keys.filter((k) => H.s.stats[k].join() !== Gs.s.stats[k].join());
      if (diff.length) fails.push('host stats ≠ guest stats: ' + diff.map((k) => `${k} ${H.s.stats[k]} vs ${Gs.s.stats[k]}`).join(', '));
    } else fails.push(`last event seen differs after 1.5 s idle: host ${H.net.seen} guest ${Gs.net.seen}`);

    // end the match: the server's clock is authoritative, so play it out on a short match (rematch below, 0.25 min)
    // start a 15-second match from the host through a rematch-like cfg and wait for its end on both sides
    await host.page.evaluate(`(function(){ var n=__hk.net(); n.ws.send(JSON.stringify({t:'cfg',a:0,b:3,min:0.25,id:'abcdef0123456789abcdef01'})); })()`);
    for (const [who, g] of sides) await g.page.waitForFunction('__hk.match().id==="abcdef0123456789abcdef01"', null, { timeout: 5000 }).catch(() => fails.push(`${who}: did not get the new cfg`));
    for (const [who, g] of sides) await g.page.waitForFunction('__hk.match().summary', null, { timeout: 30000 }).catch(() => fails.push(`${who}: no match:summary after the 15 s match`));
    const H2 = await snap(host), G2 = await snap(guest);
    const shown = (g) => g.page.evaluate('getComputedStyle(document.getElementById("overscr")).display!=="none"');
    for (const [who, g] of sides) if (!(await shown(g))) fails.push(`${who}: result screen not shown`);
    if (H2.m.summary && G2.m.summary) {
      if (H2.m.summary.score.join() !== G2.m.summary.score.join()) fails.push(`summary score host ${H2.m.summary.score} guest ${G2.m.summary.score}`);
      if (H2.m.summary.team !== 0 || G2.m.summary.team !== 1) fails.push(`summary teams host ${H2.m.summary.team} guest ${G2.m.summary.team}`);
      console.log(`  15 s match: host ${H2.m.summary.result} · guest ${G2.m.summary.result} · score ${H2.m.summary.score.join(':')}`);
    }
    // rematch from the host's result screen
    await host.page.evaluate('document.getElementById("oAgain").click()');
    for (const [who, g] of sides) await g.page.waitForFunction('getComputedStyle(document.getElementById("overscr")).display==="none"', null, { timeout: 5000 })
      .catch(() => fails.push(`${who}: result screen still open after the rematch`));
    const H3 = await snap(host), G3 = await snap(guest);
    if (H3.m.id === H2.m.id || G3.m.id !== H3.m.id) fails.push(`rematch ids: ${H2.m.id} → host ${H3.m.id}, guest ${G3.m.id}`);
    else console.log('  rematch: ok, new match id on both sides');
    for (const [who, g] of sides) {
      for (const e of g.logs.filter(isError)) fails.push(`${who} [${e.type}] ${e.text}`);
      for (const e of await g.page.evaluate('__hk.errors()')) fails.push(`${who} [window] ${e}`);
    }
  } catch (e) {
    fails.push('runner error: ' + e.message.split('\n').slice(0, 6).join('\n'));
  } finally {
    for (const [, g] of sides) await g.browser.close();
    if (backend) backend.close();
    srv.close();
  }
  if (fails.length) console.log('  FAIL:\n    ' + fails.join('\n    '));
  console.log(fails.length ? '\nSERVER SMOKE FAIL' : '\nSERVER SMOKE OK');
  process.exit(fails.length ? 1 : 0);
}
