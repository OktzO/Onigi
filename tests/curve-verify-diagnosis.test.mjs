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
 * But it collapses two unrelated conditions into one boolean. On darwin/arm64
 * (or any platform without a prebuild) Curve.verify returns false for "I cannot
 * verify on this machine", and the noise handshake then reports it as
 * 'noise certificate signature invalid' (noise-handler.js:165) -- the exact same
 * message a real signature failure produces. The user cannot tell a broken
 * platform from a forged certificate.
 *
 * The unsupported-platform condition has to be distinguishable from a bad
 * signature, without Curve.verify ever throwing (it must stay fail-closed, and
 * a bad signature must not turn into a crash).
 *
 * A prebuild-less install is reproduced the same way tests/
 * curve-platform-fallback.test.mjs does it: resolve the specifier at a copy of
 * the real index.cjs with no .node beside it.
 */

const realIndex = createRequire(import.meta.url).resolve('oktz-curve25519');
const staging = mkdtempSync(join(tmpdir(), 'curve-verify-diag-'));
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

test('the reproduction really is a prebuild-less oktz-curve25519', () => {
	assert.throws(
		() => createRequire(import.meta.url)('oktz-curve25519'),
		err => err.code === 'MODULE_NOT_FOUND' && /curve25519\..*\.node/.test(err.message)
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
