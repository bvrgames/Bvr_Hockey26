// The goalie model from Blender (GLB: skinned body + equipment parented to bones, actions as animations) → the game's
// format in assets/src/hd_data.json (key `goalie`, same layout as hdModel()/hdGeo() in index.html).
// The GLB comes from the Blender scripts in assets/src/Модель/Вратарь/anim_src (paint.py paints, export.py exports):
//   COLOR_0     own colour (sRGB) or, on team parts, baked shading in .r — as in the old models
//   TEXCOORD_0  decal atlas UV (crest / name / numbers, the atlas is drawn by the game per team)
//   TEXCOORD_1  .x = team slot: 0 own colour, 1 jersey (j), 2 second colour (p), 3 third (h)
// Equipment (helmet, pads, glove, blocker, stick) is rigid: each part follows the bone it hangs on (weight 1).
// Units: the armature is in cm (scale 0.01); everything is written in metres times SCALE (game size).
// usage: node tools/goalie-glb.mjs <goalie.glb> [--scale 0.9]  → then node tools/bake-lod.mjs && node tools/pack-assets.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? +args[i + 1] : d; };
const SCALE = opt('scale', 0.9), FPS = 20;
const OUT = new URL('../assets/src/hd_data.json', import.meta.url);
const glb = readFileSync(args[0]);
const jlen = glb.readUInt32LE(12), J = JSON.parse(glb.subarray(20, 20 + jlen).toString('utf8'));
const BIN = glb.subarray(20 + jlen + 8);

const CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function acc(i) {
  const a = J.accessors[i], bv = J.bufferViews[a.bufferView], T = CT[a.componentType], n = NC[a.type];
  const stride = bv.byteStride || n * T.BYTES_PER_ELEMENT, off = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = new Float64Array(a.count * n);
  const norm = a.normalized ? { 5121: 255, 5123: 65535, 5120: 127, 5122: 32767 }[a.componentType] : 1;
  for (let i2 = 0; i2 < a.count; i2++) {
    const v = new T(BIN.buffer, BIN.byteOffset + off + i2 * stride, n);
    for (let k = 0; k < n; k++) out[i2 * n + k] = v[k] / norm;
  }
  return { d: out, n, count: a.count };
}

// ---------- matrices (column-major 4×4) ----------
const mul = (a, b) => { const o = new Float64Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
function trs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q, m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0]; m[1] = (2 * (x * y + z * w)) * s[0]; m[2] = (2 * (x * z - y * w)) * s[0];
  m[4] = (2 * (x * y - z * w)) * s[1]; m[5] = (1 - 2 * (x * x + z * z)) * s[1]; m[6] = (2 * (y * z + x * w)) * s[1];
  m[8] = (2 * (x * z + y * w)) * s[2]; m[9] = (2 * (y * z - x * w)) * s[2]; m[10] = (1 - 2 * (x * x + y * y)) * s[2];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1; return m;
}
function inv(m) {   // rigid (rotation + translation) inverse
  const o = new Float64Array(16);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = m[r * 4 + c];
  for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * m[12] + o[4 + r] * m[13] + o[8 + r] * m[14]);
  o[15] = 1; return o;
}
const xf = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
const qnorm = (q) => { const l = Math.hypot(...q) || 1; return q.map((x) => x / l); };

