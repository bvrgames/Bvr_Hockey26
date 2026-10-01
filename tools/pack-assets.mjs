// Game assets outside index.html: the player models (mesh, skeleton, clips, LOD indices) and the PNG textures live as
// sources in assets/src/ and are published as content-hashed files in assets/dist/ (cached forever, see vercel.json).
// index.html only carries a small head script with the manifest (window.ASSETS) that also starts the model download.
//
//   assets/src/hd_data.json   HD_DATA as before (skater / goalie: nv, ni, lo, sc, bones, …, mesh + anim as base64)
//   assets/src/hd_lod.json    HD_LOD (tools/bake-lod.mjs): LOD index buffers as base64
//   assets/src/{env,ads,logo}.png
//   assets/src/train.js       the training lessons (index.html loads them on entering «Тренировка») → assets/dist/train.<hash>.js
//   assets/dist/players-lo.<hash>.bin  skeleton, clips, animation, compact LOD meshes (what every level needs first)
//   assets/dist/players-hi.<hash>.bin  full meshes (high level only; loaded on demand)
//     both: 'BVR1', u32 header length, header JSON (blobs as [offset, length]), raw blobs 4-byte aligned — no base64
//   assets/dist/<name>.<hash>.png
//   assets/src/music/*.mp3    menu music (title = file name, artist BvR) → assets/dist/music-<hash>.m4a, AAC 96 kbit/s via
//                             macOS afconvert; the hash is of the source + encoder settings, so --check never re-encodes
//   assets/src/fonts/*.woff2  menu font (Fira Sans Extra Condensed 800 italic, OFL) → assets/dist/font-lat|font-cyr.<hash>.woff2
//
// usage: node tools/pack-assets.mjs            rebuild dist + manifest (after changing anything in assets/src)
//        node tools/pack-assets.mjs --check    exit 1 if index.html / dist are out of date (npm run check)
//        node tools/pack-assets.mjs --extract  one-time: move the inline data out of index.html into assets/src
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'assets', 'src'), DIST = join(ROOT, 'assets', 'dist'), HTML = join(ROOT, 'index.html');
const IMAGES = ['env', 'ads', 'logo'];
const MUSIC = join(SRC, 'music'), FONTS = join(SRC, 'fonts');
const AAC = ['-f', 'm4af', '-d', 'aac', '-b', '96000'];      // afconvert arguments (part of the music file hash)
const FONT_FILES = { fontLat: 'fira-sans-extra-condensed-latin-800-italic.woff2', fontCyr: 'fira-sans-extra-condensed-cyrillic-800-italic.woff2' };
const args = process.argv.slice(2);
const hash = (b) => createHash('sha1').update(b).digest('hex').slice(0, 10);

