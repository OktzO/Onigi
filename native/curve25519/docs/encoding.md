# Encoding

Every length, every prefix, and every place a wrong-length argument turns into
an exception instead of a `false`. All of it is read from `index.cjs` and
`src/lib.rs` in this directory, and every `js run` block below is executed by
`npm run docs:verify`.

---

## 1. There are exactly three lengths

| Thing | Length | Enforced in |
|---|---|---|
| secret key (X25519 private scalar) | 32 | `index.cjs:68` (`sign`), `index.cjs:52` (`sharedKey`), `src/lib.rs:153` |
| public key (X25519 `u` coordinate) | 32 | `index.cjs:77` (`verify`), `index.cjs:51` (`sharedKey`), `src/lib.rs:175` |
| signature (`R ‖ S`) | 64 | `index.cjs:78`, `src/lib.rs:176` |
| `opt_random` nonce | 64 | `index.cjs:70`, `src/lib.rs:156` |
| `generateKeyPair` seed | 32 | `index.cjs:33` |

Every one of these is checked **twice** — once in `index.cjs`'s `checkLen`
before the call crosses into the addon, and again in Rust's `check_len`
(`src/lib.rs:32-42`). The JavaScript check is the one that fires, so the
message a caller sees comes from `index.cjs:22-25` and does not name the
lengths:

```js run
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const curve = require('../index.cjs');

for (const [what, thunk] of [
	['secret key', () => curve.sign(new Uint8Array(31), Buffer.from('m'))],
	['public key', () => curve.verify(new Uint8Array(33), Buffer.from('m'), new Uint8Array(64))],
	['signature', () => curve.verify(new Uint8Array(32), Buffer.from('m'), new Uint8Array(63))],
	['random data', () => curve.sign(new Uint8Array(32), Buffer.from('m'), new Uint8Array(63))],
	['seed', () => curve.generateKeyPair(new Uint8Array(31))]
]) {
	try {
		thunk();
		console.log(what, '-> no throw');
	} catch (err) {
		console.log(`wrong ${what} length ->`, `${err.constructor.name}: ${err.message}`);
	}
}
```

`oktz-signal`'s equivalent checks live in Rust, so *its* messages do name the
lengths — `wrong public key length: 33 (expected 32)`. Both throw. Only the
text differs.

### Length is checked before type

`index.cjs:22-25` is two statements in this order:

```js illustrative
function checkLen(v, n, what) {
  if (v.length !== n) throw new Error(`wrong ${what} length`);
  if (!(v instanceof Uint8Array)) throw new TypeError('unexpected type, use Uint8Array');
}
```

So a plain `Array` of the wrong length gets a length `Error`, and a plain
`Array` of the *right* length gets the `TypeError`. A `Buffer` passes both,
because `Buffer` is a `Uint8Array`.

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const curve = require('../index.cjs');

// wrong length wins, even though the type is also wrong
assert.throws(() => curve.sign([1], Buffer.from('m')), /^Error: wrong secret key length$/);
// right length, wrong type
assert.throws(() => curve.sign(new Array(32).fill(1), Buffer.from('m')),
	/TypeError: unexpected type, use Uint8Array/);
// a Buffer is a Uint8Array
assert.doesNotThrow(() => curve.sign(Buffer.alloc(32), Buffer.from('m')));
console.log('length is checked before type; Buffer passes both');
```

---

## 2. The 33-byte `0x05` public key — the failure that is not a `false`

This is the single most common way to get this package wrong.

**libsignal carries an identity public key as 33 bytes**: a `0x05` type byte
followed by the 32 raw X25519 bytes. Callers written against `libsignal`'s
`curve.js` produce that shape. `sign()` and `verify()` here want the **32 raw
bytes**.

Handing `verify()` the 33-byte form does **not** return `false`. It **throws**,
because 33 ≠ 32 trips the length check in `index.cjs:77` before any curve
arithmetic happens.

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const curve = require('../index.cjs');

const identity = curve.generateKeyPair(new Uint8Array(32).fill(4));
const message = Buffer.from('prefixed public key');
const signature = curve.sign(identity.private, message);

const raw32 = Buffer.from(identity.public);
const prefixed33 = Buffer.concat([Buffer.from([0x05]), raw32]);

console.log('verify(raw32)     ->', curve.verify(raw32, message, signature));
assert.equal(curve.verify(raw32, message, signature), true);

try {
	curve.verify(prefixed33, message, signature);
	console.log('verify(prefixed33) -> returned without throwing (unexpected)');
} catch (err) {
	console.log('verify(prefixed33) ->', `${err.constructor.name}: ${err.message}`);
}

// The fix, and it is one line:
console.log('verify(prefixed33.subarray(1)) ->', curve.verify(prefixed33.subarray(1), message, signature));
```