// ---------- skeleton ----------
const nodes = J.nodes, parentOf = [];
nodes.forEach((n, i) => (n.children || []).forEach((c) => (parentOf[c] = i)));
const skin = J.skins[0], bodyNode = nodes.findIndex((n) => n.skin === 0);
const U = 0.01 * SCALE;                                   // cm → game metres
// joints that carry weight or equipment; leaf helpers (head_end, headfront) are dropped
const bodyPrim = J.meshes[nodes[bodyNode].mesh].primitives[0];
const JW = acc(bodyPrim.attributes.JOINTS_0), WW = acc(bodyPrim.attributes.WEIGHTS_0);
const used = new Set();
for (let i = 0; i < JW.d.length; i++) if (WW.d[i] > 0.001) used.add(skin.joints[JW.d[i]]);
const partNodes = nodes.map((n, i) => i).filter((i) => nodes[i].mesh !== undefined && i !== bodyNode);
for (const p of partNodes) used.add(parentOf[p]);
const isJoint = new Set(skin.joints);
const keep = skin.joints.filter((j) => used.has(j) || skin.joints.some((k) => used.has(k) && ancestors(k).includes(j)));
function ancestors(i) { const a = []; for (let p = parentOf[i]; p !== undefined; p = parentOf[p]) a.push(p); return a; }
// parents before children
const order = keep.slice().sort((a, b) => ancestors(a).length - ancestors(b).length);
const idx = new Map(order.map((j, i) => [j, i]));
const bones = order.map((j) => nodes[j].name);
const parent = order.map((j) => (isJoint.has(parentOf[j]) && idx.has(parentOf[j]) ? idx.get(parentOf[j]) : -1));
const restT = order.map((j) => (nodes[j].translation || [0, 0, 0]).map((x) => x * U));
const restR = order.map((j) => qnorm(nodes[j].rotation || [0, 0, 0, 1]));
const world = [];   // rest world matrices in game metres
order.forEach((j, i) => { const L = trs(restT[i], restR[i]); world[i] = parent[i] < 0 ? L : mul(world[parent[i]], L); });
const ibm = world.map((m) => Array.from(inv(m)).map((x) => +x.toFixed(6)));
const hip = bones.indexOf('Hips');
if (parent.filter((p) => p < 0).length !== 1 || parent[hip] !== -1) throw new Error('expected one root: Hips');

// ---------- meshes into one vertex list ----------
const V = { pos: [], nrm: [], col: [], slot: [], jnt: [], wgt: [], uv: [] }, I = [];
function add(prim, M, N, jfix) {
  const P = acc(prim.attributes.POSITION), Nn = acc(prim.attributes.NORMAL), C = acc(prim.attributes.COLOR_0);
  const T0 = acc(prim.attributes.TEXCOORD_0), T1 = acc(prim.attributes.TEXCOORD_1);
  const base = V.pos.length / 3;
  for (let i = 0; i < P.count; i++) {
    const p = xf(M, [P.d[i * 3], P.d[i * 3 + 1], P.d[i * 3 + 2]]);
    V.pos.push(...p);
    const n = [0, 1, 2].map((r) => N[r] * Nn.d[i * 3] + N[3 + r] * Nn.d[i * 3 + 1] + N[6 + r] * Nn.d[i * 3 + 2]);
    const l = Math.hypot(...n) || 1; V.nrm.push(...n.map((x) => x / l));
    // the exporter writes colours linear: back to sRGB (the shader takes vertex colour as sRGB, like the old models)
    for (let k = 0; k < 3; k++) V.col.push(Math.pow(Math.max(0, C.d[i * C.n + k]), 1 / 2.2));
    V.slot.push(Math.round(T1.d[i * 2]));
    V.uv.push(T0.d[i * 2], T0.d[i * 2 + 1]);
    const [j4, w4] = jfix(i); V.jnt.push(...j4); V.wgt.push(...w4);
  }
  const ix = acc(prim.indices); for (let i = 0; i < ix.count; i++) I.push(base + ix.d[i]);
}
const nmat = (m) => { // normal matrix (A⁻¹)ᵀ of the 3×3 part, laid out as N[c*3+r] for n'[r] = Σc N[c*3+r]·n[c]
  const A = [0, 1, 2].map((r) => [0, 1, 2].map((c) => m[c * 4 + r]));
  const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  const B = [0, 1, 2].map((r) => [0, 1, 2].map((c) => {   // inverse: B[r][c] = cofactor(c, r) / det
    const rr = [0, 1, 2].filter((x) => x !== c), cc = [0, 1, 2].filter((x) => x !== r);
    const minor = A[rr[0]][cc[0]] * A[rr[1]][cc[1]] - A[rr[0]][cc[1]] * A[rr[1]][cc[0]];
    return ((r + c) % 2 ? -minor : minor) / det;
  }));
  const N = []; for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) N[c * 3 + r] = B[c][r]; return N;
};
// the skinned body: the exporter writes its vertices in the bind pose in metres (the armature's 0.01 applied)
{
  const M = trs([0, 0, 0], [0, 0, 0, 1], [SCALE, SCALE, SCALE]);
  add(bodyPrim, M, [1, 0, 0, 0, 1, 0, 0, 0, 1], (i) => {
    const j = [], w = [];
    for (let k = 0; k < 4; k++) {
      const jn = skin.joints[JW.d[i * 4 + k]], ww = WW.d[i * 4 + k];
      if (ww > 0.001 && !idx.has(jn)) throw new Error('weight on a dropped joint ' + nodes[jn].name);
      j.push(ww > 0.001 ? idx.get(jn) : 0); w.push(ww);
    }
    return [j, w];
  });
}
for (const p of partNodes) {
  const jn = parentOf[p], ji = idx.get(jn);
  const n = nodes[p], L = trs((n.translation || [0, 0, 0]).map((x) => x * U), n.rotation || [0, 0, 0, 1], (n.scale || [1, 1, 1]).map((x) => x * U));
  const M = mul(world[ji], L);
  for (const prim of J.meshes[n.mesh].primitives) add(prim, M, nmat(M), () => [[ji, 0, 0, 0], [1, 0, 0, 0]]);
}
// Mirror X (the whole model, skeleton and clips alike): in the game the GLB comes out mirrored — the catching glove on
// the right hand and the writing reversed. Mirrored, the glove is on the left as on the reference, the decals read right.
for (let i = 0; i < V.pos.length; i += 3) { V.pos[i] = -V.pos[i]; V.nrm[i] = -V.nrm[i]; }
for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; }
restT.forEach((t) => (t[0] = -t[0]));
const mirQ = (q) => [q[0], -q[1], -q[2], q[3]];
for (const m of ibm) for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) if ((r === 0) !== (c === 0)) m[c * 4 + r] = -m[c * 4 + r];
const nv = V.pos.length / 3, ni = I.length;
if (nv > 65535) throw new Error(nv + ' vertices: more than u16 indices allow');

