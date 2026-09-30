// Server-mode smoke (phase 3.2): the match runs on the server, both players are followers (snapshots + prediction).
// Two headless browsers join one room with a plain link (server mode is the default since phase 3.5) against
//   · --target wrangler (default): `wrangler dev` on server/ — the real Worker + Durable Object in local workerd;
//   · --target mock: tools/relay-mock.mjs, which runs the same server/room-sim.js in Node.
// Checks: the room really is in server mode on both sides, the host does not simulate (it follows snapshots), bus
// events reach both, both players' statistics (built only from server events) are equal, match:end / match:summary with
// the same score on both, a rematch from the host restarts the match on both, no page errors.
// Lost connection (phase 3.5): the guest's socket is cut for 5 s — the host sees "opponent is reconnecting", the
// server marks the guest away (the AI plays), the guest comes back into the same match by itself and its input
// reaches the server again; then for 40 s — the guest gives up after ~30 s (menu, summary result "left"), the host
// plays the match out against the AI and its summary carries disconnect.oppLeft.
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

    // ---- lost connection: a 75-second match, the guest's socket is cut for 5 s and then for 40 s ----
    const DID = 'dc0123456789abcdef012345';
    await host.page.evaluate(`__hk.net().ws.send(JSON.stringify({t:'cfg',a:1,b:2,min:1.25,id:'${DID}'}))`);
    for (const [who, g] of sides) await g.page.waitForFunction(`__hk.match().id==="${DID}"`, null, { timeout: 5000 }).catch(() => fails.push(`${who}: no cfg for the disconnect match`));
    await host.page.evaluate(BOT); await guest.page.evaluate(BOT);
    await host.page.waitForTimeout(3000);
    const ban = (g) => g.page.evaluate('(function(){ var e=document.getElementById("netban"); return +getComputedStyle(e).opacity>0.5 || e.style.opacity==="1" ? e.textContent : ""; })()');
    const tDrop = Date.now();
    await guest.page.evaluate('__hk.netDrop(5)');
    await host.page.waitForFunction('(__hk.net().w&2)===2', null, { timeout: 4000 }).catch(() => fails.push('5 s drop: the host never saw the guest as away (w bit 2)'));
    await host.page.waitForTimeout(700);
    const hb = await ban(host), gb = await ban(guest);
    if (!/переподключается|reconnecting|menyambung/.test(hb)) fails.push(`5 s drop: host banner "${hb}"`);
    if (!/переподключение|reconnecting|menyambung/.test(gb)) fails.push(`5 s drop: guest banner "${gb}" ` + await guest.page.evaluate('(function(){var e=document.getElementById("netban"),n=__hk.net();return JSON.stringify({rc:!!n.rc,on:n.on,tok:!!n.tok,txt:e.textContent,op:e.style.opacity,cs:getComputedStyle(e).opacity,st:__hk.st(),status:n.status})})()'));
    const clk0 = await host.page.evaluate('__hk.snap().clock');
    // a stranger with the same room code must not get the dropped guest's slot: it is kept for the key holder
    const stranger = await openGame(name, { headed: args.includes('--headed') }); sides.push(['stranger', stranger]);
    await stranger.page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await stranger.page.waitForFunction('window.__hk && /занята|full|penuh/.test(__hk.net().status)', null, { timeout: 4000 })
      .catch(async () => fails.push('5 s drop: a stranger was not refused: ' + await stranger.page.evaluate('JSON.stringify({role:__hk.net().role,on:__hk.net().on,status:__hk.net().status,st:__hk.st()})')));
    if (await stranger.page.evaluate('__hk.st()') !== 'menu') fails.push('5 s drop: the stranger got into the match');
    await stranger.browser.close(); sides.pop();
    await guest.page.waitForFunction('!__hk.net().rc && __hk.net().ws && __hk.net().ws.readyState===1', null, { timeout: 15000 }).catch(() => fails.push('5 s drop: the guest did not reconnect in 15 s'));
    const tBack = ((Date.now() - tDrop) / 1000).toFixed(1);
    // the away bit clears only when the guest's input reaches the server again
    await host.page.waitForFunction('(__hk.net().w&2)===0', null, { timeout: 5000 }).catch(() => fails.push('5 s drop: the guest is still away for the server after reconnecting'));
    await host.page.waitForTimeout(1500);
    const A = await snap(host), B = await snap(guest);
    if (await ban(host) || await ban(guest)) fails.push(`5 s drop: banners still shown after the return: host "${await ban(host)}" guest "${await ban(guest)}"`);
    if (B.m.id !== DID || B.s.state === 'menu') fails.push(`5 s drop: guest is not in the same match (${B.m.id}, ${B.s.state})`);
    if (!(B.ni.buf > 0)) fails.push('5 s drop: guest has no fresh snapshots after the return');
    if (Math.abs(A.s.clock - B.s.clock) > 1.5) fails.push(`5 s drop: clocks differ after the return: host ${A.s.clock} guest ${B.s.clock}`);
    if (!(A.s.clock < clk0)) fails.push(`5 s drop: the match stood still while the guest was away (${clk0} → ${A.s.clock})`);
    if (A.s.score.join() !== B.s.score.join()) fails.push(`5 s drop: score host ${A.s.score} guest ${B.s.score}`);
    console.log(`  5 s drop: stranger refused, guest back after ${tBack} s, same match, clock host ${A.s.clock} / guest ${B.s.clock}`);

    // the app was closed and opened again: a new page takes the slot back with the key from sessionStorage
    await guest.page.evaluate('clearInterval(window.__smk)');
    await guest.page.reload({ waitUntil: 'load', timeout: 120000 });
    await guest.page.waitForFunction(`window.__hk && __hk.net().role==="guest" && __hk.st()!=="menu" && __hk.match().id==="${DID}"`, null, { timeout: 30000 })
      .catch(async () => fails.push('reload: the guest did not return into the match with the stored key: ' + await guest.page.evaluate('JSON.stringify({role:__hk.net().role,status:__hk.net().status,st:__hk.st(),id:__hk.match().id})')));
    await guest.page.evaluate(BOT);
    await host.page.waitForFunction('(__hk.net().w&2)===0', null, { timeout: 6000 }).catch(() => fails.push('reload: the guest is still away for the server (its input does not count)'));
    await host.page.waitForTimeout(1500);
    const A2 = await snap(host), B2 = await snap(guest);
    if (Math.abs(A2.s.clock - B2.s.clock) > 1.5 || A2.s.score.join() !== B2.s.score.join()) fails.push(`reload: host ${A2.s.clock} ${A2.s.score} / guest ${B2.s.clock} ${B2.s.score}`);
    else console.log(`  reload: guest page reopened, back in the match with the key from sessionStorage, clock ${A2.s.clock} / ${B2.s.clock}`);

    const tDrop2 = Date.now();
    await guest.page.evaluate('__hk.netDrop(40)');
    await guest.page.waitForFunction('__hk.st()==="menu"', null, { timeout: 40000 }).catch(() => fails.push('40 s drop: the guest did not give up in 40 s'));
    const tGive = (Date.now() - tDrop2) / 1000;
    if (tGive < 28) fails.push(`40 s drop: the guest gave up after only ${tGive.toFixed(1)} s`);
    const G4 = await snap(guest);
    if (!G4.m.summary || G4.m.summary.result !== 'left' || !G4.m.summary.disconnect || !G4.m.summary.disconnect.selfLeft) fails.push(`40 s drop: guest summary ${JSON.stringify(G4.m.summary && { r: G4.m.summary.result, d: G4.m.summary.disconnect })}`);
    await host.page.waitForFunction('(__hk.net().w&8)===8 || __hk.st()==="over"', null, { timeout: 8000 }).catch(() => fails.push('40 s drop: the server never marked the guest as gone (w bit 8)'));
    const H4 = await snap(host);
    if (H4.s.state === 'menu') fails.push('40 s drop: the host was thrown out of the match');
    await host.page.waitForFunction('__hk.match().summary', null, { timeout: 90000 }).catch(() => fails.push('40 s drop: the host match was not played out to the end'));
    const H5 = await snap(host), d5 = H5.m.summary && H5.m.summary.disconnect;
    if (!d5 || !d5.opp || !d5.oppLeft || d5.selfLeft) fails.push(`40 s drop: host summary disconnect ${JSON.stringify(d5)}`);
    if (H5.m.summary && !['win', 'loss', 'draw'].includes(H5.m.summary.result)) fails.push(`40 s drop: host result ${H5.m.summary.result}`);
    console.log(`  40 s drop: guest gave up after ${tGive.toFixed(1)} s (result ${G4.m.summary && G4.m.summary.result}), host played on against the AI: ${H5.m.summary && H5.m.summary.result} ${H5.m.summary && H5.m.summary.score.join(':')}, disconnect ${JSON.stringify(d5)}`);
    await host.page.evaluate('clearInterval(window.__smk)'); await guest.page.evaluate('clearInterval(window.__smk)');

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
