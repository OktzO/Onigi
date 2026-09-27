import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import module from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/*
 * curve-native.js delegates XEdDSA to oktz-signal's curveSign/curveVerify. A
 * delegation is only safe if the two implementations are byte-compatible, and
 * only useful if it is actually the one being used -- so this file pins both.
 *
 * The proof that oktz-signal is preferred is not inference from the source: the
 * native subpath is redirected at a proxy that forwards to the real binding and
 * counts calls. If the delegation ever silently reverts to oktz-curve25519, the
 * counters stay at zero and this fails.
 *
 * Only the subpath curve-native.js requires is redirected, not the relative
 * require inside oktz-signal/index.js, so lib/Signal/libsignal.js keeps the real
 * binding and the rest of the library loads normally.
 */

const req = createRequire(import.meta.url);
const realSignalBinding = req.resolve('oktz-signal/native/signal/index.cjs');

const staging = mkdtempSync(join(tmpdir(), 'curve-xeddsa-dispatch-'));
const proxy = join(staging, 'signal-proxy.cjs');
// absolute path: the proxy lives in a temp dir with no node_modules above it
writeFileSync(proxy, `'use strict';
const real = require(${JSON.stringify(realSignalBinding)});
const calls = { sign: 0, verify: 0 };
module.exports = {
    curveSign: (...a) => { calls.sign++; return real.curveSign(...a); },
    curveVerify: (...a) => { calls.verify++; return real.curveVerify(...a); },
    curveGenerateKeypair: real.curveGenerateKeypair,
    curveScalarMultiply: real.curveScalarMultiply,
    calls
};
`);

module.registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'oktz-signal/native/signal/index.cjs') {
            return { url: new URL(`file://${proxy}`).href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    }
});

const proxyBinding = createRequire(import.meta.url)(proxy);
const realBinding = req(realSignalBinding);
const oktzCurve = req('oktz-curve25519');

const { generateKeyPair, calculateSignature, verifySignature, calculateAgreement, getPublicFromPrivateKey } = await import('../lib/Modded/curve-native.js');
const { Curve } = await import('../lib/Utils/crypto.js');

const before = { ...proxyBinding.calls };

test('oktz-signal is the implementation that signs and verifies', () => {
    const { pubKey, privKey } = generateKeyPair();
    const message = Buffer.from('dispatch order');
    const sig = calculateSignature(privKey, message);
    assert.equal(verifySignature(pubKey, message, sig), true);
    assert.equal(proxyBinding.calls.sign - before.sign, 1, 'curveSign must be the signer actually used');
    assert.equal(proxyBinding.calls.verify - before.verify, 1, 'curveVerify must be the verifier actually used');
});

test('Curve.sign and Curve.verify go through oktz-signal too', () => {
    const mark = { ...proxyBinding.calls };
    const { public: pubKey, private: privKey } = Curve.generateKeyPair();
    const message = Buffer.from('crypto js dispatch');
    assert.equal(Curve.verify(pubKey, message, Curve.sign(privKey, message)), true);
    assert.equal(proxyBinding.calls.sign - mark.sign, 1);
    assert.equal(proxyBinding.calls.verify - mark.verify, 1);
});

test('keygen and DH do not depend on either XEdDSA implementation', () => {
    const mark = { ...proxyBinding.calls };
    const a = generateKeyPair();
    const b = generateKeyPair();
    assert.equal(calculateAgreement(b.pubKey, a.privKey).length, 32);
    assert.deepEqual(proxyBinding.calls, mark, 'X25519 keygen/DH must not touch the XEdDSA binding');
});

/*
 * Byte-compatibility. Signatures are randomized (oktz-signal takes an
 * Option<Buffer> nonce and a previous wave made the null nonce correct), so
 * signature BYTES are meaningless to compare -- only verdicts are.
 */
test('the two implementations are byte-compatible in both directions', () => {
    const messageLengths = [0, 1, 2, 15, 32, 33, 64, 100, 255, 1000];
    for (let i = 0; i < 300; i++) {
        const { pubKey, privKey } = generateKeyPair();
        const message = randomBytes(messageLengths[i % messageLengths.length]);
        const raw = pubKey.subarray(1);

        const ours = calculateSignature(privKey, message);
        assert.equal(realBinding.curveVerify(raw, message, ours), true, `oktz-signal must verify our signature (i=${i})`);

        const theirs = realBinding.curveSign(privKey, message, null);
        assert.equal(verifySignature(pubKey, message, Buffer.from(theirs)), true, `we must verify an oktz-signal signature (i=${i})`);

        // and each must reject the other's signature over a different message
        const other = randomBytes(16);
        assert.equal(realBinding.curveVerify(raw, other, ours), false, `wrong message must be rejected (i=${i})`);
        assert.equal(verifySignature(pubKey, other, Buffer.from(theirs)), false, `wrong message must be rejected (i=${i})`);
    }
});

test('signatures are randomized, so byte equality is not the contract', () => {
    const { pubKey, privKey } = generateKeyPair();
    const message = Buffer.from('randomized');
    const a = calculateSignature(privKey, message);
    const b = calculateSignature(privKey, message);
    assert.notDeepEqual(a, b, 'an XEdDSA signature must not be deterministic');
    assert.equal(verifySignature(pubKey, message, a), true, 'the first must verify');
    assert.equal(verifySignature(pubKey, message, b), true, 'the second must verify');
});

test('a degenerate secret key signs in both implementations, and both agree', () => {
    for (const [label, secret] of [
        ['all-zero', Buffer.alloc(32)],
        ['all-ff', Buffer.alloc(32, 0xff)],
        ['one', Buffer.concat([Buffer.from([1]), Buffer.alloc(31)])],
        ['random', randomBytes(32)]
    ]) {
        const message = Buffer.from('degenerate key');
        const pubKey = getPublicFromPrivateKey(secret);
        const ours = calculateSignature(secret, message);
        const theirs = Buffer.from(realBinding.curveSign(secret, message, null));

        assert.equal(verifySignature(pubKey, message, ours), true, `${label}: our own signature must verify`);
        assert.equal(verifySignature(pubKey, message, theirs), true, `${label}: an oktz-signal signature must verify`);
        assert.equal(realBinding.curveVerify(pubKey.subarray(1), message, ours), true, `${label}: oktz-signal must accept ours`);
        // and the two independent implementations must not disagree on a forgery
        const forged = Buffer.from(ours);
        forged[63] ^= 0x80;
        assert.equal(realBinding.curveVerify(pubKey.subarray(1), message, forged), false, `${label}: forgery must be rejected`);
    }
});

test('the two implementations agree on the native curve module too', () => {
    // oktz-curve25519 is still the second source, so it must remain usable where
    // its prebuild exists; that is what makes the delegation a fallback chain
    for (let i = 0; i < 50; i++) {
        const { pubKey, privKey } = generateKeyPair();
        const message = randomBytes(1 + (i % 64));
        const sig = Buffer.from(oktzCurve.sign(privKey, message));
        assert.equal(verifySignature(pubKey, message, sig), true, `we must accept oktz-curve25519 signatures (i=${i})`);
    }
});