// ---------- pack: pos int16×3, nrm int8×3, col u8×3, slot u8, joints u8×4, weights u8×4, uv u16×2, indices u16 ----------
const lo = [0, 1, 2].map((k) => Math.min(...V.pos.filter((_, i) => i % 3 === k)));
const hi = [0, 1, 2].map((k) => Math.max(...V.pos.filter((_, i) => i % 3 === k)));
const sc = lo.map((l, k) => (hi[k] - l) / 65534);
const buf = Buffer.alloc(nv * (6 + 3 + 3 + 1 + 4 + 4 + 4) + ni * 2);
let o = 0;
for (let i = 0; i < nv * 3; i++) buf.writeInt16LE(Math.round((V.pos[i] - lo[i % 3]) / sc[i % 3]) - 32767, o + i * 2);
o += nv * 6;
for (let i = 0; i < nv * 3; i++) buf.writeInt8(Math.max(-127, Math.min(127, Math.round(V.nrm[i] * 127))), o + i);
o += nv * 3;
for (let i = 0; i < nv * 3; i++) buf[o + i] = Math.max(0, Math.min(255, Math.round(V.col[i] * 255)));
o += nv * 3;
for (let i = 0; i < nv; i++) buf[o + i] = V.slot[i];
o += nv;
for (let i = 0; i < nv * 4; i++) buf[o + i] = V.jnt[i];
o += nv * 4;
for (let i = 0; i < nv; i++) {   // weights to bytes summing to 255
  const w = V.wgt.slice(i * 4, i * 4 + 4), s = w.reduce((a, b) => a + b, 0) || 1;
  const b = w.map((x) => Math.round(x / s * 255)); b[b.indexOf(Math.max(...b))] += 255 - b.reduce((a, c) => a + c, 0);
  for (let k = 0; k < 4; k++) buf[o + i * 4 + k] = b[k];
}
o += nv * 4;
for (let i = 0; i < nv * 2; i++) buf.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(V.uv[i] * 65535))), o + i * 2);
o += nv * 4;
for (let i = 0; i < ni; i++) buf.writeUInt16LE(I[i], o + i * 2);

