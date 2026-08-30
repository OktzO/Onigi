// Roundtrip test — pakai ed25519-dalek verify
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;
use curve25519_dalek::MontgomeryPoint;
use sha2::{Digest, Sha512};

use ed25519_dalek::{VerifyingKey, Signature, Verifier};

fn clamp_scalar(sk: &[u8; 32]) -> [u8; 32] {
    let mut a = *sk;
    a[0] &= 248;
    a[31] &= 127;
    a[31] |= 64;
    a
}

fn base_mult_scalar(a: &Scalar) -> [u8; 32] {
    (ED25519_BASEPOINT_POINT * a).compress().to_bytes()
}

fn challenge(r: &[u8; 32], a: &[u8; 32], msg: &[u8]) -> Scalar {
    let mut h = Sha512::new();
    h.update(r);
    h.update(a);
    h.update(msg);
    Scalar::from_bytes_mod_order_wide(&h.finalize().into())
}

fn sign_internal(sk_raw: &[u8; 32], msg: &[u8]) -> [u8; 64] {
    let sk = clamp_scalar(sk_raw);
    let a = Scalar::from_bytes_mod_order(sk);
    let a_bytes = base_mult_scalar(&a);
    let sign_bit = a_bytes[31] & 128;
    let mut h = Sha512::new();
    h.update(sk);
    h.update(msg);
    let r = Scalar::from_bytes_mod_order_wide(&h.finalize().into());
    let r_bytes = base_mult_scalar(&r);
    let h2 = challenge(&r_bytes, &a_bytes, msg);
    let s = r + h2 * a;
    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&r_bytes);
    sig[32..64].copy_from_slice(&s.to_bytes());
    sig[63] |= sign_bit;
    sig
}

fn verify_ed25519(pk: &[u8; 32], msg: &[u8], sig: &[u8; 64]) -> Result<(), String> {
    let sign_bit = sig[63] & 128;
    let mut sig_bytes = *sig;
    sig_bytes[63] &= 127; // clear sign bit
    let signature = Signature::from_bytes(&sig_bytes);

    let a_pt = MontgomeryPoint(*pk).to_edwards(sign_bit >> 7).ok_or("to_edwards failed")?;
    let a_bytes = a_pt.compress().to_bytes();
    let vk = VerifyingKey::from_bytes(&a_bytes).map_err(|e| format!("vk err: {}", e))?;

    vk.verify(msg, &signature).map_err(|e| format!("verify err: {}", e))
}

fn main() {
    let sk = [0u8; 32];
    let sk_clamped = clamp_scalar(&sk);
    let a_scalar = Scalar::from_bytes_mod_order(sk_clamped);
    let a_pt = ED25519_BASEPOINT_POINT * a_scalar;
    let u = a_pt.to_montgomery().to_bytes();

    println!("sk_clamped: {}", bytes_to_hex(&sk_clamped));
    println!("mont pk: {}", bytes_to_hex(&u));

    let msgs: &[&[u8]] = &[b"", b"hello"];
    for msg in msgs {
        let sig = sign_internal(&sk, msg);
        let ok_ed = verify_ed25519(&u, msg, &sig);
        println!("ed25519-dalek verify msg_len={}: {:?}", msg.len(), ok_ed);
    }
}

fn bytes_to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}
