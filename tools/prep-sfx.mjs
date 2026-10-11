// Match sounds from the owner's own files: assets/src/sfx/<папка>/<файл>.mp3|wav (originals, never written) →
// assets/src/sfx-ready/<name>.wav (44.1 kHz mono 16 bit); `npm run assets` then encodes them to
// assets/dist/sfx-<name>.<hash>.m4a (AAC, like the music) and lists them in window.ASSETS.sfx.
//   node tools/prep-sfx.mjs [--cache <dir>]     (decoded originals are kept in the cache dir, default: the OS temp dir)
// mp3 / wav are decoded by macOS afconvert (downmixed to mono).
// Loudness — ITU-R BS.1770 (K-weighting): a one-shot's loudest 400 ms (momentary loudness) is set to ONE_LUFS, a loop's
// integrated loudness (gated) to LOOP_LUFS; peaks above CEIL dBFS go through a short limiter of at most MAX_GR dB (a sharper
// transient ends up quieter instead): no clipping, and the AAC encoder's overshoot stays under 0 dBFS. The mix between
// sounds (fans and arena well under the hits) is in index.html (SFX).
// One-shots: silence trimmed at both ends (they start at once), short fades. Loops: an equal-power crossfade of the end
// into the head makes them seamless; LOOP_TAIL s of the head are appended after the loop, so the page loops
// [LOOP_TAIL / 2, LOOP_TAIL / 2 + length] inside the decoded buffer and an AAC decoder that keeps a few ms of priming
// still lands on a seamless window. A loop name ends in _loop (tools/pack-assets.mjs).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IN = join(ROOT, 'assets', 'src', 'sfx'), OUT = join(ROOT, 'assets', 'src', 'sfx-ready'), MUS = join(ROOT, 'assets', 'src', 'music');
const args = process.argv.slice(2), ci = args.indexOf('--cache');
const CACHE = ci >= 0 ? args[ci + 1] : join(tmpdir(), 'bvr-sfx2');
const SR = 44100, ONE_LUFS = -16, LOOP_LUFS = -23, CEIL = -1.5, MAX_GR = 6;
export const LOOP_TAIL = 1;
// музыка арены на вбрасывании: из каждого трека меню (assets/src/music, по алфавиту — как ASSETS.music) два куска по
// MUS_LEN с (с 30 % и 62 % длины) → arena_m<трек>_<кусок>.wav, громкость MUS_LUFS по всей длине. Это короткие звуки, а не
// трек меню: качаются заранее и звучат сразу (трек в мегабайты на телефоне не успевал загрузиться за вбрасывание)
const MUS_AT = [0.30, 0.62], MUS_LEN = 16, MUS_LUFS = -14;   // tools/pack-assets.mjs: loop = [LOOP_TAIL / 2, duration - LOOP_TAIL / 2]

