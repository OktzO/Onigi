import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import module from 'node:module';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

/*
 * The residual limitation, pinned.
 *
 * After R7 a platform is unsupported for XEdDSA only when NEITHER binding has a
 * prebuild: oktz-curve25519 publishes only curve25519.linux-x64-gnu.node, and
 * oktz-signal publishes only signal-linux-{arm64,x64}-{gnu,musl}. In practice
 * that is darwin and win32.
 *
 * Those platforms are unsupported for XEdDSA, and XEdDSA is what they are
 * unsupported FOR: lib/Signal/libsignal.js loads the engine lazily, so a missing
 * oktz-signal prebuild no longer takes down lib/index.js -- it fails at the first
 * pair-wise E2EE operation instead, with the platform named
 * (tests/signal-lazy-engine.test.mjs). The group path needs no engine, but
 * group message signing goes through curve-native.js, so XEdDSA is the limit
 * that remains for it. That was this file's own ownership boundary, and the
 * lazy engine is now fixed; what this file pins is the contract that matters
 * for curve-native.js
 * standing on its own: it must still load, keygen and DH must still work, and
 * XEdDSA must fail LOUDLY -- never return a fabricated signature, never return a
 * verdict it did not compute.
 *
 * Stripping both bindings at the curve-native.js boundary is the only
 * simulation possible here: strip the relative require inside oktz-signal/index.js
 * as well and lib/Utils/crypto.js itself stops loading, because its graph reaches
 * libsignal.js. tests/curve-verify-diagnosis.test.mjs covers the crypto.js warn
 * channel with that in mind.
 */

const realCurveIndex = createRequire(import.meta.url).resolve('oktz-curve25519');
const realSignalIndex = createRequire(import.meta.url).resolve('oktz-signal/native/signal/index.cjs');
const staging = mkdtempSync(join(tmpdir(), 'curve-no-xeddsa-'));
const strippedCurveIndex = join(staging, 'curve-index.cjs');
const strippedSignalIndex = join(staging, 'signal-index.cjs');
copyFileSync(realCurveIndex, strippedCurveIndex);
copyFileSync(realSignalIndex, strippedSignalIndex);
// oktz-curve25519 0.0.9 resolves its binding in native-loader.cjs, so stage that
// too. The staged curve-index.cjs is named 'curve-index.cjs', and the loader looks
// for './native-loader.cjs' relative to itself, so the loader must be copied under
// the staged name's own directory -- which it is: same dir, and the copy has no
// .node and no node_modules/@oktz, so every candidate misses.
copyFileSync(join(dirname(realCurveIndex), 'native-loader.cjs'), join(staging, 'native-loader.cjs'));

module.registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'oktz-curve25519') {
            return { url: new URL(`file://${strippedCurveIndex}`).href, shortCircuit: true };
        }
        if (specifier === 'oktz-signal/native/signal/index.cjs') {
            return { url: new URL(`file://${strippedSignalIndex}`).href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    }
});

const platform = `${process.platform}-${process.arch}`;

const curve = await import('../lib/Modded/curve-native.js');

test('the reproduction has no XEdDSA binding at all', () => {
    const req = createRequire(import.meta.url);
    // Both bindings must genuinely be binding-less, not merely malformed. Since
    // oktz-curve25519 0.0.9 the curve failure is the native-loader one, so match
    // that and check its cause chain names the local .node it tried. Staging the
    // real loader with no .node beside it means every candidate misses, so nothing
    // loads. (The scoped name's presence in the chain is not asserted: the loader
    // can short-circuit before reaching it, and a bare `@oktz/curve25519-` prefix
    // is matched by the always-present wasm32 line.)
    assert.throws(() => req('oktz-curve25519'), (err) => {
        assert.match(err.message, /Cannot find native binding/);
        const causes = [];
        for (let c = err.cause; c; c = c.cause) causes.push(String(c.message));
        const joined = causes.join('\n');
        assert.match(joined, /Cannot find module '\.\/curve25519\..*\.node'/,
            `the local prebuild must be absent, got: ${joined}`);
        return true;
    });
    assert.throws(() => req('oktz-signal/native/signal/index.cjs'), /native binding/);
});

