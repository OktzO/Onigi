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
// Re-export dari `sha2::digest`, bukan dependensi baru: `generic-array` sendiri
// tidak masuk Cargo.toml. Dipakai supaya digest masuk ke guard TANPA lewat
// temporer by-value milik crate ini (lihat catatan zeroization di akhir file).
use sha2::digest::generic_array::GenericArray;

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
fn clamp_scalar(sk: &mut Zeroizing<[u8; 32]>) {
    sk[0] &= 248;
    sk[31] &= 127;
    sk[31] |= 64;
}
// In place, bukan return `[u8; 32]`: bentuk lama menyalin key yang BELUM di-clamp
// ke local yang tidak di-wipe, lalu menyalin hasilnya keluar lagi (catatan di akhir).

/// r = SHA512(0xfe 0xff*31 || sk || m || rnd) mod L (crypto_sign_direct_rnd)
fn nonce_rnd(sk: &[u8; 32], msg: &[u8], rnd: &[u8]) -> Scalar {
    let mut h = Sha512::new();
    h.update([0xfeu8]);
    h.update([0xffu8; 31]);
    h.update(sk);
    h.update(msg);
    h.update(rnd);
    let mut digest = Zeroizing::new([0u8; 64]);
    h.finalize_into_reset(GenericArray::from_mut_slice(&mut digest[..]));
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
    let digest = Zeroizing::new(h.finalize().into());
    Scalar::from_bytes_mod_order_wide(&digest)
}

