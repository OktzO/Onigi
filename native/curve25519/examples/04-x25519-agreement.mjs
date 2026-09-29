// 04-x25519-agreement.mjs — generateKeyPair and sharedKey, and the trap.
//
// sharedKey() is the X25519 Diffie-Hellman, not XEdDSA: it agrees on a secret
// nobody can sign with, which is a different primitive on a different curve
// encoding. Both of them are node:crypto, not Rust, so they work anywhere
// Node works and carry no platform dependency at all.
//
// The trap this file exists to make unmissable: generateKeyPair(seed) IGNORES
// the seed. curve25519-js derives a keypair deterministically from it; this
// package calls node:crypto's random keygen and validates the seed's length
// and nothing else. A caller that signs with the seed and verifies with the
// returned public key gets false, every time, and no error explaining why.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const curve = require('../index.cjs');

const seed = new Uint8Array(32).fill(42);

const first = curve.generateKeyPair(seed);
const second = curve.generateKeyPair(seed);

console.log('seed        :', Buffer.from(seed).toString('hex'));
console.log('generate #1 :', Buffer.from(first.public).toString('hex'));
console.log('generate #2 :', Buffer.from(second.public).toString('hex'));
assert.notDeepEqual(Buffer.from(first.public), Buffer.from(second.public),
	'the seed does not determine the keypair — each call generates a fresh random one');
console.log('-> the same seed produces two different keypairs. The seed is only length-checked.');

// What a caller must do instead: use the private key the call returned.
const signature = curve.sign(first.private, Buffer.from('agreement identity'));
assert.equal(curve.verify(first.public, Buffer.from('agreement identity'), signature), true);
console.log('sign(first.private) verifies against first.public ->', true);

// The seed is still validated, so a wrong type or length is a loud failure
// rather than a silent ignore.
assert.throws(() => curve.generateKeyPair(new Uint8Array(31)), /wrong seed length/);
assert.throws(() => curve.generateKeyPair(new Array(32).fill(1)), TypeError);
console.log('a 31-byte seed still throws, and a plain Array still throws TypeError');

// --- sharedKey: X25519 agreement, both directions the same ---------------

const alice = curve.generateKeyPair(seed);
const bob = curve.generateKeyPair(seed);

const aliceToBob = curve.sharedKey(alice.private, bob.public);
const bobToAlice = curve.sharedKey(bob.private, alice.public);

console.log('alice->bob  :', Buffer.from(aliceToBob).toString('hex'));
console.log('bob->alice  :', Buffer.from(bobToAlice).toString('hex'));
assert.equal(aliceToBob.length, 32);
assert.deepEqual(Buffer.from(aliceToBob), Buffer.from(bobToAlice),
	'Diffie-Hellman is symmetric');
console.log('-> 32 identical bytes from both directions');

// An agreement is not a signature: this package has no way to turn a shared
// secret into an XEdDSA signature for it, and this package's verify() will
// never accept a signature made from it.
const forged = Buffer.alloc(64, 0x5a);
assert.equal(curve.verify(alice.public, Buffer.from('anything'), forged), false);
console.log('a fabricated "signature" over the shared secret ->', false);

// Length rules for sharedKey, checked in index.cjs before node:crypto sees it.
assert.throws(() => curve.sharedKey(alice.private, new Uint8Array(33)), /wrong public key length/);
assert.throws(() => curve.sharedKey(new Uint8Array(31), alice.public), /wrong secret key length/);
console.log('sharedKey length mismatches throw, exactly as sign/verify do');

console.log('ok — 04-x25519-agreement');
