#![deny(unsafe_code)]

// curve25519-rs — native Rust untuk fungsi curve25519 yang TIDAK ada native di
// Node.js: XEdDSA sign/verify (Signal). generateKeyPair + sharedKey sudah
// native node:crypto (x25519 keygen + diffieHellman) → TIDAK dibuat ulang,
// zero binary tambahan untuk yang Node sudah punya.
//
// Implementasi XEdDSA = BUKAN Ed25519 standar: konversi Montgomery↔Edwards,
// secret key dipakai langsung di hash (r = SHA512(0xfe 0xff*31 || sk || m
// || rnd), rnd dari CSPRNG), sign bit di byte signature[63].
// Port manual bit-exact di atas curve25519-dalek (constant-time).

use napi_derive::napi;
use napi::bindgen_prelude::*;

use curve25519_dalek::edwards::EdwardsPoint;
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;
use curve25519_dalek::MontgomeryPoint;

use ed25519_dalek::{Signature, VerifyingKey};

use sha2::{Digest, Sha512};

use zeroize::Zeroizing;

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
///
/// Bisa gagal kalau CSPRNG tidak tersedia — nonce tidak boleh pernah turun ke
/// nilai tetap, termasuk nol. Catatan: `Result` di file ini adalah alias dari
/// napi, jadi tipe error-nya ditulis eksplisit sebagai `std::result::Result`.
fn sign_internal(
    sk_raw: &[u8; 32],
    msg: &[u8],
    rnd: Option<&[u8; 64]>,
) -> std::result::Result<[u8; 64], String> {
    // Zeroizing: wipe clamped secret saat drop (stack/error path sekalipun).
    let sk = Zeroizing::new(clamp_scalar(sk_raw));
    // scalar a untuk pubkey & S. JS pakai byte mentah (mod L), sama saja.
    // Zeroizing juga di sini: Scalar dalek tidak punya Drop (lihat catatan
    // zeroization di akhir file), jadi r/h/s di bawah ikut dibungkus.
    let a = Zeroizing::new(Scalar::from_bytes_mod_order(*sk));
    // A = a*B (Edwards), packed. signBit = A[31] & 128.
    let a_bytes = base_mult_scalar(&a);
    let sign_bit = a_bytes[31] & 128;

    // The nonce must come from a CSPRNG: SHA512(sk||m) made sign() deterministic,
    // so two signatures over chosen messages recovered the identity key
    // (hidden-number-problem lattice attack). rnd stays injectable so the
    // parity oracle and known-answer vectors can still pin a fixed nonce, as
    // oktz-signal's curveSign does (that crate's source is not vendored here).
    let mut generated = [0u8; 64];
    if rnd.is_none() {
        getrandom::getrandom(&mut generated)
            .map_err(|_| "no CSPRNG available for the XEdDSA nonce".to_string())?;
    }
    let r = Zeroizing::new(match rnd {
        Some(rnd) => nonce_rnd(&sk, msg, rnd),
        None => nonce_rnd(&sk, msg, &generated),
    });

    // R = r*B, packed
    let r_bytes = base_mult_scalar(&r);

    // h = SHA512(R || A || msg)
    let h = Zeroizing::new(challenge(&r_bytes, &a_bytes, msg));

    // S = r + h*a mod L. `&*r + &*h * &*a`, bukan `*r + *h * *a`: Scalar-nya Copy,
    // jadi bentuk by-value menyalin r/h/a keluar dari buffer Zeroizing, sedangkan
    // `r + h * a` sendiri tidak compile — Zeroizing tak meneruskan operator.
    let s = Zeroizing::new(&*r + &*h * &*a);
    let s_bytes = s.to_bytes();

    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&r_bytes);
    sig[32..64].copy_from_slice(&s_bytes);
    // salurkan sign bit pubkey ke byte terakhir signature
    sig[63] |= sign_bit;
    Ok(sig)
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
    let sk = Zeroizing::new(<[u8; 32]>::try_from(&secret_key[..32]).unwrap());
    let sig = sign_internal(&sk, &msg, rnd.as_ref()).map_err(napi::Error::from_reason)?;
    Ok(Buffer::from(sig.to_vec()))
}

