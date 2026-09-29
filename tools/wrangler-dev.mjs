// `wrangler dev` for tests: the real server/worker.js (Worker + Durable Object) in local workerd.
// import { startWrangler } from './wrangler-dev.mjs'; const w = await startWrangler(8797); … w.close()
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// resolves when the Worker answers GET /diag on port p
export async function startWrangler(p, { quiet = true } = {}) {
  const bin = join(ROOT, 'node_modules', '.bin', 'wrangler');
  const child = spawn(bin, ['dev', '--port', String(p), '--ip', '127.0.0.1', '--local', '--show-interactive-dev-session=false'],
    { cwd: join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; if (!quiet) process.stdout.write(d); });
  child.stderr.on('data', (d) => { out += d; if (!quiet) process.stderr.write(d); });
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    if (child.exitCode !== null) throw new Error('wrangler dev exited:\n' + out.slice(-2000));
    try { const r = await fetch(`http://127.0.0.1:${p}/diag`); if (r.ok) return { close: () => child.kill('SIGTERM'), log: () => out }; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  child.kill('SIGTERM');
  throw new Error('wrangler dev did not start in 90 s:\n' + out.slice(-2000));
}
