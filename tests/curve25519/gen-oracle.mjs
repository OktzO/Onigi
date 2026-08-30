// Fase 1 — generator oracle untuk curve25519-js (implementasi LAMA).
// Menghasilkan fixture input->output bit-exact yang dipakai validasi Rust nanti.
// Deterministik (PRNG seed tetap) supaya reproducible.
//
// Sanity check pertama: RFC 7748 §6.1 X25519 test vectors harus cocok dengan
// output sharedKey dari curve25519-js. Kalau tidak cocok => STOP, jangan lanjut.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const curve = require('/home/user/noddjs/ourin-md/node_modules/curve25519-js/lib/index.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'fixtures');
mkdirSync(OUT, { recursive: true });

// --- PRNG deterministik (mulberry32) ---
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x0fa5e);

function randBytes(n, r) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(r() * 256);
  return b;
}
const hex = (u) => Buffer.from(u).toString('hex');
const fromHex = (h) => new Uint8Array(Buffer.from(h, 'hex'));

// --- 1. Sanity: RFC 7748 §6.1 (X25519) ---
const RFC = [
  // [scalar, u, expected] — RFC 7748 section 5.2 (X25519 test vectors)
  [
    'a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4',
    'e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c',
    'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552',
  ],
  [
    '4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d',
    'e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493',
    '95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957',
  ],
];
for (const [scalarHex, uHex, expectedHex] of RFC) {
  const out = curve.sharedKey(fromHex(scalarHex), fromHex(uHex));
  const actual = hex(out);
  if (actual !== expectedHex) {
    throw new Error(`RFC 7748 vector GAGAL: scalar=${scalarHex} u=${uHex} got=${actual} want=${expectedHex}`);
  }
}
console.log(`[ok] RFC 7748 X25519: ${RFC.length} vector cocok`);

// --- 2. generateKeyPair fixtures ---
const genKeyPairs = [];
// edge cases
const edgeSeeds = [
  new Uint8Array(32),                                          // seed nol
  (() => { const s = new Uint8Array(32); s[0] = 1; return s; })(), // seed = 1
  (() => { const s = new Uint8Array(32); s.fill(0xff); return s; })(), // semua 0xff
  (() => { const s = new Uint8Array(32); s[31] = 0xff; return s; })(),
  (() => { const s = new Uint8Array(32); s[0] = 0xfe; return s; })(), // sudah mulai clamping
  (() => { const s = new Uint8Array(32); s[0] = 0xff; s[31] = 0x7f; return s; })(),
];
const allSeeds = [...edgeSeeds];
for (let i = 0; i < 2000; i++) allSeeds.push(randBytes(32, rnd));
for (const seed of allSeeds) {
  const kp = curve.generateKeyPair(seed);
  genKeyPairs.push({ seed: hex(seed), public: hex(kp.public), private: hex(kp.private) });
}

// --- 3. sharedKey fixtures ---
const sharedFixtures = [];
// low-order / edge public keys (u-coordinate). Sumber: small-order points Curve25519.
const edgePks = [
  new Uint8Array(32),                                            // pk nol
  (() => { const u = new Uint8Array(32); u[0] = 1; return u; })(),  // u=1 (identity/low-order)
  (() => { const u = new Uint8Array(32); u.fill(0xff); return u; })(), // u = -1 (mod p)
  fromHex('0000000000000000000000000000000000000000000000000000000000000000'),
  fromHex('0100000000000000000000000000000000000000000000000000000000000000'),
  fromHex('e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800'),
  fromHex('5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157'),
  fromHex('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'),
];
const edgeSks = [
  new Uint8Array(32),                                          // sk nol
  (() => { const s = new Uint8Array(32); s[0] = 1; return s; })(),
  (() => { const s = new Uint8Array(32); s.fill(0xff); return s; })(),
];
for (const pk of edgePks) for (const sk of edgeSks) {
  sharedFixtures.push({ sk: hex(sk), pk: hex(pk), out: hex(curve.sharedKey(sk, pk)) });
}
for (let i = 0; i < 3000; i++) {
  const sk = randBytes(32, rnd);
  const pk = randBytes(32, rnd);
  sharedFixtures.push({ sk: hex(sk), pk: hex(pk), out: hex(curve.sharedKey(sk, pk)) });
}
// RFC vectors juga masuk fixture (baseline publik)
for (const [scalarHex, uHex] of RFC) {
  sharedFixtures.push({ sk: scalarHex, pk: uHex, out: hex(curve.sharedKey(fromHex(scalarHex), fromHex(uHex))), rfc: true });
}

