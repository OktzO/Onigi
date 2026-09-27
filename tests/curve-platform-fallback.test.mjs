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

const platform = `${process.platform}-${process.arch}`;

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

test('calculateSignature fails loudly instead of returning a fake signature', async () => {
    const { generateKeyPair, calculateSignature } = await import('../lib/Modded/curve-native.js');
    const { privKey } = generateKeyPair();
    assert.throws(
        () => calculateSignature(privKey, Buffer.from('loud')),
        (err) => {
            assert.ok(err instanceof Error, 'must be a real Error, never a silent value');
            assert.match(err.message, /XEdDSA/i);
            assert.ok(err.message.includes(platform), `error must name the platform, got: ${err.message}`);
            assert.match(err.message, /curve25519/);
            return true;
        }
    );
});

test('verifySignature fails loudly instead of returning true', async () => {
    const { generateKeyPair, verifySignature } = await import('../lib/Modded/curve-native.js');
    const { pubKey } = generateKeyPair();
    let outcome = 'returned';
    try {
        const value = verifySignature(pubKey, Buffer.from('loud'), Buffer.alloc(64));
        outcome = `returned ${String(value)}`;
    } catch (err) {
        assert.ok(err instanceof Error);
        assert.match(err.message, /XEdDSA/i);
        assert.ok(err.message.includes(platform), `error must name the platform, got: ${err.message}`);
        outcome = 'threw';
    }
    assert.equal(outcome, 'threw', 'verifySignature must throw, never return a verdict it cannot compute');
});

test('Curve.verify stays fail-closed when the verifier is unavailable', async () => {
    const { Curve } = await import('../lib/Utils/crypto.js');
    const { public: pubKey, private: privKey } = Curve.generateKeyPair();
    assert.equal(pubKey.length, 32);
    assert.equal(Curve.verify(pubKey, Buffer.from('loud'), Buffer.alloc(64)), false);
    assert.throws(() => Curve.sign(privKey, Buffer.from('loud')), /XEdDSA/);
});
