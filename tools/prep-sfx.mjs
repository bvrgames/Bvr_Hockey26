// Match sounds from recordings: downloads the sources (CC0 only — see THIRD_PARTY.md), cuts each sound out, trims the
// silence, evens out the loudness and writes assets/src/sfx/<name>.wav (44.1 kHz mono 16 bit); `npm run assets` then
// encodes them to assets/dist/sfx-<name>.<hash>.m4a (AAC, like the music) and lists them in window.ASSETS.sfx.
//   node tools/prep-sfx.mjs [--cache <dir>]     (downloads are kept in the cache dir, default: the OS temp dir)
// mp3 / wav are decoded by macOS afconvert, ogg (Kenney) by Chromium (Playwright).
// Loudness: a one-shot's loudest 50 ms is set to ONE_DB rms (peak capped at -1 dBFS); the mix between sounds is in
// index.html (SFX). The crowd loop is set to LOOP_DB rms over its length and made seamless with an equal-power
// crossfade; LOOP_TAIL s of its start are appended after the loop, so the page loops [LOOP_PAD, LOOP_PAD + length]
// inside the decoded buffer and an AAC decoder that keeps a few ms of priming still lands on a seamless window.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), OUT = join(ROOT, 'assets', 'src', 'sfx');
const args = process.argv.slice(2), ci = args.indexOf('--cache');
const CACHE = ci >= 0 ? args[ci + 1] : join(tmpdir(), 'bvr-sfx');
const SR = 44100, ONE_DB = -14, LOOP_DB = -20, LOOP_XF = 0.6;
export const LOOP_TAIL = 1;   // tools/pack-assets.mjs: loop = [LOOP_TAIL / 2, duration - LOOP_TAIL / 2]

// sources: Freesound previews (CC0), Kenney packs (CC0), OpenGameArt (CC0)
const FS = (id, file) => ({ url: `https://cdn.freesound.org/previews/${Math.floor(id / 1000)}/${file}-hq.mp3`, file: `fs-${id}.mp3` });
const SRC = {
  practice: FS(416981, '416981_2780774'),   // simonlabelle — Ice Hockey Practice round
  check: FS(161996, '161996_2115985'),      // producerdan — Hockey - Huge Body Check Hit Into Boards
  whistle: FS(538422, '538422_11966684'),   // Rosa-Orenes256 — Referee whistle sound
  horn: FS(702099, '702099_15203576'),      // SEF7 — Hockey arena goal horn with crowd applause
  arena: FS(706497, '706497_15203576'),     // SEF7 — Rogers Arena - NHL game atmosphere
  coin: FS(830033, '830033_13183432'),      // JW_Audio — Coin, Pick-Up, Tonal, High Pitched, Digital_15
  impact: { url: 'https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip', file: 'kenney-impact.zip' },
  ui: { url: 'https://kenney.nl/media/pages/assets/ui-audio/490d233f68-1677590494/kenney_ui-audio.zip', file: 'kenney-ui.zip' },
  swish: { url: 'https://opengameart.org/sites/default/files/swishes.zip', file: 'oga-swishes.zip' },
};
// name → source, [in the zip], cut from…to (s), fades (s)
const SFX = {
  stick: { src: 'practice', from: 15.160, to: 15.300 },
  shot_wrist: { src: 'practice', from: 87.668, to: 88.050 },
  shot_slap: { src: 'practice', from: 209.010, to: 209.520 },
  hit: { src: 'check', from: 4.735, to: 5.550 },
  save: { src: 'impact', zip: 'Audio/impactPunch_medium_001.ogg' },
  post: { src: 'impact', zip: 'Audio/impactMetal_light_003.ogg' },
  whistle: { src: 'whistle' },
  horn: { src: 'horn', from: 3.350, to: 7.300, fadeOut: 1.2 },
  coin: { src: 'coin', to: 0.700, fadeOut: 0.35 },
  ui: { src: 'ui', zip: 'Audio/click5.ogg' },
  swap: { src: 'swish', zip: 'swishes/swish-11.wav' },
  crowd_loop: { src: 'arena', from: 33.0, to: 43.5, loop: true },
};