// name → file (folder/file under assets/src/sfx), cut from…to (s, of the original), max length after the trim (s),
// start threshold (dB under the peak; a quiet run-up before the hit is cut), loop: crossfade (s) or window (s, the
// steadiest part of a long recording), seamless: the file is already a seamless loop plus a 1 s tail
const SFX = {
  // арена и фанаты (петли; фанаты — по сборным матча, index.html sfxFans)
  crowd_loop: { f: 'Арена/crowd_loop.wav', loop: true, seamless: true },
  fan_a_loop: { f: 'Фанаты/FAN.mp3', loop: true, from: 1.0, to: 18.0, xf: 1.2 },
  fan_b_loop: { f: 'Фанаты/FAN 2.mp3', loop: true, from: 3.0, to: 29.5, xf: 1.2 },
  fan_rus_loop: { f: 'Фанаты/FAN RUSSIAN.mp3', loop: true, from: 1.0, to: 18.2, xf: 1.2 },
  fan_rusblr_loop: { f: 'Фанаты/FANS RUSSIAN AND BELARUSIAN.mp3', loop: true, from: 0.5, to: 7.9, xf: 1.0 },
  // «шайбу-шайбу» — ритм ~2.295 с: петля ровно на два такта (4.59 с) с 1.0 с + 0.3 с перекрёстного затухания
  fan_shaibu_loop: { f: 'Фанаты/шайбу шайбу.mp3', loop: true, from: 1.0, to: 5.89, xf: 0.3 },
  // катание (петля, громкость по скорости своего игрока; на матч — один из трёх)
  skate1_loop: { f: 'Катание/Катание.mp3', loop: true, win: 8, xf: 0.6 },
  skate2_loop: { f: 'Катание/Катание 2.mp3', loop: true, win: 8, xf: 0.6 },
  skate3_loop: { f: 'Катание/Катание 3.mp3', loop: true, win: 8, xf: 0.6 },
  // гол, судья
  horn: { f: 'Гол/horn.wav', fadeOut: 1.0 },
  horn2: { f: 'Гол/Сирена.mp3', max: 4.5, fadeOut: 1.2 },
  joy: { f: 'Гол/Радость.mp3', max: 6.0, fadeOut: 2.0 },   // трибуны радуются голу (вместе с сиреной)
  whistle: { f: 'Рефери/whistle.wav' },
  whistle2: { f: 'Рефери/Свист.mp3' },
  // силовой: в открытом льду (случайно один из пяти) / у борта
  hit: { f: 'Силовой /hit.wav' },
  hit_boards: { f: 'Силовой /Об борт.mp3', start: -20, max: 2.2, fadeOut: 0.8 },
  hit2: { f: 'Силовой /силовой 2.mp3', start: -20, max: 1.6, fadeOut: 0.6 },   // разбег перед ударом срезан
  hit3: { f: 'Силовой /силовой 3.mp3', start: -20, max: 1.6, fadeOut: 0.6 },
  hit4: { f: 'Силовой /силовой 4.mp3', start: -20, max: 1.6, fadeOut: 0.6 },
  hit_hard: { f: 'Силовой /силовой жесткий.mp3', start: -20, max: 1.6, fadeOut: 0.6 },
  // торможение, разворот
  brake1: { f: 'Торможение/Торможение 1.mp3' },
  brake2: { f: 'Торможение/Торможение 2.mp3' },
  brake3: { f: 'Торможение/Торможение 3.mp3' },
  brake4: { f: 'Торможение/Торможение 4.mp3' },
  turn: { f: 'Разворот/Разворот.mp3', max: 1.8, fadeOut: 0.4 },
  // броски, шайба в борт, штанга
  shot_wrist: { f: 'Удар/кистевой бросок.mp3' },
  shot_slap: { f: 'Удар/удар по шайбе .mp3', max: 1.4, fadeOut: 0.5 },
  boards: { f: 'Удар/ударил попал в борт.mp3', max: 1.4, fadeOut: 0.5 },
  post: { f: 'Штанга/шайба об штангу.mp3', max: 1.4, fadeOut: 0.5 },
  // пасы
  pass1: { f: 'пас/пас.mp3', max: 1.0, fadeOut: 0.4 },
  pass2: { f: 'пас/пас 2.mp3', max: 1.0, fadeOut: 0.4 },
  pass3: { f: 'пас/пас 3.mp3', max: 1.0, fadeOut: 0.4 },
  pass_hard: { f: 'пас/пас сильный.mp3', to: 2.7, max: 1.4, fadeOut: 0.5 },   // после 2.9 с в файле — второй удар
  // сейв
  save: { f: 'сейв/save.wav' },
  save2: { f: 'сейв/сейв.mp3' },
  // меню
  ui_swipe: { f: 'меню/Свайп.mp3' },
  ui_back: { f: 'меню/Назад.mp3' },
  // монета на экране итога — запись из прежнего набора (CC0, THIRD_PARTY.md): новой нет, оставлена по просьбе
  coin: { f: 'coin.wav' },
};

const sh = (cmd, a) => execFileSync(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'] });
function readWav(f) {
  const b = readFileSync(f); let o = 12, fmt = null;
  while (o < b.length) {
    const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') {
      if (!fmt || fmt.ch !== 1 || fmt.sr !== SR || fmt.bits !== 16) throw new Error(f + ': want 44.1 kHz mono 16 bit');
      const x = new Float32Array(n / 2); for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(o + 8 + i * 2) / 32768; return x;
    }
    o += 8 + n + (n & 1);
  }
  throw new Error(f + ': no data');
}
function writeWav(f, x) {
  const n = x.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  writeFileSync(f, b);
}
const db = (v) => 20 * Math.log10(v + 1e-12), amp = (d) => Math.pow(10, d / 20);
const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