/// verify(publicKey, msg, signature) → bool (XEdDSA verify)
///
/// XEdDSA verify = Ed25519 verify standar setelah:
///   1. convertPublicKey: montgomery u → edwards y = (u-1)/(u+1)
///   2. restore sign bit dari signature[63] ke pubkey
///   3. hapus sign bit dari signature[63] (kembalikan S asli)
/// Pakai ed25519-dalek verify (R = S*B + h*A), bukan manual — dalek lebih
/// aman + sudah divalidasi. Nonce di verify memang standard (h = SHA512(R||A||m));
/// yang custom cuma di sisi sign.
#[napi]
pub fn verify(public_key: Uint8Array, msg: Uint8Array, signature: Uint8Array) -> Result<bool> {
    check_len(&public_key, 32, "public key")?;
    check_len(&signature, 64, "signature")?;
    let pk: [u8; 32] = public_key[..32].try_into().unwrap();
    let sig: [u8; 64] = signature[..64].try_into().unwrap();

    // Restore sign bit dari signature ke pubkey (edwards).
    let sign_bit = sig[63] & 128;
    let a_bytes = match pubkey_montgomery_to_edwards(&pk, sign_bit >> 7) {
        Some(p) => p.compress().to_bytes(),
        None => return Ok(false),
    };

    // Hapus sign bit dari signature → S asli.
    let mut sig_clean = sig;
    sig_clean[63] &= 127;

    let signature = Signature::from_bytes(&sig_clean);
    let vk = match VerifyingKey::from_bytes(&a_bytes) {
        Ok(v) => v,
        Err(_) => return Ok(false),
    };
    // verify_strict, not verify: the cofactorless equation accepts a forged
    // signature whenever the public key is a small-order point (u = 0 maps to
    // the Edwards order-2 point, where R = A, S = 0 verifies for every message
    // and every key). verify_strict rejects small-order R and weak A. oktz-signal
    // already does this; the two implementations must stay byte-compatible.
    Ok(vk.verify_strict(&msg, &signature).is_ok())
}