const sh = (cmd, a) => execFileSync(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'] });
function fetchSrc(k) {
  const s = SRC[k], f = join(CACHE, s.file);
  if (!existsSync(f)) sh('curl', ['-sfL', '--retry', '6', '--retry-all-errors', '--retry-delay', '3', '--max-time', '300', '-A', 'Mozilla/5.0', '-o', f, s.url]);
  if (!/\.zip$/.test(f)) return f;
  const d = f.replace(/\.zip$/, '');
  if (!existsSync(d)) sh('unzip', ['-oq', f, '-d', d]);
  return d;
}
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
async function decodeOgg(files) {   // Chromium decodes Vorbis; WebKit and afconvert do not
  const { chromium } = await import('playwright'), br = await chromium.launch(), p = await br.newPage();
  for (const [src, out] of files) {
    const pcm = await p.evaluate(async (b64) => {
      const u = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(u.buffer);
      const oc = new OfflineAudioContext(1, Math.ceil(buf.duration * 44100), 44100), s = oc.createBufferSource();
      s.buffer = buf; s.connect(oc.destination); s.start(); return Array.from((await oc.startRendering()).getChannelData(0));
    }, readFileSync(src).toString('base64'));
    writeWav(out, Float32Array.from(pcm));
  }
  await br.close();
}
const db = (v) => 20 * Math.log10(v + 1e-12), amp = (d) => Math.pow(10, d / 20);
const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

function trim(x) {   // silence: start 3 ms before the first sample above -36 dB of the peak, end after the last above -50 dB
  const p = peak(x); let a = 0, b = x.length;
  while (a < b && Math.abs(x[a]) < p * amp(-36)) a++;
  while (b > a && Math.abs(x[b - 1]) < p * amp(-50)) b--;
  return x.slice(Math.max(0, a - Math.round(0.003 * SR)), b);
}
function fade(x, fin, fout) {
  const ni = Math.round(fin * SR), no = Math.min(x.length, Math.round(fout * SR));
  for (let i = 0; i < ni; i++) x[i] *= i / ni;
  for (let i = 0; i < no; i++) x[x.length - 1 - i] *= Math.pow(i / no, 1.5);
  return x;
}
function oneShot(x) {   // loudest 50 ms → ONE_DB rms, peak ≤ -1 dBFS
  const w = Math.round(0.05 * SR); let best = 0;
  for (let i = 0; i + w <= Math.max(w, x.length); i += Math.round(w / 4)) best = Math.max(best, rms(x, i, Math.min(x.length, i + w)));
  const g = Math.min(amp(ONE_DB) / best, amp(-1) / peak(x));
  return { x: x.map((v) => v * g), loud: db(best * g), pk: db(peak(x) * g) };
}
function loop(x) {   // seamless: the head crossfades with what follows the end; then LOOP_TAIL s of the head again
  const c = Math.round(LOOP_XF * SR), L = x.length - c, y = new Float32Array(L + LOOP_TAIL * SR);
  for (let i = 0; i < L; i++) y[i] = x[i];
  for (let i = 0; i < c; i++) { const t = i / c; y[i] = x[i] * Math.sin(t * Math.PI / 2) + x[L + i] * Math.cos(t * Math.PI / 2); }
  for (let i = 0; i < LOOP_TAIL * SR; i++) y[L + i] = y[i % L];
  const g = amp(LOOP_DB) / rms(y, 0, L), out = y.map((v) => v * g);
  if (peak(out) > amp(-1)) throw new Error('crowd loop clips: lower LOOP_DB');
  return { x: out, loud: LOOP_DB, pk: db(peak(out)), len: L / SR };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(CACHE, { recursive: true }); mkdirSync(OUT, { recursive: true });
  const pcm = {}, ogg = [];
  for (const [name, s] of Object.entries(SFX)) {
    const got = fetchSrc(s.src), f = s.zip ? join(got, s.zip) : got, w = join(CACHE, `${s.src}-${(s.zip || 'src').replace(/\W/g, '_')}.wav`);
    if (!existsSync(w)) { if (/\.ogg$/.test(f)) ogg.push([f, w]); else sh('afconvert', ['-f', 'WAVE', '-d', `LEI16@${SR}`, '-c', '1', f, w]); }
    pcm[name] = w;
  }
  if (ogg.length) await decodeOgg(ogg);
  for (const [name, s] of Object.entries(SFX)) {
    let x = readWav(pcm[name]);
    x = x.slice(Math.round((s.from || 0) * SR), s.to ? Math.round(s.to * SR) : x.length);
    const r = s.loop ? loop(x) : oneShot(fade(trim(x), 0.002, s.fadeOut || Math.min(0.04, x.length / SR * 0.25)));
    writeWav(join(OUT, name + '.wav'), r.x);
    console.log(`${name.padEnd(11)} ${(r.x.length / SR).toFixed(3)} s  loud ${r.loud.toFixed(1)} dB  peak ${r.pk.toFixed(1)} dBFS${r.len ? `  loop ${r.len.toFixed(3)} s` : ''}`);
  }
  const extra = readdirSync(OUT).filter((f) => !SFX[f.replace(/\.wav$/, '')]);
  if (extra.length) console.log('not in SFX (delete?): ' + extra.join(', '));
}
