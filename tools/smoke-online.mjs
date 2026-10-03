// Online smoke: host + guest in two headless browsers through tools/relay-mock.mjs (same protocol as server/worker.js).
// Checks that bus events reach the guest (snapshot field `e`), that the guest's match statistics — built only from those
// events — equal the host's, that match:end / match:summary arrive on both sides, and that neither page logs an error.
// The server scheme is the default (phase 3.5), so this pair asks for the host scheme by hand (&net=host). Then two
// short fallback runs with a plain link: an old Worker that does not know server mode, and a server-mode room that
// never starts the match — both must end up playing in the host scheme by themselves.
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
const url = `http://127.0.0.1:${port}/index.html?room=${room}&srv=http://127.0.0.1:${rport}&seed=5&net=host`;

const srv = await startServer(port);
const relay = await startRelay(rport);
const fails = [];
const sides = [];
const snap = (g) => g.page.evaluate('({s:__hk.snap(), st:__hk.stats(), m:__hk.match(), net:{role:__hk.net().role, seen:__hk.net().evSeen||0}})');

// plain link (no &net=…): the game asks for server mode; the match must still start, in the host scheme
async function fallback(label, relayOpt, srvAtFirst) {
  const rp = rport + 1, code = 'FBK' + Math.floor(Math.random() * 1e5);
  const u = `http://127.0.0.1:${port}/index.html?room=${code}&srv=http://127.0.0.1:${rp}&seed=5`;
  const r2 = await startRelay(rp, relayOpt), pair = [];
  try {
    for (const who of ['first', 'second']) {
      const g = await openGame(name, { headed: args.includes('--headed') }); pair.push([who, g]); sides.push([`${label} ${who}`, g]);
      await g.page.goto(u, { waitUntil: 'load', timeout: 120000 });
      await g.page.waitForFunction('window.__hk && !!__hk.net().role', null, { timeout: 30000 });
    }
    const [a, b] = [pair[0][1], pair[1][1]];
    await a.page.waitForFunction('__hk.net().peer', null, { timeout: 10000 });
    for (const [who, g] of pair) if ((await g.page.evaluate('!!__hk.net().srv')) !== srvAtFirst) fails.push(`${label}: ${who} srv flag is not ${srvAtFirst} before the start`);
    await a.page.evaluate('__hk.start()');
    for (const [who, g] of pair) await g.page.waitForFunction('__hk.st()!=="menu" && __hk.net().on && !__hk.net().srv', null, { timeout: 20000 })
      .catch(() => fails.push(`${label}: ${who} is not in a host-scheme match 20 s after the start`));
    await a.page.waitForTimeout(2000);
    const M = []; for (const [, g] of pair) M.push(await g.page.evaluate('({m:__hk.match(), role:__hk.net().role, clk:__hk.snap().clock})'));
    if (M[0].m.id !== M[1].m.id || !M[0].m.id) fails.push(`${label}: match ids ${M[0].m.id} / ${M[1].m.id}`);
    if (M.some((x) => x.m.net !== 'host')) fails.push(`${label}: match net ${M.map((x) => x.m.net)}`);
    if (M.map((x) => x.role).sort().join() !== 'guest,host') fails.push(`${label}: roles ${M.map((x) => x.role)}`);
    console.log(`  fallback (${label}): host-scheme match on both sides, roles ${M.map((x) => x.role).join(' / ')}`);
    for (const [who, g] of pair) {
      for (const e of g.logs.filter(isError)) fails.push(`${label} ${who} [${e.type}] ${e.text}`);
      for (const e of await g.page.evaluate('__hk.errors()')) fails.push(`${label} ${who} [window] ${e}`);
    }
  } finally { r2.close(); }
}

