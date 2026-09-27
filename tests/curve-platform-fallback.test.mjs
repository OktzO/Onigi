import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import module from 'node:module';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// oktz-curve25519 0.0.4 ships exactly ONE prebuild (curve25519.linux-x64-gnu.node)
// and requires it at the top level of index.cjs, with no optionalDependencies and
// no JS fallback. Any other platform throws MODULE_NOT_FOUND at import time, and
// the static `import * as native from 'oktz-curve25519'` in curve-native.js took
// the whole library down with it. This file reproduces a prebuild-less install by
// redirecting the specifier at a copy of the real index.cjs with no .node beside it.
//
// That is linux-arm64 (and musl) in the field, and since R7 it is NOT an
// unsupported platform: oktz-signal -- already a hard dependency, already loaded
// by lib/Signal/libsignal.js -- publishes signal-linux-{arm64,x64}-{gnu,musl}
// through optionalDependencies and its curveSign/curveVerify are byte-compatible
// with oktz-curve25519's. So keygen and DH fall back to node:crypto and XEdDSA
// delegates to oktz-signal. tests/curve-xeddsa-unsupported.test.mjs covers the
// one condition that is still unsupported: neither binding has a prebuild.

const realIndex = createRequire(import.meta.url).resolve('oktz-curve25519');
const staging = mkdtempSync(join(tmpdir(), 'curve-no-prebuild-'));
const strippedIndex = join(staging, 'index.cjs');
copyFileSync(realIndex, strippedIndex);

module.registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'oktz-curve25519') {
            return { url: new URL(`file://${strippedIndex}`).href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    }
});

test('the reproduction really is a prebuild-less oktz-curve25519', () => {
    assert.throws(
        () => createRequire(import.meta.url)('oktz-curve25519'),
        (err) => err.code === 'MODULE_NOT_FOUND' && /curve25519\..*\.node/.test(err.message)
    );
});

test('curve-native.js loads without a native prebuild', async () => {
    const curve = await import('../lib/Modded/curve-native.js');
    assert.equal(typeof curve.generateKeyPair, 'function');
});

test('lib/index.js loads without a native prebuild', async () => {
    const lib = await import('../lib/index.js');
    assert.equal(typeof lib.makeWASocket, 'function');
});

test('generateKeyPair falls back to node:crypto x25519 keygen', async () => {
    const { generateKeyPair } = await import('../lib/Modded/curve-native.js');
    const { pubKey, privKey } = generateKeyPair();
    assert.equal(pubKey.length, 33);
    assert.equal(pubKey[0], 5);
    assert.equal(privKey.length, 32);
});

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const jwkOf = (kp) => ({ kty: 'OKP', crv: 'X25519', x: b64u(kp.pubKey.subarray(1)), d: b64u(kp.privKey) });
const privJwk = (kp) => {
    const { d, ...rest } = jwkOf(kp);
    return { ...rest, d };
};
const pubJwk = (kp) => {
    const { d, ...rest } = jwkOf(kp);
    return rest;
};

test('the keygen fallback yields key material node:crypto can re-import', async () => {
    const nodeCrypto = await import('node:crypto');
    const { generateKeyPair } = await import('../lib/Modded/curve-native.js');
    const kp = generateKeyPair();
    const priv = nodeCrypto.createPrivateKey({ format: 'jwk', key: privJwk(kp) });
    const pub = nodeCrypto.createPublicKey({ format: 'jwk', key: pubJwk(kp) });
    assert.equal(nodeCrypto.diffieHellman({ privateKey: priv, publicKey: pub }).length, 32);
});

test('calculateAgreement agrees with node:crypto diffieHellman on the same bytes', async () => {
    const nodeCrypto = await import('node:crypto');
    const { generateKeyPair, calculateAgreement } = await import('../lib/Modded/curve-native.js');
    const a = generateKeyPair();
    const b = generateKeyPair();
    const expected = Buffer.from(nodeCrypto.diffieHellman({
        privateKey: nodeCrypto.createPrivateKey({ format: 'jwk', key: privJwk(a) }),
        publicKey: nodeCrypto.createPublicKey({ format: 'jwk', key: pubJwk(b) })
    }));
    assert.ok(Buffer.from(calculateAgreement(b.pubKey, a.privKey)).equals(expected));
});

test('calculateAgreement falls back to node:crypto diffieHellman', async () => {
    const { generateKeyPair, calculateAgreement } = await import('../lib/Modded/curve-native.js');
    const a = generateKeyPair();
    const b = generateKeyPair();
    const ab = Buffer.from(calculateAgreement(b.pubKey, a.privKey));
    const ba = Buffer.from(calculateAgreement(a.pubKey, b.privKey));
    assert.equal(ab.length, 32);
    assert.ok(ab.equals(ba), 'X25519 shared secret must be symmetric');
    assert.ok(!ab.equals(a.privKey.subarray(0, 32)));
});

/*
 * The loud-throw guarantee is unchanged and still enforced -- it just moved to
 * the condition that is actually unsupported. On this platform signing must
 * work, because oktz-signal can do it.
 */
test('calculateSignature signs for real, by delegating to oktz-signal', async () => {
    const { generateKeyPair, calculateSignature, verifySignature } = await import('../lib/Modded/curve-native.js');
    const { pubKey, privKey } = generateKeyPair();
    const message = Buffer.from('loud');
    const sig = calculateSignature(privKey, message);
    assert.ok(Buffer.isBuffer(sig), 'must be a real Buffer, never a fake value');
    assert.equal(sig.byteLength, 64);
    assert.equal(verifySignature(pubKey, message, sig), true);
});

test('verifySignature returns a real verdict, not a stand-in', async () => {
    const { generateKeyPair, calculateSignature, verifySignature } = await import('../lib/Modded/curve-native.js');
    const { pubKey, privKey } = generateKeyPair();
    const message = Buffer.from('loud');
    const sig = Buffer.from(calculateSignature(privKey, message));
    assert.equal(verifySignature(pubKey, message, sig), true, 'a genuine match must be accepted');
    sig[0] ^= 0x01;
    assert.equal(verifySignature(pubKey, message, sig), false, 'a forgery must be rejected, never waved through');
});

test('a signature from a different key is rejected on this platform too', async () => {
    const { generateKeyPair, calculateSignature, verifySignature } = await import('../lib/Modded/curve-native.js');
    const a = generateKeyPair();
    const b = generateKeyPair();
    const message = Buffer.from('loud');
    assert.equal(verifySignature(a.pubKey, message, calculateSignature(b.privKey, message)), false);
});

test('Curve.verify fails closed on a forgery, and pairing works', async () => {
    const { Curve, signedKeyPair } = await import('../lib/Utils/crypto.js');
    const { public: pubKey } = Curve.generateKeyPair();
    assert.equal(pubKey.length, 32);
    assert.equal(Curve.verify(pubKey, Buffer.from('loud'), Buffer.alloc(64)), false, 'fail-closed, never permissive');

    // pairing signs the 33-byte prekey with the identity key; both halves must work
    const identity = Curve.generateKeyPair();
    const { keyPair, signature, keyId } = signedKeyPair(identity, 3);
    assert.equal(keyId, 3);
    assert.equal(keyPair.public.length, 32);
    assert.equal(signature.byteLength, 64);
    const prefixedPreKey = Buffer.concat([Buffer.from([5]), keyPair.public]);
    assert.equal(Curve.verify(identity.public, prefixedPreKey, signature), true, 'the prekey must verify against the signing identity');
});
