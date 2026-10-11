// News to every player from @bvr_games_bot (server/coins.js handleBroadcast, docs/EVENTS.md «Рассылка»).
// usage: node tools/broadcast.mjs news/<id>.json [--dry] [--only 454163382,…] [--api https://…workers.dev]
// The news file: { id, texts: { ru, en, id }, button: { ru, en, id } } (HTML, ≤ 4096 chars). The secret: env
// BVR_BCAST_SECRET or server/.broadcast-secret (not in git; the same value as the Worker secret BROADCAST_SECRET).
// Calls the Worker again and again until nobody is left; stopping and running again sends to nobody twice.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a) => a.endsWith('.json'));
if (!file) { console.error('usage: node tools/broadcast.mjs news/<id>.json [--dry] [--only uid,uid] [--api url]'); process.exit(2); }
const news = JSON.parse(readFileSync(file, 'utf8'));
const sf = join(ROOT, 'server', '.broadcast-secret');
const secret = process.env.BVR_BCAST_SECRET || (existsSync(sf) ? readFileSync(sf, 'utf8').trim() : '');
if (!secret) { console.error('no secret: BVR_BCAST_SECRET or server/.broadcast-secret'); process.exit(2); }
const api = (opt('--api') || 'https://bvr-hockey-relay.bvrhockey.workers.dev').replace(/\/$/, '');
const only = opt('--only') ? opt('--only').split(',').map(Number) : undefined;
const call = async (extra) => {
  const r = await fetch(api + '/tg/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Broadcast-Secret': secret },
    body: JSON.stringify({ id: news.id, texts: news.texts, button: news.button, only, ...extra }) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`);
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args.includes('--dry')) { console.log(await call({ dry: true })); process.exit(0); }
let tries = 0;
for (;;) {
  let j;
  try { j = await call({ max: 100 }); tries = 0; }
  catch (e) { if (++tries > 5) throw e; console.warn('retry after error:', e.message); await sleep(3000 * tries); continue; }
  console.log(`${news.id}: +${j.batch.sent} sent, +${j.batch.gone} unreachable, +${j.batch.fail} failed · so far sent ${j.sent}, unreachable ${j.gone}, failed ${j.fail}, left ${j.left}`);
  if (j.retry) { await sleep(j.retry * 1000 + 500); continue; }
  if (!j.left) break;
}
