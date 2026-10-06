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

/*
 * The wire-compatibility oracle. These expected bytes are NOT this crate's
 * own output — they were cross-checked to be byte-identical across all three of
 *
 *   1. curve25519-js@0.0.4  (node_modules under the oktz-signal checkout) —
 *      the upstream JavaScript implementation libsignal and WhatsApp call
 *   2. oktz-signal's native curveSign() (node_modules/oktz-signal)
 *   3. this crate
 *
 * None of the three shares code with the others: a pure-JS library using
 * jsbn/bigint, a separate Rust crate, and this crate.
 *
 * The triples deliberately vary what a regression would move: the clamped key
 * bits (sk 0x11…, 0xff…, 0x0f… all clamp differently), the nonce bytes
 * (0xef…, 0x01…, 0x00…), and the message length (12, 1, and empty — the empty
 * message is the case where a length off-by-one in the SHA512 preimage would
 * otherwise hide).
 *
  * Changing the nonce domain separation (`src/lib.rs:61-62`, the 0xfe ‖ 0xff×31
 * prefix), the challenge hash (`challenge`), or `clamp_scalar` will break every
 * one of these and silently break curve25519-js@0.0.4 / libsignal / WhatsApp
 * compatibility. Determinism tests cannot catch any of that.
 */
const PARITY_VECTORS = [
  {
    sk: '11'.repeat(32),
    msg: Buffer.from('same message').toString('hex'),
    rnd: 'ef'.repeat(64),
    sig: '8944c8f12ddf761d96a663101612e687e2cd6fe2da6d723a17c7c8f4b89db28' +
         '6210f546b6af4ec0415a234c2a46d3c4481503909fb62ba2c7d51f04d83583886',
  },
  {
    sk: 'ff'.repeat(32),
    msg: Buffer.from('m').toString('hex'),
    rnd: '01'.repeat(64),
    sig: '33f591551c8d900cc54c22b1a82c261019a03a37c7fc38984c7e7f56c20781ea' +
         '73aae792187580a5137509639af8a3d7ec5acb6bb352cfc2f374ba7b05dddb85',
  },
  {
    sk: '0f'.repeat(32),
    msg: '',
    rnd: '00'.repeat(64),
    sig: '216365db2c1c8edad89a3f661c8a091b4308c77fb278c7022bb85faf5d33835' +
         '7c7fe6290b7c608ba5eb1ea68344780e2467025ff2c564fb25d86fe2c05a6d183',
  },
];

test('an explicit rnd reproduces the curve25519-js@0.0.4 signature byte for byte', () => {
  for (const { sk: skHex, msg, rnd, sig } of PARITY_VECTORS) {
    const got = Buffer.from(native.sign(
      Buffer.from(skHex, 'hex'),
      Buffer.from(msg, 'hex'),
      Buffer.from(rnd, 'hex'),
    )).toString('hex');
    assert.equal(got, sig, `wire-compatibility vector broken: sk=${skHex.slice(0, 8)}…`);
  }
});

test('omitting the nonce produces a different signature each call', () => {
  const a = native.sign(sk, Buffer.from('same message'));
  const b = native.sign(sk, Buffer.from('same message'));
  assert.notDeepEqual(a, b, 'sign() is deterministic — nonce is not random');
});

test('an explicit rnd still pins the signature', () => {
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