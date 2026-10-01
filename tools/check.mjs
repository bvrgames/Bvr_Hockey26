// Syntax check: every inline <script> of index.html is compiled (not run) by V8, plus every .js/.mjs under tools/,
// server/ and shared/. Errors point at the real line of the file. Then shared/sim.js plays one short seeded match in
// Node.js (tools/sim-node.mjs): the shared simulation must run without a browser. Exit 1 on any failure.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0, n = 0;

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
for (let m; (m = re.exec(html));) {
  if (/\bsrc\s*=/.test(m[1] || '')) continue;
  const bodyStart = m.index + m[0].indexOf('>') + 1;
  const line0 = html.slice(0, bodyStart).split('\n').length - 1;
  n++;
  try { new Script('\n'.repeat(line0) + m[2], { filename: 'index.html' }); }
  catch (e) { fails++; console.log(`index.html: ${e.message}\n${(e.stack || '').split('\n').slice(0, 3).join('\n')}`); }
}

for (const dir of ['tools', 'server', 'shared', 'assets/src']) {
  let files = [];
  try { files = readdirSync(join(ROOT, dir)).filter((f) => /\.(m?js)$/.test(f)); } catch { continue; }
  for (const f of files) {
    n++;
    try { execFileSync(process.execPath, ['--check', join(ROOT, dir, f)], { stdio: 'pipe' }); }
    catch (e) { fails++; console.log(`${dir}/${f}:\n${e.stderr}`); }
  }
}
// <script src="shared/sim.js?v=…"> must carry the file's hash, or a cached old copy would run with a new index.html
{
  const want = createHash('sha1').update(readFileSync(join(ROOT, 'shared', 'sim.js'))).digest('hex').slice(0, 10);
  const got = (/<script src="shared\/sim\.js\?v=([0-9a-f]+)">/.exec(html) || [])[1];
  n++;
  if (got !== want) { fails++; console.log(`index.html: <script src="shared/sim.js?v=${got}"> — expected ?v=${want} (node tools/check.mjs --fix-version)`); }
  if (got !== want && process.argv.includes('--fix-version')) {
    const fixed = html.replace(/<script src="shared\/sim\.js(\?v=[0-9a-f]*)?">/, `<script src="shared/sim.js?v=${want}">`);
    (await import('node:fs')).writeFileSync(join(ROOT, 'index.html'), fixed); fails--; console.log('  fixed');
  }
}
// assets/dist and the manifest in index.html must match assets/src (tools/pack-assets.mjs)
try { execFileSync(process.execPath, [join(ROOT, 'tools', 'pack-assets.mjs'), '--check'], { stdio: 'pipe' }); n++; }
catch (e) { fails++; console.log(`tools/pack-assets.mjs --check:\n${e.stdout}${e.stderr}`); }
try { execFileSync(process.execPath, [join(ROOT, 'tools', 'sim-node.mjs'), '--seeds', '1', '--len', '60'], { stdio: 'pipe' }); n++; }
catch (e) { fails++; console.log(`tools/sim-node.mjs (shared/sim.js in Node):\n${e.stdout}${e.stderr}`); }
console.log(fails ? `CHECK FAIL (${fails} of ${n})` : `syntax ok (${n} scripts)`);
process.exit(fails ? 1 : 0);