// --- 4. sign fixtures (XEdDSA, tanpa opt_random => deterministik) ---
const signFixtures = [];
const msgLens = [0, 1, 2, 16, 32, 64, 100, 256, 1024];
const edgeSksSign = [
  new Uint8Array(32),
  (() => { const s = new Uint8Array(32); s[0] = 1; return s; })(),
  (() => { const s = new Uint8Array(32); s.fill(0xff); return s; })(),
];
for (const sk of edgeSksSign) {
  for (const len of [0, 32]) {
    const msg = randBytes(len, rnd);
    const sig = curve.sign(sk, msg);
    signFixtures.push({ sk: hex(sk), msg: hex(msg), sig: hex(sig) });
  }
}
for (let i = 0; i < 3000; i++) {
  const sk = randBytes(32, rnd);
  const len = msgLens[Math.floor(rnd() * msgLens.length)];
  const msg = randBytes(len, rnd);
  const sig = curve.sign(sk, msg);
  signFixtures.push({ sk: hex(sk), msg: hex(msg), sig: hex(sig) });
}

// --- 5. verify fixtures ---
// valid: pasangan (pk, msg, sig) yang harus true. Untuk tiap sign fixture kita
// perlu public key. generateKeyPair(seed) != sk yang dipakai sign di sini —
// jadi generate keypair sendiri: pk = generateKeyPair(sk).public (XEdDSA pakai
// pk yang di-encode). Tapi verify di curve25519-js menerima pk 32 byte Montgomery.
const verifyFixtures = [];
for (const f of signFixtures.slice(0, 500)) {
  const sk = fromHex(f.sk);
  const pk = curve.generateKeyPair(sk).public; // Montgomery pub key
  const msg = fromHex(f.msg);
  const sig = fromHex(f.sig);
  const ok = curve.verify(pk, msg, sig);
  if (!ok) throw new Error(`verify valid GAGAL: sk=${f.sk}`);
  verifyFixtures.push({ pk: hex(pk), msg: f.msg, sig: f.sig, expect: true });
}
// invalid: flip 1 byte sig / pk / msg => harus false
for (let i = 0; i < 200; i++) {
  const sk = randBytes(32, rnd);
  const pk = curve.generateKeyPair(sk).public;
  const msg = randBytes(64, rnd);
  const sig = curve.sign(sk, msg);
  const sig2 = new Uint8Array(sig);
  sig2[Math.floor(rnd() * 64)] ^= 1;
  const ok = curve.verify(pk, msg, sig2);
  if (ok) throw new Error(`verify invalid GAGAL (harus false): i=${i}`);
  verifyFixtures.push({ pk: hex(pk), msg: hex(msg), sig: hex(sig2), expect: false });
}
// pk salah 1 bit
for (let i = 0; i < 100; i++) {
  const sk = randBytes(32, rnd);
  const pk = curve.generateKeyPair(sk).public;
  const msg = randBytes(32, rnd);
  const sig = curve.sign(sk, msg);
  const pk2 = new Uint8Array(pk);
  pk2[0] ^= 1;
  const ok = curve.verify(pk2, msg, sig);
  if (ok) throw new Error(`verify pk-tamper GAGAL (harus false)`);
  verifyFixtures.push({ pk: hex(pk2), msg: hex(msg), sig: hex(sig), expect: false });
}

// --- tulis fixture ---
writeFileSync(join(OUT, 'generateKeyPair.json'), JSON.stringify(genKeyPairs, null, 2));
writeFileSync(join(OUT, 'sharedKey.json'), JSON.stringify(sharedFixtures, null, 2));
writeFileSync(join(OUT, 'sign.json'), JSON.stringify(signFixtures, null, 2));
writeFileSync(join(OUT, 'verify.json'), JSON.stringify(verifyFixtures, null, 2));

console.log('generateKeyPair:', genKeyPairs.length);
console.log('sharedKey:', sharedFixtures.length, `(termasuk ${RFC.length} RFC)`);
console.log('sign:', signFixtures.length);
console.log('verify:', verifyFixtures.length);
console.log('fixtures →', OUT);
