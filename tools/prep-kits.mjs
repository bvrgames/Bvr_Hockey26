// Kit and flag pictures for the team select (countries → kits): the designer's sheets (front and back, two kits) →
// the front view of each kit on a transparent background + a small flag, into assets/src/kits/ (then `npm run assets`).
//   node tools/prep-kits.mjs <folder>   (the folder has one sub-folder per country: <kit sheet> + "<…> FLAG.<ext>")
// The sheet's top row holds the fronts: left half — kit L, right half — kit R; KITS says which one is the bright kit (0).
import { readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const SRC = process.argv[2];
if (!SRC) { console.error('usage: node tools/prep-kits.mjs <folder>'); process.exit(1); }
const OUT = 'assets/src/kits';
// id → [folder, bright kit on the left?, patches over the kit to paint out (fractions of the half-sheet crop: x0,y0,x1,y1),
//        white kit cut by the bright kit's outline?] — a white kit on a grey sheet differs from the background by a few
//        levels only (226 vs 225), the flood fill runs into it; both kits of a sheet are one mock-up, so the bright kit's
//        clean outline, scaled to the white kit's box, is its outline too
const KITS = {
  rus: ['RUSSIA', true], can: ['CANADA', true], usa: ['USA', true, null, true], swe: ['SWEDEN', true, [[0.63, 0.815, 1, 1]]],
  ger: ['GERMANY', true], kaz: ['Kazakhstan', true, null, true], blr: ['BELARUS', false, null, true], urs: ['СССР', true, null, true],
};
const H = 240;          // kit picture height, px (the card shows it at ~110 css px, 2x screens)

// background → transparent: flood fill from the crop's border. A pixel joins the background when it is light and grey,
// close to the border colour and to the neighbour it is reached from (the sheets have soft gradients and shadows, the
// white kits have a thin outline — a plain colour threshold either leaves the background or eats into a white kit)
function cutBg(px, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const i = (y * w + x) * 4; r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
  r /= n; g /= n; b /= n;
  const grey = (i) => Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) < 22 && px[i] > 150;
  const dBg = (i) => Math.hypot(px[i] - r, px[i + 1] - g, px[i + 2] - b);
  const step = (i, j) => Math.hypot(px[i] - px[j], px[i + 1] - px[j + 1], px[i + 2] - px[j + 2]);
  const bg = new Uint8Array(w * h), st = [];
  const go = (k, from) => { if (bg[k]) return; const i = k * 4; if (!grey(i) || dBg(i) > 60 || (from >= 0 && step(i, from * 4) > 7)) return; bg[k] = 1; st.push(k); };
  for (let x = 0; x < w; x++) { go(x, -1); go((h - 1) * w + x, -1); }
  for (let y = 0; y < h; y++) { go(y * w, -1); go(y * w + w - 1, -1); }
  while (st.length) { const k = st.pop(), x = k % w, y = (k / w) | 0;
    if (x > 0) go(k - 1, k); if (x < w - 1) go(k + 1, k); if (y > 0) go(k - w, k); if (y < h - 1) go(k + w, k); }
  for (let k = 0; k < w * h; k++) if (bg[k]) px[k * 4 + 3] = 0;
  // soft edge: a kit pixel touching the background gets half alpha
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const k = y * w + x;
    if (!bg[k] && (bg[k - 1] || bg[k + 1] || bg[k - w] || bg[k + w])) px[k * 4 + 3] = 150; }
}
// a patch drawn over the kit (Sweden: the name-plate swatches): inside the kit's outline — the kit colour of the same row
// just left of the patch, outside — transparent (the outline continues straight down from the row above the patch)
// only the largest opaque piece stays: the crop's bottom edge catches the collars of the back views in the next row
function largest(px, w, h) {
  const lab = new Int32Array(w * h), size = [0];
  for (let k0 = 0; k0 < w * h; k0++) {
    if (lab[k0] || !px[k0 * 4 + 3]) continue;
    const id = size.length, st = [k0]; lab[k0] = id; let n = 0;
    while (st.length) { const k = st.pop(), x = k % w; n++;
      for (const j of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w]) if (j >= 0 && j < w * h && !lab[j] && px[j * 4 + 3]) { lab[j] = id; st.push(j); } }
    size.push(n);
  }
  let best = 1; for (let i = 2; i < size.length; i++) if (size[i] > size[best]) best = i;
  for (let k = 0; k < w * h; k++) if (lab[k] !== best) px[k * 4 + 3] = 0;
}
function box(px, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
// the white kit's box: from its clearly coloured pixels (stripes, cuffs, collar, side shadows) — not from the flood fill,
// which may run through a white kit to the crop's edges
function inkBox(px, w, h) {
  let r = 0, g = 0, bl = 0, n = 0;
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const i = (y * w + x) * 4; r += px[i]; g += px[i + 1]; bl += px[i + 2]; n++; }
  r /= n; g /= n; bl /= n;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) { const i = (y * w + x) * 4;
    if (Math.hypot(px[i] - r, px[i + 1] - g, px[i + 2] - bl) > 45) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
async function outline(px, w, h, bright) {
  const b = inkBox(px, w, h);
  const m = await sharp(bright.alpha, { raw: { width: bright.w, height: bright.h, channels: 1 } }).extract(bright.box)
    .resize(b.width, b.height, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height;
    px[(y * w + x) * 4 + 3] = inside ? m[(y - b.top) * b.width + (x - b.left)] : 0;
  }
}
function patch(px, w, h, [fx0, fy0, fx1, fy1]) {
  const x0 = Math.floor(fx0 * w), y0 = Math.floor(fy0 * h), x1 = Math.min(w, Math.ceil(fx1 * w)), y1 = Math.min(h, Math.ceil(fy1 * h));
  let edge = x0; for (let x = x1 - 1; x >= x0; x--) if (px[((y0 - 3) * w + x) * 4 + 3] > 200) { edge = x; break; }
  let bottom = y0; for (let y = y0; y < y1; y++) if (px[(y * w + x0 - 6) * 4 + 3] > 200) bottom = y;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * w + x) * 4, s = (y * w + x0 - 6) * 4;
    if (x <= edge && y <= bottom) { px[i] = px[s]; px[i + 1] = px[s + 1]; px[i + 2] = px[s + 2]; px[i + 3] = px[s + 3]; } else px[i + 3] = 0;
  }
}

