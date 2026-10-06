# API

The complete export list, read from `index.cjs:100` and the two Rust
`#[napi]` functions in `src/lib.rs`. There are six functions and one empty
`default` object. Nothing else is exported; if you have seen a seventh name
somewhere, it belongs to `curve25519-js` or to `libsignal`, not to this
package.

---

## The export list

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const curve = require('../index.cjs');

const names = Object.keys(curve).sort();
console.log('exports:', names.join(', '));
assert.deepEqual(names, [
	'default', 'generateKeyPair', 'openMessage', 'sharedKey', 'sign', 'signMessage', 'verify'
]);
for (const name of names) {
	console.log(`  ${name}: ${typeof curve[name]}`);
}
assert.deepEqual(curve.default, {}, '`default` exists so an ESM default import works; it is empty');
```

Two of those names are added by the generated loader rather than by
`index.cjs`: `native-loader.cjs:781-782` re-exports `sign` and `verify`
directly off the binding object so that `cjs-module-lexer` can see them as
named exports. They are the same two functions `index.cjs:67-80` wraps.

---

## The six functions

### `sign(secretKey, msg[, opt_random]) → Uint8Array` (64 bytes)

XEdDSA signature. `index.cjs:67-73`, `src/lib.rs:156-167`.

| Parameter | Type | Length | Notes |
|---|---|---|---|
| `secretKey` | `Uint8Array` | 32 | the raw X25519 private scalar |
| `msg` | `Uint8Array` | any | passed to `node:crypto`/`napi` as bytes; empty is fine |
| `opt_random` | `Uint8Array` \| `undefined` \| `null` | 64 | nonce. **Omit it and the nonce is drawn from the platform CSPRNG**, so every call returns a different signature. Pass a fixed 64-byte value to pin the output byte for byte — that is the `curve25519-js@0.0.4` / `libsignal` / WhatsApp path, and the only one that reproduces a signature another implementation already produced. `sign` throws if the CSPRNG cannot be read; it never falls back to a predictable nonce |

Returns a `Uint8Array` of 64 bytes, `R ‖ S`. Throws `Error: wrong secret key
length`, `Error: wrong random data length`, or
`TypeError: unexpected type, use Uint8Array`.

**The secret key is clamped inside the addon** (`src/lib.rs:48-56`, RFC 7748:
`sk[0] &= 248; sk[31] &= 127; sk[31] |= 64`). You do not clamp it yourself,
and you cannot observe the clamped value. Note the consequence: two different
32-byte secrets that differ only in the clamped bits produce the **same**
signature. If your secret came from somewhere that already clamped, that is
fine; if you are generating secrets, generate 32 uniform random bytes and let
the addon clamp.

**Omitting `opt_random` does not make the signature reproducible**, so a
signature you produced earlier cannot be regenerated and compared. Two
consequences worth stating: two signatures over the same message are not
interchangeable evidence of two distinct events, and if you need to test against
a signature another system produced, you must have its nonce — see
[encoding.md §6](encoding.md#6-the-nonce-is-random-unless-you-pin-it) for why
the default is a CSPRNG rather than a function of the key.

The returned `Uint8Array` is a fresh copy (`src/lib.rs:166` builds a new
`Vec`), not a view over the addon's memory. `Buffer.from(sig)` is safe if you
want a `Buffer` for another API.

### `verify(publicKey, msg, signature) → boolean`

XEdDSA verification. `index.cjs:76-80`, `src/lib.rs:178-207`.

| Parameter | Type | Length |
|---|---|---|
| `publicKey` | `Uint8Array` | 32 (raw, **no** `0x05` prefix) |
| `msg` | `Uint8Array` | any |
| `signature` | `Uint8Array` | 64 |

Returns `true` or `false`. **Never throws for a wrong-length key or
signature** — that is a throw, from `index.cjs:77-78`. Returns `false`, never
throws, when the signature does not match, when the message differs, when the
key differs, and when the 32-byte public key has no Edwards preimage
(`src/lib.rs:187-190`) or is not a valid `VerifyingKey`
(`src/lib.rs:197-200`).

A `false` tells you nothing about *which* of those happened. There is no
error code, no reason string, no out-parameter. If you need to distinguish
"malformed key" from "forged signature", you have to check the key yourself
first.

> The public key must be the **32 raw bytes**. The 33-byte `0x05`-prefixed
> form that `libsignal` uses throws. See [encoding.md §2](encoding.md#2-the-33-byte-0x05-public-key--the-failure-that-is-not-a-false).

### `generateKeyPair(seed) → { public, private }`

Both `Uint8Array`, 32 bytes. `index.cjs:32-47`. **Not** the Rust addon —
`node:crypto.generateKeyPairSync('x25519')`, with the DER envelope stripped
(`index.cjs:19-20` hold the two prefixes).

**`seed` is validated and then discarded.** It does not determine the
keypair; every call returns a fresh random one. The function's own docstring
says so (`index.cjs:29-31`). This is the one place where the API *shape*
suggests a seed and the behaviour does not supply one — see
[encoding.md §5](encoding.md#5-generatekeypairseed-ignores-the-seed).

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const curve = require('../index.cjs');

// libsignal's shape: a 33-byte public key, 0x05 type byte in front.
const identity = curve.generateKeyPair(new Uint8Array(32));
const prefixed = Buffer.concat([Buffer.from([0x05]), Buffer.from(identity.public)]);
const message = Buffer.from('an identity, not an agreement');
const signature = curve.sign(identity.private, message);
const bundle = Buffer.concat([prefixed, Buffer.from(message)]);

console.log('bundle     :', bundle.toString('hex'));
console.log('bundle len :', bundle.length, '= 1 + 32 + message');
assert.equal(bundle.length, 1 + 32 + message.length);
assert.equal(bundle[0], 0x05, 'libsignal KeyBundleType for a Curve25519 identity key');
assert.equal(curve.verify(bundle.subarray(1, 33), bundle.subarray(33), signature), true,
	'strip the type byte and the 32 bytes, and the bundle verifies');
```

