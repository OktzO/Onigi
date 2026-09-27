import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import module from 'node:module';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/*
 * R7: "XEdDSA is unsupported off linux-x64" was FALSE and avoidable.
 *
 * oktz-curve25519 0.0.4 ships exactly one prebuild, but oktz-signal -- already a
 * hard dependency, loaded by lib/Signal/libsignal.js -- publishes four through
 * optionalDependencies (signal-linux-{arm64,x64}-{gnu,musl}) and its native
 * module exports a byte-compatible XEdDSA. So on linux-arm64 the fallback added
 * by aa82b8e declared the platform unsupported and hard-threw from
 * calculateSignature/verifySignature, which makes pairing, group send and the
 * noise handshake impossible, and -- because lib/Utils/crypto.js turns every
 * throw into `false` -- reports an unverifiable platform to the user as a forged
 * certificate.
 *
 * This file reproduces the platform that regressed: oktz-curve25519 has no
 * prebuild, and oktz-signal is present. Nothing may throw, and a signature made
 * here must be a real signature.
 */

const realIndex = createRequire(import.meta.url).resolve('oktz-curve25519');
const staging = mkdtempSync(join(tmpdir(), 'curve-xeddsa-delegate-'));
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

const platform = `${process.platform}-${process.arch}`;

const curve = await import('../lib/Modded/curve-native.js');
const { Curve, signedKeyPair } = await import('../lib/Utils/crypto.js');

test('the reproduction is oktz-curve25519 without a prebuild, with oktz-signal present', () => {
    assert.throws(
        () => createRequire(import.meta.url)('oktz-curve25519'),
        err => err.code === 'MODULE_NOT_FOUND' && /curve25519\..*\.node/.test(err.message)
    );
    const signalNative = createRequire(import.meta.url)('oktz-signal/native/signal/index.cjs');
    assert.equal(typeof signalNative.curveSign, 'function');
    assert.equal(typeof signalNative.curveVerify, 'function');
});

test('calculateSignature produces a real signature with no oktz-curve25519 prebuild', () => {
    const { privKey } = curve.generateKeyPair();
    const sig = curve.calculateSignature(privKey, Buffer.from('delegated'));
    assert.ok(Buffer.isBuffer(sig), `a signature must be a Buffer, got ${typeof sig}`);
    assert.equal(sig.byteLength, 64);
});

test('verifySignature accepts a signature made on a prebuild-less oktz-curve25519', () => {
    const { pubKey, privKey } = curve.generateKeyPair();
    const message = Buffer.from('delegated round trip');
    assert.equal(curve.verifySignature(pubKey, message, curve.calculateSignature(privKey, message)), true);
});

test('verifySignature still rejects a forged signature on that platform', () => {
    const { pubKey, privKey } = curve.generateKeyPair();
    const message = Buffer.from('delegated round trip');
    const sig = Buffer.from(curve.calculateSignature(privKey, message));
    sig[0] ^= 0x01;
    assert.equal(curve.verifySignature(pubKey, message, sig), false);
});

test('Curve.sign/Curve.verify round-trip, so pairing is possible again', () => {
    const { public: pubKey, private: privKey } = Curve.generateKeyPair();
    assert.equal(Curve.verify(pubKey, Buffer.from('noise cert'), Curve.sign(privKey, Buffer.from('noise cert'))), true);
});

test('a signature from a different key is still rejected', () => {
    const a = Curve.generateKeyPair();
    const b = Curve.generateKeyPair();
    const message = Buffer.from('noise cert');
    assert.equal(Curve.verify(a.public, message, Curve.sign(b.private, message)), false);
});

test('signedKeyPair works, so pairing is not blocked by a missing prebuild', () => {
    const identity = Curve.generateKeyPair();
    const { keyPair, signature, keyId } = signedKeyPair(identity, 7);
    assert.equal(keyId, 7);
    assert.equal(keyPair.public.byteLength, 32);
    assert.equal(Buffer.from(Curve.generateKeyPair ? signature : 0).byteLength, 64);
    const prefixed = Buffer.concat([Buffer.from([5]), keyPair.public]);
    assert.equal(Curve.verify(identity.public, prefixed, signature), true, 'the prekey must verify against the signing identity');
});

test('group send signing works: getSignature is Curve.sign over the 33-byte public key', () => {
    const sender = Curve.generateKeyPair();
    const message = Buffer.from('sender key message bytes');
    const signature = Curve.sign(sender.private, message);
    assert.equal(signature.byteLength, 64);
    assert.equal(Curve.verify(sender.public, message, signature), true);
});

test('a native-install signature is byte-compatible with a prebuild-less one', () => {
    // cross-implementation: the two packages' XEdDSA must agree in both
    // directions, or delegation silently swaps the algorithm
    const signalNative = createRequire(import.meta.url)('oktz-signal/native/signal/index.cjs');
    const { pubKey, privKey } = curve.generateKeyPair();
    const message = Buffer.from('cross implementation');
    const ours = curve.calculateSignature(privKey, message);
    const theirs = Buffer.from(signalNative.curveSign(privKey, message, null));
    assert.notDeepEqual(ours, theirs, 'signatures are randomized, so only verification is comparable');
    const raw = pubKey.byteLength === 33 ? pubKey.subarray(1) : pubKey;
    assert.equal(signalNative.curveVerify(raw, message, ours), true, 'oktz-signal must verify our signature');
    assert.equal(curve.verifySignature(pubKey, message, theirs), true, 'we must verify an oktz-signal signature');
});

test('the noise handshake no longer sees a false "invalid certificate"', () => {
    // noise-handler.js:180 turns Curve.verify's false into a Boom. Before the
    // delegation every well-formed certificate on this platform produced one.
    const { public: pubKey, private: privKey } = Curve.generateKeyPair();
    const details = Buffer.from('certificate details payload');
    const signature = Curve.sign(privKey, details);
    assert.equal(Curve.verify(pubKey, details, signature), true, `a genuine match must not be reported as invalid on ${platform}`);
});
