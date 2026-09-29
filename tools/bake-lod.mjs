// Bakes the low-detail player meshes (LOD) into assets/src/hd_lod.json: a second index buffer for the same vertices,
// made with meshoptimizer's simplifier. The vertices are untouched, so bone weights, team-colour slots and baked AO stay
// exactly as they are; only fewer triangles are drawn. Used on the low and medium graphics levels (weak Android GPUs
// are bound by the 12 × 23k skinned triangles, see tools/perf.mjs). Rerun after the models in assets/src/hd_data.json
// change, then node tools/pack-assets.mjs.
// usage: node tools/bake-lod.mjs [--ratio 0.22] [--error 0.02]
import { readFileSync, writeFileSync } from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? +args[i + 1] : d; };
const RATIO = opt('ratio', 0.22), ERR = opt('error', 0.02);
const SRC = new URL('../assets/src/hd_data.json', import.meta.url), OUT = new URL('../assets/src/hd_lod.json', import.meta.url);
const HD = JSON.parse(readFileSync(SRC, 'utf8'));
await MeshoptSimplifier.ready;

const out = {};
for (const name of ['skater', 'goalie']) {
  const PD = HD[name], nv = PD.nv, ni = PD.ni;
  const b = Buffer.from(PD.mesh, 'base64');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) pos[i] = (dv.getInt16(i * 2, true) + 32767) * PD.sc[i % 3] + PD.lo[i % 3];
  const io = nv * 6 + nv * 3 + nv * 3 + nv + nv * 4 + nv * 4;          // same layout as hdModel() in index.html
  const idx = new Uint32Array(ni);
  for (let i = 0; i < ni; i++) idx[i] = dv.getUint16(io + i * 2, true);
  const target = Math.floor(ni * RATIO / 3) * 3;
  const [lo, err] = MeshoptSimplifier.simplify(idx, pos, 3, target, ERR, []);
  const u16 = new Uint16Array(lo);
  out[name] = { ni: u16.length, idx: Buffer.from(u16.buffer).toString('base64') };
  console.log(`${name}: ${ni / 3} → ${u16.length / 3} triangles (target ${target / 3}, error ${err.toFixed(4)})`);
}
const txt = JSON.stringify(out);
writeFileSync(OUT, txt);
console.log(`assets/src/hd_lod.json written (${(txt.length / 1024).toFixed(1)} KB) — now: node tools/pack-assets.mjs`);
