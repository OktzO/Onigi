# Changelog

All notable changes to `oktz-curve25519`. This directory is vendored into the
`Onigi` repository and has its own CI (`.github/workflows/ci.yml` and
`release.yml`) and its own `napi.config.json`; the commits below are the real
ones from `git log -- native/curve25519`, and the file lists are the real
ones in this tree. The two bullets with no hash are the ones in the commit that
writes this file: a commit cannot contain its own hash, so those two are
identified by subject rather than by identifier.

The Rust crate's own version is `0.1.0` (`Cargo.toml`); the npm package's is
`0.0.4`. They are independent.

---

## next — the fixes after 0.0.4, none of them published

**Nothing in this section is on npm, and the version number has not moved.**
`package.json` still says `0.0.4`, which is the version the registry serves
today, and that artifact contains none of these fixes. Two of them change
observable behaviour, so publishing this tree under the existing `0.0.4` would
ship a signature-nonce change and a verification change as a patch release.
Whoever publishes this needs a version that is not `0.0.4`. The identifiers
below are commit hashes, not version numbers.

- **`fcf1cf9` — `fix(curve): verify XEdDSA with verify_strict, not the
  cofactorless equation`.** `verify` called `ed25519-dalek`'s cofactorless
  `vk.verify`. That equation accepts a forged signature whenever the public key
  is a small-order point: `u = 0` converts through `MontgomeryPoint::to_edwards`
  to the Edwards order-2 point `(0, -1)`, for which `R = A, S = 0` satisfies
  `[S]B = R + [k]A` for **every** message and **every** key. So a caller that
  was handed a bogus 32-byte "public key" got `true` back for a signature
  nobody signed. `verify` now calls `vk.verify_strict`
  (`src/lib.rs:201`), which rejects a small-order `R` and a weak `A`.
  `oktz-signal` has been strict at the same point all along
  (`native/signal/src/curve.rs:175-178`); the two implementations have to agree,
  because callers fall back between them. Added
  `tests/loworder-forgery.test.cjs`, which asserts `false` for exactly that
  forgery under four messages.
