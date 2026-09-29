// Static dev server for the game (no caching, so every test run sees the current index.html).
// { vercel: true } — behaves like the production host for load tests (tools/load.mjs): brotli/gzip by Accept-Encoding,
// ETag + 304, and the Cache-Control rules of vercel.json (hashed assets immutable, the rest revalidated).
// usage: node tools/serve.mjs [port=8490]   ·   import { startServer } from './serve.mjs'
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants as Z } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream', '.webp': 'image/webp',
};
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|octet-stream)|image\/svg)/;

// Cache-Control from vercel.json "headers" (source patterns like /assets/(.*)), default as on Vercel
function cacheRules(root) {
  const f = join(root, 'vercel.json');
  if (!existsSync(f)) return [];
  const cfg = JSON.parse(readFileSync(f, 'utf8'));
  return (cfg.headers || []).map((h) => ({ re: new RegExp('^' + h.source.replace(/\(\.\*\)/g, '.*') + '$'),
    cc: (h.headers.find((x) => x.key.toLowerCase() === 'cache-control') || {}).value })).filter((r) => r.cc);
}

export function startServer(port = 8490, { quiet = true, root = ROOT, vercel = false } = {}) {
  const rules = vercel ? cacheRules(root) : [];
  const packed = new Map();   // path -> { mtime, br, gz, etag }
  const srv = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
    const file = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
      const type = TYPES[extname(file)] || 'application/octet-stream';
      if (!vercel) {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(body); return;
      }
      let P = packed.get(file);
      if (!P || P.mtime !== st.mtimeMs) {
        const body = await readFile(file);
        P = { mtime: st.mtimeMs, raw: body, etag: '"' + createHash('sha1').update(body).digest('hex').slice(0, 16) + '"' };
        if (COMPRESSIBLE.test(type)) {
          P.br = brotliCompressSync(body, { params: { [Z.BROTLI_PARAM_QUALITY]: 9 } });
          P.gz = gzipSync(body, { level: 9 });
        }
        packed.set(file, P);
      }
      const rule = rules.find((r) => r.re.test(path));
      const h = { 'Content-Type': type, 'Cache-Control': rule ? rule.cc : 'public, max-age=0, must-revalidate', ETag: P.etag, Vary: 'Accept-Encoding' };
      if (req.headers['if-none-match'] === P.etag) { res.writeHead(304, h).end(); return; }
      const ae = req.headers['accept-encoding'] || '';
      let body = P.raw;
      if (P.br && /\bbr\b/.test(ae)) { body = P.br; h['Content-Encoding'] = 'br'; }
      else if (P.gz && /\bgzip\b/.test(ae)) { body = P.gz; h['Content-Encoding'] = 'gzip'; }
      h['Content-Length'] = body.length;
      res.writeHead(200, h); res.end(body);
    } catch {
      if (!quiet) console.log('404', path);
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = +(process.argv[2] || 8490);
  await startServer(port, { quiet: false, vercel: process.argv.includes('--vercel') });
  console.log(`serving ${ROOT} on http://localhost:${port}/`);
}
