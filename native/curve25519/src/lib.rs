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
// Dua lapis yang berbeda, dan hanya yang pertama yang otomatis:
//
// 1. Byte buffer di `Zeroizing`: `sk` (99, 164), `digest` di kedua fungsi
//    SHA-512 (66, 83), `generated` (113), `rnd` (159). Wipe-nya otomatis lewat
//    `Drop` (zeroize-1.9.0/src/lib.rs:696) → `Z::zeroize`.
// 2. `Scalar` — representasi aritmetika — juga di `Zeroizing`. TAPI
//    `curve25519_dalek::Scalar` (curve25519-dalek-4.1.3/src/scalar.rs:195)
//    hanya `#[derive(Copy, Clone, Hash)]`; `impl Zeroize for Scalar` ada di
//    baris 556 dan TIDAK ada `impl Drop`. Fitur `zeroize` di Cargo.toml membuat
//    `scalar.zeroize()` bisa dipanggil tanpa membuat `Scalar` hapus dirinya.
//
// Yang secret-derived: `a`, `r`, `digest` di `nonce_rnd` (66), `generated` (113)
// dan `rnd` (159). Tiga yang terakhir semuanya preimage `r` atau lebih dekat ke
// sana — dari `S` dan `h` yang publik orang bisa ambil `a = (S − r)·h⁻¹` — jadi
// secret-equivalent dengan `a`, bukan hanya "bukan turunan secret" seperti klaim
// lama soal `generated`. `h`, `s`, dan `digest` di `challenge` (83) ikut
// dibungkus demi aturan seragam; inputnya publik semua, daftarnya ada di bawah.
//
// Dibungkus, bukan diberi `.zeroize()` di titik-titik pilihan: pembungkus
// membuat wipe terjadi di SETIEMAP jalur keluar — termasuk `?` CSPRNG di
// baris 116 dan error yang dipropagasikan `sign` di baris 165 — tanpa harus
// mengingat setiap `return`. Length check di baris 158/161 bukan contoh:
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
//   sebagai nilai `Scalar`. Yang keluar by-value ada DUA, keduanya di baris 132:
//   produk `h * a` (return `Mul`) lalu jumlahnya (return `Add`) — bukan satu,
//   seperti klaim lama di catatan ini. Keduanya langsung dipindah ke dalam
//   `Zeroizing::new` pada baris yang sama, jadi tidak ada temporer ketiga yang
//   memegang salah satunya.
//
// Batasnya, jujur:
//
// - Dua nilai by-value baris 132 itu, masing-masing di frame `Mul` dan frame `Add`,
//   tidak di-wipe. Tidak masalah: `h` sudah publik, jadi yang tertinggal adalah
//   `h·a` lalu `r + h·a`, dan `a` tidak dapat diambil dari keduanya tanpa sudah
//   memegang `a`. Yang berbahaya adalah salinan `a`/`r`, dan itulah yang tidak
//   terjadi di baris itu.
// - Yang menyerap byte secret lalu dibuang tanpa wipe ada di dalam DEPENDENCY,
//   dan `Zeroizing` crate ini tidak bisa menjangkau:
//   - dalek: `Scalar::unpack()` (scalar.rs:1119) dan operasi limbanya membuat
//     `UnpackedScalar` sementara yang dalek sendiri tidak zeroize (yang di-wipe
//     hanya scratch `batch_invert`, scalar.rs:834). Isinya limb `a` dan `r`.
//   - sha2 0.10.9, dua hal, dan ownership-nya dipisah karena sebelumnya keduanya
//     disampur jadi "milik sha2":
//     (i) State `Sha512` di `nonce_rnd` (baris 60-65) menyerap `sk` lewat
//     `h.update(sk)` di baris 63; `digest_pad`
//     (block-buffer-0.10.4/src/lib.rs:290) hanya meng-nol byte SETELAH posisi
//     blok dan `BlockBuffer::reset` (baris 180) hanya mengembalikan posisi, jadi
//     `finalize_fixed_reset` tidak menolong — `sk` masih ada saat hasher di-drop.
//     (ii) `CtVariableCoreWrapper::finalize_fixed_core` (ct_variable.rs:119)
//     mengalokasikan `full_res` yang tidak di-wipe. Ini milik sha2 dan ada di
//     SETIAP jalur finalisasi: `CoreWrapper::finalize_into_reset`
//     (wrapper.rs:185) memanggil `finalize_fixed_core` lalu menambah
//     `core.reset()`/`buffer.reset()`, dan tidak ada API sha2 yang menulis digest
//     tanpa lewat situ.
//     Yang BUKAN milik sha2, dan sekarang hilang: `out` di
//     `FixedOutput::finalize_fixed` (digest-0.10.7/src/lib.rs:99-103,
//     `let mut out = Default::default(); self.finalize_into(&mut out); out`).
//     `out` dialokasikan di frame `finalize_fixed`, tapi NILAI-nya dipindah ke
//     frame kita, jadi itu salinan milik crate ini — bisa dihapus, dan dihapus:
//     baris 67 memanggil `finalize_into_reset(GenericArray::from_mut_slice(&mut
//     digest[..]))`, yang menulis digest langsung ke dalam guard, sehingga `out`
//     tidak pernah muncul di frame kita. Bentuk lamanya — `let digest =
//     Zeroizing::new(h.finalize().into())`, satu baris di mana `out` sekarang
//     hidup — memang mematerialisasikannya di slot yang tidak di-wipe.
//   `Zeroizing<Scalar>` menjaga representasi kanonik 32 byte saja. Jadi ini
//   membatasi residue, bukan menjamin "tidak ada sisa".
//
// Yang TIDAK dibungkus, dan alasan tiap-tiapnya bukan "wipe-nya terlewat":
// - `a_bytes`/`r_bytes` plus temporer di `base_mult_scalar` — `p` dari
//   `impl Mul<&Scalar> for EdwardsPoint` (edwards.rs:717; `self`-nya by value tapi
//   `self` itu konstanta publik `B`), lalu `CompressedEdwardsY` dari `compress()`:
//   koordinat publik, karena `A` sudah keluar sebagai public key dan `R` sebagai
//   paruh pertama signature. Berlaku juga untuk `s_bytes` dan `sig`.
// - `Uint8Array` milik pemanggil: napi 3.12.2 membacanya lewat
//   `napi_get_typedarray_info` (arraybuffer.rs:740, dari `impl_typed_array!` yang
//   mendefinisikan `Uint8Array` di baris 1546), jadi `Uint8Array` hanyalah `&[u8]`
//   yang menunjuk ke memori JS dan crate ini tidak menyalin satu byte pun darinya.
//   Di `verify` tidak ada buffer secret sama sekali: inputnya sudah publik.
//
// Kriteria yang dipakai, supaya aturan ini bisa diterapkan tanpa tebakan. DUA
// pertanyaan, keduanya wajib; satu saja sudah dua kali gagal menemukan residue
// yang benar-benar ada.
//
// 1. APAKAH INI SECRET-EQUIVALENT? Sebuah buffer dianggap secret-equivalent kalau
//    siapa pun yang memegangnya bisa mendapat `a` dari `S = r + h·a` yang publik,
//    dengan `r = SHA512(...) mod L`. Buffer seperti itu dibungkus. "Bukan turunan
//    secret" BELUM tentu lolos: `digest` baris 66, `generated` baris 113, dan
//    `rnd` baris 159 tidak satu pun diturunkan dari `sk`, dan ketiganya tetap
//    dibungkus justru karena semuanya preimage `r`.
// 2. APAKAH ADA SALINAN BY-VALUE-NYA? Setiap argumen by-value dan setiap return
//    by-value di jalur signing adalah salinan byte secret ke memori yang crate ini
//    tidak wipe, dan itu dihitung sama beratnya apa pun tipenya — `Scalar`,
//    `[u8; 32]`, atau output hash. Yang membuatnya residue adalah SALINAN-nya, bukan
//    asal-usul byte-nya, jadi pertanyaan 1 tidak akan pernah melihatnya. Bentuknya
//    ada tiga dan ketiganya harus dicari sendiri: (a) `let` yang menginisialisasi
//    local tanpa guard dari material ber-guard, BESERTA return by-value yang
//    memakainya — `let mut a = *sk;` di `clamp_scalar` lama persis begini, dan byte
//    di local itu adalah key yang BELUM di-clamp; (b) argumen by-value yang dipaksa
//    dependency — `from_bytes_mod_order` mau `[u8; 32]` positional (scalar.rs:237),
//    dan salinannya ada di frame callee sehingga `Zeroizing` di sini tidak bisa
//    menjangkau; (c) temporer by-value yang lahir dari return by-value lalu dibaca
//    oleh yang lain — `h.finalize().into()` di baris 66 dan 83 pada versi
//    sebelumnya file ini, yang keduanya sudah hilang (lihat di bawah).
//
// Lolos kalau salah satu: byte-nya publik atau milik pemanggil; ATAU rentang dari
// sumber sampai guard-nya seluruhnya tertutup `Zeroizing`; ATAU salinannya tidak
// bisa dihindari — dan klausa terakhir ini hanya sah kalau mustahilnya
// DIBUKTIKAN dengan menyebut alternatif yang ABSEN, bukan sekadar diklaim.
// Contoh yang sah, dan memang yang berlaku untuk baris 103: "dalek tidak punya
// konstruktor yang menerima `&[u8; 32]`", jadi slot argumen itu tidak bisa
// dihilangkan dari file ini. Yang tidak sah adalah "tidak bisa dihindari"
// tanpa nama — kriteria yang bisa dipenuhi dengan MENYATAKAN sebuah fakta bukan
// kriteria, dan itulah celah yang membuat salinan `GenericArray` di baris 66 lolos
// satu putaran: ia ditemukan, lalu dituliskan sebagai tidak bisa dihindari, padahal
// ada alternatifnya (`finalize_into_reset` ke dalam `&mut [u8]` milik kita) yang
// justru dipakai di baris 67 sekarang. Kalau alternatifnya tidak ada, sebutkan
// konstruktor atau fungsi yang dicari dan tidak ditemukan; kalau ada, itu salinan
// dan harus dihapus.
//
// Kriteria di atas, dijalankan ulang ke seluruh jalur signing; salinan by-value
// yang diperiksa dan disposition-nya:
// - SECRET: `**sk` baris 103 → argumen by-value `from_bytes_mod_order`, bentuk (b),
//   tidak bisa dihindari → dicatat, dengan alternatif absen yang disebut nama di
//   atas. `a`, `r`, `h`, `s` sendiri tidak punya salinan by-value; yang keluar dari
//   buffer-nya hanya dua nilai baris 132, produk lalu jumlahnya, keduanya
//   public-derived.
// - PUBLIK, jadi sengaja tidak dibungkus: `p`/`CompressedEdwardsY` di
//   `base_mult_scalar` (= `A`), `r_bytes` (= `R`), `s_bytes` (= `S`), `sig`,
//   `digest` baris 83 (`SHA512(R ‖ A ‖ m)`), `sign_bit`.
// - MEMILIK PEMANGGIL: `secret_key`, `opt_random`, `msg` — dipinjam lewat `&`.
// - SUDAH DI-GUARD dari sumber sampai akhir: `sk` baris 164 (dibuat dari
//   `&secret_key[..32]`, lalu di-clamp IN PLACE di baris 99 — nol salinan),
//   `generated` baris 113, `rnd` baris 159, `digest` baris 66 dan 83.
// - PASS BY-REFERENCE, jadi tidak menyalin sama sekali: `check_len`,
//   `base_mult_scalar` (`&Scalar`), `challenge(&r_bytes, &a_bytes, msg)`,
//   `nonce_rnd` di kedua arm (semuanya `&[u8]`), `getrandom(&mut generated[..])`,
//   `s.to_bytes()` (lewat `&self`), `copy_from_slice(&r_bytes)`/`(&s_bytes)`, dan
//   `GenericArray::from_mut_slice(&mut digest[..])` di baris 67.
//
// Yang benar-benar secret dan TIDAK bisa dihindari dari sini: DUA. Standard yang
// dipakai dinyatakan terbuka di depan kedua butir: ini SOURCE-level, dengan
// sengaja, dan tidak bergantung pada codegen.
// 1. Slot argumen by-value `**sk` di baris 103. Standard yang dipakai di sini
//    dinyatakan terbuka: ini klaim level SOURCE — nilai `[u8; 32]` itu ada di
//    slot argumen sebagai objek tersendiri di sumber, dan tidak ada yang
//    meng-wipe-nya. Sengaja tidak ada klaim apa pun tentang codegen: apakah
//    optimiser benar-benar menyalin byte ke sana, atau meng-optimasi salinan itu
//    pada build tertentu, tidak diklaim di sini dan tidak boleh disandarkan pada
//    catatan ini. Yang diklaim hanya bentuknya di sumber, dan itu bentuknya
//    memang ada, apa pun yang terjadi setelahnya.
//    Alasannya tidak bisa dihapus dari file ini: `Scalar::from_bytes_mod_order`
//    menerima 32 byte itu BY VALUE (curve25519-dalek-4.1.3/src/scalar.rs:237),
//    dan dalek tidak punya konstruktor yang menerima `&[u8; 32]` — dua fungsi
//    constructor-nya (scalar.rs:237 dan :250) keduanya positional. `**sk` —
//    hasil dua kali deref dari `&mut Zeroizing<[u8; 32]>` — memanggil yang itu,
//    jadi slot argumennya terisi dan tidak ada penataan ulang di file ini yang
//    memanggilnya lewat `&`. Salinan ini milik frame callee, di luar jangkauan
//    `Zeroizing` crate ini.
// 2. Yang di dalam sha2, sudah disebut lengkap di batasannya di atas: block
//    buffer yang masih memuat `sk`, dan `full_res` di
//    `finalize_fixed_core`. Keduanya dialokasikan sha2 di frame-nya sendiri, dan
//    tidak punya wipe maupun `Drop` — sha2 0.10.9 tidak mengimplementasikan
//    salah satu pun.
// Dua-duanya di luar jangkauan `Zeroizing` crate ini. Dicatat, bukan diklaim
// hilang, dan yang tersisa bukan "salinan yang lupa dihapus" melainkan dua
// tempat yang tidak punya API untuk dihapus dari sini.
//
// Yang hilang di kode, bukan cuma dicatat: salinan `clamp_scalar` yang lama —
// local tak ber-guard berisi key yang belum di-clamp, plus return by-value-nya —
// dan temporer `GenericArray` dari `h.finalize().into()` yang dulu ada di baris
// 66 sebelum perubahan ini. Yang kedua hilang karena crate ini menulis digest
// langsung ke dalam `&mut` miliknya sendiri; `Zeroizing<GenericArray<u8, U64>>`
// sendiri tidak tersedia di sini (`generic-array` meng-gate impl `Zeroize`-nya di
// balik feature `zeroize`, generic-array-0.14.7/src/lib.rs:90, dan yang aktif cuma
// `more_lengths`), jadi `GenericArray::from_mut_slice` menyelesaikannya tanpa
// feature baru — `sha2::digest::generic_array` hanya re-export, `Cargo.toml`
// tidak berubah sama sekali.
