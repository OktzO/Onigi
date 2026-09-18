const assert = require('node:assert/strict');
const test = require('node:test');
const curve = require('../index.cjs');

test('loads XEdDSA prebuild and signs', () => {
  const secret = new Uint8Array(32).fill(7);
  const pair = curve.generateKeyPair(secret);
  const message = Buffer.from('platform loader');
  const signature = curve.sign(secret, message);
  assert.equal(signature.length, 64);
  assert.equal(curve.verify(pair.public, message, signature), true);
  assert.deepEqual(curve.default, {});
});