### `sharedKey(secretKey, publicKey) → Uint8Array` (32 bytes)

X25519 Diffie-Hellman. `index.cjs:50-64`. Also `node:crypto` — the addon is
not involved, so this works on every platform regardless of which prebuild
loaded.

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const curve = require('../index.cjs');

const alice = curve.generateKeyPair(new Uint8Array(32));
const bob = curve.generateKeyPair(new Uint8Array(32));
const message = Buffer.from('an agreement, not a signature');

const fromAlice = curve.sharedKey(alice.private, bob.public);
const fromBob = curve.sharedKey(bob.private, alice.public);
console.log('alice->bob:', Buffer.from(fromAlice).toString('hex'));
console.log('bob->alice:', Buffer.from(fromBob).toString('hex'));
assert.deepEqual(Buffer.from(fromAlice), Buffer.from(fromBob), 'symmetric');
assert.equal(fromAlice.length, 32);

const signature = curve.sign(alice.private, message);
console.log('this package has no way to sign a shared secret:',
	curve.verify(bob.public, message, signature));
assert.equal(curve.verify(bob.public, message, signature), false,
	'an XEdDSA signature is not a Diffie-Hellman transcript');
```

An agreement and a signature are different primitives. Do not expect to
derive one from the other, and do not use `sharedKey` output as a signing
key.

### `signMessage(secretKey, msg[, opt_random]) → Uint8Array` (64 + `msg.length`)

`signature ‖ msg`. `index.cjs:83-89`. Present for `curve25519-js` API parity;
`libsignal` does not use it, and neither does anything in this repository.

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const curve = require('../index.cjs');

const kp = curve.generateKeyPair(new Uint8Array(32));
const message = Buffer.from('concatenated');
// sign() draws a fresh CSPRNG nonce on every call, so pin one to compare
// two signatures byte for byte. This is the same path libsignal uses.
const rnd = new Uint8Array(64).fill(9);
const signed = curve.signMessage(kp.private, message, rnd);

console.log('signed length:', signed.length, '= 64 +', message.length);
assert.equal(signed.length, 64 + message.length);
assert.deepEqual(
	Buffer.from(signed.subarray(0, 64)),
	Buffer.from(curve.sign(kp.private, message, rnd)),
	'the first 64 bytes are exactly sign() output'
);
assert.equal(Buffer.from(curve.openMessage(kp.public, signed)).toString(), 'concatenated');
```

### `openMessage(publicKey, signedMsg) → Uint8Array | null`

The inverse. `index.cjs:92-98`. Returns the message, or `null` — never
`false`, never a throw for a bad signature. `signedMsg` shorter than 64 bytes
returns `null` immediately (`index.cjs:93`), with no `checkLen` involved.

---

## What the addon exports underneath

If you `require('./native-loader.cjs')` directly you bypass every check in
`index.cjs` and get the raw napi bindings — `sign` and `verify` only, and
nothing else (`native-loader.cjs:781-782`). They take `Uint8Array` for every
argument including the message, return a `Buffer` for `sign` and a boolean for
`verify`, and report wrong lengths as
`Error: wrong public key length: 33 (expected 32)` — the Rust text, from
`src/lib.rs:36-46`, with the lengths included.

There is no reason to do this except in a test that wants to prove the JS
wrapper's checks exist.

---

## What is *not* in the API

Named explicitly, because each of these exists in the thing this package is a
replacement for, and reaching for one here means reaching past `index.cjs` into
code that was never written:

- **`getPublicFromPrivateKey(privKey)`** — exists in `libsignal`'s
  `curve.js` and in this repository's `lib/Modded/curve-native.js:148-157`. Not
  here. Derive it with `node:crypto` yourself:
  `createPrivateKey` + `createPublicKey`, then strip the DER prefix
  (`index.cjs:20`), then prefix `0x05` if the caller wants libsignal's form.
- **`scalarMultiply`** — exported by `oktz-signal` as `curveScalarMultiply`
  (`native/signal/src/lib.rs:40-45`, in that crate's checkout, which this
  repository does not vendor). Not here. `sharedKey` covers the same
  ground through `node:crypto`.
- **A seeded / deterministic keygen** — see above.
- **A 33-byte public key accepted anywhere** — see
  [encoding.md §2](encoding.md#2-the-33-byte-0x05-public-key--the-failure-that-is-not-a-false).
- **Any Ed25519 signature** (as opposed to XEdDSA). The two are not
  interchangeable. See the security note in the [README](../README.md).

---

## See also

- [quickstart.md](quickstart.md) — sign and verify, end to end
- [encoding.md](encoding.md) — lengths, the `0x05` prefix, the sign bit
- `examples/01-sign-verify.mjs`, `examples/04-x25519-agreement.mjs`
