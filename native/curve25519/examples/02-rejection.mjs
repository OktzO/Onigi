// 02-rejection.mjs — what verify() actually rejects.
//
// Every case here is a genuine "returns false", not an exception. The point
// is to show which failures are *silent* and which are *loud*: a wrong key, a
// wrong message and a tampered signature all return false and are
// indistinguishable from each other, while a wrong *length* throws.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const curve = require('../index.cjs');

const message = Buffer.from('reject me');
const alice = curve.generateKeyPair(new Uint8Array(32).fill(1));
const bob = curve.generateKeyPair(new Uint8Array(32).fill(2));

const signature = curve.sign(alice.private, message);
assert.equal(curve.verify(alice.public, message, signature), true);

const flip = (bytes, index) => {
	const copy = Buffer.from(bytes);
	copy[index] ^= 0x01;
	return copy;
};

const cases = [
	['a flipped bit in R (signature byte 0)', flip(signature, 0)],
	['a flipped bit in R (signature byte 31)', flip(signature, 31)],
	['a flipped bit in S (signature byte 32)', flip(signature, 32)],
	['a flipped bit in S (signature byte 63)', flip(signature, 63)],
	['the sign bit toggled in byte 63', (() => {
		// Toggle, not clear. verify() reads bit 7 to rebuild the Edwards
		// public key (src/lib.rs:186), so flipping it names a different key
		// and the signature cannot match. Clearing a bit that is already clear
		// is a no-op, and the signature still verifies — that is the trap this
		// case is written to avoid.
		const copy = Buffer.from(signature);
		copy[63] ^= 0x80;
		return copy;
	})()],
	['an all-zero signature', Buffer.alloc(64)]
];

for (const [what, candidate] of cases) {
	const result = curve.verify(alice.public, message, candidate);
	console.log(`verify(alice, message, ${what}) ->`, result);
	assert.equal(result, false, `${what} must not verify`);
}

// A rejection about the KEY rather than the signature — the case the cofactorless
// equation got wrong. u = 0 converts through
// MontgomeryPoint::to_edwards to the Edwards order-2 point (0, -1), and for
// that A the equation [S]B = R + [k]A is satisfied by R = A, S = 0 for EVERY
// message and EVERY key — so this forgery verifies under a public key that
// was never anybody's. verify() calls verify_strict (src/lib.rs:206), which
// rejects a small-order R and a weak A; tests/loworder-forgery.test.cjs and
// tests/platform-loader.test.cjs pin the same thing, the second one against
// oktz-signal's native curveVerify as well.
//
// The 32 bytes of R below are the little-endian encoding of y = -1, derived
// here rather than copied: (0 - 1) / (0 + 1) = -1 mod (2^255 - 19).
const ORDER_2_PUBKEY = new Uint8Array(32);
const ORDER_2_SIGNATURE = Buffer.concat([
	Buffer.from('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'hex'),
	Buffer.alloc(32)
]);

for (const what of ['reject me', '', 'a different message']) {
	const result = curve.verify(ORDER_2_PUBKEY, Buffer.from(what), ORDER_2_SIGNATURE);
	console.log(`verify(all-zero public key, "${what}", R = A, S = 0) ->`, result);
	assert.equal(result, false,
		`the forged signature must not verify under the order-2 public key (message ${JSON.stringify(what)})`);
}

// The no-op case, stated so the distinction is on the record: masking byte 63
// only changes the signature when the public key's sign bit was actually set.
const masked = Buffer.from(signature);
masked[63] &= 0x7f;
const signBitWasSet = (signature[63] & 0x80) !== 0;
console.log(`byte 63 masked with 0x7f (sign bit was ${signBitWasSet ? 'set' : 'clear'}) ->`,
	curve.verify(alice.public, message, masked));
assert.equal(curve.verify(alice.public, message, masked), !signBitWasSet,
	'masking only changes anything when it actually clears a set bit');

console.log('verify(alice, different message, signature) ->',
	curve.verify(alice.public, Buffer.from('a different message'), signature));
assert.equal(curve.verify(alice.public, Buffer.from('a different message'), signature), false,
	'a signature is bound to the message');

console.log('verify(bob, message, signature) ->',
	curve.verify(bob.public, message, signature));
assert.equal(curve.verify(bob.public, message, signature), false,
	'a signature is bound to the key that made it');

// openMessage reports the same rejections as null rather than false, so the
// caller cannot tell "bad signature" from "too short to hold one".
assert.equal(curve.openMessage(alice.public, flip(signature, 5)), null);
assert.equal(curve.openMessage(alice.public, new Uint8Array(63)), null);
console.log('openMessage(tampered) -> null, openMessage(63 bytes) -> null');

// Length mismatches throw instead, from index.cjs's checkLen before any of it
// reaches the addon. These are the loud failures.
const throws = [
	['sign() with a 31-byte secret key', () => curve.sign(new Uint8Array(31), message)],
	['verify() with a 33-byte public key', () => curve.verify(new Uint8Array(33), message, signature)],
	['verify() with a 63-byte signature', () => curve.verify(alice.public, message, new Uint8Array(63))],
	['sign() with 63 bytes of opt_random', () => curve.sign(alice.private, message, new Uint8Array(63))],
	['sign() with a plain Array instead of a Uint8Array', () => curve.sign(new Array(32).fill(1), message)]
];

for (const [what, thunk] of throws) {
	let message_;
	assert.throws(thunk, (err) => {
		message_ = `${err.constructor.name}: ${err.message}`;
		return true;
	}, `${what} must throw`);
	console.log(`${what} -> ${message_}`);
}

console.log('ok — 02-rejection');
