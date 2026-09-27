import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Curve } from '../lib/Utils/crypto.js';

// Curve.verify must propagate the native verifier's boolean. curve-native.js
// RETURNS false on a signature mismatch (unlike curve25519-js, which throws),
// so the old bare `return true` made every signature verify.

const message = Buffer.from('noise handshake certificate details');
const { public: pubKey, private: privKey } = Curve.generateKeyPair();
const signature = Curve.sign(privKey, message);

const flipLowBit = (buf) => { const c = Buffer.from(buf); c[0] ^= 0x01; return c; };

test('Curve.verify accepts a valid signature', () => {
    assert.equal(Curve.verify(pubKey, message, signature), true);
});

test('Curve.verify rejects a 1-bit-flipped signature', () => {
    assert.equal(Curve.verify(pubKey, message, flipLowBit(signature)), false);
});

test('Curve.verify rejects an all-zero signature', () => {
    assert.equal(Curve.verify(pubKey, message, Buffer.alloc(signature.length)), false);
});

test('Curve.verify rejects a signature made by a different key', () => {
    const impostor = Curve.generateKeyPair();
    assert.equal(Curve.verify(pubKey, message, Curve.sign(impostor.private, message)), false);
});

test('Curve.verify rejects random garbage', () => {
    assert.equal(Curve.verify(pubKey, message, randomBytes(signature.length)), false);
});

test('Curve.verify returns false for a malformed public key instead of throwing', () => {
    assert.equal(Curve.verify(Buffer.alloc(5), message, signature), false);
});