`oktz-signal` behaves the same way and for the same reason — its check is
`check_len(public_key, 32, "public key")?` at the top of
`native/signal/src/curve.rs:154`, in that crate's checkout, which this
repository does not vendor. This is what makes cross-implementation delegation
work only after the prefix is stripped:

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const curve = require('../index.cjs');

let signalNative = null;
try {
	signalNative = require('oktz-signal/native/signal/index.cjs');
} catch {
	console.log('skipped: oktz-signal is not installed next to this tree');
}

if (signalNative) {
	const kp = curve.generateKeyPair(new Uint8Array(32).fill(5));
	const msg = Buffer.from('cross implementation');
	const ours = curve.sign(kp.private, msg);
	const prefixed = Buffer.concat([Buffer.from([0x05]), Buffer.from(kp.public)]);

	// oktz-signal accepts our signature, but only after the prefix is gone.
	assert.equal(signalNative.curveVerify(prefixed.subarray(1), msg, ours), true);
	assert.throws(() => signalNative.curveVerify(prefixed, msg, ours),
		/wrong public key length: 33 \(expected 32\)/);
	console.log('oktz-signal verifies our signature on the 32-byte form and throws on the 33-byte form');
}
```

The parent repository does this stripping in one place, before either
implementation is reached — `lib/Modded/curve-native.js:79-93`:

```js illustrative
function scrubPubKeyFormat(pubKey) {
  // accepts 33 bytes whose first byte is 5, or a bare 32
  if ((pubKey.byteLength != 33 || pubKey[0] != 5) && pubKey.byteLength != 32) {
    throw new Error('Invalid public key');
  }
  if (pubKey.byteLength == 33) {
    return pubKey.slice(1);
  }
  return pubKey;
}
```

Note the `pubKey[0] != 5` half: a 33-byte key that does *not* start with
`0x05` is rejected outright, not silently sliced.

**This package does not do that stripping for you.** It has no
`getPublicFromPrivateKey`, and it does not accept a 33-byte key anywhere.

---

## 3. Byte 63 of the signature is not entirely `S`

A signature is `R ‖ S`, 32 bytes each. `S` is a scalar reduced mod the group
order `L ≈ 2^252`, so it occupies 252 bits and its top four bits are zero.
The bit that is *not* part of `S` is bit 7 of byte 63: the sign bit of the
public key, transported inside the signature.

**Sign** — `src/lib.rs:101` reads it off the compressed public key and
`src/lib.rs:134` writes it in:

```js illustrative
let sign_bit = a_bytes[31] & 128;   // src/lib.rs:101
// …
sig[32..64].copy_from_slice(&s_bytes);  // src/lib.rs:132
sig[63] |= sign_bit;                    // src/lib.rs:134
```

**Verify** — `src/lib.rs:181` reads it back out to reconstruct the Edwards
public key, and `src/lib.rs:189` clears it to recover the real `S`:

```js illustrative
let sign_bit = sig[63] & 128;            // src/lib.rs:181
let a_bytes = match pubkey_montgomery_to_edwards(&pk, sign_bit >> 7) { … };
sig_clean[63] &= 127;                    // src/lib.rs:189
```

Consequences a caller can observe:

- `signature[63] & 0x70` is **always** `0`. If you see otherwise, you are
  looking at something that is not an XEdDSA signature.
- `signature[63] & 0x80` is set roughly half the time, and it carries no
  information you need to compute. Do not treat it as part of `S`.
- **Toggling** that bit always makes verification return `false`, because you
  have changed which public key the verifier reconstructs. *Clearing* it
  only does anything when the bit was actually set — masking a clear bit is a
  no-op and the signature still verifies. This distinction is easy to get
  wrong and it is asserted below, because a test written as "clear the sign
  bit" passes about half the time and fails about half the time.
- `verify()` takes the sign bit from the **signature**, not from the public
  key argument. A 32-byte X25519 `u` coordinate does not carry it. That is why
  the encoding is self-contained: `R ‖ S` verifies against a bare 32-byte
  public key with no extra state.

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const curve = require('../index.cjs');

const message = Buffer.from('sign bit');
let set = 0;
let cleared = 0;

for (let i = 0; i < 64; i++) {
	const kp = curve.generateKeyPair(new Uint8Array(32).fill(i));
	const signature = curve.sign(kp.private, message);

	// bits 4-6 of the S half are always clear: S < L < 2^252
	assert.equal(signature[63] & 0x70, 0);
	assert.equal(curve.verify(kp.public, message, signature), true);

	// toggling bit 7 always names a different public key, so it always fails
	const toggled = Buffer.from(signature);
	toggled[63] ^= 0x80;
	assert.equal(curve.verify(kp.public, message, toggled), false,
		'a toggled sign bit must not verify');

	// masking only changes anything when it clears a bit that was set
	const masked = Buffer.from(signature);
	masked[63] &= 0x7f;
	const wasSet = (signature[63] & 0x80) !== 0;
	assert.equal(curve.verify(kp.public, message, masked), !wasSet,
		'masking a clear sign bit is a no-op; masking a set one breaks the signature');

	if (wasSet) { set++; } else { cleared++; }
}

console.log('bits 4-6 of byte 63: clear in all 64 signatures');
console.log(`bit 7 of byte 63: ${set} set, ${cleared} clear — both are normal`);
console.log('a toggled bit 7 never verifies; a masked bit 7 only matters when it was set');
```

