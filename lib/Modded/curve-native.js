// curve-native.js — drop-in replacement untuk libsignal/src/curve.js.
//
// Alasan: libsignal GPL-3.0 + curve25519-js JS (lambat). Adaptor ini menyediakan
// API yang SAMA PERSIS dengan libsignal/src/curve.js, tapi semua operasi pakai
// native: node:crypto (X25519 keygen + diffieHellman) + oktz-curve25519
// (XEdDSA sign/verify Rust).
//
// Call-site (lib baileys) diganti dari 'libsignal/src/curve.js' ke file ini:
//   - lib/Utils/crypto.js
//   - lib/Signal/Group/keyhelper.js
//   - lib/Signal/Group/sender-key-message.js
//
// libsignal INTERNAL (session_builder/session_cipher X3DH) masih pakai
// curve25519-js JS asli — rare path (bikin session baru), bukan per-message.
// Diganti penuh di fase rewrite Signal protocol ke Rust.
import nodeCrypto from 'crypto';
import * as native from 'oktz-curve25519';

// DER prefixes untuk X25519 — SAMA dengan libsignal/src/curve.js.
const PUBLIC_KEY_DER_PREFIX = Buffer.from([48, 42, 48, 5, 6, 3, 43, 101, 110, 3, 33, 0]);
const PRIVATE_KEY_DER_PREFIX = Buffer.from([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 110, 4, 34, 4, 32]);
const KEY_BUNDLE_TYPE = Buffer.from([5]);

const prefixKeyInPublicKey = function (pubKey) {
  return Buffer.concat([KEY_BUNDLE_TYPE, pubKey]);
};

function validatePrivKey(privKey) {
  if (privKey === undefined) {
    throw new Error('Undefined private key');
  }
  if (!(privKey instanceof Buffer)) {
    throw new Error(`Invalid private key type: ${privKey.constructor.name}`);
  }
  if (privKey.byteLength != 32) {
    throw new Error(`Incorrect private key length: ${privKey.byteLength}`);
  }
}

function scrubPubKeyFormat(pubKey) {
  if (!(pubKey instanceof Buffer)) {
    throw new Error(`Invalid public key type: ${pubKey.constructor.name}`);
  }
  if (pubKey === undefined || ((pubKey.byteLength != 33 || pubKey[0] != 5) && pubKey.byteLength != 32)) {
    throw new Error('Invalid public key');
  }
  if (pubKey.byteLength == 33) {
    return pubKey.slice(1);
  }
  return pubKey;
}

/**
 * getPublicFromPrivateKey(privKey) → pubKey 33-byte (prefix 0x05).
 * Dead code di baileys (grep: tidak ada call-site). Dipertahankan untuk
 * parity API. Derive X25519 pubkey dari private via node:crypto
 * (createPrivateKey + createPublicKey) — sama persis hasil libsignal asli
 * (clamp sk → base scalar mult), bukan random.
 */
export const getPublicFromPrivateKey = function (privKey) {
  validatePrivKey(privKey);
  const priv = nodeCrypto.createPrivateKey({
    key: Buffer.concat([PRIVATE_KEY_DER_PREFIX, privKey]),
    format: 'der',
    type: 'pkcs8',
  });
  const der = nodeCrypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
  return prefixKeyInPublicKey(der.subarray(PUBLIC_KEY_DER_PREFIX.length));
};

export const generateKeyPair = function () {
  const kp = native.generateKeyPair(new Uint8Array(32));
  return {
    pubKey: prefixKeyInPublicKey(Buffer.from(kp.public)),
    privKey: Buffer.from(kp.private),
  };
};

export const calculateAgreement = function (pubKey, privKey) {
  pubKey = scrubPubKeyFormat(pubKey);
  validatePrivKey(privKey);
  if (!pubKey || pubKey.byteLength != 32) {
    throw new Error('Invalid public key');
  }
  const shared = native.sharedKey(privKey, pubKey);
  return Buffer.from(shared);
};

export const calculateSignature = function (privKey, message) {
  validatePrivKey(privKey);
  if (!message) {
    throw new Error('Invalid message');
  }
  const sig = native.sign(privKey, message);
  return Buffer.from(sig);
};

export const verifySignature = function (pubKey, msg, sig, isInit) {
  pubKey = scrubPubKeyFormat(pubKey);
  if (!pubKey || pubKey.byteLength != 32) {
    throw new Error('Invalid public key');
  }
  if (!msg) {
    throw new Error('Invalid message');
  }
  if (!sig || sig.byteLength != 64) {
    throw new Error('Invalid signature');
  }
  return isInit ? true : native.verify(pubKey, msg, sig);
};