try {
  const host = await openGame(name, { headed: args.includes('--headed') }); sides.push(['host', host]);
  await host.page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await host.page.waitForFunction('window.__hk && __hk.net().role==="host"', null, { timeout: 30000 });
  const guest = await openGame(name, { headed: args.includes('--headed') }); sides.push(['guest', guest]);
  await guest.page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await guest.page.waitForFunction('window.__hk && __hk.net().role==="guest"', null, { timeout: 30000 });
  await host.page.waitForFunction('__hk.net().peer', null, { timeout: 10000 });
  // the build fingerprint goes to the room: the guest's hello lists the host with the same build as its own
  const bInfo = await guest.page.evaluate('({me:__hk.build(), conns:(__hk.ndg().diag && __hk.ndg().diag.conns)||[]})');
  const hostConn = bInfo.conns.find((c) => c.slot === 'host');
  if (!/^[0-9a-f]{6}$/.test(bInfo.me) || !hostConn || hostConn.b !== bInfo.me) fails.push(`build fingerprint not in the room diag ${JSON.stringify(bInfo)}`);

  await host.page.evaluate('__hk.start()');
  // both humans "play": wander the stick toward the enemy goal and pass / shoot now and then (also exercises the
  // guest → host input path). Autopilot is off online by design, so without this the idle carriers never move.
  const BOT = `window.__smk=setInterval(function(){ var a=Math.random()*6.283; __hk.move(Math.cos(a)*0.9, Math.sin(a)*0.9);
    var r=Math.random(); __hk.press(r<0.45?'A':(r<0.6?'B':'Y')); }, 650);`;
  await host.page.evaluate(BOT); await guest.page.evaluate(BOT);
  await guest.page.waitForFunction('__hk.st()!=="menu"', null, { timeout: 10000 }).catch(() => fails.push('guest never left the menu (cfg not received)'));
  await host.page.waitForTimeout(REAL * 1000);

  // stop the host (no more snapshots), let the last ones arrive, compare the event-built statistics
  // freeze, then push one last snapshot: an event from the very last host frame would otherwise wait for the next
  // (throttled) snapshot that never comes, and the guest's statistics would be one event short
  await host.page.evaluate('clearInterval(window.__smk); __hk.freeze(); __hk.netSnap()');
  await guest.page.evaluate('clearInterval(window.__smk)');
  await guest.page.waitForTimeout(1200);
  const H = await snap(host), Gs = await snap(guest);
  if (Gs.m.id !== H.m.id) fails.push(`match id differs: host ${H.m.id} guest ${Gs.m.id}`);
  if (Gs.m.role !== 'guest' || Gs.m.mode !== 'online') fails.push(`guest match meta ${Gs.m.mode}/${Gs.m.role}`);
  if (!(Gs.net.seen > 0)) fails.push('guest received no events');
  if (!(Gs.s.ice && Gs.s.ice.strokes > 0)) fails.push('guest: no skate marks on the ice (marks are generated per frame from player positions)');
  const keys = ['shots', 'sog', 'goals', 'passes', 'passesDone', 'saves', 'hits', 'pokes', 'takeaways', 'penalties', 'posts'];
  const diff = keys.filter((k) => H.s.stats[k][0] !== Gs.s.stats[k][0] || H.s.stats[k][1] !== Gs.s.stats[k][1]);
  if (diff.length) fails.push('guest stats ≠ host stats: ' + diff.map((k) => `${k} ${H.s.stats[k]} vs ${Gs.s.stats[k]}`).join(', '));
  if (H.s.stats.faceoffs !== Gs.s.stats.faceoffs) fails.push(`faceoffs ${H.s.stats.faceoffs} vs ${Gs.s.stats.faceoffs}`);
  console.log(`[${name} online] ${REAL} s · events host ${H.s.stats.events} / guest ${Gs.s.stats.events} (last seq seen ${Gs.net.seen}) · ice strokes host ${H.s.ice.strokes} / guest ${Gs.s.ice.strokes}`);
  console.log('  stats: ' + keys.map((k) => `${k} ${H.s.stats[k].join(':')}`).join(' · '));

  // end the match on the host: both sides must build a summary with the same score
  await host.page.evaluate('__hk.setClock(0.3); __hk.unfreeze()');
  await host.page.waitForFunction('__hk.st()==="over"', null, { timeout: 10000 }).catch(() => fails.push('host match did not end'));
  await guest.page.waitForFunction('__hk.match().summary', null, { timeout: 5000 }).catch(() => fails.push('guest got no match:summary'));
  const H2 = await snap(host), G2 = await snap(guest);
  const shown = (g) => g.page.evaluate('getComputedStyle(document.getElementById("overscr")).display!=="none"');
  if (!(await shown(host))) fails.push('host: result screen not shown');
  if (!(await shown(guest))) fails.push('guest: result screen not shown after match:end');
  if (await guest.page.evaluate('getComputedStyle(document.getElementById("oAgain")).display!=="none"')) fails.push('guest: rematch button visible (only the host starts a rematch)');
  const guestText = await guest.page.evaluate('document.getElementById("oScore").textContent');
  if (G2.m.summary && guestText.replace(/\s/g, '') !== G2.m.summary.score.join(':')) fails.push(`guest result shows "${guestText}", summary ${G2.m.summary.score}`);
  if (!H2.m.summary) fails.push('host has no match:summary');
  if (H2.m.summary && G2.m.summary) {
    if (H2.m.summary.score.join() !== G2.m.summary.score.join()) fails.push(`summary score host ${H2.m.summary.score} guest ${G2.m.summary.score}`);
    if (G2.m.summary.team !== 1) fails.push('guest summary is not from team 1 perspective');
    console.log(`  summary: host ${H2.m.summary.role} ${H2.m.summary.result} · guest ${G2.m.summary.role} ${G2.m.summary.result} · score ${H2.m.summary.score.join(':')}`);
  }
  // rematch from the host: the guest gets a new cfg, its result screen closes, both share the new match id
  await host.page.evaluate('document.getElementById("oAgain").click()');
  await guest.page.waitForFunction('getComputedStyle(document.getElementById("overscr")).display==="none"', null, { timeout: 5000 })
    .catch(() => fails.push('guest: result screen still open after the host started a rematch'));
  const H3 = await snap(host), G3 = await snap(guest);
  if (H3.m.id === H2.m.id || G3.m.id !== H3.m.id) fails.push(`rematch ids: host ${H2.m.id} → ${H3.m.id}, guest ${G3.m.id}`);
  else console.log(`  rematch: ok, new match id on both sides`);
  for (const [who, g] of sides) {
    for (const e of g.logs.filter(isError)) fails.push(`${who} [${e.type}] ${e.text}`);
    for (const e of await g.page.evaluate('__hk.errors()')) fails.push(`${who} [window] ${e}`);
  }
  await fallback('old Worker', { noSrv: true }, false);
  await fallback('silent server', { deadSrv: true }, true);
} catch (e) {
  fails.push('runner error: ' + e.message.split('\n')[0]);
} finally {
  for (const [, g] of sides) await g.browser.close();
  relay.close(); srv.close();
}
if (fails.length) console.log('  FAIL:\n    ' + fails.join('\n    '));
console.log(fails.length ? '\nONLINE SMOKE FAIL' : '\nONLINE SMOKE OK');
process.exit(fails.length ? 1 : 0);
