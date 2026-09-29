const assert = require('node:assert/strict');
const test = require('node:test');
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
