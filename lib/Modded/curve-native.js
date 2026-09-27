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
//
// oktz-curve25519 0.0.4 hanya punya SATU prebuild (curve25519.linux-x64-gnu.node)
// dan require() itu di top-level index.cjs tanpa optionalDependencies, jadi
// import statis mematikan SELURUH library di platform lain. Di-load lewat
// createRequire + try/catch: keygen & DH jatuh ke node:crypto (setara persis,
// keduanya native Node).
//
// XEdDSA TIDAK punya ekuivalen di node:crypto, tapi juga TIDAK perlu gagal
// keras. oktz-signal — dependency yang sudah wajib, di-load
// lib/Signal/libsignal.js — mempublish prebuild linux-{arm64,x64}-{gnu,musl}
// lewat optionalDependencies, dan modul native-nya mengekspor curveSign/
// curveVerify yang byte-compatible dengan oktz-curve25519 (dua arah, diuji di
// tests/curve-xeddsa-dispatch.test.mjs). Jadi linux-arm64 yang ter-regression
// oleh aa82b8e tetap bisa signing/verify. Require lewat subpath CJS, bukan
// paketnya: oktz-signal/index.js itu ESM dan meledak saat import kalau prebuild
// tidak resolve, dan require(esm) baru ada di Node 20.19+/22.12+.
import nodeCrypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let native = null;
try {
    native = require('oktz-curve25519');
}
catch {
    native = null;
}

let signalNative = null;
try {
    const binding = require('oktz-signal/native/signal/index.cjs');
    // binding bisa load tanpa fungsi XEdDSA di skimanya; cek bentuk, bukan
    // hanya keberadaan objek.
    if (typeof binding?.curveSign === 'function' && typeof binding?.curveVerify === 'function') {
        signalNative = binding;
    }
}
catch {
    signalNative = null;
}

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
    if (pubKey === undefined || pubKey === null) {
        throw new Error('Invalid public key');
    }
    if (!(pubKey instanceof Buffer)) {
        throw new Error(`Invalid public key type: ${pubKey.constructor.name}`);
    }
    if ((pubKey.byteLength != 33 || pubKey[0] != 5) && pubKey.byteLength != 32) {
        throw new Error('Invalid public key');
    }
    if (pubKey.byteLength == 33) {
        return pubKey.slice(1);
    }
    return pubKey;
}

/**
 * Dilempar hanya kalau TIDAK ADA implementasi XEdDSA sama sekali untuk
 * platform ini. Subclass + `code` supaya pemanggil bisa mengklasifikasi tanpa
 * mencocokkan teks pesan — teks pesan berubah, kode tidak.
 */
export class XEdDsaUnavailableError extends Error {
    constructor() {
        super(`XEdDSA sign/verify is unavailable on ${process.platform}-${process.arch}: `
            + `no native prebuild loaded. oktz-curve25519 publishes only curve25519.linux-x64-gnu.node, `
            + `and oktz-signal publishes only signal-linux-{arm64,x64}-{gnu,musl}; node:crypto has no XEdDSA. `
            + `Install a matching @oktz-signal/signal-${process.platform}-${process.arch} build, or run on linux-x64 or linux-arm64.`);
        this.name = 'XEdDsaUnavailableError';
        this.code = 'ONIGI_XEDDSA_UNSUPPORTED';
    }
}

// Delegasi ke oktz-signal lebih dulu: prebuild-nya jauh lebih luas, dan
// signature kedua implementasi terbukti kompatibel dua arah. oktz-curve25519
// tetap dipakai sebagai sumber kedua supaya install yang punya prebuild-nya
// tetap punya jalur yang sudah teruji.
const xeddsaSign = (privKey, message) => {
    if (signalNative) {
        // argumen ke-3 Option<Buffer> untuk nonce; null = nonce teracak.
        return Buffer.from(signalNative.curveSign(privKey, message, null));
    }
    if (native) {
        return Buffer.from(native.sign(privKey, message));
    }
    throw new XEdDsaUnavailableError();
};

const xeddsaVerify = (pubKey, message, sig) => {
    if (signalNative) {
        return signalNative.curveVerify(pubKey, message, sig);
    }
    if (native) {
        return native.verify(pubKey, message, sig);
    }
    throw new XEdDsaUnavailableError();
};

if (!signalNative && !native) {
    process.emitWarning(new XEdDsaUnavailableError().message);
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

const nodeGenerateKeyPair = () => {
    const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('x25519', {
        publicKeyEncoding: { format: 'der', type: 'spki' },
        privateKeyEncoding: { format: 'der', type: 'pkcs8' }
    });
    return {
        pubKey: prefixKeyInPublicKey(publicKey.subarray(PUBLIC_KEY_DER_PREFIX.length, PUBLIC_KEY_DER_PREFIX.length + 32)),
        privKey: privateKey.subarray(PRIVATE_KEY_DER_PREFIX.length, PRIVATE_KEY_DER_PREFIX.length + 32)
    };
};

const nodeAgreement = (pubKey, privKey) => {
    const priv = nodeCrypto.createPrivateKey({
        key: Buffer.concat([PRIVATE_KEY_DER_PREFIX, privKey]),
        format: 'der',
        type: 'pkcs8'
    });
    const pub = nodeCrypto.createPublicKey({
        key: Buffer.concat([PUBLIC_KEY_DER_PREFIX, pubKey]),
        format: 'der',
        type: 'spki'
    });
    return nodeCrypto.diffieHellman({ privateKey: priv, publicKey: pub });
};

export const generateKeyPair = function () {
    if (!native) {
        return nodeGenerateKeyPair();
    }
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
    if (!native) {
        return nodeAgreement(pubKey, privKey);
    }
    const shared = native.sharedKey(privKey, pubKey);
    return Buffer.from(shared);
};

export const calculateSignature = function (privKey, message) {
    validatePrivKey(privKey);
    if (!message) {
        throw new Error('Invalid message');
    }
    return xeddsaSign(privKey, message);
};

export const verifySignature = function (pubKey, msg, sig) {
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
    return xeddsaVerify(pubKey, msg, sig);
};
