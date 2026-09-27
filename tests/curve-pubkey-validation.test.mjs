import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateAgreement, generateKeyPair, verifySignature } from '../lib/Modded/curve-native.js';

// scrubPubKeyFormat tested `pubKey === undefined` only AFTER `instanceof Buffer`,
// so a missing public key dereferenced undefined and raised
// "TypeError: Cannot read properties of undefined" instead of the intended
// 'Invalid public key'. Every public entry point routes through it.

const { pubKey, privKey } = generateKeyPair();
const msg = Buffer.from('pubkey validation');
const sig = Buffer.alloc(64);

for (const [label, bad] of [['undefined', undefined], ['null', null]]) {
    test(`verifySignature rejects a ${label} public key with Invalid public key`, () => {
        assert.throws(() => verifySignature(bad, msg, sig), /^Error: Invalid public key$/);
    });

    test(`calculateAgreement rejects a ${label} public key with Invalid public key`, () => {
        assert.throws(() => calculateAgreement(bad, privKey), /^Error: Invalid public key$/);
    });
}

test('verifySignature still rejects a bad-length public key', () => {
    assert.throws(() => verifySignature(Buffer.alloc(5), msg, sig), /^Error: Invalid public key$/);
});

test('scrubPubKeyFormat does not mask a non-Buffer public key type', () => {
    assert.throws(() => verifySignature('nope', msg, sig), /^Error: Invalid public key type: String$/);
});

test('a prefixed 33-byte public key is accepted by calculateAgreement', () => {
    const { pubKey: other } = generateKeyPair();
    assert.equal(Buffer.from(calculateAgreement(other, privKey)).length, 32);
});
