// Tiny QR code maker (byte mode, error correction M), drawn as an SVG.
// Self-contained so the app needs no extra download. Based on the QR Code spec (ISO/IEC 18004).
const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const FORMAT_M = 0;

function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
  return r;
}
const dataCodewords = ver => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * BLOCKS_M[ver];

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
  return z & 0xFF;
}
function rsDivisor(deg) {
  const r = new Array(deg).fill(0); r[deg - 1] = 1;
  let root = 1;
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < deg; j++) { r[j] = gfMul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; }
    root = gfMul(root, 0x02);
  }
  return r;
}
function rsRemainder(data, div) {
  const r = div.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift(); r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}
function alignPositions(ver, size) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1;
  for (; ver <= 40; ver++) {
    const cc = ver < 10 ? 8 : 16;
    if (4 + cc + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > 40) throw new Error('Too long for a QR code');
  const cap = dataCodewords(ver) * 8;
  // bit stream
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - bits.length % 8) % 8);
  for (let p = 0xEC; bits.length < cap; p ^= 0xEC ^ 0x11) put(p, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // error correction + interleave
  const nBlocks = BLOCKS_M[ver], eccLen = ECC_PER_BLOCK_M[ver], raw = Math.floor(rawModules(ver) / 8);
  const nShort = nBlocks - raw % nBlocks, shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(eccLen), blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1)); k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const all = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) all.push(b[i]); });

  // modules
  const size = ver * 4 + 17;
  const M = Array.from({ length: size }, () => new Array(size).fill(false));
  const F = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = (x, y, dark) => { M[y][x] = dark; F[y][x] = true; };
  for (let i = 0; i < size; i++) { fn(6, i, i % 2 === 0); fn(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) fn(x, y, d !== 2 && d !== 4);
    }
  const al = alignPositions(ver, size), last = al.length - 1;
  al.forEach((ax, i) => al.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) fn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const drawFormat = mask => {
    const d = FORMAT_M << 3 | mask;
    let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412, bit = i => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) fn(8, i, bit(i));
    fn(8, 7, bit(6)); fn(8, 8, bit(7)); fn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) fn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) fn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) fn(8, size - 15 + i, bit(i));
    fn(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
    const b = ver << 12 | r;
    for (let i = 0; i < 18; i++) { const bit = ((b >>> i) & 1) === 1, a = size - 11 + i % 3, c = Math.floor(i / 3); fn(a, c, bit); fn(c, a, bit); }
  }
  // data, zig-zag
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (!F[y][x] && i < all.length * 8) { M[y][x] = ((all[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }
  // pick the mask that's easiest to scan
  const maskFn = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
    (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
  const apply = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!F[y][x] && maskFn[m](x, y)) M[y][x] = !M[y][x]; };
  const penalty = () => {
    let p = 0, dark = 0;
    for (let y = 0; y < size; y++) for (const horiz of [true, false]) {
      let run = 0, prev = null;
      for (let x = 0; x < size; x++) {
        const c = horiz ? M[y][x] : M[x][y];
        if (c === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else { run = 1; prev = c; }
      }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = M[y][x]; if (c === M[y][x + 1] && c === M[y + 1][x] && c === M[y + 1][x + 1]) p += 3; }
    for (const row of M) for (const c of row) if (c) dark++;
    return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) { apply(m); drawFormat(m); const p = penalty(); if (p < bestP) { bestP = p; best = m; } apply(m); }
  apply(best); drawFormat(best);
  return M;
}

export function qrSVG(text, { dark = '#000', light = '#fff', quiet = 4 } = {}) {
  const M = qrMatrix(text), n = M.length + quiet * 2;
  let d = '';
  M.forEach((row, y) => row.forEach((c, x) => { if (c) d += `M${x + quiet} ${y + quiet}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

// =====================================================================================================
// Reading QR codes — for browsers with no built-in QR reader (iPhone/iPad Safari, Firefox). Finds the
// code in a picture (camera frame or photo), straightens it, fixes damaged parts (Reed–Solomon) and
// reads the text. Works on BAZINGA!'s own codes and ordinary QR codes (any error-correction level).
// =====================================================================================================
const ECC_PER_BLOCK = [ // [L, M, Q, H][version]
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ECC_PER_BLOCK_M,
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
];
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  BLOCKS_M,
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
];
const ECL_OF_BITS = [1, 0, 3, 2]; // format bits 00=M 01=L 10=H 11=Q  →  index into [L, M, Q, H]

// GF(256) for error correction
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const gm = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const gd = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);
// Fix up to nsym/2 wrong bytes in one block (data + error-correction bytes). Returns the fixed block or null.
export function rsFix(cw, nsym) {
  const n = cw.length, S = new Array(nsym).fill(0);
  let bad = false;
  for (let j = 0; j < nsym; j++) { let s = 0; const a = EXP[j]; for (let i = 0; i < n; i++) s = gm(s, a) ^ cw[i]; S[j] = s; if (s) bad = true; }
  if (!bad) return cw;
  // Berlekamp–Massey: the error locator
  let C = [1], B = [1], L = 0, m = 1, b = 1;
  for (let k = 0; k < nsym; k++) {
    let d = S[k]; for (let i = 1; i <= L; i++) d ^= gm(C[i] || 0, S[k - i]);
    if (!d) { m++; continue; }
    const T = C.slice(), f = gd(d, b);
    while (C.length < B.length + m) C.push(0);
    for (let i = 0; i < B.length; i++) C[i + m] ^= gm(f, B[i]);
    if (2 * L <= k) { L = k + 1 - L; B = T; b = d; m = 1; } else m++;
  }
  if (2 * L > nsym) return null;
  // Chien search: where the errors are
  const pos = [];
  for (let i = 0; i < n; i++) {
    const p = n - 1 - i, xinv = EXP[(255 - p) % 255];
    let v = 0; for (let k = C.length - 1; k >= 0; k--) v = gm(v, xinv) ^ C[k];
    if (!v) pos.push(i);
  }
  if (pos.length !== L) return null;
  // Forney: how wrong each one is
  const O = new Array(nsym).fill(0);
  for (let i = 0; i < nsym; i++) for (let k = 0; k <= i && k < C.length; k++) O[i] ^= gm(S[i - k], C[k]);
  const out = cw.slice();
  for (const i of pos) {
    const p = n - 1 - i, X = EXP[p], xinv = EXP[(255 - p) % 255];
    let ov = 0; for (let k = nsym - 1; k >= 0; k--) ov = gm(ov, xinv) ^ O[k];
    let dv = 0; for (let k = 1; k < C.length; k += 2) { let t = C[k]; for (let r = 0; r < k - 1; r++) t = gm(t, xinv); dv ^= t; }
    if (!dv) return null;
    out[i] ^= gm(X, gd(ov, dv));
  }
  return out;
}

const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
function functionMask(ver) {
  const size = ver * 4 + 17, F = Array.from({ length: size }, () => new Uint8Array(size));
  const set = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) F[y][x] = 1; };
  for (let i = 0; i < size; i++) { set(6, i); set(i, 6); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) set(cx + dx, cy + dy);
  const al = alignPositions(ver, size), last = al.length - 1;
  al.forEach((ax, i) => al.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy);
  }));
  for (let i = 0; i <= 8; i++) { set(8, i); set(i, 8); }
  for (let i = 0; i < 8; i++) { set(size - 1 - i, 8); set(8, size - 1 - i); }
  if (ver >= 7) for (let i = 0; i < 18; i++) { const a = size - 11 + i % 3, c = Math.floor(i / 3); set(a, c); set(c, a); }
  return F;
}
const FORMATS = [];
for (let d = 0; d < 32; d++) { let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); FORMATS.push([((d << 10) | r) ^ 0x5412, d]); }
const VERSIONS = [];
for (let v = 7; v <= 40; v++) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25); VERSIONS.push([(v << 12) | r, v]); }
const popc = x => { let c = 0; while (x) { x &= x - 1; c++; } return c; };
const nearest = (table, v, maxd) => { let best = null, bd = maxd + 1; for (const [w, d] of table) { const k = popc(w ^ v); if (k < bd) { bd = k; best = d; } } return best; };

// M[y][x] = true for dark. Returns the text, or null.
export function decodeMatrix(M) {
  const size = M.length;
  if (size < 21 || (size - 17) % 4) return null;
  const dark = (x, y) => !!M[y][x];
  let f1 = 0, f2 = 0;
  for (let i = 0; i <= 5; i++) f1 |= dark(8, i) << i;
  f1 |= dark(8, 7) << 6; f1 |= dark(8, 8) << 7; f1 |= dark(7, 8) << 8;
  for (let i = 9; i < 15; i++) f1 |= dark(14 - i, 8) << i;
  for (let i = 0; i < 8; i++) f2 |= dark(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) f2 |= dark(8, size - 15 + i) << i;
  let fmt = nearest(FORMATS, f1, 3); if (fmt === null) fmt = nearest(FORMATS, f2, 3);
  if (fmt === null) return null;
  const ecl = ECL_OF_BITS[fmt >> 3], mask = MASKS[fmt & 7];
  let ver = (size - 17) / 4;
  if (ver >= 7) {
    let v1 = 0, v2 = 0;
    for (let i = 0; i < 18; i++) { const a = size - 11 + i % 3, c = Math.floor(i / 3); v1 |= dark(a, c) << i; v2 |= dark(c, a) << i; }
    const vv = nearest(VERSIONS, v1, 3) ?? nearest(VERSIONS, v2, 3);
    if (vv !== null && vv !== ver) return null; // the grid was read at the wrong size
  }
  const F = functionMask(ver), raw = Math.floor(rawModules(ver) / 8), cw = new Uint8Array(raw);
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (F[y][x] || bit >= raw * 8) continue;
      if (dark(x, y) !== mask(x, y)) cw[bit >>> 3] |= 0x80 >>> (bit & 7);
      bit++;
    }
  }
  // un-interleave the blocks, fix each one
  const nB = BLOCKS[ecl][ver], eccLen = ECC_PER_BLOCK[ecl][ver];
  const nShort = nB - raw % nB, shortLen = Math.floor(raw / nB);
  const blocks = Array.from({ length: nB }, () => new Array(shortLen + 1).fill(0));
  let k = 0;
  for (let i = 0; i <= shortLen; i++) for (let j = 0; j < nB; j++) { if (i === shortLen - eccLen && j < nShort) continue; if (k < raw) blocks[j][i] = cw[k++]; }
  const data = [];
  for (let j = 0; j < nB; j++) {
    const dl = shortLen - eccLen + (j >= nShort ? 1 : 0);
    const b = blocks[j], block = j >= nShort ? b.slice(0, shortLen + 1) : b.slice(0, dl).concat(b.slice(dl + 1, shortLen + 1));
    const fixed = rsFix(block, eccLen); if (!fixed) return null;
    data.push(...fixed.slice(0, dl));
  }
  return readBits(data, ver);
}
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
function readBits(data, ver) {
  let p = 0;
  const total = data.length * 8;
  const get = n => { let v = 0; for (let i = 0; i < n; i++, p++) v = (v << 1) | (p < total ? (data[p >>> 3] >>> (7 - (p & 7))) & 1 : 0); return v; };
  const grp = ver < 10 ? 0 : ver < 27 ? 1 : 2;
  const bytes = []; let text = '';
  const flush = () => { if (bytes.length) { try { text += new TextDecoder('utf-8').decode(new Uint8Array(bytes)); } catch { text += String.fromCharCode(...bytes); } bytes.length = 0; } };
  while (p + 4 <= total) {
    const mode = get(4);
    if (mode === 0) break;
    if (mode === 4) { const n = get([8, 16, 16][grp]); for (let i = 0; i < n; i++) bytes.push(get(8)); }
    else if (mode === 1) { flush(); let n = get([10, 12, 14][grp]); while (n >= 3) { text += String(get(10)).padStart(3, '0'); n -= 3; } if (n === 2) text += String(get(7)).padStart(2, '0'); else if (n === 1) text += String(get(4)); }
    else if (mode === 2) { flush(); let n = get([9, 11, 13][grp]); while (n >= 2) { const v = get(11); text += ALNUM[Math.floor(v / 45)] + ALNUM[v % 45]; n -= 2; } if (n) text += ALNUM[get(6)]; }
    else if (mode === 7) { const a = get(8); if ((a & 0xC0) === 0x80) get(8); else if ((a & 0xE0) === 0xC0) get(16); }
    else if (mode === 8) { flush(); const n = get([8, 10, 12][grp]); p += n * 13; }
    else if (mode === 3 || mode === 5) { get(mode === 3 ? 16 : 8); }
    else return null;
  }
  flush();
  return text;
}

// ---------- finding the code in a picture ----------
// gray: Uint8Array (w*h) of brightness. Dark pixels are found with a local threshold (copes with shadows / glare).
function binarize(gray, w, h) {
  const B = 8, bw = Math.ceil(w / B), bh = Math.ceil(h / B), bp = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let sum = 0, mn = 255, mx = 0, c = 0;
    for (let y = by * B; y < Math.min(h, by * B + B); y++) for (let x = bx * B; x < Math.min(w, bx * B + B); x++) { const v = gray[y * w + x]; sum += v; if (v < mn) mn = v; if (v > mx) mx = v; c++; }
    let avg = sum / c;
    if (mx - mn <= 24) {
      avg = mn / 2;
      if (by > 0 && bx > 0) { const nb = (bp[(by - 1) * bw + bx] + 2 * bp[by * bw + bx - 1] + bp[(by - 1) * bw + bx - 1]) / 4; if (mn < nb) avg = nb; }
    }
    bp[by * bw + bx] = avg;
  }
  const out = new Uint8Array(w * h);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let s = 0, c = 0;
    for (let y = Math.max(0, by - 2); y <= Math.min(bh - 1, by + 2); y++) for (let x = Math.max(0, bx - 2); x <= Math.min(bw - 1, bx + 2); x++) { s += bp[y * bw + x]; c++; }
    const t = s / c;
    for (let y = by * B; y < Math.min(h, by * B + B); y++) for (let x = bx * B; x < Math.min(w, bx * B + B); x++) out[y * w + x] = gray[y * w + x] <= t ? 1 : 0;
  }
  return out;
}
// 1:1:3:1:1 (dark light dark light dark)
function finderRatio(s) {
  const tot = s[0] + s[1] + s[2] + s[3] + s[4]; if (tot < 7) return 0;
  const m = tot / 7, v = m / 1.6;
  return Math.abs(m - s[0]) < v && Math.abs(m - s[1]) < v && Math.abs(3 * m - s[2]) < 3 * v && Math.abs(m - s[3]) < v && Math.abs(m - s[4]) < v ? m : 0;
}
// Count the 5 runs through (cx, cy) along a direction; returns [centre offset, total] or null
function crossCheck(img, w, h, cx, cy, dx, dy, maxCount) {
  const at = (k) => { const x = Math.round(cx + dx * k), y = Math.round(cy + dy * k); return x < 0 || y < 0 || x >= w || y >= h ? -1 : img[y * w + x]; };
  const s = [0, 0, 0, 0, 0];
  let k = 0;
  while (at(k) === 1) { s[2]++; k--; } if (at(k) < 0) return null;
  while (at(k) === 0 && s[1] <= maxCount) { s[1]++; k--; } if (at(k) < 0 || s[1] > maxCount) return null;
  while (at(k) === 1 && s[0] <= maxCount) { s[0]++; k--; } if (s[0] > maxCount) return null;
  const startK = k + 1;
  k = 1;
  while (at(k) === 1) { s[2]++; k++; } if (at(k) < 0) return null;
  while (at(k) === 0 && s[3] <= maxCount) { s[3]++; k++; } if (at(k) < 0 || s[3] > maxCount) return null;
  while (at(k) === 1 && s[4] <= maxCount) { s[4]++; k++; } if (s[4] > maxCount) return null;
  if (!finderRatio(s)) return null;
  const tot = s.reduce((a, b) => a + b, 0);
  return [startK + s[0] + s[1] + s[2] / 2 - 0.5, tot];
}
// Runs of dark / light along one row; every dark-light-dark-light-dark group is offered to cb
function scanRow(img, w, y, cb) {
  let runs = [], cur = img[y * w], len = 0;
  for (let x = 0; x < w; x++) { const d = img[y * w + x]; if (d === cur) len++; else { runs.push([cur, len, x]); cur = d; len = 1; } }
  runs.push([cur, len, w]);
  for (let i = 0; i + 4 < runs.length; i++) if (runs[i][0] === 1) cb([runs[i][1], runs[i + 1][1], runs[i + 2][1], runs[i + 3][1], runs[i + 4][1]], runs[i + 4][2]);
}
function findFinders2(img, w, h) {
  const found = [];
  const step = Math.max(1, Math.floor(h / 500));
  for (let y = 0; y < h; y += step) scanRow(img, w, y, (s, end) => {
    if (!finderRatio(s)) return;
    const cx = end - s[4] - s[3] - s[2] / 2;
    const v = crossCheck(img, w, h, cx, y, 0, 1, s[2] * 2); if (!v) return;
    const cy = y + v[0];
    const hz = crossCheck(img, w, h, cx, cy, 1, 0, s[2] * 2); if (!hz) return;
    const ccx = cx + hz[0];
    const v2 = crossCheck(img, w, h, ccx, cy, 0, 1, s[2] * 2); if (!v2) return;
    const ccy = cy + v2[0], ms = (v2[1] + hz[1]) / 14;
    const f = found.find(q => Math.abs(q.x - ccx) <= ms * 2.5 && Math.abs(q.y - ccy) <= ms * 2.5 && Math.abs(q.ms - ms) <= Math.max(1.2, ms * 0.6));
    if (f) { f.x = (f.x * f.n + ccx) / (f.n + 1); f.y = (f.y * f.n + ccy) / (f.n + 1); f.ms = (f.ms * f.n + ms) / (f.n + 1); f.n++; }
    else found.push({ x: ccx, y: ccy, ms, n: 1 });
  });
  return found.sort((a, b) => b.n - a.n);
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// The three finder patterns that look most like the corners of one square code
function pickCorners(fs) {
  const c = fs.slice(0, 12), out = [];
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) for (let k = j + 1; k < c.length; k++) {
    const p = [c[i], c[j], c[k]];
    const ms = p.map(q => q.ms), mmin = Math.min(...ms), mmax = Math.max(...ms);
    if (mmax / mmin > 1.6) continue;
    const d = [dist(p[1], p[2]), dist(p[0], p[2]), dist(p[0], p[1])]; // side opposite each point
    const hi = d.indexOf(Math.max(...d)), tl = p[hi], o = p.filter((_, n) => n !== hi);
    const a = dist(tl, o[0]), b = dist(tl, o[1]), hyp = d[hi];
    if (Math.max(a, b) / Math.min(a, b) > 1.8) continue;
    const right = Math.abs(a * a + b * b - hyp * hyp) / (hyp * hyp);
    if (right > 0.35) continue;
    let tr = o[0], bl = o[1];
    if ((tr.x - tl.x) * (bl.y - tl.y) - (tr.y - tl.y) * (bl.x - tl.x) < 0) [tr, bl] = [bl, tr];
    out.push({ tl, tr, bl, ms: (tl.ms + tr.ms + bl.ms) / 3, score: right + Math.abs(a - b) / Math.max(a, b) + (mmax / mmin - 1) - 0.02 * (tl.n + tr.n + bl.n) });
  }
  return out.sort((x, y) => x.score - y.score).slice(0, 4);
}
// Perspective transform (unit square ↔ quadrilateral), as in the QR spec's reference decoders
function sq2quad(x0, y0, x1, y1, x2, y2, x3, y3) {
  const dx3 = x0 - x1 + x2 - x3, dy3 = y0 - y1 + y2 - y3;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) return [x1 - x0, y1 - y0, 0, x2 - x1, y2 - y1, 0, x0, y0, 1];
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, den = dx1 * dy2 - dx2 * dy1;
  const a13 = (dx3 * dy2 - dx2 * dy3) / den, a23 = (dx1 * dy3 - dx3 * dy1) / den;
  return [x1 - x0 + a13 * x1, y1 - y0 + a13 * y1, a13, x3 - x0 + a23 * x3, y3 - y0 + a23 * y3, a23, x0, y0, 1];
}
function adj([a11, a12, a13, a21, a22, a23, a31, a32, a33]) {
  return [a22 * a33 - a23 * a32, a13 * a32 - a12 * a33, a12 * a23 - a13 * a22, a23 * a31 - a21 * a33, a11 * a33 - a13 * a31, a13 * a21 - a11 * a23, a21 * a32 - a22 * a31, a12 * a31 - a11 * a32, a11 * a22 - a12 * a21];
}
function mul(a, b) {
  return [a[0] * b[0] + a[3] * b[1] + a[6] * b[2], a[1] * b[0] + a[4] * b[1] + a[7] * b[2], a[2] * b[0] + a[5] * b[1] + a[8] * b[2],
    a[0] * b[3] + a[3] * b[4] + a[6] * b[5], a[1] * b[3] + a[4] * b[4] + a[7] * b[5], a[2] * b[3] + a[5] * b[4] + a[8] * b[5],
    a[0] * b[6] + a[3] * b[7] + a[6] * b[8], a[1] * b[6] + a[4] * b[7] + a[7] * b[8], a[2] * b[6] + a[5] * b[7] + a[8] * b[8]];
}
function quad2quad(src, dst) { return mul(sq2quad(...dst), adj(sq2quad(...src))); }
const apply = (t, x, y) => { const d = t[2] * x + t[5] * y + t[8]; return [(t[0] * x + t[3] * y + t[6]) / d, (t[1] * x + t[4] * y + t[7]) / d]; };
// Small alignment pattern (light-dark-light 1:1:1 across its middle) near where it should be
function findAlign(img, w, h, ex, ey, ms) {
  const r = Math.max(4, ms * 5), x0 = Math.max(0, Math.floor(ex - r)), x1 = Math.min(w - 1, Math.ceil(ex + r)), y0 = Math.max(0, Math.floor(ey - r)), y1 = Math.min(h - 1, Math.ceil(ey + r));
  let best = null;
  const ok = (a, b, c) => { const m = (a + b + c) / 3; return Math.abs(a - ms) < ms * 0.7 && Math.abs(b - ms) < ms * 0.7 && Math.abs(c - ms) < ms * 0.7 && m > 0; };
  for (let y = y0; y <= y1; y++) {
    const runs = []; let cur = img[y * w + x0], len = 0;
    for (let x = x0; x <= x1; x++) { const d = img[y * w + x]; if (d === cur) len++; else { runs.push([cur, len, x]); cur = d; len = 1; } }
    runs.push([cur, len, x1 + 1]);
    for (let i = 1; i + 1 < runs.length; i++) {
      if (runs[i][0] !== 1 || runs[i - 1][0] !== 0 || runs[i + 1][0] !== 0 || !ok(runs[i - 1][1], runs[i][1], runs[i + 1][1])) continue;
      const cx = runs[i][2] - runs[i][1] / 2 - 0.5;
      // vertical check
      let up = 0, dn = 0, k = 0; const col = Math.round(cx);
      const at = yy => (yy < 0 || yy >= h ? -1 : img[yy * w + col]);
      let yy = y; while (at(yy) === 1) { up++; yy--; } let lu = 0; while (at(yy) === 0 && lu < ms * 2) { lu++; yy--; }
      yy = y + 1; while (at(yy) === 1) { dn++; yy++; } let ld = 0; while (at(yy) === 0 && ld < ms * 2) { ld++; yy++; }
      if (!ok(lu, up + dn, ld)) continue;
      const cy = y - up + (up + dn) / 2 + 0.5;
      const dd = Math.hypot(cx - ex, cy - ey);
      if (!best || dd < best.d) best = { x: cx, y: cy, d: dd };
      k++;
    }
  }
  return best;
}
function sampleGrid(img, w, h, t, dim) {
  const M = [];
  for (let y = 0; y < dim; y++) {
    const row = [];
    for (let x = 0; x < dim; x++) {
      const [px, py] = apply(t, x + 0.5, y + 0.5);
      const ix = Math.round(px), iy = Math.round(py);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) return null;
      row.push(img[iy * w + ix] === 1);
    }
    M.push(row);
  }
  return M;
}
const transpose = M => M[0].map((_, x) => M.map(r => r[x]));
// Module size measured across a finder pattern in the direction of another one (right for rotated codes,
// where straight across the picture the pattern looks √2 wider)
function msAlong(img, w, h, a, b, fallback) {
  const L = dist(a, b) || 1, dx = (b.x - a.x) / L, dy = (b.y - a.y) / L;
  const r = crossCheck(img, w, h, a.x, a.y, dx, dy, fallback * 6);
  return r ? r[1] / 7 : fallback;
}
function tryCorners(img, w, h, { tl, tr, bl, ms }) {
  const mT = (msAlong(img, w, h, tl, tr, ms) + msAlong(img, w, h, tr, tl, ms)) / 2;
  const mL = (msAlong(img, w, h, tl, bl, ms) + msAlong(img, w, h, bl, tl, ms)) / 2;
  ms = (mT + mL) / 2;
  const est = Math.round((dist(tl, tr) / mT + dist(tl, bl) / mL) / 2) + 7;
  const dims = [];
  const base = est % 4 === 1 ? est : est % 4 === 0 ? est + 1 : est % 4 === 2 ? est - 1 : est - 2;
  for (const d of [base, base + 4, base - 4, base + 8, base - 8]) if (d >= 21 && d <= 177 && !dims.includes(d)) dims.push(d);
  for (const dim of dims) {
    const ver = (dim - 17) / 4;
    let br = { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y }, brMod = dim - 3.5;
    if (ver >= 2) {
      const f = (dim - 10) / (dim - 7);
      const ex = tl.x + f * (tr.x - tl.x) + f * (bl.x - tl.x), ey = tl.y + f * (tr.y - tl.y) + f * (bl.y - tl.y);
      // (a tilted phone moves it: look close first, then further out)
      const al = findAlign(img, w, h, ex, ey, ms) || findAlign(img, w, h, ex, ey, ms * 2.2);
      br = al || { x: ex, y: ey }; brMod = dim - 6.5;
    }
    for (const b of br === null ? [] : [br, ...(ver >= 2 ? [{ x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y, m: dim - 3.5 }] : [])]) {
      const bm = b.m || brMod;
      const t = quad2quad([3.5, 3.5, dim - 3.5, 3.5, bm, bm, 3.5, dim - 3.5], [tl.x, tl.y, tr.x, tr.y, b.x, b.y, bl.x, bl.y]);
      const M = sampleGrid(img, w, h, t, dim);
      if (!M) continue;
      const txt = decodeMatrix(M) ?? decodeMatrix(transpose(M));
      if (txt !== null) return txt;
    }
  }
  return null;
}
// rgba: ImageData-like {data, width, height} (or gray: Uint8Array with width/height). Returns the text or null.
export function readQR(imgData) {
  const { width: w, height: h } = imgData;
  let gray = imgData.gray;
  if (!gray) {
    const d = imgData.data; gray = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  }
  // a light 3×3 blur first: camera noise otherwise breaks up the patterns
  const soft = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) { s += gray[yy * w + xx]; c++; }
    soft[y * w + x] = s / c;
  }
  for (const [src, invert] of [[soft, false], [gray, false], [soft, true]]) {
    let img = binarize(src, w, h);
    if (invert) for (let i = 0; i < img.length; i++) img[i] ^= 1;
    const fs = findFinders2(img, w, h);
    if (fs.length < 3) continue;
    for (const c of pickCorners(fs)) { const t = tryCorners(img, w, h, c); if (t !== null) return t; }
  }
  return null;
}
