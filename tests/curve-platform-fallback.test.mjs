import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import module from 'node:module';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

// oktz-curve25519 resolves its binding through native-loader.cjs: it tries
// ./curve25519.<platform>.node and then @oktz/curve25519-<platform>, which is
// published per platform through optionalDependencies. When neither resolves --
// an unpublished platform, an arm64-musl box whose registry copy is stale, a
// partial `npm i` -- the loader throws at import time, and the static
// `import * as native from 'oktz-curve25519'` in curve-native.js took the whole
// library down with it. This file reproduces a binding-less install by
// redirecting the specifier at a copy of the real index.cjs WITH the real
// native-loader.cjs beside it and with no binding reachable from that copy:
// nothing resolves, so the loader runs its full candidate chain and fails, which
// is the condition curve-native.js has to survive. Staging index.cjs alone
// would prove nothing -- it would just fail one require() earlier.
//
// That is linux-arm64 (and musl) in the field, and it is NOT an unsupported
// platform: oktz-signal -- already a hard dependency, already loaded by
// lib/Signal/libsignal.js -- publishes signal-linux-{arm64,x64}-{gnu,musl}
// through optionalDependencies and its curveSign/curveVerify are byte-compatible
// with oktz-curve25519's. So keygen and DH fall back to node:crypto and XEdDSA
// delegates to oktz-signal. tests/curve-xeddsa-unsupported.test.mjs covers the
// one condition that is still unsupported: neither binding has a prebuild.

const realIndex = createRequire(import.meta.url).resolve('oktz-curve25519');
const staging = mkdtempSync(join(tmpdir(), 'curve-no-prebuild-'));
const strippedIndex = join(staging, 'index.cjs');
copyFileSync(realIndex, strippedIndex);
// the loader is what resolves the binding, so the copy has to carry it or the
// reproduction is just a missing-file test. Both files go in; no .node and no
// node_modules/@oktz does, which is what makes every candidate miss.
copyFileSync(join(dirname(realIndex), 'native-loader.cjs'), join(staging, 'native-loader.cjs'));

module.registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'oktz-curve25519') {
            return { url: new URL(`file://${strippedIndex}`).href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    }
});

test('the reproduction really is a prebuild-less oktz-curve25519', () => {
    // Since 0.0.9 the failure is the loader's, not a bare MODULE_NOT_FOUND from
    // index.cjs: native-loader.cjs tries every candidate, collects the misses and
    // throws one error with the chain hung off `.cause`. This asserts the top-level
    // shape and the local prebuild being absent -- every candidate misses, so
    // nothing loads. It deliberately does not claim to prove the scoped package is
    // unresolvable: on a host where an earlier candidate fails hard the loader
    // short-circuits before naming it, and a bare `@oktz/curve25519-` prefix is
    // satisfied by the always-present wasm32 line either way.
    assert.throws(
        () => createRequire(import.meta.url)('oktz-curve25519'),
        (err) => {
            assert.match(err.message, /Cannot find native binding/);
            const causes = [];
            for (let c = err.cause; c; c = c.cause) causes.push(String(c.message));
            const joined = causes.join('\n');
            assert.match(joined, /Cannot find module '\.\/curve25519\..*\.node'/,
                `the local prebuild must be absent, got: ${joined}`);
            return true;
        }
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

test('the DH fallback is byte-exact against the native path over many random pairs', async () => {
    // on this platform calculateAgreement runs the node:crypto fallback (no
    // oktz-curve25519 prebuild). It must produce the same 32 bytes the native
    // module produces, or peers would disagree on the shared secret.
    const nodeCrypto = await import('node:crypto');
    // realIndex is the real module's absolute path, captured before the hook was
    // registered; loading it by path dodges the stripped specifier, and its own
    // relative require of the .node is not intercepted
    const oktzCurve = createRequire(import.meta.url)(realIndex);
    const { generateKeyPair, calculateAgreement } = await import('../lib/Modded/curve-native.js');
    const b64u = (buf) => Buffer.from(buf).toString('base64url');
    const pubJwk = (kp) => ({ kty: 'OKP', crv: 'X25519', x: b64u(kp.pubKey.subarray(1)) });
    const privJwk = (kp) => ({ ...pubJwk(kp), d: b64u(kp.privKey) });
    for (let i = 0; i < 100; i++) {
        const a = generateKeyPair();
        const b = generateKeyPair();
        const expected = Buffer.from(oktzCurve.sharedKey(a.privKey, b.pubKey.subarray(1)));
        const actual = Buffer.from(calculateAgreement(b.pubKey, a.privKey));
        assert.equal(actual.length, 32);
        assert.ok(actual.equals(expected), `the node:crypto fallback must be byte-exact (i=${i})`);
        // and it must match what node:crypto derives from the same JWK material
        const viaNode = Buffer.from(nodeCrypto.diffieHellman({
            privateKey: nodeCrypto.createPrivateKey({ format: 'jwk', key: privJwk(a) }),
            publicKey: nodeCrypto.createPublicKey({ format: 'jwk', key: pubJwk(b) })
        }));
        assert.ok(actual.equals(viaNode), `the fallback must agree with node:crypto (i=${i})`);
    }
});

test('the DH fallback rejects the same malformed keys the native path does', async () => {
    const { generateKeyPair, calculateAgreement } = await import('../lib/Modded/curve-native.js');
    const { privKey } = generateKeyPair();
    for (const [label, bad] of [['undefined', undefined], ['null', null], ['string', 'nope'], ['5 bytes', Buffer.alloc(5)]]) {
        assert.throws(() => calculateAgreement(bad, privKey), err => err instanceof Error, `${label} public key must be rejected`);
    }
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