---

## 4. The public key is a Montgomery `u`, not an Edwards point

This is not an encoding choice you can make differently at the call site, but
it explains the sizes. X25519 public keys are the Montgomery form: 32 bytes
holding the `u` coordinate. `verify()` converts to Edwards internally with
`MontgomeryPoint::to_edwards` (`src/lib.rs:140-143`) and hands the result to
`ed25519-dalek`.

The conversion can fail — a `u` with no Edwards preimage — and when it does,
`verify()` returns `false` rather than throwing (`src/lib.rs:182-185`):

```js illustrative
// src/lib.rs:182-185
let a_bytes = match pubkey_montgomery_to_edwards(&pk, sign_bit >> 7) {
    Some(p) => p.compress().to_bytes(),
    None => return Ok(false),
};
```

So a 32-byte value of the right length that is not a real public key produces
`false`, and is indistinguishable from a valid signature that does not match.

---

## 5. `generateKeyPair(seed)` ignores the seed

Not a formatting detail — a behavioural trap, and the easiest way to write code
that always returns `false`.

`index.cjs:32-47` validates the seed's length and then discards it: the
keypair comes from `generateKeyPairSync('x25519')`, which is random. The
package's own docstring says so — `index.cjs:29-31`, "*diabaikan — Node
keygen random*", with the note that `libsignal` only ever calls it as a
fallback with `randomBytes`. The published `0.0.4` has the identical
function, so this is long-standing behaviour and not a 0.0.4 regression.

What `curve25519-js` itself does with that argument is not verifiable from
this tree — it is not a dependency here — so the safe statement is the
practical one: the parameter is named `seed`, and it does not seed anything.

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const curve = require('../index.cjs');

const seed = new Uint8Array(32).fill(42);
const first = curve.generateKeyPair(seed);
const second = curve.generateKeyPair(seed);

