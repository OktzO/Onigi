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

/*
 * A rejected signature on a platform that *can* verify is a normal outcome and
 * must stay silent. Only the "this platform cannot verify at all" condition is
 * worth a loud warning, so pin the negative half here -- on a real native
 * install, where every rejection below is a genuine verdict.
 */
const captureWarnings = async work => {
	const warnings = [];
	const listener = warning => warnings.push(warning.message);
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

test('a signature mismatch warns about nothing', async () => {
	const { value, warnings } = await captureWarnings(() => Curve.verify(pubKey, message, flipLowBit(signature)));
	assert.equal(value, false);
	assert.deepEqual(warnings, [], `a bad signature must not be reported as an unsupported platform: ${warnings}`);
});

test('a malformed public key warns about nothing', async () => {
	const { value, warnings } = await captureWarnings(() => Curve.verify(Buffer.alloc(5), message, signature));
	assert.equal(value, false);
	assert.deepEqual(warnings, []);
});

/*
 * The FATAL fix in this remediation (42d416d) was Curve.verify propagating the
 * native verifier's boolean instead of a bare `true`. R7 then changed which
 * native implementation answers, so the whole rejection surface is re-pinned
 * here against the delegated one: a wrong answer in either direction is a
 * forged certificate accepted, or a genuine handshake aborted.
 */
const KEY_BUNDLE_TYPE = Buffer.from([5]);
const prefixed = key => Buffer.concat([KEY_BUNDLE_TYPE, key]);

// small-order / invalid curve25519 points; a verifier that accepts any of these
// has a signature-forgery primitive
const LOW_ORDER_POINTS = [
	'0000000000000000000000000000000000000000000000000000000000000000',
	'0100000000000000000000000000000000000000000000000000000000000000',
	'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
	'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
	'26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
	'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'
];

const flipBit = (buf, bit) => { const c = Buffer.from(buf); c[bit >> 3] ^= 1 << (bit & 7); return c; };

const rejections = [];
const reject = (label, key, msg, sig) => rejections.push([label, key, msg, sig]);

// malformed public keys of every interesting length
for (const len of [0, 1, 2, 5, 31, 32, 33, 34, 63, 64, 65, 128]) {
	reject(`public key of ${len} bytes`, Buffer.alloc(len), message, signature);
}
// prefixed degenerate keys
reject('0x05 + all-zero key', prefixed(Buffer.alloc(32)), message, signature);
reject('0x05 + all-ff key', prefixed(Buffer.alloc(32, 0xff)), message, signature);
// wrong version byte
for (const version of [0, 1, 2, 4, 6, 0xff]) {
	reject(`version byte 0x${version.toString(16)}`, Buffer.concat([Buffer.from([version]), pubKey]), message, signature);
}
// low-order points
for (const hex of LOW_ORDER_POINTS) {
	reject(`low-order point ${hex.slice(0, 8)}`, Buffer.from(hex, 'hex'), message, signature);
}
// degenerate signatures
reject('all-zero signature', pubKey, message, Buffer.alloc(64));
reject('all-ff signature', pubKey, message, Buffer.alloc(64, 0xff));
// truncations and an over-long signature
for (const len of [0, 1, 2, 31, 32, 33, 63]) {
	reject(`signature truncated to ${len} bytes`, pubKey, message, signature.subarray(0, len));
}
reject('signature of 65 bytes', pubKey, message, Buffer.concat([signature, Buffer.alloc(1)]));
// bit flips at both ends
reject('signature bit 0 flipped', pubKey, message, flipBit(signature, 0));
reject('signature bit 63 flipped', pubKey, message, flipBit(signature, 63));
// wrong message, wrong key
reject('signature over a different message', pubKey, Buffer.from('a different message'), signature);
reject('signature from a different key', Curve.generateKeyPair().public, message, signature);
reject('random signature', pubKey, message, randomBytes(64));
// non-Buffer arguments
reject('null public key', null, message, signature);
reject('undefined public key', undefined, message, signature);
reject('string public key', 'not a key', message, signature);
reject('number public key', 1234, message, signature);
reject('array public key', new Array(32).fill(9), message, signature);
reject('null message', pubKey, null, signature);
reject('undefined message', pubKey, undefined, signature);
reject('number message', pubKey, 99, signature);
reject('string message', pubKey, 'a message', signature);
reject('empty-array message', pubKey, [], signature);
reject('null signature', pubKey, message, null);
reject('undefined signature', pubKey, message, undefined);
reject('string signature', pubKey, message, 'a signature');
reject('number signature', pubKey, message, 7);
reject('array signature', pubKey, message, new Array(64).fill(1));

test(`Curve.verify rejects ${rejections.length} adversarial inputs and never throws`, () => {
	for (const [label, key, msg, sig] of rejections) {
		let outcome;
		try {
			outcome = Curve.verify(key, msg, sig);
		} catch (error) {
			assert.fail(`Curve.verify threw on ${label}: ${error?.message}`);
		}
		assert.equal(outcome, false, `${label} must be rejected`);
	}
});

test('only a genuine match returns true, in both public-key forms', () => {
	// the 32-byte form is what Curve.generateKeyPair hands out; the 33-byte
	// 0x05-prefixed form is what goes on the wire
	assert.equal(Curve.verify(pubKey, message, signature), true, '32-byte key must verify');
	assert.equal(Curve.verify(prefixed(pubKey), message, signature), true, '33-byte prefixed key must verify');
});

test('genuine matches verify over many random keys, and forgeries still do not', () => {
	for (let i = 0; i < 200; i++) {
		const { public: key, private: secret } = Curve.generateKeyPair();
		const msg = Buffer.from(`round trip ${i}`);
		const sig = Curve.sign(secret, msg);
		assert.equal(Curve.verify(key, msg, sig), true, `genuine signature must verify (i=${i})`);
		assert.equal(Curve.verify(prefixed(key), msg, sig), true, `genuine signature must verify prefixed (i=${i})`);
		assert.equal(Curve.verify(key, msg, flipBit(sig, i % 512)), false, `a forgery must not (i=${i})`);
	}
});

test('an empty message is signed and verified consistently', () => {
	// a zero-length Buffer is truthy, so sign accepts it; verify must agree with
	// sign about it rather than treat it as a missing message
	const sig = Curve.sign(privKey, Buffer.alloc(0));
	assert.equal(sig.byteLength, 64);
	assert.equal(Curve.verify(pubKey, Buffer.alloc(0), sig), true);
	assert.equal(Curve.verify(pubKey, Buffer.from('x'), sig), false);
});

test('Curve.sharedKey agrees with node:crypto diffieHellman on the same bytes', async () => {
	const { createPrivateKey, createPublicKey, diffieHellman } = await import('node:crypto');
	const { calculateAgreement, generateKeyPair } = await import('../lib/Modded/curve-native.js');
	const b64u = buf => Buffer.from(buf).toString('base64url');
	const pubJwk = kp => ({ kty: 'OKP', crv: 'X25519', x: b64u(kp.pubKey.subarray(1)) });
	const privJwk = kp => ({ ...pubJwk(kp), d: b64u(kp.privKey) });
	for (let i = 0; i < 100; i++) {
		const a = generateKeyPair();
		const b = generateKeyPair();
		const expected = Buffer.from(diffieHellman({
			privateKey: createPrivateKey({ format: 'jwk', key: privJwk(a) }),
			publicKey: createPublicKey({ format: 'jwk', key: pubJwk(b) })
		}));
		assert.ok(Buffer.from(calculateAgreement(b.pubKey, a.privKey)).equals(expected), `shared secret must be byte-exact (i=${i})`);
	}
});
