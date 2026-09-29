# Quickstart

Sign a message, verify it, and watch a tampered signature get rejected. Every
`js run` block here is executed by `npm run docs:verify`, so if one of them
stops working, the build stops.

If you have not read [the README's platform section](../README.md#platform-matrix)
yet, do that first — on anything but Linux x64/arm64 there is no published
binary to load, and the failure is at `require()` time, not at signing time.

---

## Requirements

- **Node.js ≥ 20** (`package.json` `engines`). Verified on 22.23.3 here; CI
  runs 20, 22 and 24.
- **A prebuild for your platform.** See [the platform matrix](../README.md#platform-matrix).
  If none matches, `require('oktz-curve25519')` throws before you can call
  anything.

## Install

```bash
npm install oktz-curve25519
```

## The shortest complete program

Sign, verify, and confirm a corrupted signature does not verify. This is
`examples/01-sign-verify.mjs` in full.

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const curve = require('oktz-curve25519');

const { public: publicKey, private: secretKey } = curve.generateKeyPair(new Uint8Array(32));
const message = Buffer.from('hello, XEdDSA');

// sign: 32-byte secret key, any message, 64-byte signature out
const signature = curve.sign(secretKey, message);
console.log('signature:', Buffer.from(signature).toString('hex'));
console.log('length   :', signature.length, 'bytes (R ‖ S)');

assert.equal(signature.length, 64);

// verify: a genuine signature is accepted
assert.equal(curve.verify(publicKey, message, signature), true);
console.log('verify   :', curve.verify(publicKey, message, signature));

// corrupt one byte of R and try again
const corrupted = Buffer.from(signature);
corrupted[0] ^= 0x01;
const verdict = curve.verify(publicKey, message, corrupted);
console.log('corrupted:', verdict);
assert.equal(verdict, false, 'a signature with one flipped bit must not verify');
```

Three things to notice before you go further:

1. **`verify()` returns `false`, it does not throw**, for a bad signature. The
   things that throw are the length and type checks.
2. **`publicKey` is 32 raw bytes.** If your public key came from `libsignal`
   it is 33 bytes with a `0x05` type byte in front, and passing it here
   **throws**. See [encoding.md §2](encoding.md#2-the-33-byte-0x05-public-key--the-failure-that-is-not-a-false).
3. **`generateKeyPair` ignores its argument.** It returns a random keypair;
   use the `private` it gives you back. See
   [encoding.md §5](encoding.md#5-generatekeypairseed-ignores-the-seed).

---

## What rejection actually looks like

There is no `try`/`catch` needed for a forged signature, and no error to
inspect if you want one. Eight cases, all `false`.

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const curve = require('oktz-curve25519');

const message = Buffer.from('reject me');
const alice = curve.generateKeyPair(new Uint8Array(32).fill(1));
const bob = curve.generateKeyPair(new Uint8Array(32).fill(2));
const signature = curve.sign(alice.private, message);

const flip = (bytes, index) => {
	const copy = Buffer.from(bytes);
	copy[index] ^= 0x01;
	return copy;
};

const rejected = [
	['tampered R', flip(signature, 0)],
	['tampered S', flip(signature, 40)],
	['sign bit toggled', (() => { const c = Buffer.from(signature); c[63] ^= 0x80; return c; })()],
	['all zeros', Buffer.alloc(64)]
];

for (const [what, candidate] of rejected) {
	const ok = curve.verify(alice.public, message, candidate);
	console.log(`${what.padEnd(16)} -> ${ok}`);
	assert.equal(ok, false);
}

// Wrong key, wrong message: also false, and indistinguishable from the above.
assert.equal(curve.verify(bob.public, message, signature), false, 'wrong key');
assert.equal(curve.verify(alice.public, Buffer.from('other'), signature), false, 'wrong message');
console.log('wrong key       -> false');
console.log('wrong message   -> false');

// Length and type are the loud failures.
assert.throws(() => curve.verify(new Uint8Array(33), message, signature), /wrong public key length/);
assert.throws(() => curve.sign(new Uint8Array(31), message), /wrong secret key length/);
assert.throws(() => curve.sign(new Array(32).fill(1), message), TypeError);
console.log('33-byte public key -> throws Error: wrong public key length');
console.log('plain Array        -> throws TypeError');
```

`openMessage` reports the same rejections as `null`, which also means it
reports "this input is too short to be a signed message" as `null`:

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const curve = require('oktz-curve25519');

const kp = curve.generateKeyPair(new Uint8Array(32).fill(3));
const message = Buffer.from('concatenated');
const signed = curve.signMessage(kp.private, message);

console.log('signed length  :', signed.length, '= 64 +', message.length);
assert.equal(signed.length, 64 + message.length);
console.log('openMessage ok :', Buffer.from(curve.openMessage(kp.public, signed)).toString());

const tampered = Buffer.from(signed);
tampered[2] ^= 0x01;
console.log('tampered       :', curve.openMessage(kp.public, tampered));
assert.equal(curve.openMessage(kp.public, tampered), null);

console.log('63 bytes       :', curve.openMessage(kp.public, new Uint8Array(63)));
assert.equal(curve.openMessage(kp.public, new Uint8Array(63)), null);
```

---

## Producing a `libsignal`-shaped key bundle

The form `libsignal` and this repository's `lib/Modded/curve-native.js` put on
the wire: a `0x05` type byte, 32 public key bytes, then the message. This
package produces the middle part and nothing else.

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const curve = require('oktz-curve25519');

const identity = curve.generateKeyPair(new Uint8Array(32));
const message = Buffer.from('an identity, not an agreement');
const signature = curve.sign(identity.private, message);

// 1 (type) + 32 (public key) + message
const bundle = Buffer.concat([
	Buffer.from([0x05]),           // KeyBundleType, libsignal
	Buffer.from(identity.public),
	message
]);

console.log('bundle:', bundle.toString('hex'));
assert.equal(bundle[0], 0x05);
assert.equal(bundle.length, 1 + 32 + message.length);

// Verifying means stripping the type byte again — the 33-byte form is not
// accepted by verify(), it throws.
assert.equal(curve.verify(bundle.subarray(1, 33), bundle.subarray(33), signature), true);
assert.throws(() => curve.verify(bundle, bundle.subarray(33), signature), /wrong public key length/);
console.log('verified with the type byte stripped; threw without stripping it');
```

---

## Interoperating with `oktz-signal`

The two Rust bindings implement the same XEdDSA and are byte-compatible in
both directions. This is what makes a fallback from one to the other safe.
The `0x05` prefix has to come off first, on both sides.

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const curve = require('oktz-curve25519');

let signalNative = null;
try {
	signalNative = require('oktz-signal/native/signal/index.cjs');
} catch {
	console.log('skipped: oktz-signal is not installed next to this tree');
}

if (signalNative) {
	const kp = curve.generateKeyPair(new Uint8Array(32).fill(8));
	const message = Buffer.from('cross implementation');

	const ours = curve.sign(kp.private, message);
	const theirs = Buffer.from(signalNative.curveSign(kp.private, message, null));

	console.log('ours  :', Buffer.from(ours).toString('hex'));
	console.log('theirs:', theirs.toString('hex'));
	assert.notDeepEqual(Buffer.from(ours), theirs,
		'a plain sign() here derives the nonce from the key and message; curveSign() takes one from the CSPRNG');

	assert.equal(signalNative.curveVerify(kp.public, message, ours), true,
		'oktz-signal accepts our signature');
	assert.equal(curve.verify(kp.public, message, theirs), true,
		'we accept oktz-signal\'s signature');
	console.log('oktz-signal verified our signature, and we verified theirs');
}
```

> The signatures differ, and the reason is in the security note of
> [the README](../README.md#security-note): `sign()` with no third argument
> derives the nonce deterministically from the key and message
> (`src/lib.rs:54-60`), while `oktz-signal`'s `curveSign` with a `null` nonce
> draws one from the CSPRNG (`native/signal/src/curve.rs:123-140`). Pass your
> own 64-byte nonce to `sign()` to get the same property.

---

## Working in a checkout

Every `run` block on this page writes `require('oktz-curve25519')`, the
specifier a consumer writes. `docs/verify.mjs` rewrites that one specifier to
this directory's `index.cjs` before running it — the enclosing `Onigi`
repository has the *published* package in its `node_modules`, and without the
rewrite each block would exercise that instead. `examples/*.mjs` do the
resolution themselves, with `require('../index.cjs')`.

If you are running this against a checkout of your own and not through the
verifier, use the path:

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const curve = createRequire(import.meta.url)(join(here, '..', 'index.cjs'));

const kp = curve.generateKeyPair(new Uint8Array(32));
const signature = curve.sign(kp.private, Buffer.from('from a checkout'));
assert.equal(curve.verify(kp.public, Buffer.from('from a checkout'), signature), true);
console.log('loaded', Object.keys(curve).length, 'exports from the checkout');
```

Building the addon for this checkout:

```bash nonrunnable
# needs a C linker on PATH
cargo build --release --manifest-path native/curve25519/Cargo.toml
cp target/release/libcurve25519_rs.so \
   native/curve25519/curve25519.linux-x64-gnu.node
```

The `.node` filename is what `native-loader.cjs` looks for first on
linux-x64-glibc (line 296), and it is covered by the package's `.gitignore`
(`*.node`), so a local build never lands in a commit.

---

## Verifying the documentation

```bash nonrunnable
npm run docs:verify
```

Runs every `js run` block in `README.md`, `CHANGELOG.md` and `docs/`, plus
every `examples/*.mjs`, and exits non-zero if any of them does. It is wired
into the same CI leg as the test suite, because every one of those blocks
loads the native binding and would otherwise pass vacuously on a machine with
no prebuild.

---

## See also

- [api.md](api.md) — every export, read from source
- [encoding.md](encoding.md) — the `0x05` prefix, the sign bit, the lengths
- `../CHANGELOG.md` — what changed in 0.0.4, and what is not fixed