- **`958c3a5` — `fix(curve): draw the XEdDSA nonce from a CSPRNG instead of
  SHA512(sk‖m)`.** With no third argument, `sign` derived the nonce as
  `SHA512(sk ‖ m) mod L` — a deterministic function of the secret key. With
  `sk` fixed, `S = r + h·a` is affine in the nonce, so two signatures over
  chosen messages give enough equations to recover `a`: the
  hidden-number-problem lattice attack documented at
  `native/signal/src/curve.rs:123-126`. The `None` arm now fills a 64-byte
  buffer from `getrandom` (`src/lib.rs:108-116`). A CSPRNG failure propagates
  out of `sign` rather than falling back to a predictable nonce, so
  `sign_internal` returns `Result` (`src/lib.rs:88`) — and there is no code
  path on which a fixed or zero nonce can be produced.
  - **`sign()` output is randomised, which is a behavioural break.** Two calls
    with one key over one message no longer return the same 64 bytes. Measured
    on this tree over 64 distinct keypairs: 0/64 pairs came back
    byte-identical, where every pair previously did. Anything that relied on
    reproducible output must now pass a 64-byte `opt_random` — see
    [docs/encoding.md §6](docs/encoding.md#6-the-nonce-is-random-unless-you-pin-it).
  - The `Some(rnd)` arm is untouched. 48 explicit-`rnd` signatures over
    4 keys × 4 nonces × 3 messages are byte-identical to the previous build,
    which is what keeps this crate wire-compatible with
    `curve25519-js@0.0.4` / `libsignal` / WhatsApp. Within this tree the
    pinning is the three known-answer vectors in
    `tests/nonce-randomness.test.cjs`.
  - `getrandom 0.2.17` was already in `Cargo.lock` via `rand_core`; this
    promotes it to a direct dependency. No new package, no version change.
    `curve25519-dalek` stays 4.1.3, `ed25519-dalek` 2.2.0, `sha2` 0.10.9.
- **`0bd9500` — `test(curve): pin the wire-compatible signature to
  curve25519-js@0.0.4 bytes`.** The test then called "libsignal parity"
  compared two `sign()` calls *inside one build*, which pins determinism, not
  identity with the wire value: editing the nonce domain separation, the
  challenge hash or `clamp_scalar` changes every signature and it still
  passed. It now asserts three known-answer vectors whose expected bytes were
  cross-checked byte for byte across `curve25519-js@0.0.4`, `oktz-signal`'s
  native `curveSign`, and this crate. The vectors vary the clamped key bits,
  the nonce bytes and the message length, including the empty message.
- **Secret `Scalar` temporaries are zeroized.** `curve25519-dalek`'s `Scalar`
  has a manual `Zeroize` impl and **no `Drop` impl**, so the `zeroize` feature
  already enabled in `Cargo.toml` makes `scalar.zeroize()` callable without
  making a `Scalar` wipe itself. Only the raw clamped 32-byte secret was in a
  `Zeroizing` buffer; the arithmetic form of the key — `a` and `r` in
  `sign_internal` — was left on the napi/worker stack after the call returned,
  for the life of the process. All four scalars are now wrapped in `Zeroizing`
  (`src/lib.rs:98`, `src/lib.rs:113`, `src/lib.rs:122`, `src/lib.rs:127`)
  rather than zeroized by hand at chosen points, which makes the wipe
  unconditional on every exit path — including the CSPRNG error return the
  previous entry added. `h` and `s` are wrapped too, though neither is secret
  (`h = SHA512(R ‖ A ‖ m)` over public values, `S` is published in the
  signature); the rule is uniform rather than per-variable. The arithmetic is
  written `&*r + &*h * &*a`, not `*r + *h * *a`, because `Scalar` is `Copy` and
  the by-value form would copy the secrets back out of the guarded buffers. No
  observable behaviour change — the 48-signature explicit-`rnd` grid above was
  re-measured against a build of `0bd9500` and is byte-identical — and the note
  at `src/lib.rs:204` records what is deliberately *not* covered, including
  dalek's internal limb temporaries and the caller-owned `Uint8Array`.
- **Documentation corrected to match.** The README still described
  `sign()` as deterministic, `verify()` as cofactorless, "no test in this
  repository distinguishes the two behaviours", and the nonce mitigation as a
  reader's choice; all four statements were false as of the two commits
  above, and the README's own measured test count said 5 tests in a suite of
  12. Also refreshed the `src/lib.rs:NNN` references that the line shifts
  left behind, in `README.md`, `docs/api.md` and `docs/encoding.md`.

---

## 0.0.4 — the multi-prebuild loader (2026-09-18)

**The substantive change, and it has never been published.** The npm registry
still serves the pre-multi-prebuild artifact. See "0.0.4 as published" below
for the exact difference.

- **`b5d08d1` — `feat: package curve prebuilds by platform`.** Replaced the
  hand-rolled loader in `index.cjs` with `require('./native-loader.cjs')`, and
  `files` changed from `["index.cjs", "curve25519.linux-x64-gnu.node"]` to
  `["index.cjs", "native-loader.cjs"]`. Added the five `npm/<platform>`
  packages, the five matching `optionalDependencies` at `0.0.4`, and
  `napi.config.json` with exactly those five targets. Added
  `tests/platform-loader.test.cjs`.
  - The loader it replaced tried three filename candidates
    (`curve25519.<platform>-<arch>-{gnu,musl}.node`, then
    `curve25519.<platform>-<arch>.node`) against `process.platform` and
    `process.arch` only, and hard-coded `linux-x64-gnu` in its error message.
    It had no libc detection, so a glibc host and a musl host on the same
    platform/arch pair could not be told apart.
  - The replacement detects musl three ways in order
    (`native-loader.cjs:15-27`): `/usr/bin/ldd` contents, then
    `process.report.getReport()`, then `ldd --version` via `execSync`.
- **`f3a74ea` — `fix: generate curve native loader`.** Replaced the 22-line
  hand-written loader with the 782-line `@napi-rs/cli` generated one, so the
  platform dispatch is no longer maintained by hand.
- **`e13c20b` — `chore: omit generated platform readmes`.** Removed the
  per-platform `README.md` files that `b5d08d1` had added under `npm/`.
- **`8a78a1a` — `ci: build curve prebuild matrix`.** Added
  `.github/workflows/ci.yml` and `.github/workflows/release.yml` with the
  five-target matrix, and `tests/pack-install.test.cjs`.
- **`2356c2d` — `docs: document native platform support`.** Added the
  `engines` field.

### 0.0.4 as published — and why it is not this

Downloaded and read on 2026-09-29:

```text
$ tar tzf oktz-curve25519-0.0.4.tgz
package/index.cjs
package/package.json
package/curve25519.linux-x64-gnu.node
```

`files: ["index.cjs", "curve25519.linux-x64-gnu.node"]`, no
`optionalDependencies`, 3 files, 734 523 bytes unpacked. Its `index.cjs:16` is
`const native = require('./curve25519.linux-x64-gnu.node');` — one line, no
branch, no platform detection. `oktz-curve25519@1.0.0` is the same layout.

All five `@oktz-curve25519/curve25519-*` names return `404` from the registry.
The `optionalDependencies` in this tree therefore cannot resolve for anyone,
so publishing the main package as-is would produce an install that always
throws `Cannot find native binding` at `require()` time.

---

## Earlier

- **`dd7eaa6` (2026-08-30) — `feat(native/curve25519): Rust sign/verify 100%
  match (3806/3806)`.** Switched XEdDSA verification to `ed25519-dalek`
  (`Verifier::verify`) instead of a hand-rolled equation, and added
  `examples/verify_debug.rs` as the round-trip harness for that work. The
  3806 figure is the commit message's; the vectors it refers to are not in
  this tree and are not re-runnable here.
- **`319a0da` (2026-08-30) — the crate arrives.** Initial `Cargo.lock`,
  `src/lib.rs`, `build.rs`.
- **`c91774e` (2026-09-02) — `chore(audit)`.** Verify-bypass removal,
  `zeroize`, `execFile` hardening, loader platform detection, and dropping
  `javascript-obfuscator` from the build.

---

## Fixed in this tree, after 0.0.4

Documentation and CI only. No `Cargo.toml`, `npm/**` or `native-loader.cjs`
change is part of it, and no `src/**` change: the library fixes are the
`next` section above, and the two are not the same work.

- **`npm test` now works on Node 22.** It was `node --test tests/`, which on
  Node 22.23.3 fails with
  `Error: Cannot find module '…/native/curve25519/tests'` — the directory
  positional argument is treated as a file path. It is now
  `node --test tests/*.test.cjs`, a shell glob that resolves on Node 20 and
  Node 22 alike. This is the same trap, and the same fix, as the parent
  repository's `node --test tests/*.test.mjs`.
- **`tests/platform-loader.test.cjs` was asserting something impossible**, and
  failing. It called `curve.generateKeyPair(secret)` and then verified
  `curve.sign(secret, …)` against the returned public key — but
  `generateKeyPair` discards its argument (`index.cjs:32-47`; it delegates to
  `generateKeyPairSync('x25519')`), so the two keys are unrelated and
  `verify` correctly returned `false`. The test is now driven from the
  `private` the call returns, and it additionally pins the divergence: two
  calls with the same seed must produce *different* public keys. No library
  code was changed to make it pass — the behaviour it asserted was never the
  behaviour that existed.
- **`docs/verify.mjs` and `docs:verify`.** Every `js run` block in the
  documentation and every `examples/*.mjs` is executed and gated in CI.
- **CI actions pinned to commit SHAs**, a Node 20/22/24 matrix for the
  leg that actually loads the binary, and a status summary that separates
  "built" from "loaded".
- Added `README.md`, `docs/quickstart.md`, `docs/api.md`, `docs/encoding.md`
  and `examples/01`–`04`.

---

## Known issues, not fixed here

Recorded because they are properties of the code and a reader needs them. No
library source was modified for any of the six below — they are still open
after the `next` section above.

1. **The five platform packages are unpublished.** Every
   `@oktz-curve25519/curve25519-*` is a `404`. The layout this tree
   describes cannot work for an installed consumer.
2. **The version number does not describe the artifact.** `package.json` is
   still `0.0.4`, and `0.0.4` on npm is a single-prebuild package built before
   every entry in this file. There is no version under which the fixes above
   have been released, so a tree-based build and an `npm install` of the same
   version number are not the same program.
3. **`generateKeyPair(seed)` ignores `seed`.** The parameter is named `seed`,
   is validated as one, and is discarded (`index.cjs:29-31` says so in its own
   docstring). The published `0.0.4` has the identical function, so this is not
   a regression introduced by the multi-prebuild work.
4. **`ci.yml` and `release.yml` reference `native/curve25519/…` paths and run
   root `npm ci`.** That is the invocation convention of the enclosing
   `Onigi` repository. Copied out as a standalone repository the paths do not
   resolve and there is no root lockfile. Both workflows are therefore inert
   where they sit, because GitHub only reads `.github/workflows/` at a
   repository root.
5. **No `LICENSE` file in this directory**, while `package.json` declares MIT.
6. **No TypeScript definitions ship.** No `types` field, no `types` entry in
   `napi.config.json`, and a generated `.d.ts` would not be in `files`.

---

## Version map

| Version | On npm | In this tree |
|---|---|---|
| `0.0.4` | yes — single prebuild, no `optionalDependencies` | the multi-prebuild loader; the fixes above are **not** under this version |
| `0.0.4-native.1` | yes — a prerelease of the above | — |
| `1.0.0` | yes — same single-prebuild layout | — |
| next | **never published** | this tree |