test('curve-native.js still loads with no native prebuild at all', () => {
    assert.equal(typeof curve.generateKeyPair, 'function');
});

test('keygen and DH keep working without any native prebuild', () => {
    const a = curve.generateKeyPair();
    const b = curve.generateKeyPair();
    assert.equal(a.pubKey.length, 33);
    assert.equal(a.pubKey[0], 5);
    assert.equal(a.privKey.length, 32);
    const ab = Buffer.from(curve.calculateAgreement(b.pubKey, a.privKey));
    const ba = Buffer.from(curve.calculateAgreement(a.pubKey, b.privKey));
    assert.equal(ab.length, 32);
    assert.ok(ab.equals(ba), 'X25519 shared secret must stay symmetric');
});

test('calculateSignature fails loudly instead of returning a fake signature', () => {
    const { privKey } = curve.generateKeyPair();
    assert.throws(
        () => curve.calculateSignature(privKey, Buffer.from('loud')),
        (err) => {
            assert.ok(err instanceof Error, 'must be a real Error, never a silent value');
            assert.ok(err instanceof curve.XEdDsaUnavailableError, 'must be the typed error, so callers can classify without matching text');
            assert.match(err.message, /XEdDSA/i);
            assert.ok(err.message.includes(platform), `error must name the platform, got: ${err.message}`);
            assert.match(err.message, /curve25519/, 'the message must still name what was tried');
            assert.match(err.message, /oktz-signal/, 'the message must name the second implementation, which is what lifted linux-arm64');
            assert.equal(err.code, 'ONIGI_XEDDSA_UNSUPPORTED');
            return true;
        }
    );
});

test('verifySignature fails loudly instead of returning true', () => {
    const { pubKey } = curve.generateKeyPair();
    let outcome = 'returned';
    try {
        const value = curve.verifySignature(pubKey, Buffer.from('loud'), Buffer.alloc(64));
        outcome = `returned ${String(value)}`;
    } catch (err) {
        assert.ok(err instanceof Error);
        assert.ok(err instanceof curve.XEdDsaUnavailableError);
        assert.match(err.message, /XEdDSA/i);
        assert.ok(err.message.includes(platform), `error must name the platform, got: ${err.message}`);
        outcome = 'threw';
    }
    assert.equal(outcome, 'threw', 'verifySignature must throw, never return a verdict it cannot compute');
});

test('the unavailable case is checked AFTER argument validation, not before', () => {
    // a malformed key is still an ordinary rejection: it must not be reported as
    // an unsupported platform, or every bad input would look like a broken build
    const { pubKey } = curve.generateKeyPair();
    assert.throws(() => curve.verifySignature(Buffer.alloc(5), Buffer.from('loud'), Buffer.alloc(64)), /^Error: Invalid public key$/);
    assert.throws(() => curve.verifySignature(pubKey, Buffer.from('loud'), Buffer.alloc(8)), /^Error: Invalid signature$/);
    assert.throws(() => curve.verifySignature(pubKey, null, Buffer.alloc(64)), /^Error: Invalid message$/);
});

test('a well-formed request on an unsupported platform is a typed error, not a rejection', () => {
    const { pubKey } = curve.generateKeyPair();
    let thrown = null;
    try {
        curve.verifySignature(pubKey, Buffer.from('loud'), Buffer.alloc(64));
    } catch (error) {
        thrown = error;
    }
    assert.ok(thrown, 'a well-formed verify on an unsupported platform must not quietly return false');
    assert.equal(thrown.code, 'ONIGI_XEDDSA_UNSUPPORTED');
    assert.notEqual(thrown.message, 'Invalid public key', 'must not masquerade as a malformed key');
});
