const assert = require('node:assert/strict');
const test = require('node:test');
const { createRequire } = require('node:module');
const { createPrivateKey, createPublicKey } = require('node:crypto');
const curve = require('../index.cjs');

/*
 * The loader resolved, the addon loaded, and XEdDSA round-trips.
 *
 * This test used to sign with `secret` and verify against
 * `generateKeyPair(secret).public`, which cannot work: generateKeyPair
 * validates the seed's length and then discards it (index.cjs:32-47 delegates
 * to node:crypto's random generateKeyPairSync), so the public key it returns
 * belongs to a different key entirely. `verify` was right to return false and
 * the test was wrong. The seed divergence is now pinned by its own case below
 * rather than left as a trap.
 */
test('loads XEdDSA prebuild and signs', () => {
  const pair = curve.generateKeyPair(new Uint8Array(32).fill(7));
  const message = Buffer.from('platform loader');
  const signature = curve.sign(pair.private, message);
  assert.equal(signature.length, 64);
  assert.equal(curve.verify(pair.public, message, signature), true);
  assert.deepEqual(curve.default, {});
});

test('a tampered signature is rejected, not thrown', () => {
  const pair = curve.generateKeyPair(new Uint8Array(32).fill(7));
  const message = Buffer.from('platform loader');
  const signature = Buffer.from(curve.sign(pair.private, message));
  signature[0] ^= 0x01;
  assert.equal(curve.verify(pair.public, message, signature), false);
});

test('the 33-byte 0x05-prefixed public key throws rather than returning false', () => {
  const pair = curve.generateKeyPair(new Uint8Array(32).fill(7));
  const message = Buffer.from('platform loader');
  const signature = curve.sign(pair.private, message);
  const prefixed = Buffer.concat([Buffer.from([0x05]), Buffer.from(pair.public)]);
  assert.throws(() => curve.verify(prefixed, message, signature), /wrong public key length/);
  assert.equal(curve.verify(prefixed.subarray(1), message, signature), true);
});

/*
 * generateKeyPair(seed) ignores the seed. This is a divergence from
 * curve25519-js, where the argument determines the keypair, and it is the
 * reason the case above must sign with `pair.private`. Pinning it here means a
 * future change to seeded keygen has to update this assertion too, rather than
 * silently changing what every caller's `private` means.
 */
test('generateKeyPair discards its seed', () => {
  const seed = new Uint8Array(32).fill(7);
  const a = curve.generateKeyPair(seed);
  const b = curve.generateKeyPair(seed);
  assert.notDeepEqual(Buffer.from(a.public), Buffer.from(b.public));
  assert.throws(() => curve.generateKeyPair(new Uint8Array(31)), /wrong seed length/);
});

/*
 * The cross-implementation check that no other test in this repository makes.
 *
 * `lib/Modded/curve-native.js:126-134` prefers oktz-signal's native
 * curveVerify and falls back to this package's verify() when that binding is
 * unavailable, and the fallback is silent — nothing warns when exactly one of
 * them loads. tests/curve-xeddsa-delegation.test.mjs blocks
 * `oktz-curve25519` resolution entirely, so this crate's verify() is never
 * exercised against a real oktz-signal signature anywhere in the tree. If the
 * two ever disagree, which one a caller gets is decided by whether an optional
 * prebuild happened to install, not by anything a test would catch.
 *
 * That is how Task 1's bug survived: this package used the cofactorless
 * equation, which accepts a forged signature under a small-order public key,
 * while oktz-signal was already strict. Both now call verify_strict, and this
 * is what keeps them agreeing.
 *
 * oktz-signal's prebuild is an optionalDependency of the parent repository and
 * is legitimately absent from some installs, so a load failure skips the test.
 * A missing prebuild must not fail the suite; a present one that disagrees must.
 */
test('this crate and oktz-signal agree on verify, including the low-order forgery', (t) => {
  let signal;
  try {
    signal = createRequire(__filename)('oktz-signal/native/signal/index.cjs');
  } catch (err) {
    t.skip(`oktz-signal's native prebuild is not available here: ${err.message}`);
    return;
  }
  for (const fn of ['curveSign', 'curveVerify']) {
    if (typeof signal[fn] !== 'function') {
      t.skip(`oktz-signal's native binding loaded but exposes no ${fn}()`);
      return;
    }
  }

  // The forgery: an all-zero (Montgomery u = 0) public key converts to the
  // Edwards order-2 point, for which R = A, S = 0 satisfies [S]B = R + [k]A
  // for every message and every key. Both implementations must say false.
  const ORDER_2_PUBKEY = new Uint8Array(32);
  const FORGED = Buffer.concat([
    Buffer.from('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'hex'),
    Buffer.alloc(32)
  ]);
  for (const text of ['platform loader', '', 'a different message']) {
    const message = Buffer.from(text);
    const ours = curve.verify(ORDER_2_PUBKEY, message, FORGED);
    const theirs = signal.curveVerify(ORDER_2_PUBKEY, message, FORGED);
    assert.equal(ours, false, `this crate must reject the forgery (message ${JSON.stringify(text)})`);
    assert.equal(theirs, false, `oktz-signal must reject the forgery (message ${JSON.stringify(text)})`);
  }

  // A control of its own, so the assertions above cannot pass because the
  // bindings are inert: a real signature, made and checked in both directions.
  // The XEdDSA public key is the Montgomery u of the clamped key, which is what
  // node:crypto's x25519 derives — the same clamping RFC 7748 specifies, and the
  // same one clamp_scalar applies.
  const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
  const publicKeyFor = (sk) => {
    const der = createPublicKey(createPrivateKey({
      key: Buffer.concat([PKCS8, Buffer.from(sk)]),
      format: 'der',
      type: 'pkcs8'
    })).export({ format: 'der', type: 'spki' });
    return der.subarray(der.length - 32);
  };

  for (const fill of [0x07, 0x11, 0x0f]) {
    const sk = Buffer.alloc(32, fill);
    const publicKey = publicKeyFor(sk);
    const message = Buffer.from('platform loader');
    const rnd = Buffer.alloc(64, 3);

    const ours = Buffer.from(curve.sign(sk, message, rnd));
    const theirs = Buffer.from(signal.curveSign(sk, message, rnd));
    assert.deepEqual(ours, theirs, `sign() must agree byte for byte (sk ${fill})`);
    assert.equal(curve.verify(publicKey, message, theirs), true,
      'this crate must verify oktz-signal signature bytes');
    assert.equal(signal.curveVerify(publicKey, message, ours), true,
      'oktz-signal must verify this crate signature bytes');
    assert.equal(curve.verify(publicKey, Buffer.from('wrong message'), ours), false,
      'this crate must reject the signature under a wrong message');
    assert.equal(signal.curveVerify(publicKey, Buffer.from('wrong message'), ours), false,
      'oktz-signal must reject the signature under a wrong message');
  }
});
