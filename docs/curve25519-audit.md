# Fase 0 — Audit kurva Curve25519 di oktz-baileys

Date: 2026-08-30 · Target: ganti `curve25519-js` (v0.0.4) dengan native Rust (napi-rs).
Metode: baca source `curve25519-js` baris per baris + telusur call-site nyata dari `libsignal` dan `ourin-baileys`.

## 1. Peta dependency

```
ourin-baileys (lib/)
  └── Utils/crypto.js  ── import * as curve from 'libsignal/src/curve.js'
  └── Signal/Group/sender-key-message.js ── import { calculateSignature, verifySignature } from 'libsignal/src/curve.js'
        └── libsignal (npm, WhiskeySockets/libsignal-node v6.0.0)
              └── src/curve.js  ── require('curve25519-js')
```

`curve25519-js` hanya dipanggil lewat satu file: `libsignal/src/curve.js`.

## 2. Fungsi yang di-export curve25519-js (v0.0.4)

Dari `lib/index.js` (1669 baris):

| Export | Algoritma | Dipakai di curve.js? |
|---|---|---|
| `generateKeyPair(seed)` | X25519 base scalar mult (`crypto_scalarmult_base`) + clamp sk + buang sign bit pk | Ya — tapi HANYA di fallback |
| `sharedKey(sk, pk)` | X25519 DH (`crypto_scalarmult`, RFC 7748) | Ya — tapi HANYA di fallback |
| `sign(sk, msg, opt_random?)` | XEdDSA (`curve25519_sign`) | Ya — SELALU (hot) |
| `verify(pk, msg, sig)` | XEdDSA verify (`curve25519_sign_open`) | Ya — SELALU (hot) |
| `signMessage`, `openMessage` | wrapper sign/verify + msg | Tidak pernah |
| `default` | `{}` | Tidak pernah |

## 3. Call-site nyata di libsignal/src/curve.js

File: `node_modules/libsignal/src/curve.js` (142 baris).

### `getPublicFromPrivateKey` (baris 61)
```js
const keyPair = curveJs.generateKeyPair(unclampedPK);
```
- Pakai `generateKeyPair` JS. TAPI: `getPublicFromPrivateKey` **tidak dipanggil di mana pun** di `ourin-baileys` maupun `libsignal` (grep kosong). Dead code di fork ini.

### `generateKeyPair` (baris 67-91)
```js
const {publicKey, privateKey} = nodeCrypto.generateKeyPairSync('x25519', ...); // primary
} catch(e) { curveJs.generateKeyPair(nodeCrypto.randomBytes(32)); }            // fallback
```
- Di Node 20/22 (OpenSSL 3.3) `generateKeyPairSync('x25519')` **selalu sukses** → fallback JS **tidak pernah dieksekusi**. Keygen sudah native node:crypto.

### `calculateAgreement` (baris 93-120)
```js
if(typeof nodeCrypto.diffieHellman === 'function') { ... nodeCrypto.diffieHellman(...) }
else { const secret = curveJs.sharedKey(privKey, pubKey); }
```
- Di Node 20/22 `nodeCrypto.diffieHellman` **ada** → DH pakai OpenSSL native. `curveJs.sharedKey` **tidak pernah dieksekusi**.

### `calculateSignature` (baris 122-128) — HOT
```js
return Buffer.from(curveJs.sign(privKey, message));
```
- **Selalu** pakai `curveJs.sign`. Satu-satunya path sign yang benar-benar jalan.

### `verifySignature` (baris 130-142) — HOT
```js
return isInit ? true : curveJs.verify(pubKey, msg, sig);
```
- `isInit=true` → skip verify (dipakai `session_builder.js:26` untuk signed prekey).
- `isInit` falsy → **selalu** `curveJs.verify`. Caller:
  - `Utils/crypto.js:25` `Curve.verify` → dipakai `noise-handler.js:153-154` (verify cert chain) dan `validate-connection.js:147` (verify account signature).
  - `sender-key-message.js:52` `verifySignature(signatureKey, ...)` → verify signature pesan sender-key **setiap pesan grup**.

## 4. Kesimpulan hot path (Node 20/22)

| Fungsi | Runtime sebenarnya | Alasan |
|---|---|---|
| `generateKeyPair` | node:crypto (native) | fallback JS tak pernah jalan |
| `sharedKey`/DH | node:crypto (native) | `diffieHellman` ada |
| `sign` | **curve25519-js XEdDSA** | `calculateSignature` selalu JS |
| `verify` | **curve25519-js XEdDSA** | `verifySignature` (isInit=false) selalu JS |

**Kandidat Rust yang benar-benar panas: `sign` + `verify`.** `generateKeyPair` + `sharedKey` juga diimplementasikan (biar API kurva lengkap + aman kalau runtime target tak punya OpenSSL x25519), tapi bukan target performa utama.

## 5. Identifikasi: DH standar vs XEdDSA custom

