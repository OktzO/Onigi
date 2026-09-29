import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import module from 'node:module';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/*
 * aa82b8e made lib/Modded/curve-native.js load without a native prebuild and
 * had XEdDSA sign/verify throw an error naming the platform. Curve.verify in
 * lib/Utils/crypto.js catches every throw and returns false, which is right for
 * a malformed key -- verifySignature genuinely throws on a wrong-length public
 * key and that must stay a rejection.
 *
 * But it collapses two unrelated conditions into one boolean. Curve.verify
 * returns false for "I cannot verify on this machine", and the noise handshake
 * then reports it as 'noise certificate signature invalid'
 * (noise-handler.js:183) -- the exact same message a real signature failure
 * produces. The user cannot tell a broken platform from a forged certificate.
 *
 * The unsupported-platform condition has to be distinguishable from a bad
 * signature, without Curve.verify ever throwing (it must stay fail-closed, and
 * a bad signature must not turn into a crash).
 *
 * R7 changed which platforms that is. Stripping only oktz-curve25519 is no
 * longer an unsupported platform: oktz-signal ships linux-{arm64,x64}-{gnu,musl}
 * prebuilds and its curveSign/curveVerify are byte-compatible, so curve-native
 * delegates to it. A platform is unsupported only when BOTH bindings are
 * missing, and that is what this file now reproduces.
 *
 * One simulation artifact, stated plainly: the hook strips the oktz-signal
 * binding only for the subpath curve-native.js requires, not for the relative
 * require inside oktz-signal/index.js. On a real platform with no oktz-signal
 * prebuild the engine is now loaded lazily (tests/signal-lazy-engine.test.mjs),
 * so lib/Utils/crypto.js imports there too -- but this file still needs the
 * narrow hook, because the engine's own reach for the binding is the thing it is
 * leaving alone. tests/curve-xeddsa-unsupported.test.mjs covers the
 * curve-native.js boundary without that artifact.
 */

const realIndex = createRequire(import.meta.url).resolve('oktz-curve25519');
const realSignalIndex = createRequire(import.meta.url).resolve('oktz-signal/native/signal/index.cjs');
const staging = mkdtempSync(join(tmpdir(), 'curve-verify-diag-'));
const strippedIndex = join(staging, 'index.cjs');
const strippedSignalIndex = join(staging, 'signal-index.cjs');
copyFileSync(realIndex, strippedIndex);
copyFileSync(realSignalIndex, strippedSignalIndex);

module.registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'oktz-curve25519') {
			return { url: new URL(`file://${strippedIndex}`).href, shortCircuit: true };
		}
		if (specifier === 'oktz-signal/native/signal/index.cjs') {
			return { url: new URL(`file://${strippedSignalIndex}`).href, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	}
});

const platform = `${process.platform}-${process.arch}`;

const captureWarnings = async work => {
	const warnings = [];
	const listener = warning => warnings.push(warning);
	process.on('warning', listener);
	try {
		const value = work();
		await new Promise(resolve => setTimeout(resolve, 20));
		return { value, warnings };
	}
	finally {
		process.off('warning', listener);
	}
};

const { Curve } = await import('../lib/Utils/crypto.js');
const { XEdDsaUnavailableError } = await import('../lib/Modded/curve-native.js');

test('the reproduction really is a prebuild-less oktz-curve25519', () => {
	assert.throws(
		() => createRequire(import.meta.url)('oktz-curve25519'),
		err => err.code === 'MODULE_NOT_FOUND' && /curve25519\..*\.node/.test(err.message)
	);
});

test('the reproduction has no XEdDSA implementation at all', () => {
	assert.throws(
		() => createRequire(import.meta.url)('oktz-signal/native/signal/index.cjs'),
		/native binding/
	);
});

test('the missing implementation is a typed error, not a bare Error', () => {
	const { pubKey } = Curve.generateKeyPair();
	assert.throws(
		() => Curve.sign(Curve.generateKeyPair().private, Buffer.from('loud')),
		err => {
			assert.ok(err instanceof XEdDsaUnavailableError, 'must be the exported subclass, not a plain Error');
			assert.equal(err.name, 'XEdDsaUnavailableError');
			// the classification contract crypto.js keys on
			assert.equal(err.code, 'ONIGI_XEDDSA_UNSUPPORTED');
			assert.ok(err.message.includes(platform), `the message must name the platform, got: ${err.message}`);
			return true;
		}
	);
});

test('an unverifiable platform is fail-closed but says so, once', async () => {
	const { public: pubKey } = Curve.generateKeyPair();
	const { value, warnings } = await captureWarnings(() => {
		// well-formed key, message and 64-byte signature, so verifySignature gets
		// past every validation and reaches the missing-prebuild check
		const first = Curve.verify(pubKey, Buffer.from('loud'), Buffer.alloc(64));
		const second = Curve.verify(pubKey, Buffer.from('loud'), Buffer.alloc(64));
		return [first, second];
	});
	assert.deepEqual(value, [false, false], 'verify must stay fail-closed, never permissive and never throwing');
	const ours = warnings.filter(w => w.code === 'ONIGI_XEDDSA_UNSUPPORTED');
	assert.equal(ours.length, 1, `exactly one warning per process, got: ${JSON.stringify(warnings.map(w => w.message))}`);
	assert.ok(ours[0].message.includes(platform), `the warning must name the platform, got: ${ours[0].message}`);
	assert.match(ours[0].message, /XEdDSA/);
	assert.match(ours[0].message, /Curve\.verify/, 'the warning must say which operation failed closed');
});

test('the classification is the error code, not the message text', async () => {
	// a reworded message must not stop the platform being reported, and a
	// same-shaped message without the code must not be mistaken for one
	const { public: pubKey } = Curve.generateKeyPair();
	const { warnings } = await captureWarnings(() => {
		// the warn-once latch is already set by the test above, so this asserts
		// the shape rather than the count: the thrown error is the typed one
		try {
			Curve.verify(pubKey, Buffer.from('loud'), Buffer.alloc(64));
		} catch (error) {
			assert.equal(error.code, 'ONIGI_XEDDSA_UNSUPPORTED');
		}
		return Curve.verify(pubKey, Buffer.from('loud'), Buffer.alloc(64));
	});
	assert.equal(warnings.filter(w => w.code === 'ONIGI_XEDDSA_UNSUPPORTED').length, 0, 'the platform is reported once per process, not per call');
	assert.ok(XEdDsaUnavailableError.prototype instanceof Error);
});

test('a malformed public key is an expected rejection and stays silent', async () => {
	const { public: pubKey } = Curve.generateKeyPair();
	const { value, warnings } = await captureWarnings(() => Curve.verify(Buffer.alloc(5), Buffer.from('loud'), Buffer.alloc(64)));
	assert.equal(value, false, 'a wrong-length public key is a rejection, not a crash');
	assert.deepEqual(warnings.filter(w => /XEdDSA|Curve\.verify/.test(w.message)), [], `a bad key must not be reported as an unsupported platform: ${JSON.stringify(warnings.map(w => w.message))}`);
	// and it really is the malformed key, not the platform, that produced false
	assert.equal(Curve.verify(pubKey, Buffer.from('loud'), Buffer.alloc(64)), false);
});

test('a truncated signature is an expected rejection and stays silent', async () => {
	const { public: pubKey } = Curve.generateKeyPair();
	const { value, warnings } = await captureWarnings(() => Curve.verify(pubKey, Buffer.from('loud'), Buffer.alloc(8)));
	assert.equal(value, false);
	assert.deepEqual(warnings.filter(w => /XEdDSA|Curve\.verify/.test(w.message)), []);
});

