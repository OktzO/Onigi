#![deny(unsafe_code)]

// curve25519-rs — native Rust untuk fungsi curve25519 yang TIDAK ada native di
// Node.js: XEdDSA sign/verify (Signal). generateKeyPair + sharedKey sudah
// native node:crypto (x25519 keygen + diffieHellman) → TIDAK dibuat ulang,
// zero binary tambahan untuk yang Node sudah punya.
//
// Implementasi XEdDSA = BUKAN Ed25519 standar: konversi Montgomery↔Edwards,
// secret key dipakai langsung di hash (r = SHA512(sk||m)), sign bit di byte
// signature[63]. Port manual bit-exact di atas curve25519-dalek (constant-time).

use napi_derive::napi;
use napi::bindgen_prelude::*;

use curve25519_dalek::edwards::EdwardsPoint;
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;
use curve25519_dalek::MontgomeryPoint;

use sha2::{Digest, Sha512};

/// B-poin Edwards (base point) yang sama dengan B di curve25519-js.
const B: EdwardsPoint = ED25519_BASEPOINT_POINT;

// --- helpers ---

fn check_len(v: &[u8], n: usize, what: &str) -> Result<()> {
    if v.len() != n {
        return Err(napi::Error::from_reason(format!(
            "wrong {} length: {} (expected {})",
            what,
            v.len(),
            n
        )));
    }
    Ok(())
}

/// Clamping secret key versi curve25519-js (RFC 7748).
/// edsk[0] &= 248; edsk[31] &= 127; edsk[31] |= 64
fn clamp_scalar(sk: &[u8; 32]) -> [u8; 32] {
    let mut a = *sk;
    a[0] &= 248;
    a[31] &= 127;
    a[31] |= 64;
    a
}

/// r = SHA512(sk || m) mod L  → Scalar (crypto_sign_direct)
fn nonce_direct(sk: &[u8; 32], msg: &[u8]) -> Scalar {
    let mut h = Sha512::new();
    h.update(sk);
    h.update(msg);
    let digest: [u8; 64] = h.finalize().into();
    Scalar::from_bytes_mod_order_wide(&digest)
}

/// r = SHA512(0xfe 0xff*31 || sk || m || rnd) mod L (crypto_sign_direct_rnd)
fn nonce_rnd(sk: &[u8; 32], msg: &[u8], rnd: &[u8]) -> Scalar {
    let mut h = Sha512::new();
    h.update([0xfeu8]);
    h.update([0xffu8; 31]);
    h.update(sk);
    h.update(msg);
    h.update(rnd);
    let digest: [u8; 64] = h.finalize().into();
    Scalar::from_bytes_mod_order_wide(&digest)
}

/// A = a*B (Edwards), compressed → byte-32 (scalarbase + pack di JS)
fn base_mult_scalar(a: &Scalar) -> [u8; 32] {
    let p = B * a;
    p.compress().to_bytes()
}

/// h = SHA512(R || A || msg) mod L
fn challenge(r: &[u8; 32], a: &[u8; 32], msg: &[u8]) -> Scalar {
    let mut h = Sha512::new();
    h.update(r);
    h.update(a);
    h.update(msg);
    let digest: [u8; 64] = h.finalize().into();
    Scalar::from_bytes_mod_order_wide(&digest)
}

