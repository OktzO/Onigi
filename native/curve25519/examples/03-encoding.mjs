// 03-encoding.mjs — the 32-byte vs 33-byte public key rule, executed.
//
// libsignal (and therefore anything written against it) carries an identity
// public key as 33 bytes: a 0x05 type byte followed by the 32 raw X25519
// bytes. This package's sign()/verify() want the 32 raw bytes. Handing them
// the 33-byte form does not return false — it throws.
//
// Run with a 33-byte key:

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const curve = require('../index.cjs');

// 0x05 is libsignal's KeyBundleType for a Curve25519 identity key. See
// lib/Modded/curve-native.js in the parent repository: KEY_BUNDLE_TYPE.
const KEY_BUNDLE_TYPE = 0x05;

const identity = curve.generateKeyPair(new Uint8Array(32).fill(4));
const message = Buffer.from('prefixed public key');
const signature = curve.sign(identity.private, message);

const raw32 = Buffer.from(identity.public);
const prefixed33 = Buffer.concat([Buffer.from([KEY_BUNDLE_TYPE]), raw32]);

console.log('raw        :', raw32.toString('hex'), `(${raw32.length} bytes)`);
console.log('prefixed   :', prefixed33.toString('hex'), `(${prefixed33.length} bytes)`,
	`— first byte is 0x${KEY_BUNDLE_TYPE.toString(16).padStart(2, '0')}`);

assert.equal(raw32.length, 32);
assert.equal(prefixed33.length, 33);
assert.equal(prefixed33[0], KEY_BUNDLE_TYPE);

assert.equal(curve.verify(raw32, message, signature), true, 'the 32-byte form is what verify() wants');

let thrown = null;
try {
	curve.verify(prefixed33, message, signature);
} catch (err) {
	thrown = err;
}
assert.ok(thrown, 'the 33-byte form must throw, not return false');
console.log('verify(prefixed33, ...) ->', `${thrown.constructor.name}: ${thrown.message}`);

assert.throws(
	() => curve.verify(prefixed33, message, signature),
	/wrong public key length/,
	'the failure is a length check, raised in index.cjs before the addon is reached'
);

// The fix is one line, and it is the line every caller needs:
assert.equal(curve.verify(prefixed33.subarray(1), message, signature), true);

// oktz-signal throws too, with a message that names the lengths, because its
// check lives in Rust rather than in the JS wrapper.
let signalNative = null;
try {
	signalNative = require('oktz-signal/native/signal/index.cjs');
} catch {
	console.log('cross-check : skipped, oktz-signal is not installed next to this tree');
}

if (signalNative) {
	assert.throws(
		() => signalNative.curveVerify(prefixed33, message, signature),
		/wrong public key length: 33 \(expected 32\)/,
		'oktz-signal reports the lengths in the message'
	);
	assert.equal(signalNative.curveVerify(prefixed33.subarray(1), message, signature), true);
	console.log('cross-check : oktz-signal throws on 33 bytes, accepts 32');
}

// The other half of the encoding: byte 63 of the signature is R's sign bit
// carrying the public key's sign bit, not part of the scalar S.
let withSignBit = 0;
let withoutSignBit = 0;
for (let i = 0; i < 64; i++) {
	const kp = curve.generateKeyPair(new Uint8Array(32).fill(i));
	const sig = curve.sign(kp.private, message);
	assert.equal(sig[63] & 0x70, 0, 'S < L < 2^252, so bits 4-6 of byte 63 are always clear');
	if (sig[63] & 0x80) {
		withSignBit++;
	} else {
		withoutSignBit++;
	}
}
console.log(`sign bit set in ${withSignBit}/64 signatures, clear in ${withoutSignBit}/64`);
assert.equal(withSignBit + withoutSignBit, 64);

console.log('ok — 03-encoding');