// ---------- clips: FPS frames, rotation relative to rest (x, y, z, w int16), hips offset (int16 / 4096) ----------
const LOOP = new Set(['ready', 'shuffle_c', 'shuffle_b']);
function sampler(anim, node, path) {
  const ch = anim.channels.find((c) => c.target.node === node && c.target.path === path);
  if (!ch) return null;
  const s = anim.samplers[ch.sampler], t = acc(s.input).d, v = acc(s.output), n = v.n;
  return (time) => {
    let k = 0; while (k < t.length - 1 && t[k + 1] <= time) k++;
    const k1 = Math.min(k + 1, t.length - 1), a = k1 === k ? 0 : Math.max(0, Math.min(1, (time - t[k]) / (t[k1] - t[k])));
    const A = Array.from(v.d.subarray(k * n, k * n + n)), B = Array.from(v.d.subarray(k1 * n, k1 * n + n));
    if (path === 'rotation' && A.reduce((s2, x, i) => s2 + x * B[i], 0) < 0) for (let i = 0; i < 4; i++) B[i] = -B[i];
    const r = A.map((x, i) => x + (B[i] - x) * a);
    return path === 'rotation' ? qnorm(r) : r;
  };
}
const clips = {}, anim = [];
let off = 0;
for (const a of J.animations) {
  const end = Math.max(...a.samplers.map((s) => { const t = acc(s.input).d; return t[t.length - 1]; }));
  const loop = LOOP.has(a.name);
  const n = loop ? Math.max(2, Math.round(end * FPS)) : Math.round(end * FPS) + 1;
  const dur = loop ? end : end * n / (n - 1);
  const rot = order.map((j) => sampler(a, j, 'rotation')), tr = sampler(a, order[hip], 'translation');
  const q = Buffer.alloc(n * order.length * 8), h = Buffer.alloc(n * 6);
  for (let f = 0; f < n; f++) {
    const t = loop ? f * end / n : f * end / (n - 1);
    order.forEach((j, b) => {
      const r = mirQ(rot[b] ? rot[b](t) : restR[b]);   // full local rotation: restR is written as identity (see below)
      for (let k = 0; k < 4; k++) q.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r[k])) * 32767), (f * order.length + b) * 8 + k * 2);
    });
    const ht = tr ? tr(t).map((x, k) => (k ? x * U : -x * U) - restT[hip][k]) : [0, 0, 0];   // restT is mirrored already
    for (let k = 0; k < 3; k++) h.writeInt16LE(Math.round(ht[k] * 4096), f * 6 + k * 2);
  }
  clips[a.name] = { n, dur: +dur.toFixed(4), rot: off, len: q.length, hips: off + q.length, hlen: h.length };
  anim.push(q, h); off += q.length + h.length;
}

const hd = JSON.parse(readFileSync(OUT, 'utf8'));
hd.goalie = {
  nv, ni, lo, sc, uv: 1, mesh: buf.toString('base64'), bones, parent, hip,
  // clip rotations are the bones' full local rotations and restR is identity, as in the old models (ibm keeps the bind pose)
  restT: restT.map((t) => t.map((x) => +x.toFixed(6))), restR: restR.map(() => [0, 0, 0, 1]), ibm,
  clips, anim: Buffer.concat(anim).toString('base64'),
};
writeFileSync(OUT, JSON.stringify(hd));
const tris = ni / 3, h0 = hi[1];
console.log(`goalie: ${bones.length} bones, ${nv} vertices, ${tris} triangles, height ${h0.toFixed(2)} m, clips: ` +
  Object.entries(clips).map(([k, c]) => `${k} ${c.n}/${c.dur}s`).join(', '));
