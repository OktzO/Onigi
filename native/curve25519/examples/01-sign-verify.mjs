// 01-sign-verify.mjs — the whole API in one pass.
//
// Signs a message, verifies it, and checks the two properties a caller
// actually depends on: the signature is 64 bytes, and a signature made by
// this package is accepted by the XEdDSA implementation in oktz-signal, which
// is a *different* Rust binding (that part is skipped when oktz-signal is
// not installed).

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const curve = require('../index.cjs');

const { public: publicKey, private: secretKey } = curve.generateKeyPair(new Uint8Array(32));
const message = Buffer.from('XEdDSA over a native binding');

const signature = curve.sign(secretKey, message);

console.log('public key  :', Buffer.from(publicKey).toString('hex'), `(${publicKey.length} bytes)`);
console.log('signature   :', Buffer.from(signature).toString('hex'), `(${signature.length} bytes)`);
console.log('verify      :', curve.verify(publicKey, message, signature));

assert.equal(publicKey.length, 32, 'a public key is 32 raw bytes');
assert.equal(signature.length, 64, 'an XEdDSA signature is R || S, 32 + 32');

// The sign bit of the public key rides in the top bit of signature[63]; the
// scalar S below it always leaves bits 4-6 clear, because S < L < 2^252.
assert.equal(signature[63] & 0x70, 0, 'bits 4-6 of byte 63 belong to S, and S < L < 2^252');

assert.equal(curve.verify(publicKey, message, signature), true, 'a genuine signature verifies');

// signMessage / openMessage are the concatenated-signature convenience pair.
// They are in the export list because curve25519-js has them; libsignal does
// not use them.
const signed = curve.signMessage(secretKey, message);
assert.equal(signed.length, 64 + message.length);
assert.equal(Buffer.from(curve.openMessage(publicKey, signed)).toString(), message.toString());

// Cross-implementation: byte-compatible with oktz-signal's curveSign/curveVerify.
// Both implementations must strip the 33-byte 0x05 prefix form themselves —
// this is the whole reason docs/encoding.md exists.
let signalNative = null;
try {
	signalNative = require('oktz-signal/native/signal/index.cjs');
} catch {
	console.log('cross-check : skipped, oktz-signal is not installed next to this tree');
}

if (signalNative) {
	const raw = publicKey.length === 33 ? publicKey.subarray(1) : publicKey;
	assert.equal(signalNative.curveVerify(raw, message, signature), true,
		'oktz-signal must accept a signature made here');
	const theirs = Buffer.from(signalNative.curveSign(secretKey, message, null));
	assert.equal(curve.verify(raw, message, theirs), true,
		'this package must accept a signature made by oktz-signal');
	console.log('cross-check : oktz-signal accepted our signature, and vice versa');
}

console.log('ok — 01-sign-verify');
