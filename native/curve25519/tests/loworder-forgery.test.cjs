const assert = require('node:assert/strict');
const { test } = require('node:test');

// oktz-curve25519's verify() used ed25519-dalek's cofactorless `verify`,
// which accepts a forged signature whenever the public key is a small-order
// point. oktz-signal already used `verify_strict`; these are the two
// implementations that must agree.
const native = require('../index.cjs');

// u = 0 maps through MontgomeryPoint::to_edwards to the Edwards point of
// order 2, (0, -1). For that A the cofactorless equation [S]B = R + [k]A is
// satisfied by R = A, S = 0, for EVERY message and EVERY key.
const ORDER_2_PUBKEY = Buffer.alloc(32, 0);
const EDWARDS_ORDER_2 = Buffer.from(
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'hex');
const FORGED = Buffer.concat([EDWARDS_ORDER_2, Buffer.alloc(32, 0)]);

test('verify rejects a forged signature under the all-zero public key', () => {
  assert.equal(native.verify(ORDER_2_PUBKEY, Buffer.from('probe #0'), FORGED), false);
});

test('verify rejects the same forgery under any message', () => {
  for (const m of ['probe #1', 'probe #2', '']) {
    assert.equal(native.verify(ORDER_2_PUBKEY, Buffer.from(m), FORGED), false);
  }
});