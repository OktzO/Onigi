const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');

// sign() used to derive the nonce as SHA512(sk || msg) when no rnd was given —
// a deterministic function of the secret key. Two signatures over chosen
// messages then yield signature scalars that are an affine function of the
// private key, which is a hidden-number-problem key-recovery setup.
//
// rnd stays injectable on purpose: libsignal / WhatsApp interoperate through a
// fixed 64-byte rnd, so that path must keep producing byte-identical output.
const native = require('../index.cjs');

const sk = Buffer.alloc(32, 0x11);

test('omitting the nonce produces a different signature each call', () => {
  const a = native.sign(sk, Buffer.from('same message'));
  const b = native.sign(sk, Buffer.from('same message'));
  assert.notDeepEqual(a, b, 'sign() is deterministic — nonce is not random');
});

test('an explicit rnd still pins the signature (libsignal parity)', () => {
  const rnd = Buffer.alloc(64, 0xef);
  const a = native.sign(sk, Buffer.from('same message'), rnd);
  const b = native.sign(sk, Buffer.from('same message'), rnd);
  assert.deepEqual(a, b, 'an explicit rnd must remain deterministic');
});

test('two different explicit rnd values give different signatures', () => {
  const a = native.sign(sk, Buffer.from('m'), Buffer.alloc(64, 0x01));
  const b = native.sign(sk, Buffer.from('m'), Buffer.alloc(64, 0x02));
  assert.notDeepEqual(a, b);
});

test('a signature made with no rnd still verifies', () => {
  const { public, private } = native.generateKeyPair(randomBytes(32));
  const sig = native.sign(private, Buffer.from('verify me'));
  assert.equal(native.verify(public, Buffer.from('verify me'), sig), true);
});