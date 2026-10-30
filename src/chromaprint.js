// Chromaprint audio fingerprints in plain JavaScript, for AcoustID lookups (acoustid.org).
// A port of Chromaprint's default algorithm (TEST2 / "algorithm 1"), the same one fpcalc and
// AcoustID use: 11025 Hz mono → 4096-sample Hamming-windowed FFT frames (hop 1365) → 12 chroma
// bands (28–3520 Hz) → 5-tap smoothing over time → normalise → 16 image classifiers → 32-bit
// sub-fingerprints → AcoustID's compressed, URL-safe base64 format.
// Checked bit-for-bit against libchromaprint 1.5.

export const SAMPLE_RATE = 11025;
const FRAME = 4096, HOP = FRAME - (FRAME - FRAME / 3 | 0); // overlap 2731 → hop 1365
const MIN_FREQ = 28, MAX_FREQ = 3520, BANDS = 12;
const FILTER = [0.25, 0.75, 1.0, 0.75, 0.25];
// [type, y, height, width], [t0, t1, t2]
const CLASSIFIERS = [
  [[0, 4, 3, 15], [1.98215, 2.35817, 2.63523]],
  [[4, 4, 6, 15], [-1.03809, -0.651211, -0.282167]],
  [[1, 0, 4, 16], [-0.298702, 0.119262, 0.558497]],
  [[3, 8, 2, 12], [-0.105439, 0.0153946, 0.135898]],
  [[3, 4, 4, 8], [-0.142891, 0.0258736, 0.200632]],
  [[4, 0, 3, 5], [-0.826319, -0.590612, -0.368214]],
  [[1, 2, 2, 9], [-0.557409, -0.233035, 0.0534525]],
  [[2, 7, 3, 4], [-0.0646826, 0.00620476, 0.0784847]],
  [[2, 6, 2, 16], [-0.192387, -0.029699, 0.215855]],
  [[2, 1, 3, 2], [-0.0397818, -0.00568076, 0.0292026]],
  [[5, 10, 1, 15], [-0.53823, -0.369934, -0.190235]],
  [[3, 6, 2, 10], [-0.124877, 0.0296483, 0.139239]],
  [[2, 1, 1, 14], [-0.101475, 0.0225617, 0.231971]],
  [[3, 5, 6, 4], [-0.0799915, -0.00729616, 0.063262]],
  [[1, 9, 2, 12], [-0.272556, 0.019424, 0.302559]],
  [[3, 4, 2, 14], [-0.164292, -0.0321188, 0.0846339]]
];
const MAX_WIDTH = 16;
const GRAY = [0, 1, 3, 2];