### `sharedKey` = X25519 DH STANDAR (RFC 7748)
`crypto_scalarmult(q, n, p)` (baris 628):
- Clamping: `z[0] &= 248`, `z[31] = (n[31] & 127) | 64` — persis RFC 7748.
- Ladder Montgomery standar (sel25519/swap-dan-add), hasil `pack25519`.
- **Bisa pakai `x25519-dalek`** (bukan curve25519-dalek) — murni X25519.

### `sign` = XEdDSA CUSTOM (BUKAN Ed25519 biasa)
`curve25519_sign` (baris 1395) + `crypto_sign_direct` (baris 1326):
1. Konversi Curve25519 sk → Ed25519 sk:
   - `edsk[0..32] = sk`, clamp: `edsk[0]&=248`, `edsk[31]&=127`, `edsk[31]|=64`
   - `scalarbase(p, edsk)` → pubkey Edwards, `pack(edsk[32..64], p)`
   - simpan `signBit = edsk[63] & 128`
2. `crypto_sign_direct`: **secret key dipakai LANGSUNG dalam hash** (komentar source: "uses secret key directly in hash") — bukan hash prefix Ed25519 standar.
   - `r = SHA512(sk || msg)`, `reduce(r)` mod L
   - `R = r·B`, `pack`
   - `h = SHA512(R || A || msg)`, `reduce(h)`
   - `S = r + h·sk mod L` (modL)
   - signature = R || S, lalu `sm[63] |= signBit` (salurkan sign bit pubkey ke byte terakhir signature)

→ Ini konstruksi XEdDSA persis (versi `crypto_sign` yang hash-nya pakai secret key langsung, bukan varian RFC 8032). **Signature dari implementasi lama TIDAK valid kalau diganti crate Ed25519 generic yang konstruksinya standar.** `ed25519-dalek` dengan API baku ≠ bit-exact.

### `verify` = XEdDSA verify CUSTOM
`curve25519_sign_open` (baris 1495):
1. Konversi Curve25519 pk → Ed25519 pk: `convertPublicKey` (baris 1485): `edwardsY = (montgomeryX - 1)/(montgomeryX + 1)`, `pack25519`.
2. Pulihkan sign bit: `edpk[31] |= sm[63] & 128`, hapus dari signature: `sm[63] &= 127`.
3. `crypto_sign_open` — verifikasi Ed25519 standar (unpackneg, `h = SHA512(R||A||m)`, `p = h·A + R·B`, bandingkan R).

→ Verify memakai sha512 standar + ops Edwards; konstruksinya bit-exact harus dicocokkan dengan oracle.

## 6. Detail clamping (WAJIB persis)

| Operasi | Clamping |
|---|---|
| X25519 DH (`crypto_scalarmult`) | `z[0]&=248; z[31]=(n[31]&127)\|64` |
| `generateKeyPair` output sk | `sk[0]&=248; sk[31]&=127; sk[31]|=64` |
| `generateKeyPair` output pk | `pk[31] &= 127` (buang sign bit) |
| XEdDSA sign (edsk) | `edsk[0]&=248; edsk[31]&=127; edsk[31]|=64` |
| `curve25519_sign` signature | `sm[63] |= signBit` |
| `curve25519_sign_open` | `edpk[31]|=sig[63]&128`; `sig[63]&=127` |

Beda 1 bit clamping → keypair/signature tak kompatibel. Semua di atas harus direplikasi bit-exact di Rust.

## 7. Rekomendasi implementasi Rust

- `generateKeyPair`: `x25519-dalek` `StaticSecret::from(seed)` → pubkey; clamp ulang sk + buang bit pk manual (cocokkan oracle).
- `sharedKey`: `x25519-dalek` `StaticSecret::diffie_hellman(&PublicKey)`.
- `sign`: XEdDSA manual di atas primitif `curve25519-dalek` (Scalar/EdwardsPoint/CompressedEdwardsY) + `sha2` SHA512. Skema: clamp sk → A = clamp(sk)·B → r = SHA512(sk∥m) mod L → R=r·B → h=SHA512(R∥A∥m) mod L → S=r+h·sk mod L → sig=R∥S, `sig[63]|=signbit(A)`.
- `verify`: konversi Montgomery→Edwards (`(x-1)/(x+1)`), pulihkan sign bit, lalu verifikasi Ed25519 (h·A + R·B == R).
- **Tanpa shortcut**: pakai operasi constant-time dari dalek; jangan tambah branching tergantung secret.

## 8. Bahaya (guardrail)

1. Salah identifikasi (dipakai crate Ed25519 standar) → signature "keliatan valid" tapi **invalid bagi implementasi asli** → pesan gagal didekripsi diam-diam. Pencegahan: oracle Fase 1 bit-exact, shadow mode Fase 3.
2. Clamping beda bit → key tak kompatibel. Pencegahan: edge-case vector (sk 0, small-order, sudah/belum di-clamp).
3. Beda nonce scheme (`r=SHA512(sk∥m)` vs Ed25519 standar `r=SHA512(prefix∥m)`) → signature beda. Wajib ikut skema lama.