// BS.1770 K-weighting: high shelf (+4 dB above ~1.7 kHz) and the RLB high-pass, as biquads for SR
function biquad(x, b, a) {
  const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
function kWeight(x) {
  let K = Math.tan(Math.PI * 1681.974450955533 / SR), Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416), Q = 0.7071752369554196;
  let a0 = 1 + K / Q + K * K;
  const s = biquad(x, [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0], [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]);
  K = Math.tan(Math.PI * 38.13547087602444 / SR); Q = 0.5003270373238773; a0 = 1 + K / Q + K * K;
  return biquad(s, [1, -2, 1], [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]);
}
function blocks(x) {   // mean square of K-weighted 400 ms blocks, 75 % overlap; a sound shorter than 400 ms is one block
  const k = kWeight(x), w = Math.round(0.4 * SR), hop = Math.round(0.1 * SR), z = [];
  if (k.length <= w) { let s = 0; for (const v of k) s += v * v; return [s / w]; }
  for (let a = 0; a + w <= k.length; a += hop) { let s = 0; for (let i = a; i < a + w; i++) s += k[i] * k[i]; z.push(s / w); }
  return z;
}
const lufs = (ms) => -0.691 + 10 * Math.log10(ms + 1e-20);
const momentaryMax = (x) => lufs(Math.max(...blocks(x)));
function integrated(x) {   // gated: absolute −70 LUFS, then relative −10 LU
  const z = blocks(x).filter((m) => lufs(m) > -70), mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  const rel = lufs(mean(z)) - 10;
  return lufs(mean(z.filter((m) => lufs(m) > rel)));
}
// gain by gainDb (less, if the limiter would have to take over MAX_GR dB: a sharp click stays a click), then a limiter: the gain dips where a peak would pass CEIL — smoothly, 5 ms before it and 80 ms after
// (both passes only lower the gain, so no sample is over CEIL)
function level(x, gainDb) {
  const over = db(peak(x)) + gainDb - CEIL, g = amp(gainDb - Math.max(0, over - MAX_GR)), c = amp(CEIL), n = x.length, env = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = Math.abs(x[i] * g); env[i] = v > c ? c / v : 1; }
  const att = Math.exp(-1 / (0.005 * SR)), rel = Math.exp(-1 / (0.08 * SR));
  let e = 1, mn = 0;
  for (let i = n - 1; i >= 0; i--) { e = Math.min(env[i], 1 - (1 - e) * att); env[i] = e; }    // backward: the dip starts before the peak…
  e = 1;
  for (let i = 0; i < n; i++) { e = Math.min(env[i], 1 - (1 - e) * rel); env[i] = e; mn = Math.min(mn, db(e)); }   // …and recovers after it
  const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = x[i] * g * env[i];
  return { y, gr: mn };
}

