// Syntax check: every inline <script> of index.html is compiled (not run) by V8, plus every .js/.mjs under tools/ and
// server/. Errors point at the real line of the file. Exit 1 on the first failure.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { execFileSync } from 'node:child_process';

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

for (const dir of ['tools', 'server']) {
  let files = [];
  try { files = readdirSync(join(ROOT, dir)).filter((f) => /\.(m?js)$/.test(f)); } catch { continue; }
  for (const f of files) {
    n++;
    try { execFileSync(process.execPath, ['--check', join(ROOT, dir, f)], { stdio: 'pipe' }); }
    catch (e) { fails++; console.log(`${dir}/${f}:\n${e.stderr}`); }
  }
}
console.log(fails ? `CHECK FAIL (${fails} of ${n})` : `syntax ok (${n} scripts)`);
process.exit(fails ? 1 : 0);