console.log('first  public:', Buffer.from(first.public).toString('hex'));
console.log('second public:', Buffer.from(second.public).toString('hex'));
assert.notDeepEqual(Buffer.from(first.public), Buffer.from(second.public));
console.log('-> different. The seed does not determine the keypair.');

// The consequence, stated as code: signing with the seed and verifying with
// the returned public key is wrong every time.
const signature = curve.sign(seed, Buffer.from('m'));
console.log('verify(first.public, m, sign(seed, m)) ->', curve.verify(first.public, Buffer.from('m'), signature));
assert.equal(curve.verify(first.public, Buffer.from('m'), signature), false);

// What to write instead: use the private key the call returned.
const good = curve.sign(first.private, Buffer.from('m'));
console.log('verify(first.public, m, sign(first.private, m)) ->', curve.verify(first.public, Buffer.from('m'), good));
assert.equal(curve.verify(first.public, Buffer.from('m'), good), true);
```

The seed's validation is not dead code — a wrong length or a plain `Array`
still throws — it just does not influence the result. See
`examples/04-x25519-agreement.mjs`.

---

## 6. The nonce is random unless you pin it

`sign(secretKey, msg)` with no third argument draws a 64-byte nonce from the
platform CSPRNG (`getrandom`, `src/lib.rs:108-116`). Two calls with the same key
over the same message therefore produce **different** signatures. Passing a
third argument pins the nonce, and then the output is byte-identical every time.

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const curve = require('../index.cjs');

const kp = curve.generateKeyPair(new Uint8Array(32).fill(7));
const message = Buffer.from('randomized');
const nonce = new Uint8Array(64).fill(3);

const a = curve.sign(kp.private, message);
const b = curve.sign(kp.private, message);
const withNonce = curve.sign(kp.private, message, nonce);
const withNonceAgain = curve.sign(kp.private, message, nonce);

assert.notDeepEqual(Buffer.from(a), Buffer.from(b), 'no nonce -> CSPRNG nonce -> different output');
assert.deepEqual(Buffer.from(withNonce), Buffer.from(withNonceAgain), 'a fixed nonce -> identical output');
assert.notDeepEqual(Buffer.from(a), Buffer.from(withNonce), 'a nonce changes the output');
assert.equal(curve.verify(kp.public, message, a), true);
assert.equal(curve.verify(kp.public, message, withNonce), true);

console.log('sign(k, m) twice            -> different (CSPRNG nonce)');
console.log('sign(k, m, rnd) twice       -> identical for a fixed rnd');
console.log('sign(k, m) vs sign(k, m, rnd) -> different, and both verify');
```

The nonce path hashes it with a distinct prefix so the two derivations cannot
collide: `r = SHA512(0xfe ‖ 0xff×31 ‖ sk ‖ m ‖ rnd) mod L`
(`src/lib.rs:55-64`). That is the derivation XEdDSA specifies and what
`libsignal` gets from `curve25519-js` by way of `crypto_sign_direct_rnd`, so
pinning the nonce is what keeps this package byte-compatible with it.

Earlier versions of this package defaulted to `r = SHA512(sk ‖ m) mod L`, a
function of the secret key alone, and were deterministic. That is a key-recovery
setup rather than a curiosity: with `sk` fixed, `S = r + h·a` is affine in the
nonce, so two signatures over chosen messages supply enough equations to recover
`a` — the hidden-number-problem lattice attack `oktz-signal` documents at
`native/signal/src/curve.rs:123-126` (in that crate's checkout, which this
repository does not vendor). **A nonce must never be a function of the
secret key.** If the CSPRNG cannot be read, `sign` throws rather than fall back
to a predictable nonce.

Randomized output is also why two signatures over the same message are **not**
interchangeable evidence of two distinct events — see
[../CHANGELOG.md](../CHANGELOG.md) and the security note in the README.

---

## See also

- [api.md](api.md) — every export and its exact signature
- [quickstart.md](quickstart.md) — sign and verify, end to end
- `examples/03-encoding.mjs` — this file, as a runnable program