function trim(x, startDb = -36) {   // silence: start 3 ms before the first sample above startDb of the peak, end after the last above −50 dB
  const p = peak(x); let a = 0, b = x.length;
  while (a < b && Math.abs(x[a]) < p * amp(startDb)) a++;
  while (b > a && Math.abs(x[b - 1]) < p * amp(-50)) b--;
  return x.slice(Math.max(0, a - Math.round(0.003 * SR)), b);
}
function fade(x, fin, fout) {
  const ni = Math.round(fin * SR), no = Math.min(x.length, Math.round(fout * SR));
  for (let i = 0; i < ni; i++) x[i] *= i / ni;
  for (let i = 0; i < no; i++) x[x.length - 1 - i] *= Math.pow(i / no, 1.5);
  return x;
}
function steadiest(x, sec) {   // the window of sec s whose 0.5 s levels vary least (no single loud stride in the loop)
  const h = Math.round(0.5 * SR), lv = [];
  for (let a = 0; a + h <= x.length; a += h) { let s = 0; for (let i = a; i < a + h; i++) s += x[i] * x[i]; lv.push(db(Math.sqrt(s / h))); }
  const n = Math.round(sec / 0.5); let best = 0, bv = Infinity;
  for (let i = 1; i + n < lv.length - 1; i++) {   // not the first / last 0.5 s (fades of the recording)
    const w = lv.slice(i, i + n), m = w.reduce((s, v) => s + v, 0) / n, v = w.reduce((s, q) => s + (q - m) ** 2, 0) / n;
    if (v < bv) { bv = v; best = i; }
  }
  return x.slice(best * h, (best + n) * h + Math.round(0.6 * SR));   // + the crossfade
}
function oneShot(x, s) {
  x = trim(x, s.start);
  if (s.max && x.length > s.max * SR) x = x.slice(0, Math.round(s.max * SR));
  x = fade(x, 0.002, s.fadeOut || Math.min(0.04, x.length / SR * 0.25));
  const r = level(x, ONE_LUFS - momentaryMax(x));
  return { x: r.y, loud: momentaryMax(r.y), gr: r.gr };
}
function loop(x, s) {   // seamless: the head crossfades with what follows the end; then LOOP_TAIL s of the head again
  let y, L;
  if (s.seamless) { L = x.length - LOOP_TAIL * SR; y = x.slice(0, L + LOOP_TAIL * SR); }
  else {
    if (s.win) x = steadiest(x, s.win);
    const c = Math.round((s.xf || 0.6) * SR); L = x.length - c; y = new Float32Array(L + LOOP_TAIL * SR);
    for (let i = 0; i < L; i++) y[i] = x[i];
    for (let i = 0; i < c; i++) { const t = i / c; y[i] = x[i] * Math.sin(t * Math.PI / 2) + x[L + i] * Math.cos(t * Math.PI / 2); }
    for (let i = 0; i < LOOP_TAIL * SR; i++) y[L + i] = y[i % L];
  }
  const body = y.slice(0, L), r = level(y, LOOP_LUFS - integrated(body));
  return { x: r.y, loud: integrated(r.y.slice(0, L)), gr: r.gr, len: L / SR };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(CACHE, { recursive: true }); mkdirSync(OUT, { recursive: true });
  for (const [name, s] of Object.entries(SFX)) {
    const src = join(IN, s.f);
    if (!existsSync(src)) throw new Error('no file ' + s.f);
    const w = join(CACHE, createHash('sha1').update(readFileSync(src)).digest('hex').slice(0, 16) + '.wav');
    if (!existsSync(w)) sh('afconvert', ['-f', 'WAVE', '-d', `LEI16@${SR}`, '-c', '1', src, w]);
    let x = readWav(w);
    x = x.slice(Math.round((s.from || 0) * SR), s.to ? Math.round(s.to * SR) : x.length);
    const r = s.loop ? loop(x, s) : oneShot(x, s);
    writeWav(join(OUT, name + '.wav'), r.x);
    console.log(`${name.padEnd(16)} ${(r.x.length / SR).toFixed(3)} s  ${r.loud.toFixed(1)} LUFS${s.loop ? '-I' : '-M'}  peak ${db(peak(r.x)).toFixed(1)} dBFS` +
      `${r.gr < -0.05 ? `  limiter ${r.gr.toFixed(1)} dB` : ''}${r.len ? `  loop ${r.len.toFixed(3)} s` : ''}  ← ${s.f}`);
  }
  const tracks = existsSync(MUS) ? readdirSync(MUS).filter((f) => /\.mp3$/i.test(f)).sort((a, b) => a.normalize('NFC').localeCompare(b.normalize('NFC'))) : [];
  const made = new Set(Object.keys(SFX));
  tracks.forEach((f, ti) => {
    const src = join(MUS, f), w = join(CACHE, createHash('sha1').update(readFileSync(src)).digest('hex').slice(0, 16) + '.wav');
    if (!existsSync(w)) sh('afconvert', ['-f', 'WAVE', '-d', `LEI16@${SR}`, '-c', '1', src, w]);
    const x = readWav(w);
    MUS_AT.forEach((at, ci) => {
      const a = Math.round(x.length * at), y = fade(x.slice(a, Math.min(x.length, a + MUS_LEN * SR)), 0.03, 1.0);
      const r = level(y, MUS_LUFS - integrated(y)), name = `arena_m${ti}_${ci}`;
      writeWav(join(OUT, name + '.wav'), r.y); made.add(name);
      console.log(`${name.padEnd(16)} ${(r.y.length / SR).toFixed(3)} s  ${integrated(r.y).toFixed(1)} LUFS-I  peak ${db(peak(r.y)).toFixed(1)} dBFS` +
        `${r.gr < -0.05 ? `  limiter ${r.gr.toFixed(1)} dB` : ''}  ← music/${f.normalize('NFC')} ${(at * 100) | 0} %`);
    });
  });
  for (const f of readdirSync(OUT)) if (!made.has(f.replace(/\.wav$/, ''))) { unlinkSync(join(OUT, f)); console.log('removed ' + f); }
}
