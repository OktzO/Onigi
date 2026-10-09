# oktz-curve25519

**A native Rust XEdDSA binding for Node.js, exposed through CommonJS.**

[![npm](https://img.shields.io/badge/npm-0.0.6-blue?style=flat-square&logo=npm)](https://www.npmjs.com/package/oktz-curve25519)
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

## ⚠️ Read this first: what changed at 0.0.6

**As of `0.0.6`, the published package and this directory are the same
artifact.** Everything below this point describes `0.0.6`, and `0.0.6` is what
gets installed. There is no second layout in this README.

This was not true of what came before, and the reason the older versions are
still worth describing:

| | `oktz-curve25519@0.0.4` on npm | `oktz-curve25519@0.0.6` — this directory |
|---|---|---|
| `files` | `["index.cjs", "curve25519.linux-x64-gnu.node"]` | `["index.cjs", "native-loader.cjs"]` |
| `optionalDependencies` | **none** | 4, all `oktz-curve25519-*` |
| binaries in the tarball | `curve25519.linux-x64-gnu.node` | none — they come from the platform packages |
| how the addon is loaded | `require('./curve25519.linux-x64-gnu.node')`, hard-coded, at the top of `index.cjs` | `require('./native-loader.cjs')`, which dispatches on platform |
| tarball contents | 3 files, 734 523 bytes unpacked | — |
| works off linux-x64 | no: the `require` is unconditional, so `require()` **throws** | yes — the platform package is installed and its `.node` is loaded |

`0.0.4`'s `index.cjs:16` was the whole difference — this is that line,
verbatim, from the 0.0.4 tarball, not from this tree:

```js illustrative
// oktz-curve25519@0.0.4 — not the shipped line as of 0.0.6
const native = require('./curve25519.linux-x64-gnu.node');
```

against this directory's `index.cjs:16`, which is what `0.0.6` ships:

```js illustrative
const native = require('./native-loader.cjs');
```

What changed, in the order it matters to a consumer:

1. **0.0.6 carries a real native binding.** It is the first release of this
   package that publishes a working `.node`. The four
   `@oktz/curve25519-linux-{x64,arm64}-{gnu,musl}` packages are
   published and resolvable, and they are declared as `optionalDependencies`
   at `0.0.6` in `package.json`. Before that, `0.0.5` shipped this loader
   against four `optionalDependencies` that did not exist on the registry, so
   an install resolved no native binding at all and `require()` threw.
2. **`0.0.6` is the first release that carries the library fixes** — the
   strict `verify` equation, the CSPRNG nonce, the zeroizing and
   `clamp_scalar` work, and the known-answer vectors. Two of them change
   observable behaviour, which is why the version moved rather than `0.0.4`
   being republished. The full list is in [CHANGELOG.md](CHANGELOG.md).
3. **Only `0.0.4` and `0.0.5` had a different artifact from this tree.** If
   you have a lockfile pinning either, upgrade; the loader, the export names
   and `main` are otherwise unchanged, so nothing in your call sites moves.

Everything this README says about the loader, the exports and the platform
matrix is about `0.0.6`, which is the npm artifact. The registry also serves
`oktz-curve25519@1.0.0`, which is the old single-platform layout; that layout
is `0.0.4`'s, described above, and it is not what `0.0.6` installs.

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
- If the install is broken by something other than the host — a partial
  `node_modules`, a stale lockfile that still points at `0.0.4` or `0.0.5` —
  you get the second case too, which is the state every install was in before
  `0.0.6`.

## Platform matrix

Declared targets are the four in `napi.config.json` and the four in
`optionalDependencies` at `0.0.6`; the Android target below is built and
packaged by CI but is deliberately kept out of both. Nothing else is declared,
built, or supported.

| Target | Platform package | Published at `0.0.6`? | Binary loaded on this host? |
|---|---|---|---|
| `x86_64-unknown-linux-gnu` | `@oktz/curve25519-linux-x64-gnu` | yes | **yes — built and loaded here, tests run against it** |
| `x86_64-unknown-linux-musl` | `@oktz/curve25519-linux-x64-musl` | yes | compile result only; never loaded |
| `aarch64-unknown-linux-gnu` | `@oktz/curve25519-linux-arm64-gnu` | yes | compile result only; never loaded |
| `aarch64-unknown-linux-musl` | `@oktz/curve25519-linux-arm64-musl` | yes | compile result only; never loaded |
| `aarch64-linux-android` | `oktz-curve25519-android-arm64` | **no** — gated, see below | compile result only; never loaded |

- **macOS: not built, not published, not supported.** No `darwin` target
  appears in `napi.config.json`, in `optionalDependencies`, or in either
  workflow.
- **Windows: not built, not published, not supported.** Same.
- **Android/Termux: cross-compiled in CI, deliberately not published.**
  `release.yml` gates the publish on a `workflow_dispatch` boolean named
  `termux_test_passed` that no CI run ever sets. On Termux you get the JS
  wrapper and no `.node` — build it yourself.

The four "compile result only" rows are not a hedge, and publishing them did
not change it. `ci.yml` builds them and uploads them, `release.yml` publishes
the four Linux ones, and its step summary says which were built — but no runner
in any workflow executes one of those binaries. The workload that would prove
them needs the matching hardware or an emulator. Treat them as untested: three
of the five `.node` files a consumer can now install have never been loaded.

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
    cause: Cannot find module 'oktz-curve25519-wasm32-wasi'
```

That is what you get on `darwin-x64`, `win32-x64`, `freebsd-x64` and
`linux-riscv64` — and the same on `linux-x64` if the platform package is
absent, which is what every install looked like before `0.0.6`. Two things to
know:

- The `cause` names the **WASI** package
  (`oktz-curve25519-wasm32-wasi`, the loader's last fallback at
  `native-loader.cjs:634-655`), not the platform package that was actually
  missing. `error.cause` is a chained summary of every attempt, and the last
  one is the WASI fallback. The platform attempts are in there too.
- The advice is wrong for this failure mode. It is npm's generic message for
  "no optional dependency installed"; on a host `0.0.6` supports that means
  the platform package was skipped or removed, not that none of them exist on
  the registry, so reinstalling without clearing `node_modules` may not help.

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
`index.cjs` before running it. The rewrite is load-bearing today: the
enclosing `Onigi` repository has `oktz-curve25519@0.0.4` in its
`node_modules` — the single-platform artifact described in the first section —
so without the rewrite each block would exercise that linux-x64-only tarball
instead of the source it claims to document.

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
  (`index.cjs:29-31`: "*diabaikan — Node keygen random*"), and `0.0.6` does
  exactly what the published `0.0.4` did — this is unchanged behaviour across
  both layouts. Use the `private` the call returns. I could not verify what the
  upstream `curve25519-js` does with that argument from this tree, so treat the
  parameter name as a shape, not a contract.

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
  (`src/lib.rs:106`, `src/lib.rs:139`, and the reverse at `src/lib.rs:186-194`).
- A 32-byte value that is not a real public key returns `false`, not a throw
  (`src/lib.rs:187-190`).

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

- **Every *secret-equivalent* buffer this crate materialises and keeps is wrapped
  in `Zeroizing`.** That is the widest true claim, not the widest possible one:
  several buffers this crate keeps are public (`a_bytes`, `r_bytes`, `s_bytes`,
  `sig`) and are deliberately unwrapped, listed with reasons at `src/lib.rs:267`.
  The 32-byte secret enters this crate into a
  `zeroize::Zeroizing` buffer at `src/lib.rs:164`, and is clamped **in place** at
  `src/lib.rs:99` — `clamp_scalar` takes `&mut Zeroizing<[u8; 32]>`, so the
  **unclamped** bytes never exist inside this crate anywhere but that one buffer. Each `Scalar` is
  wrapped too — `a`, `r`, `h` and `s` in `sign_internal` (`src/lib.rs:103`,
  `src/lib.rs:118`, `src/lib.rs:127`, `src/lib.rs:132`) — together with three
  buffers that are secret-equivalent to `a`: the `SHA512` digest in `nonce_rnd`
  (`src/lib.rs:66`), the CSPRNG nonce `generated` (`src/lib.rs:113`), and the
  caller-supplied `opt_random` nonce `rnd` (`src/lib.rs:159`). Each is a
  preimage of `r`, and from the public `S` and `h` that gives
  `a = (S − r)·h⁻¹`. The wrap is the substance here, not the style:
  `curve25519-dalek`'s `Scalar` has a manual `Zeroize` impl and **no `Drop`**, so
  the `zeroize` feature makes `scalar.zeroize()` callable without making a
  `Scalar` wipe itself — the arithmetic form of the key would otherwise sit in
  freed stack memory for the life of the process.
  Wrapping makes the wipe unconditional on every exit path, including the
  error return when the CSPRNG cannot be read. The digest is finalised
  **directly into** that guard — `finalize_into_reset` over a
  `GenericArray::from_mut_slice(&mut digest[..])` at `src/lib.rs:67` — rather
  than through `h.finalize().into()`, which returned a `GenericArray` by value
  and so put the secret digest in an unwiped slot in *this* crate's frame first.
  Two honest limits, recorded at `src/lib.rs:360` and `src/lib.rs:279`:
  `&*r + &*h * &*a`
  materialises two unwiped `Scalar` temporaries, the product and then the sum,
  because each is the return value of a `Mul`/`Add` impl — harmless here, since
  `h` is public and `a` is not recoverable from `h·a` or `r + h·a` without
  already holding `a`; and `Zeroizing` bounds this crate's own buffers, not the
  ones inside its dependencies — `curve25519-dalek`'s `UnpackedScalar` limb
  temporaries and the `[i8; 64]` of radix-16 digits that `variable_base_mul`
  builds out of `a` and `r` for every `B * a`, and in sha2 0.10.9 the `Sha512`
  state that `nonce_rnd` feeds the
  secret key into at `src/lib.rs:63` (sha2 has neither `Drop` nor `Zeroize`
  anywhere, and `finalize_fixed_reset` does not help: `digest_pad` only zeroes
  bytes *after* the block position, and `BlockBuffer::reset` only rewinds the
  position) plus `full_res` in `CtVariableCoreWrapper::finalize_fixed_core`,
  which every finalisation path allocates unwiped. Separately, of the four
  scalars only `a` and `r` are secret — `h` is `SHA512(R ‖ A ‖ m)` over public
  values and `S` is published in the signature itself, so those two are wrapped
  for uniformity rather than necessity.
  `curve25519-dalek` and `ed25519-dalek` are both pulled in with the `zeroize`
  feature (`Cargo.toml`). Two questions decide the rule, and a buffer has to
  pass both: **is it secret-equivalent** — would whoever holds it be able to
  recover `a` from the public `S`? "Not derived from the secret" does not
  clear it, which is why the digest and both nonces are wrapped — **and does
  anything copy it by value**, since every by-value argument and every by-value
  return on the signing path is a copy of *material* into memory this crate does
  not wipe, whatever its type. Secret-equivalence is the other gate, not a
  substitute: that is what keeps public by-value returns such as
  `base_mult_scalar`'s `A` and `s.to_bytes()`'s `S` out of the residue list.
  The by-value question is the one that a derivation test cannot see at all:
  `clamp_scalar` used to initialise an unwiped local from the guarded key and
  return it by value, which put an
  *unclamped* copy of the secret on the stack twice, and no amount of
  derivation reasoning would have flagged it.
  The caller's `Uint8Array` inputs are the caller's to zeroize, not ours, and
  they are not zeroized here — napi hands them over as borrowed `&[u8]` views
  onto JS memory (`napi_get_typedarray_info`), and this crate does not own that
  memory. It does copy out of those views: `src/lib.rs:162` copies the 64
  caller's nonce bytes into a guard, and `src/lib.rs:164` copies the 32 caller's
  secret-key bytes into a guard. Those two copies are counted above, under
  `SUDAH DI-GUARD`; what is left outside any guard is on our side of the
  boundary, and it is not the caller's bytes. It is worth being precise about
  whose each piece is, so: one of them is ours to place, and the rest are not
  ours at all:
  `Scalar::from_bytes_mod_order` takes its 32 bytes **by value**, so the `**sk`
  at `src/lib.rs:103` materialises an unwiped `[u8; 32]` for the duration of that
  call — ours to place, dalek's to accept, and unavoidable here only because
  dalek has no `&[u8; 32]`-taking constructor to call instead. The rest are not
  ours at all: dalek's `UnpackedScalar` limb temporaries from `Scalar::unpack()`
  (`scalar.rs:1119`, reached from `from_bytes_mod_order` → `reduce()` and from
  the `Mul`/`Add` impls) *and*, separately, the `UnpackedScalar` that
  `from_bytes_mod_order_wide` gets from `UnpackedScalar::from_bytes_wide` — that
  path does not go through `unpack()` at all, it calls `from_bytes_wide(...).pack()`
  and `pack()` calls `as_bytes()` — plus the `[i8; 64]` of radix-16 digits from
  `Scalar::as_radix_16()` (`scalar.rs:985`) that `variable_base_mul` builds for
  every `B * a`; then the `Sha512`
  buffers above, which hold `sk` or a preimage of `r` until they are dropped
  unwiped, and `full_res` in `CtVariableCoreWrapper::finalize_fixed_core`
  (`digest-0.10.7/src/core_api/ct_variable.rs:119`), which every finalisation path
  allocates unwiped. The `GenericArray` that sha2's `finalize_fixed` used to
  return by value was **not** in that group — its value landed in this
  crate's frame, so it was ours to fix, and it is fixed. All of these are
  recorded at `src/lib.rs:279` as open, not as fixed: two numbered items,
  covering six allocation sites. That entry states
  plainly that the claim is a source-level one and makes no assertion about what
  any particular build's codegen does with it.
  **"Six" is the result of the criterion applied to the code as it stands, not
  a proof that six is all of them.** Two things cannot show up in a count made
  this way: allocations internal to a dependency that are not the ones the
  enumeration names, and anything reachable only through a dependency's internal
  call graph — that is, through no expression in this file. Five
  separate review rounds each turned up one more after the previous round said
  the list was finished, so the number is a claim to be re-run, not a fact to
  rely on. `src/lib.rs:287-293` carries the same hedge in the source.
- **No `unsafe` in the Rust.** `#![deny(unsafe_code)]` is the first line of
  `src/lib.rs`. Verification is delegated to `ed25519-dalek` rather than
  hand-rolled (`src/lib.rs:175-177` says why).
- **`verify()` uses the strict equation.** `src/lib.rs:206` calls
  `vk.verify_strict(...)`, not the cofactorless `vk.verify(...)`. That is not a
  stylistic choice: the cofactorless equation accepts a forgery under any
  small-order public key. For `u = 0`, the Edwards order-2 point `A`, the fixed
  pair `R = A, S = 0` satisfies it for about **half** of messages — `k` has to be
  odd, since that `A` is its own inverse — not for every message. No key
  material is involved: the attacker picks the message and retries until one
  lands.
  `tests/loworder-forgery.test.cjs` asserts that this package returns `false`
  for exactly that forgery, and `examples/02-rejection.mjs` prints it as part of
  the measured rejection surface. `oktz-signal` was already strict
  (`native/signal/src/curve.rs:175-178`, in that crate's checkout, which this
  repository does not vendor).
- **Scalar arithmetic is constant-time**, because it is `curve25519-dalek`'s,
  not hand-written. The non-scalar work is `sha2`.

### The verifier that actually runs is chosen at load time

**`verify()` is only as strong as the binding that got loaded.** Nothing inside
this package chooses that. In the enclosing `Onigi` repository,
`lib/Modded/curve-native.js:126-134` delegates XEdDSA verification to
`oktz-signal`'s native `curveVerify` when that binding loaded, and falls back to
this package's `verify()` when it did not. So the equation a caller actually gets
depends on whether an optional prebuild installed.

Both are strict, and that is checked rather than asserted:
`tests/platform-loader.test.cjs` loads `oktz-signal/native/signal/index.cjs`,
and asserts that both implementations reject the low-order forgery under three
messages and that each verifies the other's signatures — byte for byte on a
pinned nonce. Without that test, a disagreement would be invisible here:
`tests/curve-xeddsa-delegation.test.mjs` blocks `oktz-curve25519` resolution
outright, so this crate's `verify` is never reached through that path at all.
The test skips, with the reason printed, when the optional prebuild is absent —
a missing prebuild does not fail the suite.

**The fallback is silent.** `lib/Modded/curve-native.js` emits a warning only
when *neither* binding loaded; when exactly one did, the substitution is
invisible at runtime. As things stand that is not a security hole, because the
two agree — but it is the shape the bug had: this package used to be the
cofactorless one, and the only reason anyone found out is that the two were
compared by hand. **This should probably become a warning** — an opt-in one,
since a caller who deliberately installed only this prebuild would otherwise
start seeing one on every process start. It is deliberately **not** done here:
this package cannot emit it, `oktz-signal` does not own the decision either, and
changing the fallback's behaviour belongs to the adaptor, not to a change that
has no source file to put it in.

### One thing a caller should know before using it

**`sign()` is randomised unless you pin the nonce.** With no third argument the
nonce is 64 bytes from the platform CSPRNG (`src/lib.rs:113-121`), so two calls
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
`SHA512(0xfe ‖ 0xff×31 ‖ sk ‖ m ‖ rnd) mod L` (`src/lib.rs:59-69`), which is
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

One of those rejections is about the **key** rather than the signature, and it
is measured in the same example rather than asserted in prose: an all-zero
public key with `R = A, S = 0` returns `false`, under three different messages.
The cofactorless equation this package used to verify with returned `true` for
that forgery on about half of all messages, and for about three quarters of them
if `R` is allowed to range over all eight low-order points. The point is not that
the forgery always works: it is that nothing secret is needed to get a signature
accepted, so here "it returns false" is the security property rather than a
convenience.

---

## What has and has not actually been run

Being precise, because "it builds" and "it works" are not the same claim.

| | Status |
|---|---|
| `x86_64-unknown-linux-gnu` | **built and loaded.** The test suite and the documentation gate both run against it. |
| the other four targets | **built in CI. Never loaded.** No runner executes them. |
| cross-implementation agreement with `oktz-signal` | **executed in the test suite**, by the last case in `tests/platform-loader.test.cjs`: both implementations reject the low-order forgery, and each verifies the other's signatures byte for byte on a pinned nonce. Skipped, with the reason printed, when `oktz-signal`'s prebuild does not resolve. Also demonstrated in `examples/01-sign-verify.mjs`. |
| `cargo test` | **not run.** There are no `#[test]` functions in `src/lib.rs`; `examples/verify_debug.rs` is a `cargo run` example, not a test. |
| external security assessment | **none** |

```bash nonrunnable
cargo build --release --manifest-path native/curve25519/Cargo.toml
cp target/release/libcurve25519_rs.so \
   native/curve25519/curve25519.linux-x64-gnu.node

# measured on this tree, Node 22.23.3, linux-x64-gnu:
npm test            # 13 passed, 0 failed, 4 files
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
running it — otherwise every block would exercise the `oktz-curve25519@0.0.4`
that the enclosing repository has in `node_modules`, which is the wrong
artifact.

Both need a loaded native binding, so in CI they run on the
`x86_64-unknown-linux-gnu` leg only, across Node 20, 22 and 24. On any other
host they will fail at `require`, which is the correct outcome and not a
documentation bug.

---

## Known limitations

1. **Only `linux-x64-gnu` is verified end to end.** `0.0.6` publishes four
   platform packages, but the other three are compile results that no runner
   has executed. See the platform matrix above.
2. **macOS and Windows are unsupported**, by omission rather than by policy —
   there is no target to build.
3. **The Android binary is never published**, gated on a workflow input that
   nothing sets. It is also not in `optionalDependencies`, so
   `npm install` never asks for it.
4. **`generateKeyPair` is not seeded.** The parameter is named `seed`, is
   validated as one, and is then thrown away. `0.0.6` and the published
   `0.0.4` behave identically, so this is not a `0.0.6` regression — it is the
   behaviour that has always shipped here, through both layouts. Ported code
   that expects the argument to determine the keypair will not get that.
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
- [CHANGELOG.md](CHANGELOG.md) — what `0.0.6` changed, and what is still wrong
- `examples/*.mjs` — the above, as programs
- [napi-rs]: https://napi.rs/

## Licence

MIT. See the parent repository's `LICENSE`.