mkdirSync(OUT, { recursive: true });
for (const [id, [dir, leftBright, masks, byOutline]] of Object.entries(KITS)) {
  let bright = null;
  const files = readdirSync(join(SRC, dir)).filter((f) => /\.(png|jpe?g)$/i.test(f));
  const flag = files.find((f) => /flag/i.test(f)), sheet = files.find((f) => !/flag/i.test(f));
  const img = sharp(join(SRC, dir, sheet)), meta = await img.metadata();
  const hw = Math.floor(meta.width / 2), hh = Math.floor(meta.height * 0.5);
  for (const [side, left] of [[0, leftBright], [1, !leftBright]]) {
    const { data, info } = await sharp(join(SRC, dir, sheet)).extract({ left: left ? 0 : meta.width - hw, top: 0, width: hw, height: hh })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    cutBg(data, info.width, info.height);
    for (const m of masks || []) patch(data, info.width, info.height, m);
    largest(data, info.width, info.height);
    if (side === 0) { const a = Buffer.alloc(info.width * info.height); for (let k = 0; k < a.length; k++) a[k] = data[k * 4 + 3];
      bright = { alpha: a, w: info.width, h: info.height, box: box(data, info.width, info.height) }; }
    else if (byOutline) await outline(data, info.width, info.height, bright);
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).trim({ threshold: 0 })
      .resize({ height: H }).webp({ quality: 84, alphaQuality: 90 }).toFile(join(OUT, `${id}${side}.webp`));
  }
  await sharp(join(SRC, dir, flag)).resize({ width: 120, height: 80, fit: 'cover' }).webp({ quality: 86 }).toFile(join(OUT, `${id}-flag.webp`));
  console.log(id, sheet, '+', flag);
}