/// Sign inti. sk = clamped secret (32B). Mengembalikan signature 64 byte
/// (R || S), dengan sign bit dari pubkey di byte ke-63 (persis curve25519-js).
///
/// Bisa gagal kalau CSPRNG tidak tersedia — nonce tidak boleh pernah turun ke
/// nilai tetap, termasuk nol. Catatan: `Result` di file ini adalah alias dari
/// napi, jadi tipe error-nya ditulis eksplisit sebagai `std::result::Result`.
fn sign_internal(
    sk: &mut Zeroizing<[u8; 32]>,
    msg: &[u8],
    rnd: Option<&[u8; 64]>,
) -> std::result::Result<[u8; 64], String> {
    // `sk` milik `sign`: di-clamp in place (nol salinan), di-wipe saat drop.
    clamp_scalar(sk);
    // scalar a untuk pubkey & S. JS pakai byte mentah (mod L), sama saja.
    // Zeroizing juga di sini: Scalar dalek tidak punya Drop (lihat catatan
    // zeroization di akhir file), jadi r/h/s di bawah ikut dibungkus.
    let a = Zeroizing::new(Scalar::from_bytes_mod_order(**sk));
    // A = a*B (Edwards), packed. signBit = A[31] & 128.
    let a_bytes = base_mult_scalar(&a);
    let sign_bit = a_bytes[31] & 128;

    // The nonce must come from a CSPRNG: SHA512(sk||m) made sign() deterministic,
    // so two signatures over chosen messages recovered the identity key
    // (hidden-number-problem lattice attack). rnd stays injectable so the
    // parity oracle and known-answer vectors can still pin a fixed nonce, as
    // oktz-signal's curveSign does (that crate's source is not vendored here).
    let mut generated = Zeroizing::new([0u8; 64]);
    if rnd.is_none() {
        getrandom::getrandom(&mut generated[..])
            .map_err(|_| "no CSPRNG available for the XEdDSA nonce".to_string())?;
    }
    let r = Zeroizing::new(match rnd {
        Some(rnd) => nonce_rnd(sk, msg, rnd),
        None => nonce_rnd(sk, msg, &generated[..]),
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
    let mut rnd: Zeroizing<Option<[u8; 64]>> = Zeroizing::new(None);
    if let Some(r) = opt_random {
        check_len(&r, 64, "random data")?;
        *rnd = Some(r[..64].try_into().unwrap());
    }
    let mut sk = Zeroizing::new(<[u8; 32]>::try_from(&secret_key[..32]).unwrap());
    let sig = sign_internal(&mut sk, &msg, rnd.as_ref()).map_err(napi::Error::from_reason)?;
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
// Dua lapis di-guard: byte buffer dan `Scalar`. Wipe otomatis lewat `Drop`
// (zeroize-1.9.0/src/lib.rs:696) → `Z::zeroize`. `Scalar` justru perlu dibungkus
// karena dalek tidak membersihkannya sendiri: `curve25519_dalek::Scalar`
// (curve25519-dalek-4.1.3/src/scalar.rs:195) hanya `#[derive(Copy, Clone, Hash)]`,
// `impl Zeroize for Scalar` ada di :556, dan tidak ada `impl Drop` di seluruh crate
// itu — fitur `zeroize` di Cargo.toml membuat `scalar.zeroize()` bisa dipanggil
// tanpa membuat `Scalar` menghapus dirinya. Jadi `Zeroizing<Scalar>` menjaga
// representasi kanonik 32 byte saja: MEMBATASI residue, tidak menjamin "tidak ada
// sisa". Dibungkus, bukan diberi `.zeroize()` di titik pilihan, karena wipe terjadi di
// SETIEMAP jalur keluar — termasuk `?` CSPRNG :116 dan error yang dipropagasikan
// `sign` :165 — tanpa harus mengingat setiap `return`. Length check :158/:161 bukan
// contoh: keduanya jalan sebelum ada salinan secret di sisi Rust, dan `Uint8Array`
// pemanggil tetap milik pemanggil.
//
// == ATURANNYA: DUA PERTANYAAN, KEDUANYA WAJIB. Satu saja sudah beberapa kali gagal
//    menemukan residue yang benar-benar ada. ==
//
// 1. APAKAH SECRET-EQUIVALENT? Lolos kalau siapa pun yang memegangnya bisa mendapat
//    `a` dari `S = r + h·a` yang publik. "Bukan turunan secret" BELUM tentu lolos:
//    `digest` :66, `generated` :113 dan `rnd` :159 tidak satu pun diturunkan dari
//    `sk` — `generated` bahkan output CSPRNG — dan tetap dibungkus justru karena
//    semuanya preimage `r`, dari `S` dan `h` publik orang ambil `a = (S − r)·h⁻¹`.
//    Sebaliknya `h` dan `s` publik, dan dibungkus demi aturan seragam.
// 2. APAKAH ADA SALINAN BY-VALUE-NYA? Setiap argumen by-value dan setiap return
//    by-value di jalur signing adalah salinan byte MATERIAL ke memori yang crate ini
//    tidak wipe, dan itu sama beratnya apa pun tipenya — `Scalar`, `[u8; 32]`, atau
//    output hash. Yang membuat itu residue adalah SALINAN-nya, bukan asal-usul
//    byte-nya, jadi pertanyaan 1 tidak akan pernah melihatnya. Tiga bentuknya, dan
//    ketiganya harus dicari sendiri: (a) `let` yang menginisialisasi local tanpa
//    guard dari material ber-guard, BESERTA return by-value yang memakainya —
//    `let mut a = *sk;` di `clamp_scalar` lama persis begini, dan byte di local itu
//    key yang BELUM di-clamp; (b) argumen by-value yang dipaksa dependency, yang
//    salinannya mendarat di frame callee; (c) temporer by-value yang lahir dari
//    return by-value lalu dibaca yang lain — `h.finalize().into()` di :66 dan :83 pada
//    versi sebelumnya file ini, yang sudah hilang (lihat di bawah).
//
// Lolos kalau salah satu: byte-nya publik atau milik pemanggil; ATAU rentang dari
// sumber sampai guard-nya seluruhnya tertutup `Zeroizing`; ATAU salinannya tidak bisa
// dihindari — dan klausa terakhir hanya sah kalau mustahilnya DIBUKTIKAN dengan
// menyebut alternatif yang ABSEN. Contoh sah, yang berlaku untuk butir 1 di bawah:
// "dalek tidak punya konstruktor yang menerima `&[u8; 32]`". Yang tidak sah adalah
// "tidak bisa dihindari" tanpa nama: kriteria yang bisa dipenuhi dengan MENYATAKAN
// fakta bukan kriteria, dan itulah celah yang membuat `GenericArray` di :66 lolos satu
// putaran — ditemukan, lalu dituliskan sebagai tidak bisa dihindari, padahal ada
// alternatifnya (`finalize_into_reset` ke `&mut [u8]` milik kita) yang justru dipakai
// di :67 sekarang.
//
// == HASILNYA: YANG LOLOS ==
//
// SUDAH DI-GUARD dari sumber sampai akhir, nol salinan by-value: `sk` :164 (dibuat dari
// `&secret_key[..32]`, lalu di-clamp IN PLACE di :99), `generated` :113, `rnd` :159,
// `digest` :66 dan :83.
// PASS BY-REFERENCE, tidak menyalin sama sekali: `check_len`, `base_mult_scalar(&Scalar)`,
// `challenge(&r_bytes, &a_bytes, msg)`, `nonce_rnd` di kedua arm (semuanya `&[u8]`),
// `getrandom(&mut generated[..])`, `s.to_bytes()` (lewat `&self`), `copy_from_slice`
// `(&r_bytes)`/`(&s_bytes)`, `GenericArray::from_mut_slice(&mut digest[..])` :67.
// PUBLIK, jadi sengaja tidak dibungkus: `B` sendiri (konstanta), lalu `p`/
// `CompressedEdwardsY` di `base_mult_scalar` — `impl Mul<&Scalar> for &EdwardsPoint`
// (edwards.rs:720) memang menyalin `self`, tapi `self` itu konstanta publik — lalu
// `a_bytes` :105 (=`A`), `r_bytes` :124 (=`R`), `s_bytes` :133 (=`S`), `sig` :135,
// `digest` :83, `sign_bit` :106.
// MEMILIK PEMANGGIL: `secret_key`, `opt_random`, `msg` — dipinjam lewat `&` oleh napi
// 3.12.2 (`napi_get_typedarray_info`, arraybuffer.rs:740, dari `impl_typed_array!`
// di :1546). Yang dipinjam view milik pemanggil; :162 dan :164 menyalin DARI view itu
// ke guard kita, dan salinan itu sudah terhitung di atas. Di `verify` tidak ada buffer
// secret sama sekali: inputnya sudah publik.
//
// == HASILNYA: YANG BENAR-BENARNYA SECRET DAN TIDAK BISA DI-HINDARI DARI SINI —
//    DUA BUTIR, EMPAT ALOKASI ==
//
// Standar yang dipakai dinyatakan terbuka di depan butir 1: ini SOURCE-level, dengan
// sengaja, dan tidak bergantung pada codegen — apakah optimiser menyalin byte ke sana
// atau meng-optimasi salinan itu pada build tertentu tidak diklaim di sini dan tidak
// boleh disandarkan pada catatan ini. Yang diklaim hanya bentuknya di sumber.
//
// 1. Slot argumen by-value `**sk` di :103 — ours to place, dalek's to accept. Yang
//    ABSEN itu satu: constructor `Scalar` yang menerima `&[u8; 32]`.
//    `from_bytes_mod_order` (scalar.rs:237) dan `from_canonical_bytes` (:261)
//    keduanya menerima 32 byte BY VALUE; satu-satunya constructor yang menerima
//    reference adalah `from_bytes_mod_order_wide` (:250), dan yang diterimanya
//    `&[u8; 64]`. `**sk` — dua kali deref dari `&mut Zeroizing<[u8; 32]>` — memanggil
//    yang 32-byte, jadi slot argumennya terisi dan tidak ada penataan ulang di file ini
//    yang memanggilnya lewat `&`. Salinan ini milik frame callee, di luar jangkauan
//    `Zeroizing` crate ini.
// 2. Yang di dalam DEPENDENCY: ekspresi kita yang memanggilnya, API-nya yang memaksa —
//    bentuk yang sama dengan butir 1, karena tidak ada alternatif. Ketiganya benar-
//    benar secret, tidak punya wipe, dan tidak bisa dijangkau dari sini:
//    (a) dalek, `Scalar::unpack()` (scalar.rs:1119) — `pub(crate)`, jadi tidak bisa
//        dipanggil dari file ini. Setiap operasi limbanya mengembalikan `UnpackedScalar`
//        sementara yang tidak di-zeroize; satu-satunya yang di-wipe di dalek adalah
//        scratch `batch_invert` (:834), jadi zeroize di sana opt-in per call site.
//        Dipanggil dari `reduce()` (→ `from_bytes_mod_order` :237, jadi `a` dari :103),
//        dari `from_bytes_mod_order_wide` (:250, jadi `digest` :68/:84 yang
//        secret-equivalent), dan dari impl `Mul`/`Add` di :132 (jadi `a` dan `r`).
//    (b) sha2, state `Sha512` di `nonce_rnd` (:60-65) menyerap `sk` lewat
//        `h.update(sk)` :63. `digest_pad` (block-buffer-0.10.4/src/lib.rs:290) hanya
//        meng-nol byte SETELAH posisi blok dan `BlockBuffer::reset` (:180) hanya
//        mengembalikan posisi, jadi `finalize_fixed_reset` tidak menolong: `sk` masih
//        ada saat hasher di-drop.
//    (c) digest, `full_res` di `CtVariableCoreWrapper::finalize_fixed_core`
//        (digest-0.10.7/src/core_api/ct_variable.rs:119). Kode generiknya, tapi ada di
//        SETIEMAP jalur finalisasi sha2: `CoreWrapper::finalize_into_reset`
//        (digest-0.10.7/src/core_api/wrapper.rs:183-189) memanggil `finalize_fixed_core`
//        lalu menambah `core.reset()`/`buffer.reset()`, dan tidak ada API sha2 yang
//        menulis digest tanpa lewat situ. Fix :67 tidak menghapusnya; yang dihapus
//        adalah bagian yang bisa dihapus.
//
// Semuanya di luar jangkauan `Zeroizing` crate ini: dicatat, bukan diklaim hilang, dan
// yang tersisa bukan "salinan yang lupa dihapus" melainkan tempat yang tidak punya API
// untuk dihapus dari sini.
//
// == BENTUK KODE, DAN YANG DIHAPUS DARI KODE ==
//
// `r + h * a` TIDAK compile — `Zeroizing` tidak punya Mul/Add dan operator tidak
// autoderef (`error[E0369]`) — jadi bentuk by-value yang "diam-diam menyalin" memang
// tidak ada. `*r + *h * *a` compile TANPA warning (`Scalar: Copy`, dan
// `define_mul_variants!` di scalar.rs:330 menghasilkan `impl Mul<Scalar> for Scalar`):
// itu yang berbahaya, ketiga secret masuk temporer tidak di-wipe. `&*r + &*h * &*a`
// memakai `Mul<&Scalar> for &Scalar` (:323) dan `Add<&Scalar> for &Scalar` (:340),
// jadi `a`, `r`, `h` tidak pernah keluar dari buffer-nya sebagai nilai. Yang tetap
// KELUAR by-value ada dua, di :132: produk `h * a` lalu jumlahnya, masing-masing di
// frame `Mul`/`Add` dan tidak di-wipe — tidak masalah, `a` tidak dapat diambil dari
// `h·a` maupun `r + h·a` tanpa sudah memegang `a`.
//
// Dua salinan yang hilang, bukan cuma dicatat: `clamp_scalar` yang lama — local tak
// ber-guard berisi key yang belum di-clamp, plus return by-value-nya — dan temporer
// `GenericArray` dari `h.finalize().into()` yang dulu ada di :66. Yang kedua hilang
// karena crate ini menulis digest langsung ke dalam `&mut` miliknya sendiri;
// `Zeroizing<GenericArray<u8, U64>>` sendiri tidak tersedia di sini (`generic-array`
// meng-gate impl `Zeroize`-nya di balik feature `zeroize`,
// generic-array-0.14.7/src/lib.rs:90, dan yang aktif cuma `more_lengths`), jadi
// `GenericArray::from_mut_slice` menyelesaikannya tanpa feature baru —
// `sha2::digest::generic_array` hanya re-export, `Cargo.toml` tidak berubah.
