# Changelog

All notable changes to `oktz-curve25519`. This directory is vendored into the
`Onigi` repository and has its own CI (`.github/workflows/ci.yml` and
`release.yml`) and its own `napi.config.json`; the commits below are the real
ones from `git log -- native/curve25519`, and the file lists are the real
ones in this tree.

The Rust crate's own version is `0.1.0` (`Cargo.toml`); the npm package's is
`0.0.4`. They are independent.

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

Documentation and CI only. No `src/**`, `Cargo.toml`, `npm/**` or
`native-loader.cjs` change is part of it.

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
library source was modified.

1. **The five platform packages are unpublished.** Every
   `@oktz-curve25519/curve25519-*` is a `404`. The layout this tree
   describes cannot work for an installed consumer.
2. **`sign()` derives the nonce as `SHA512(sk ‖ m)` when none is supplied**
   (`src/lib.rs:54-60`), so it is deterministic. `oktz-signal` replaced the
   same derivation with a CSPRNG nonce precisely because of this
   (`native/signal/src/curve.rs:123-126`). Callers who want the property
   should pass a 64-byte `opt_random`. Not fixed here: the source is
   explicitly out of scope for documentation work, and changing the nonce
   derivation changes every signature this package produces.
3. **`verify()` uses the cofactorless check** (`vk.verify`, `src/lib.rs:183`)
   where `oktz-signal` uses `vk.verify_strict` (`native/signal/src/curve.rs:178`).
   No test distinguishes the two.
4. **`generateKeyPair(seed)` ignores `seed`.** The parameter is named `seed`,
   is validated as one, and is discarded (`index.cjs:29-31` says so in its own
   docstring). The published `0.0.4` has the identical function, so this is not
   a regression introduced by the multi-prebuild work.
5. **`ci.yml` and `release.yml` reference `native/curve25519/…` paths and run
   root `npm ci`.** That is the invocation convention of the enclosing
   `Onigi` repository. Copied out as a standalone repository the paths do not
   resolve and there is no root lockfile. Both workflows are therefore inert
   where they sit, because GitHub only reads `.github/workflows/` at a
   repository root.
6. **No `LICENSE` file in this directory**, while `package.json` declares MIT.
7. **No TypeScript definitions ship.** No `types` field, no `types` entry in
   `napi.config.json`, and a generated `.d.ts` would not be in `files`.

---

## Version map

| Version | On npm | In this tree |
|---|---|---|
| `0.0.4` | yes — single prebuild, no `optionalDependencies` | the multi-prebuild loader, unfixed since |
| `0.0.4-native.1` | yes — a prerelease of the above | — |
| `1.0.0` | yes — same single-prebuild layout | — |
| next | **never published** | this tree |
