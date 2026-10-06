# oktz-curve25519

**A native Rust XEdDSA binding for Node.js, exposed through CommonJS.**

[![npm](https://img.shields.io/badge/npm-0.0.4-blue?style=flat-square&logo=npm)](https://www.npmjs.com/package/oktz-curve25519)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodemon)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://opensource.org/licenses/MIT)

XEdDSA is the Ed25519-over-Curve25519 signature scheme Signal uses to sign
identities. `node:crypto` has no XEdDSA — it has X25519 and it has Ed25519,
and they are not the same thing. This package supplies the missing primitive
as a Rust `cdylib` behind [napi-rs], and supplies nothing else: the X25519
keygen and Diffie-Hellman that Node already has natively are called straight
through to `node:crypto`, so there is no second implementation of anything
that did not need to exist.

- **Two functions are Rust:** `sign` and `verify`.
- **Four are `node:crypto`:** `generateKeyPair`, `sharedKey`, and the
  `signMessage` / `openMessage` pair built on top of `sign` / `verify`.
- **Six exports, total.** See [docs/api.md](docs/api.md).

---

## ⚠️ Read this first: the source here is not what is on npm

**The published `oktz-curve25519@0.0.4` and this directory are different
artifacts with the same version number.** The multi-platform layout you are
reading about has never been published. If you `npm install
oktz-curve25519`, you get the *old* single-platform package.

This was verified by downloading the tarballs and reading them:

| | `oktz-curve25519@0.0.4` on npm | this directory |
|---|---|---|
| `files` | `["index.cjs", "curve25519.linux-x64-gnu.node"]` | `["index.cjs", "native-loader.cjs"]` |
| `optionalDependencies` | **none** | 5, all `@oktz-curve25519/curve25519-*` |
| binaries in the tarball | `curve25519.linux-x64-gnu.node` | none — they come from the platform packages |
| how the addon is loaded | `require('./curve25519.linux-x64-gnu.node')`, hard-coded, at the top of `index.cjs` | `require('./native-loader.cjs')`, which dispatches on platform |
| tarball contents | 3 files, 734 523 bytes unpacked | — |
| works off linux-x64 | no: the `require` is unconditional, so `require()` **throws** | no, but the failure is a clear "no native binding", and the JS-only half still works |

The published `index.cjs:16` is the whole difference:

```js illustrative
// published 0.0.4 — this is the shipped line, verbatim
const native = require('./curve25519.linux-x64-gnu.node');
```

against this directory's `index.cjs:16`:

```js illustrative
const native = require('./native-loader.cjs');
```

Consequences you need to plan around:

1. **The 5 platform packages do not exist on npm.** All five
   `@oktz-curve25519/curve25519-*` names return `404`. So the layout in this
   directory cannot work for an installed consumer today, even if the tarball
   were published as-is. `optionalDependencies` fail soft, so npm would
   install nothing and the loader would throw `Cannot find native binding`.
2. **The published package is not a drop-in for this one on any platform.**
   Same `main`, same export names, different loader.
3. **`oktz-curve25519@1.0.0` is on npm and is the same single-platform
   layout** — 3 files, the same two `files` entries, no `optionalDependencies`.
   The registry's `latest` tag points at `0.0.4`.

Nothing in this README describes the npm artifact's behaviour beyond that
table. If you are consuming from npm, the loader is one line and it does not
branch; if you are building from this tree, the loader is 782 lines and it
does.

---

## Install

```bash
npm install oktz-curve25519
```

There are no runtime dependencies. The `optionalDependencies` in
`package.json` are the platform packages, and the install behaviour is npm's,
not this package's:

- npm installs the one whose `os` / `cpu` / `libc` match the host and skips
  the rest without an error, because they are optional.
- If **no** platform package matches, `npm install` still succeeds. The
  failure comes later, at `require()` time, as
  `Cannot find native binding` — with the individual `MODULE_NOT_FOUND`
  errors attached as `error.cause` (`native-loader.cjs:701-712`).
- If none of the platform packages are actually on the registry, you get the
  second case, always. That is the current state, per the table above.

## Platform matrix

Declared targets are the five in `napi.config.json` and the five in
`optionalDependencies`. Nothing else is declared, built, or supported.

| Target | Platform package | Binary loaded on this host? |
|---|---|---|
| `x86_64-unknown-linux-gnu` | `@oktz-curve25519/curve25519-linux-x64-gnu` | **yes — built and loaded here, tests run against it** |
| `x86_64-unknown-linux-musl` | `@oktz-curve25519/curve25519-linux-x64-musl` | compile result only; never loaded |
| `aarch64-unknown-linux-gnu` | `@oktz-curve25519/curve25519-linux-arm64-gnu` | compile result only; never loaded |
| `aarch64-unknown-linux-musl` | `@oktz-curve25519/curve25519-linux-arm64-musl` | compile result only; never loaded |
| `aarch64-linux-android` | `@oktz-curve25519/curve25519-android-arm64` | compile result only; never loaded, never published |

- **macOS: not built, not published, not supported.** No `darwin` target
  appears in `napi.config.json`, in `optionalDependencies`, or in either
  workflow.
- **Windows: not built, not published, not supported.** Same.
- **Android/Termux: cross-compiled in CI, deliberately not published.**
  `release.yml` gates the publish on a `workflow_dispatch` boolean named
  `termux_test_passed` that no CI run ever sets. On Termux you get the JS
  wrapper and no `.node` — build it yourself.

The four "compile result only" rows are not a hedge. `ci.yml` builds them and
uploads them, and its step summary says so, but no runner in any workflow
executes one of those binaries. The workload that would prove them needs the
matching hardware or an emulator. Treat them as untested.

### `native-loader.cjs` covers more platforms than this package publishes

The generated loader has branches for `win32`, `darwin`, `freebsd` and
`openharmony` (`native-loader.cjs:118-530`). Those are `@napi-rs/cli`
boilerplate for a full platform matrix. **No corresponding package exists**,
so on those platforms the loader tries a name that is not on npm and then
throws. It is not a portability promise.

There is one escape hatch, and it is the loader's first check
(`native-loader.cjs:67-81`): set `NAPI_RS_NATIVE_LIBRARY_PATH` to the path of
a `.node` file and it is required instead of any platform package. Verified
here — with it set to a locally built binary, `require('oktz-curve25519')`
loads and signs, and the loader stamps the artifact it resolved as
`__napiBindingTarget === 'native'`.

## Reading the error when no prebuild matches

The failure is at `require()` time, and the message is misleading in a way
worth knowing about. Measured on this host with `process.platform` and
`process.arch` overridden:

```text
Error: Cannot find native binding. npm has a bug related to optional
dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i`
again after removing both package-lock.json and node_modules directory.
    cause: Cannot find module '@oktz-curve25519/curve25519-wasm32-wasi'
```

That is what you get on `darwin-x64`, `win32-x64`, `freebsd-x64` and
`linux-riscv64` — and the same on `linux-x64` if the platform packages were
absent, which is the state of the registry today. Two things to know:

- The `cause` names the **WASI** package
  (`@oktz-curve25519/curve25519-wasm32-wasi`, the loader's last fallback at
  `native-loader.cjs:634-655`), not the platform package that was actually
  missing. `error.cause` is a chained summary of every attempt, and the last
  one is the WASI fallback. The platform attempts are in there too.
- The advice is wrong for this failure mode. It is npm's generic message for
  "no optional dependency installed"; here no `optionalDependencies` exist on
  the registry at all, so reinstalling will not help.

## Usage

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const curve = require('oktz-curve25519');

const { public: publicKey, private: secretKey } = curve.generateKeyPair(new Uint8Array(32));
const message = Buffer.from('hello, XEdDSA');

const signature = curve.sign(secretKey, message);
console.log('signature:', Buffer.from(signature).toString('hex'));
assert.equal(signature.length, 64);
assert.equal(curve.verify(publicKey, message, signature), true);

const corrupted = Buffer.from(signature);
corrupted[0] ^= 0x01;
assert.equal(curve.verify(publicKey, message, corrupted), false);

console.log('verified, and rejected a one-bit corruption');
```

Every `js run` block above writes the package specifier a consumer would
write, and `docs/verify.mjs` rewrites that one specifier to this directory's
`index.cjs` before running it. The rewrite is load-bearing: the enclosing
`Onigi` repository has the *published* `oktz-curve25519` in its
`node_modules`, and without the rewrite each block would exercise that
linux-x64-only artifact — the one described in the first section — instead of
the source it claims to document.

In a checkout of your own, write the path instead:

```js illustrative
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const curve = createRequire(import.meta.url)(join(here, 'index.cjs'));
```

More in [docs/quickstart.md](docs/quickstart.md).

## The API

Six functions. Full detail, with the exact types and every error, in
[docs/api.md](docs/api.md).

| Export | Kind | Signature |
|---|---|---|
| `sign` | **Rust** | `(secretKey: Uint8Array(32), msg: Uint8Array, opt_random?: Uint8Array(64)) => Uint8Array(64)` |
| `verify` | **Rust** | `(publicKey: Uint8Array(32), msg: Uint8Array, signature: Uint8Array(64)) => boolean` |
| `generateKeyPair` | `node:crypto` | `(seed: Uint8Array(32)) => { public: Uint8Array(32), private: Uint8Array(32) }` |
| `sharedKey` | `node:crypto` | `(secretKey: Uint8Array(32), publicKey: Uint8Array(32)) => Uint8Array(32)` |
| `signMessage` | JS wrapper | `(secretKey, msg, opt_random?) => Uint8Array(64 + msg.length)` |
| `openMessage` | JS wrapper | `(publicKey, signedMsg) => Uint8Array \| null` |
| `default` | — | `{}`, so an ESM default import resolves |

Two traps in that table, both covered in
[docs/encoding.md](docs/encoding.md) and both verified by the examples:

- **`verify()` wants 32 raw public-key bytes.** The 33-byte `0x05`-prefixed
  form that `libsignal` carries everywhere **throws** `wrong public key
  length` — it does not return `false`. Strip it first.
- **`generateKeyPair(seed)` ignores `seed`.** It is length-checked and then
  discarded; the keypair is random. The package's own docstring says so
  (`index.cjs:29-31`: "*diabaikan — Node keygen random*"), and the published
  `0.0.4` does exactly the same. Use the `private` the call returns. I could
  not verify what the upstream `curve25519-js` does with that argument from
  this tree, so treat the parameter name as a shape, not a contract.

```js run
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const curve = require('oktz-curve25519');

const kp = curve.generateKeyPair(new Uint8Array(32).fill(1));
const msg = Buffer.from('prefix');
const sig = curve.sign(kp.private, msg);
const prefixed = Buffer.concat([Buffer.from([0x05]), Buffer.from(kp.public)]);

assert.throws(() => curve.verify(prefixed, msg, sig), /wrong public key length/);
assert.equal(curve.verify(prefixed.subarray(1), msg, sig), true);
console.log('the 0x05-prefixed 33-byte form throws; the 32-byte form verifies');
```

## Encoding, in brief

Full version with citations: [docs/encoding.md](docs/encoding.md).

- Secret key 32, public key 32, signature 64 (`R ‖ S`), nonce 64.
- `verify()` **throws** on a wrong length (`index.cjs:22-25`, before the
  addon) and **returns `false`** on a wrong key, message or signature. A
  `false` never says which.
- Byte 63 of the signature carries the public key's sign bit in bit 7; the
  scalar `S` below it leaves bits 4-6 clear, because `S < L < 2^252`
  (`src/lib.rs:101`, `src/lib.rs:134`, and the reverse at `src/lib.rs:181-189`).
- A 32-byte value that is not a real public key returns `false`, not a throw
  (`src/lib.rs:182-185`).

---

## Security note

**This package is unaudited.** There is no external security assessment of
this code, no third-party cryptographer has reviewed it, and nothing in this
repository constitutes one. The tests here are round-trip, rejection and
known-answer tests written by the same person who wrote the implementation.
Nothing below is a claim that it is safe; it is a list of what the code does,
so you can decide.

### What this primitive is for

XEdDSA signs a long-term identity key so a peer can check that a bundle belongs
to the key it claims to. It is **not**:

- **not Ed25519.** Same curve, different scheme. An Ed25519 signature and an
  XEdDSA signature are not interchangeable, and an Ed25519 verifier will
  reject an XEdDSA signature.
- **not a Diffie-Hellman.** `sharedKey` is X25519 agreement and produces a
  secret nobody can sign with. Nothing in this package converts one into the
  other.
- **not a KDF, an AEAD, or a key-derivation function.** 32 bytes of shared
  secret go in and 32 bytes come out. What you do with them is your problem.

### What the code actually does

Verified by reading `src/lib.rs` and by running it:

- **Secret keys are zeroized, in every representation the signing path
  materialises.** The clamped 32-byte secret is held in a `zeroize::Zeroizing`
  buffer (`src/lib.rs:94`, `src/lib.rs:159`), and so is each `Scalar` —
  `a`, `r`, `h` and `s` in `sign_internal` (`src/lib.rs:98`, `src/lib.rs:113`,
  `src/lib.rs:122`, `src/lib.rs:127`) — together with three buffers that are
  secret-equivalent to `a`: the `SHA512` digest in `nonce_rnd`
  (`src/lib.rs:62`), the CSPRNG nonce `generated` (`src/lib.rs:108`), and the
  caller-supplied `opt_random` nonce `rnd` (`src/lib.rs:154`). Each is a
  preimage of `r`, and from the public `S` and `h` that gives
  `a = (S − r)·h⁻¹`. The wrap is the substance here, not the style:
  `curve25519-dalek`'s `Scalar` has a manual `Zeroize` impl and **no `Drop`**, so
  the `zeroize` feature makes `scalar.zeroize()` callable without making a
  `Scalar` wipe itself — the arithmetic form of the key would otherwise sit in
  freed stack memory for the life of the process.
  Wrapping makes the wipe unconditional on every exit path, including the
  error return when the CSPRNG cannot be read. Two honest limits, both
  recorded at `src/lib.rs:249`: `&*h * &*a` still materialises the product as
  an unwiped `Scalar` temporary, because that is the `Mul` impl's return value
  — harmless here, since `h` is public and `a` is not recoverable from `h·a`
  without already holding `a`; and `Zeroizing` bounds this crate's own buffers,
  not the ones inside its dependencies — `curve25519-dalek`'s `UnpackedScalar`
  limb temporaries, and the `Sha512` state that `nonce_rnd` feeds the secret key
  into at `src/lib.rs:59`, which sha2 0.10.9 drops unwiped (it has neither
  `Drop` nor `Zeroize` anywhere). Separately, of the four scalars only `a` and
  `r` are secret — `h` is `SHA512(R ‖ A ‖ m)` over public values and `S` is
  published in the signature itself, so those two are wrapped for uniformity
  rather than necessity.
  `curve25519-dalek` and `ed25519-dalek` are both pulled in with the `zeroize`
  feature (`Cargo.toml`). The *unclamped* input `Uint8Array` is not zeroized —
  it belongs to the caller. Two copies of the *clamped* secret still sit
  outside any guard, and neither can be closed from here:
  `Scalar::from_bytes_mod_order` takes its 32 bytes **by value**, so the deref
  at `src/lib.rs:98` materialises an unwiped `[u8; 32]` for the duration of that
  call (dalek has no `&[u8; 32]`-taking constructor), and the `Sha512` state
  above holds `sk` until the hasher is dropped unwiped. Both are recorded at
  `src/lib.rs:283` as open, not as fixed.
- **No `unsafe` in the Rust.** `#![deny(unsafe_code)]` is the first line of
  `src/lib.rs`. Verification is delegated to `ed25519-dalek` rather than
  hand-rolled (`src/lib.rs:170-172` says why).
- **`verify()` uses the strict equation.** `src/lib.rs:201` calls
  `vk.verify_strict(...)`, not the cofactorless `vk.verify(...)`. That is not a
  stylistic choice: the cofactorless equation accepts a forged signature
  whenever the public key is a small-order point, because `u = 0` maps to the
  Edwards order-2 point, where `R = A, S = 0` satisfies the equation for every
  message and every key.
  `tests/loworder-forgery.test.cjs` asserts that this package returns `false`
  for exactly that forgery. `oktz-signal` was already strict
  (`native/signal/src/curve.rs:175-178`, in that crate's checkout, which this
  repository does not vendor).
- **Scalar arithmetic is constant-time**, because it is `curve25519-dalek`'s,
  not hand-written. The non-scalar work is `sha2`.

### One thing a caller should know before using it

**`sign()` is randomised unless you pin the nonce.** With no third argument the
nonce is 64 bytes from the platform CSPRNG (`src/lib.rs:108-116`), so two calls
with the same key over the same message return different signatures. Measured
on this tree: over 64 distinct keypairs, 0/64 pairs of no-nonce signatures came
back byte-identical. Bit 7 of byte 63 is the public key's, not the nonce's —
across 16 no-nonce signatures per key over those same 64 keys, 0/64 keys ever
changed it.

Earlier versions of this package defaulted to `r = SHA512(sk ‖ m) mod L`, a
function of the secret key alone, and were deterministic. That is a
key-recovery setup rather than a curiosity: with `sk` fixed, `S = r + h·a` is
affine in the nonce, so two signatures over chosen messages supply enough
equations to recover `a` — the hidden-number-problem lattice attack
`oktz-signal` documents at `native/signal/src/curve.rs:123-126` (in that
crate's checkout, which this repository does not vendor), and the reason that
sibling implementation has always taken its nonce from `OsRng` when the caller
supplies none. This package no longer derives it that way. If the CSPRNG cannot
be read, `sign` throws rather than fall back to a predictable nonce.

**Pass a 64-byte nonce only if you need a reproducible signature** — to compare
against a value another implementation produced, or to pin a test vector. It is
the third argument, and that path hashes it under a distinct prefix,
`SHA512(0xfe ‖ 0xff×31 ‖ sk ‖ m ‖ rnd) mod L` (`src/lib.rs:55-64`), which is
the derivation `curve25519-js@0.0.4`, `libsignal` and WhatsApp use — so it is
also what keeps this package byte-compatible with them. A nonce you pass in
determines the output; a nonce left out does not. Two caller-supplied nonces
over one key and one message:

```js run
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const curve = require('oktz-curve25519');

const kp = curve.generateKeyPair(new Uint8Array(32));
const message = Buffer.from('randomised nonce');

const first = curve.sign(kp.private, message, randomBytes(64));
const second = curve.sign(kp.private, message, randomBytes(64));

assert.notDeepEqual(Buffer.from(first), Buffer.from(second),
	'two CSPRNG nonces give two different signatures');
assert.equal(curve.verify(kp.public, message, first), true);
assert.equal(curve.verify(kp.public, message, second), true);
console.log('two random 64-byte nonces -> two different signatures, both valid');
```

### Rejection surface, measured

A wrong key, a wrong message, a flipped bit anywhere in the 64-byte
signature, a toggled sign bit, an all-zero signature: all `false`. A wrong
length or a plain `Array`: a throw. See
[docs/quickstart.md](docs/quickstart.md#what-rejection-actually-looks-like)
and `examples/02-rejection.mjs`, both executed by `npm run docs:verify`.

---

## What has and has not actually been run

Being precise, because "it builds" and "it works" are not the same claim.

| | Status |
|---|---|
| `x86_64-unknown-linux-gnu` | **built and loaded.** The test suite and the documentation gate both run against it. |
| the other four targets | **built in CI. Never loaded.** No runner executes them. |
| cross-implementation agreement with `oktz-signal` | **executed**, in `examples/01-sign-verify.mjs`, when `oktz-signal` resolves. Skipped otherwise, and the skip is printed. |
| `cargo test` | **not run.** There are no `#[test]` functions in `src/lib.rs`; `examples/verify_debug.rs` is a `cargo run` example, not a test. |
| external security assessment | **none** |

```bash nonrunnable
cargo build --release --manifest-path native/curve25519/Cargo.toml
cp target/release/libcurve25519_rs.so \
   native/curve25519/curve25519.linux-x64-gnu.node

# measured on this tree, Node 22.23.3, linux-x64-gnu:
npm test            # 12 passed, 0 failed, 4 files
npm run docs:verify # 20 code blocks + 4 examples, 0 failures
```

## Testing

```bash nonrunnable
npm test
npm run docs:verify
```

`npm test` is `node --test tests/*.test.cjs` — a **shell** glob. That is
deliberate and it is not the obvious spelling. `node --test tests/` — the
directory form — fails on Node 22.23.3 with
`Error: Cannot find module '…/native/curve25519/tests'`, because this Node
treats the positional argument as a file path. The shell glob works on both
Node 20 and Node 22; node's own glob syntax for positional arguments is Node
22+, so `node --test 'tests/**/*.test.cjs'` is not an option for a package
whose `engines` allow 20.

`npm run docs:verify` executes every `js run` block in this README,
`CHANGELOG.md` and `docs/`, plus every `examples/*.mjs`, and exits non-zero
if any of them does. Two shapes are hard failures rather than silent skips: a
JavaScript block that is neither `run` nor `illustrative`, and a fence with no
info string at all. A snippet nobody labelled is the one that goes stale
without anyone noticing, so the gate refuses to guess.

Each block writes the package specifier a consumer would write, and the
verifier rewrites that one specifier to this directory's `index.cjs` before
running it — otherwise every block would exercise the *published* package
that the enclosing repository has in `node_modules`, which is the wrong
artifact.

Both need a loaded native binding, so in CI they run on the
`x86_64-unknown-linux-gnu` leg only, across Node 20, 22 and 24. On any other
host they will fail at `require`, which is the correct outcome and not a
documentation bug.

---

## Known limitations

1. **No published platform packages.** All five 404. See the table at the top.
2. **macOS and Windows are unsupported**, by omission rather than by policy —
   there is no target to build.
3. **The Android binary is never published**, gated on a workflow input that
   nothing sets.
4. **`generateKeyPair` is not seeded.** The parameter is named `seed`, is
   validated as one, and is then thrown away. The published `0.0.4` behaves
   identically, so this is not a 0.0.4 regression — it is the behaviour that
   has always shipped here. Ported code that expects the argument to determine
   the keypair will not get that.
5. **No TypeScript definitions ship in the tarball.** `index.cjs` is
   CommonJS and untyped; `napi.config.json` has no `types` entry and
   `package.json` has no `types` field. Editors will infer `any`. A `.d.ts`
   generated by `napi build` is not in `files`.
6. **No `LICENSE` file in this directory.** `package.json` says MIT, and the
   parent repository carries the licence text; the vendored crate does not
   have its own copy.

---

## See also

- [docs/quickstart.md](docs/quickstart.md) — sign, verify, reject
- [docs/api.md](docs/api.md) — every export, read from source
- [docs/encoding.md](docs/encoding.md) — the `0x05` prefix, the sign bit, the lengths
- [CHANGELOG.md](CHANGELOG.md) — what 0.0.4 changed, and what is still wrong
- `examples/*.mjs` — the above, as programs
- [napi-rs]: https://napi.rs/

## Licence

MIT. See the parent repository's `LICENSE`.