// ---------- FFT (radix-2, in place) ----------
const N = FRAME, LOG = 12;
const rev = new Uint16Array(N), cosT = new Float64Array(N / 2), sinT = new Float64Array(N / 2), win = new Float64Array(N);
for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < LOG; b++) r |= ((i >> b) & 1) << (LOG - 1 - b); rev[i] = r; }
for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / N); sinT[i] = -Math.sin(2 * Math.PI * i / N); }
for (let i = 0; i < N; i++) win[i] = (0.54 - 0.46 * Math.cos(i * 2 * Math.PI / (N - 1))) / 32767;
function powerSpectrum(frame, out) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[rev[i]] = frame[i] * win[i];
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let s = 0; s < N; s += size) for (let j = 0; j < half; j++) {
      const k = j * step, a = s + j, b = a + half;
      const tr = re[b] * cosT[k] - im[b] * sinT[k], ti = re[b] * sinT[k] + im[b] * cosT[k];
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  for (let i = 0; i <= N / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
}

// ---------- chroma ----------
const idx = f => Math.round(FRAME * f / SAMPLE_RATE);
const minIdx = Math.max(1, idx(MIN_FREQ)), maxIdx = Math.min(FRAME / 2, idx(MAX_FREQ));
const notes = new Int8Array(FRAME);
for (let i = minIdx; i < maxIdx; i++) {
  const freq = i * SAMPLE_RATE / FRAME, oct = Math.log(freq / (440 / 16)) / Math.LN2;
  notes[i] = Math.floor(BANDS * (oct - Math.floor(oct)));
}

// samples: 16-bit integer values (Int16Array or numbers in -32768..32767) at 11025 Hz, mono
export function rawFingerprint(samples) {
  const spec = new Float64Array(N / 2 + 1), frame = new Float64Array(N);
  const chroma = [];
  for (let start = 0; start + N <= samples.length; start += HOP) {
    for (let i = 0; i < N; i++) frame[i] = samples[start + i];
    powerSpectrum(frame, spec);
    const f = new Float64Array(BANDS);
    for (let i = minIdx; i < maxIdx; i++) f[notes[i]] += spec[i];
    chroma.push(f);
  }
  // smooth over time, then normalise each frame
  const rows = [];
  for (let t = 0; t + FILTER.length <= chroma.length; t++) {
    const r = new Float64Array(BANDS);
    for (let k = 0; k < FILTER.length; k++) for (let b = 0; b < BANDS; b++) r[b] += FILTER[k] * chroma[t + k][b];
    let n = 0; for (let b = 0; b < BANDS; b++) n += r[b] * r[b];
    n = Math.sqrt(n);
    if (n < 0.01) r.fill(0); else for (let b = 0; b < BANDS; b++) r[b] /= n;
    rows.push(r);
  }
  // integral image
  const W = BANDS, I = rows.map(r => Float64Array.from(r));
  for (let y = 0; y < I.length; y++) for (let x = 0; x < W; x++) {
    I[y][x] += (x ? I[y][x - 1] : 0) + (y ? I[y - 1][x] : 0) - (x && y ? I[y - 1][x - 1] : 0);
  }
  const area = (r1, c1, r2, c2) => {
    if (r1 === r2 || c1 === c2) return 0;
    const A = I[r2 - 1][c2 - 1], B = r1 ? I[r1 - 1][c2 - 1] : 0, C = c1 ? I[r2 - 1][c1 - 1] : 0, D = r1 && c1 ? I[r1 - 1][c1 - 1] : 0;
    return A - B - C + D;
  };
  const cmp = (a, b) => Math.log(1 + a) - Math.log(1 + b);
  const apply = ([type, y, h, w], x) => {
    switch (type) {
      case 0: return cmp(area(x, y, x + w, y + h), 0);
      case 1: { const h2 = h >> 1; return cmp(area(x, y + h2, x + w, y + h), area(x, y, x + w, y + h2)); }
      case 2: { const w2 = w >> 1; return cmp(area(x + w2, y, x + w, y + h), area(x, y, x + w2, y + h)); }
      case 3: { const w2 = w >> 1, h2 = h >> 1; return cmp(area(x, y + h2, x + w2, y + h) + area(x + w2, y, x + w, y + h2), area(x, y, x + w2, y + h2) + area(x + w2, y + h2, x + w, y + h)); }
      case 4: { const h3 = h / 3 | 0; return cmp(area(x, y + h3, x + w, y + 2 * h3), area(x, y, x + w, y + h3) + area(x, y + 2 * h3, x + w, y + h)); }
      case 5: { const w3 = w / 3 | 0; return cmp(area(x + w3, y, x + 2 * w3, y + h), area(x, y, x + w3, y + h) + area(x + 2 * w3, y, x + w, y + h)); }
    }
    return 0;
  };
  const out = [];
  for (let x = 0; x + MAX_WIDTH <= rows.length; x++) {
    let bits = 0;
    for (const [flt, [t0, t1, t2]] of CLASSIFIERS) {
      const v = apply(flt, x);
      const q = v < t1 ? (v < t0 ? 0 : 1) : (v < t2 ? 2 : 3);
      bits = ((bits << 2) | GRAY[q]) >>> 0;
    }
    out.push(bits);
  }
  return out;
}

// AcoustID's compressed fingerprint format (algorithm 1), URL-safe base64 without padding
export function compress(raw, algorithm = 1) {
  const bits = [];
  for (let i = 0; i < raw.length; i++) {
    let x = (raw[i] ^ (i ? raw[i - 1] : 0)) >>> 0, bit = 1, last = 0;
    while (x) { if (x & 1) { bits.push(bit - last); last = bit; } x >>>= 1; bit++; }
    bits.push(0);
  }
  const pack = (vals, width) => {
    const out = new Uint8Array(Math.ceil(vals.length * width / 8));
    let pos = 0;
    for (const v of vals) for (let b = 0; b < width; b++, pos++) if ((v >> b) & 1) out[pos >> 3] |= 1 << (pos & 7);
    return out;
  };
  const normal = pack(bits.map(b => Math.min(b, 7)), 3);
  const exc = pack(bits.filter(b => b >= 7).map(b => b - 7), 5);
  const n = raw.length;
  const bytes = new Uint8Array(4 + normal.length + exc.length);
  bytes.set([algorithm & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  bytes.set(normal, 4); bytes.set(exc, 4 + normal.length);
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fingerprint(samples) {
  const raw = rawFingerprint(samples);
  return { raw, fp: compress(raw), duration: samples.length / SAMPLE_RATE };
}

// Float samples at any rate → 16-bit samples at 11025 Hz (windowed-sinc low-pass + resample)
export function to11k(float32, rate) {
  const ratio = rate / SAMPLE_RATE, outLen = Math.floor(float32.length / ratio);
  const out = new Int16Array(outLen), cutoff = 0.9 / Math.max(1, ratio), taps = 6;
  for (let i = 0; i < outLen; i++) {
    const c = i * ratio, c0 = Math.floor(c);
    let s = 0, wsum = 0;
    for (let k = c0 - taps * Math.ceil(ratio) + 1; k <= c0 + taps * Math.ceil(ratio); k++) {
      if (k < 0 || k >= float32.length) continue;
      const d = (k - c) * cutoff, sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const wv = 0.5 + 0.5 * Math.cos(Math.PI * (k - c) / (taps * Math.ceil(ratio) + 1));
      const w = sinc * wv; s += float32[k] * w; wsum += w;
    }
    out[i] = Math.max(-32768, Math.min(32767, Math.round((wsum ? s / wsum : 0) * 32767)));
  }
  return out;
}