function extract() {
  const lines = readFileSync(HTML, 'utf8').split('\n');
  const take = (prefix) => { const i = lines.findIndex((l) => l.startsWith(prefix)); if (i < 0) throw new Error(prefix + ' not found'); const v = lines[i]; lines.splice(i, 1); return v; };
  mkdirSync(SRC, { recursive: true });
  const hd = take('var HD_DATA=').slice('var HD_DATA='.length).replace(/;\s*$/, '');
  writeFileSync(join(SRC, 'hd_data.json'), JSON.stringify(JSON.parse(hd)));
  const lod = take('var HD_LOD=').slice('var HD_LOD='.length).replace(/;\s*$/, '');
  writeFileSync(join(SRC, 'hd_lod.json'), JSON.stringify(JSON.parse(lod)));
  for (const n of IMAGES) {
    const i = lines.findIndex((l) => l.startsWith(`TEX.${n}.src="data:image/png;base64,`));
    if (i < 0) throw new Error(`TEX.${n}.src not found`);
    const b64 = /base64,([^"]+)"/.exec(lines[i])[1];
    writeFileSync(join(SRC, n + '.png'), Buffer.from(b64, 'base64'));
    lines[i] = `TEX.${n}.src=ASSETS.${n};`;
  }
  // the manifest goes where HD_DATA was (before the textures use it)
  const at = lines.findIndex((l) => l.startsWith('/* ---------- логотип клуба'));
  lines.splice(at, 0, 'var ASSETS={};', '');
  writeFileSync(HTML, lines.join('\n'));
  console.log('extracted HD_DATA, HD_LOD and ' + IMAGES.join(', ') + ' into assets/src');
}

// Mesh bytes, per vertex attribute one after another (SoA): position int16×3, normal int8×3, colour u8×3, slot u8,
// joints u8×4, weights u8×4 — then indices u16. Same layout as hdGeo() in index.html.
const ATTR = [6, 3, 3, 1, 4, 4];
// the LOD mesh with only the vertices its indices use (a third of the full mesh): its own compact vertex set
function compactLod(meshB64, nv, ni, idxB64) {
  const mesh = Buffer.from(meshB64, 'base64'), idx = new Uint16Array(new Uint8Array(Buffer.from(idxB64, 'base64')).buffer);
  const remap = new Int32Array(nv).fill(-1), order = [];
  const out = new Uint16Array(idx.length);
  for (let i = 0; i < idx.length; i++) { let r = remap[idx[i]]; if (r < 0) { r = remap[idx[i]] = order.length; order.push(idx[i]); } out[i] = r; }
  const n = order.length, parts = [];
  let off = 0;
  for (const sz of ATTR) {
    const src = mesh.subarray(off, off + nv * sz), dst = Buffer.alloc(n * sz);
    for (let v = 0; v < n; v++) src.copy(dst, v * sz, order[v] * sz, order[v] * sz + sz);
    parts.push(dst); off += nv * sz;
  }
  parts.push(Buffer.from(out.buffer));
  return { nv: n, ni: out.length, mesh: Buffer.concat(parts) };
}
// file: 'BVR1', u32 header length, header JSON (blobs as [offset, length] from the end of the header), blobs 4-aligned
function packFile(fill) {
  const blobs = []; let off = 0;
  const add = (buf) => { const at = off; blobs.push(buf); off += buf.length; const pad = (4 - (off % 4)) % 4; if (pad) { blobs.push(Buffer.alloc(pad)); off += pad; } return [at, buf.length]; };
  const head = fill(add);
  let hj = Buffer.from(JSON.stringify(head));
  const hpad = (4 - ((8 + hj.length) % 4)) % 4; hj = Buffer.concat([hj, Buffer.alloc(hpad, 0x20)]);
  const pre = Buffer.alloc(8); pre.write('BVR1', 0, 'ascii'); pre.writeUInt32LE(hj.length, 4);
  return Buffer.concat([pre, hj, ...blobs]);
}
// players-lo: skeleton, clips, animation and the compact LOD mesh — enough for every level (high shows it until the
// full mesh arrives); players-hi: the full meshes, loaded only for the high level
function packPlayers() {
  const hd = JSON.parse(readFileSync(join(SRC, 'hd_data.json'), 'utf8'));
  const lod = JSON.parse(readFileSync(join(SRC, 'hd_lod.json'), 'utf8'));
  const lo = packFile((add) => {
    const head = {};
    for (const k of Object.keys(hd)) {
      const m = { ...hd[k] }, g = compactLod(m.mesh, m.nv, m.ni, lod[k].idx);
      delete m.mesh; delete m.nv; delete m.ni;
      m.anim = add(Buffer.from(m.anim, 'base64'));
      m.geo = { nv: g.nv, ni: g.ni, mesh: add(g.mesh) };
      head[k] = m;
    }
    return head;
  });
  const hi = packFile((add) => {
    const head = {};
    for (const k of Object.keys(hd)) head[k] = { geo: { nv: hd[k].nv, ni: hd[k].ni, mesh: add(Buffer.from(hd[k].mesh, 'base64')) } };
    return head;
  });
  return { lo, hi };
}

function build() {
  const P = packPlayers();
  const files = { lo: ['players-lo', 'bin', P.lo], hi: ['players-hi', 'bin', P.hi] };
  for (const n of IMAGES) files[n] = [n, 'png', readFileSync(join(SRC, n + '.png'))];
  files.train = ['train', 'js', readFileSync(join(SRC, 'train.js'))];   // lesson code, loaded on entering the training
  const manifest = {};
  for (const [k, [n, ext, buf]] of Object.entries(files)) manifest[k] = `assets/dist/${n}.${hash(buf)}.${ext}`;
  manifest.loBytes = P.lo.length; manifest.hiBytes = P.hi.length;   // loading progress (content-length is compressed)
  for (const [k, f] of Object.entries(FONT_FILES)) {
    const buf = readFileSync(join(FONTS, f));
    files[k] = [k === 'fontLat' ? 'font-lat' : 'font-cyr', 'woff2', buf];
    manifest[k] = `assets/dist/${files[k][0]}.${hash(buf)}.woff2`;
  }
  // music: the output file is named by the hash of its source, encoded only when missing (encoding is slow, mac only)
  const music = [];
  const srcs = existsSync(MUSIC) ? readdirSync(MUSIC).filter((f) => /\.mp3$/i.test(f)).sort((a, b) => a.normalize('NFC').localeCompare(b.normalize('NFC'))) : [];
  for (const f of srcs) {
    const src = join(MUSIC, f), h = hash(Buffer.concat([readFileSync(src), Buffer.from('|' + AAC.join(' '))]));
    music.push({ n: f.replace(/\.mp3$/i, '').normalize('NFC'), u: `assets/dist/music-${h}.m4a`, src });
  }
  manifest.music = music.map((m) => ({ n: m.n, u: m.u }));
  return { files, manifest, music };
}

function htmlWith(html, manifest) {
  // the manifest and the start of the model download sit in a tiny script at the top of <head>: the download runs while
  // the page is parsed, in every browser (a <link rel=preload as=fetch> is not reused by fetch() in WebKit = twice)
  const tag = '<script data-asset="players">window.ASSETS=' + JSON.stringify(manifest) +
    ';try{window.PLAYERS_FETCH=fetch(window.ASSETS.lo);}catch(e){}</script>';
  const re = /<script data-asset="players">.*?<\/script>/;
  if (re.test(html)) return html.replace(re, () => tag);
  html = html.replace(/<link rel="preload"[^>]*data-asset="players">\n?/, '');
  if (!/<script src="https:\/\/telegram\.org/.test(html)) throw new Error('telegram script tag not found in index.html');
  return html.replace(/<script src="https:\/\/telegram\.org/, () => tag + '\n<script src="https://telegram.org');
}

if (args.includes('--extract')) extract();
const { files, manifest, music } = build();
const allPaths = Object.values(manifest).filter((p) => typeof p === 'string').concat(manifest.music.map((m) => m.u));
const html = readFileSync(HTML, 'utf8'), want = htmlWith(html, manifest);
if (args.includes('--check')) {
  const bad = [];
  if (want !== html) bad.push('index.html manifest / preload are out of date');
  for (const p of allPaths) if (!existsSync(join(ROOT, p))) bad.push(p + ' is missing');
  if (bad.length) { console.log(bad.join('\n') + '\n→ node tools/pack-assets.mjs'); process.exit(1); }
  console.log('assets ok: ' + allPaths.join(', '));
} else {
  mkdirSync(DIST, { recursive: true });
  const keep = new Set(allPaths.map((p) => p.split('/').pop()));
  for (const f of readdirSync(DIST)) if (!keep.has(f)) unlinkSync(join(DIST, f));
  for (const [k, [, , buf]] of Object.entries(files)) writeFileSync(join(ROOT, manifest[k]), buf);
  for (const m of music) {
    const out = join(ROOT, m.u);
    if (!existsSync(out)) execFileSync('afconvert', [...AAC, m.src, out]);
    console.log(`${m.u}  ${(readFileSync(out).length / 1024).toFixed(1)} KB  (${m.n})`);
  }
  writeFileSync(HTML, want);
  for (const [k, [, , buf]] of Object.entries(files)) console.log(`${manifest[k]}  ${(buf.length / 1024).toFixed(1)} KB`);
}