// --- catatan zeroization ---
//
// Dua lapis yang berbeda, dan hanya yang pertama yang otomatis:
//
// 1. `sk` — byte secret yang sudah di-clamp, 32 byte — di `Zeroizing<[u8; 32]>`
//    (baris 94 dan 159). Wipe-nya benar-benar otomatis: `Zeroizing` punya
//    `Drop` (zeroize-1.9.0/src/lib.rs:696) yang memanggil `Z::zeroize`.
// 2. `a`, `r`, `h`, `s` — representasi aritmetika. `curve25519_dalek::Scalar`
//    (curve25519-dalek-4.1.3/src/scalar.rs:195) hanya `#[derive(Copy, Clone,
//    Hash)]`; `impl Zeroize for Scalar` ada di baris 556 dan TIDAK ada
//    `impl Drop`. Fitur `zeroize` di Cargo.toml membuat `scalar.zeroize()` bisa
//    dipanggil, tidak membuat `Scalar` menghapus dirinya sendiri.
//
// Yang secret-derived adalah `a` dan `r`. `h` dan `s` juga dibungkus, meski
// keduanya bukan rahasia: `h = SHA512(R ‖ A ‖ m)`, dan R serta A sudah keluar ke
// caller (A sebagai public key, R sebagai paruh signature) sementara `m` adalah
// data pemanggil — jadi `h` publik, begitu juga `S` karena ada di signature.
// Biayanya 32 byte stack dan satu wipe masing-masing, dan aturan "dibungkus,
// bukan `.zeroize()` manual" jadi jelas untuk turunan berikutnya.
//
// Dibungkus, bukan diberi `.zeroize()` di titik-titik pilihan: pembungkus
// membuat wipe terjadi di SETIEMAP jalur keluar — termasuk `?` CSPRNG di
// baris 111 dan error yang dipropagasikan `sign` di baris 160 — tanpa harus
// mengingat setiap `return`. Length check di baris 153/156 bukan contoh:
// keduanya jalan sebelum ada salinan secret di sisi Rust, dan `Uint8Array`
// pemanggil tetap milik pemanggil.
//
// Kenapa `&*r + &*h * &*a`, bukan bentuk by-value:
//
// - `r + h * a` TIDAK compile. `Zeroizing` tidak mengimplementasikan
//   Mul/Add sama sekali (zeroize-1.9.0 hanya punya Deref, DerefMut, AsRef,
//   AsMut, Zeroize, ZeroizeOnDrop, Drop, Clone, From), dan operator tidak
//   melakukan autoderef: `error[E0369]: cannot multiply Zeroizing<Scalar> by
//   Zeroizing<Scalar>`. Jadi di sini tidak ada "bentuk by-value yang diam-diam
//   menyalin" — bentuk itu memang tidak ada.
// - `*r + *h * *a` compile TANPA warning, karena `Scalar: Copy` dan dalek
//   mengimplementasikan `Mul<Scalar> for Scalar` (scalar.rs:330 lewat
//   `define_mul_variants!`). Itu yang berbahaya: ketiga secret disalin ke
//   temporer yang tidak di-wipe, persis yang wrap ini cegah.
// - `&*r + &*h * &*a` memakai `impl Mul<&Scalar> for &Scalar` (scalar.rs:323)
//   dan `impl Add<&Scalar> for &Scalar` (scalar.rs:340). Keduanya membaca lewat
//   reference, jadi `a`, `r`, dan `h` sendiri tidak pernah keluar dari buffer-nya
//   sebagai nilai `Scalar`; yang diambil by-value hanya produk `h * a` lalu
//   jumlahnya (lihat batasannya).
//
// Batasnya, jujur:
//
// - Produk `h * a` tetap dimaterialisasi sebagai `Scalar` sementara yang tidak
//   di-wipe — itu return value dari impl `Mul` di atas, dan tidak bisa dihindari
//   tanpa memanggil `.zeroize()` manual pada hasilnya. Tidak masalah: `h`
//   publik, jadi yang tertinggal adalah `h·a`, dan `a` tidak dapat diambil dari
//   `h·a` tanpa sudah memegang `a`. Yang berbahaya adalah salinan `a`/`r`.
// - Di dalam dalek, `Scalar::unpack()` (scalar.rs:1119) dan operasi limbanya
//   membuat `UnpackedScalar` sementara yang dalek sendiri tidak zeroize (yang
//   di-wipe hanya scratch `batch_invert`, scalar.rs:834). `Zeroizing<Scalar>`
//   menjaga representasi kanonik 32 byte; ia tidak bisa menjangkau ke dalam
//   dalek. Jadi ini membatasi residue, bukan menjamin "tidak ada sisa".
//
// Yang TIDAK dibungkus: `generated` (64 byte dari CSPRNG, bukan turunan
// secret — tidak rahasia), `a_bytes`/`r_bytes` (koordinat publik), dan
// `Uint8Array` milik pemanggil, yang tidak boleh disentuh crate ini sama
// sekali. `s_bytes` juga tidak, tapi itu karena `S` keluar ke caller sebagai
// signature, bukan karena wipe-nya di-lewatkan.
//
// Dan satu residue yang benar-benar byte secret, bukan turunan publik:
// `Scalar::from_bytes_mod_order` menerima 32 byte itu BY VALUE
// (curve25519-dalek-4.1.3/src/scalar.rs:237), jadi `*sk` di baris 98 — yang
// hasil deref dari `Zeroizing<[u8; 32]>` — mematerialisasi salinan `[u8; 32]`
// dari secret yang sudah di-clamp ke dalam slot argumennya, dan tidak ada yang
// meng-wipe-nya selama panggilan itu berjalan. dalek tidak punya konstruktor
// yang menerima `&[u8; 32]`, dan tidak ada penataan ulang di file ini yang
// menghindari panggilan by-value tersebut, jadi residue ini dicatat, bukan
// diperbaiki.
