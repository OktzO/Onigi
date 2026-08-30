// curve25519-js drop-in replacement (native Rust untuk XEdDSA sign/verify).
//
// Prinsip: yang Node.js sudah native → lewati, pakai node:crypto.
//   - generateKeyPair (X25519)   → node:crypto.generateKeyPairSync('x25519')
//   - sharedKey (X25519 DH)      → node:crypto.diffieHellman
// Yang Node.js TIDAK punya (XEdDSA) → native Rust .node:
//   - sign  (XEdDSA, Signal)
//   - verify (XEdDSA, Signal)
//
// signMessage/openMessage = wrapper tipis atas sign/verify (API parity
// curve25519-js; tidak dipakai libsignal).
'use strict';

const { generateKeyPairSync, diffieHellman, createPrivateKey, createPublicKey } = require('crypto');

const native = require('./curve25519.linux-x64-gnu.node');

// DER prefixes untuk X25519 (sama dengan libsignal/src/curve.js).
const PUBLIC_KEY_DER_PREFIX = Buffer.from([48, 42, 48, 5, 6, 3, 43, 101, 110, 3, 33, 0]);
const PRIVATE_KEY_DER_PREFIX = Buffer.from([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 110, 4, 34, 4, 32]);

function checkLen(v, n, what) {
  if (v.length !== n) throw new Error(`wrong ${what} length`);
  if (!(v instanceof Uint8Array)) throw new TypeError('unexpected type, use Uint8Array');
}

/**
 * X25519 keypair dari node:crypto (Node native).
 * @param {Uint8Array} seed 32-byte (diabaikan — Node keygen random; libsignal
 *   hanya memanggil ini sebagai fallback dengan randomBytes).
 */
function generateKeyPair(seed) {
  checkLen(seed, 32, 'seed');
  const { publicKey, privateKey } = generateKeyPairSync('x25519', {
    publicKeyEncoding: { format: 'der', type: 'spki' },
    privateKeyEncoding: { format: 'der', type: 'pkcs8' },
  });
  const pub = publicKey.subarray(
    PUBLIC_KEY_DER_PREFIX.length,
    PUBLIC_KEY_DER_PREFIX.length + 32
  );
  const priv = privateKey.subarray(
    PRIVATE_KEY_DER_PREFIX.length,
    PRIVATE_KEY_DER_PREFIX.length + 32
  );
  return { public: pub, private: priv };
}

/** X25519 Diffie-Hellman dari node:crypto (Node native). */
function sharedKey(secretKey, publicKey) {
  checkLen(publicKey, 32, 'public key');
  checkLen(secretKey, 32, 'secret key');
  const priv = createPrivateKey({
    key: Buffer.concat([PRIVATE_KEY_DER_PREFIX, secretKey]),
    format: 'der',
    type: 'pkcs8',
  });
  const pub = createPublicKey({
    key: Buffer.concat([PUBLIC_KEY_DER_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
  return new Uint8Array(diffieHellman({ privateKey: priv, publicKey: pub }));
}

/** XEdDSA sign (native Rust). Mengembalikan signature 64 byte. */
function sign(secretKey, msg, opt_random) {
  checkLen(secretKey, 32, 'secret key');
  if (opt_random !== undefined && opt_random !== null) {
    checkLen(opt_random, 64, 'random data');
  }
  return new Uint8Array(native.sign(secretKey, msg, opt_random));
}

/** XEdDSA verify (native Rust). true/false. */
function verify(publicKey, msg, signature) {
  checkLen(publicKey, 32, 'public key');
  checkLen(signature, 64, 'signature');
  return native.verify(publicKey, msg, signature);
}

/** signature(64) || msg — parity API, tidak dipakai libsignal. */
function signMessage(secretKey, msg, opt_random) {
  const sig = sign(secretKey, msg, opt_random);
  const out = new Uint8Array(64 + msg.length);
  out.set(sig, 0);
  out.set(msg, 64);
  return out;
}

/** verify signedMsg (sig||msg) → msg | null. */
function openMessage(publicKey, signedMsg) {
  if (signedMsg.length < 64) return null;
  const sig = signedMsg.subarray(0, 64);
  const msg = signedMsg.subarray(64);
  if (!verify(publicKey, msg, sig)) return null;
  return msg;
}

module.exports = { generateKeyPair, sharedKey, sign, verify, signMessage, openMessage, default: {} };