/// Sign inti. sk = clamped secret (32B). Mengembalikan signature 64 byte
/// (R || S), dengan sign bit dari pubkey di byte ke-63 (persis curve25519-js).
fn sign_internal(sk_raw: &[u8; 32], msg: &[u8], rnd: Option<&[u8; 64]>) -> [u8; 64] {
    let sk = clamp_scalar(sk_raw);
    // scalar a untuk pubkey & S. JS pakai byte mentah (mod L), sama saja.
    let a = Scalar::from_bytes_mod_order(sk);
    // A = a*B (Edwards), packed. signBit = A[31] & 128.
    let a_bytes = base_mult_scalar(&a);
    let sign_bit = a_bytes[31] & 128;

    // r (nonce) — beda jalur: direct vs rnd (hash separation).
    let r = match rnd {
        Some(rnd) => nonce_rnd(&sk, msg, rnd),
        None => nonce_direct(&sk, msg),
    };

    // R = r*B, packed
    let r_bytes = base_mult_scalar(&r);

    // h = SHA512(R || A || msg)
    let h = challenge(&r_bytes, &a_bytes, msg);

    // S = r + h*a mod L
    let s = r + h * a;
    let s_bytes = s.to_bytes();

    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&r_bytes);
    sig[32..64].copy_from_slice(&s_bytes);
    // salurkan sign bit pubkey ke byte terakhir signature
    sig[63] |= sign_bit;
    sig
}

/// convertPublicKey di JS: montgomery u → edwards y = (u-1)/(u+1),
/// lalu restore sign bit dari sig[63]. Pakai dalek MontgomeryPoint::to_edwards.
fn pubkey_montgomery_to_edwards(pk: &[u8; 32], sign_bit: u8) -> Option<EdwardsPoint> {
    let mp = MontgomeryPoint(*pk);
    mp.to_edwards(sign_bit)
}

// --- napi exports ---
// CATATAN: generateKeyPair + sharedKey TIDAK dibuat di Rust — Node 20/22
// sudah native (node:crypto generateKeyPairSync('x25519') + diffieHellman).
// Hanya XEdDSA sign/verify (yang tidak ada di Node) yang dibuat native.

/// sign(secretKey, msg, opt_random?) → signature 64 byte (XEdDSA)
#[napi]
pub fn sign(secret_key: Uint8Array, msg: Uint8Array, opt_random: Option<Uint8Array>) -> Result<Buffer> {
    check_len(&secret_key, 32, "secret key")?;
    let mut rnd: Option<[u8; 64]> = None;
    if let Some(r) = opt_random {
        check_len(&r, 64, "random data")?;
        rnd = Some(r[..64].try_into().unwrap());
    }
    let sk: [u8; 32] = secret_key[..32].try_into().unwrap();
    let sig = sign_internal(&sk, &msg, rnd.as_ref());
    Ok(Buffer::from(sig.to_vec()))
}

/// verify(publicKey, msg, signature) → bool (XEdDSA verify)
#[napi]
pub fn verify(public_key: Uint8Array, msg: Uint8Array, signature: Uint8Array) -> Result<bool> {
    check_len(&public_key, 32, "public key")?;
    check_len(&signature, 64, "signature")?;
    let pk: [u8; 32] = public_key[..32].try_into().unwrap();
    let sig: [u8; 64] = signature[..64].try_into().unwrap();

    // S = signature[32..64] dengan sign bit dihapus.
    let sign_bit = sig[63] & 128;
    let mut s_bytes = [0u8; 32];
    s_bytes.copy_from_slice(&sig[32..64]);
    s_bytes[31] &= 127; // hapus sign bit dari S

    // Konversi montgomery pk → edwards point, restore sign bit (sign=0/1).
    let a_point = match pubkey_montgomery_to_edwards(&pk, sign_bit >> 7) {
        Some(p) => p,
        None => return Ok(false),
    };

    // A (edwards, sign-restored) → bytes. h = SHA512(R || A || msg).
    // PERSIS crypto_sign_open JS: m = sm, lalu m[32..64] = edpk (hasil konversi).
    let a_bytes = a_point.compress().to_bytes();
    let r_bytes: [u8; 32] = sig[..32].try_into().unwrap();
    let h = challenge(&r_bytes, &a_bytes, &msg);

    // p = h*A + S*B, bandingkan dengan R
    let s_scalar = Scalar::from_bytes_mod_order(s_bytes);
    let p = EdwardsPoint::vartime_double_scalar_mul_basepoint(&h, &a_point, &s_scalar);
    let p_bytes = p.compress().to_bytes();
    Ok(p_bytes == r_bytes)
}
