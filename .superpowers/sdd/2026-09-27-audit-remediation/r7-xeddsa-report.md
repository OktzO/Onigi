# R7 — "XEdDSA is unsupported off linux-x64" is false, and avoidable

**Status:** fixed. One-line delegation to `oktz-signal`'s native `curveSign`/`curveVerify`.
**Commits:** `b3f0aa9` (RED test) → `43acf0d` (the fix) → `c14b443` (regression surface) → `cb877fc` (comment).
**Full suite:** `npm test` → **403 pass / 0 fail** (was 364 pass / 4 fail; the 4 `onWhatsApp`
failures were another agent's in-flight `lib/Socket/socket.js` work and are now resolved.
I added 37 test cases: 368 + 37 = 405 nominal, 403 actual, 0 failing.)
**Curve files only:** 64 pass / 0 fail across all seven `tests/curve-*.test.mjs`.

---

## 1. Independent verification of the reviewer's claim

I did not take the claim on faith. The reviewer asserted byte-compatibility from three
lines of output; three lines prove a happy path, not a delegation. I measured the full matrix.

### 1a. The prebuild inventory (the claim's premise) — CONFIRMED

| package | published prebuilds |
|---|---|
| `oktz-curve25519` 0.0.4 | `curve25519.linux-x64-gnu.node` only. No `optionalDependencies`, `require`d at the top level of `index.cjs:16`. |
| `oktz-signal` 0.3.0-rc.1 | `optionalDependencies` = `signal-linux-{arm64,x64}-{gnu,musl}`. |

`oktz-signal` is already a hard dependency (`package.json`) and already loaded at
`oktz-signal/index.js:4`. So the second implementation was in the dependency graph all along.

### 1b. Encoding facts the delegation had to respect — one is a trap

```
oktz-signal.curveVerify(33-byte 0x05-prefixed key)
  -> throws "wrong public key length: 33 (expected 32)"
```

`oktz-signal` takes the **32-byte** form. Passing the 33-byte wire form through
un-scrubbed **throws**, it does not verify. `verifySignature` already routes the public key
through `scrubPubKeyFormat` before any native call, so the delegation is fed the 32-byte
form. Had the delegation been written at the wrong layer it would have converted a
platform limitation into a total outage on *every* platform.

`curveSign(secret, message, random)` — third arg is `Option<Buffer>`. `null` → correctly
randomized nonce (verified: two calls on the same key+message produce different 64-byte
outputs). `Buffer.alloc(0)` → throws `wrong random data length: 0 (expected 64)`.
An empty 64-byte nonce buffer is accepted but deterministic, so it is never passed.

### 1c. Byte-compatibility, both directions — 300/300

300 random keypairs, message lengths cycling 0/1/2/15/32/33/64/100/255/1000:

```
oktz-curve25519.sign   -> oktz-signal.curveVerify  :  300 / 300 true
oktz-signal.curveSign  -> oktz-curve25519.verify    :  300 / 300 true
signature over a different message, cross-checked   :  300 / 300 false (both)
```

Signatures are randomized, so this compares **verification verdicts, never signature
bytes** — exactly as the task required. A test asserting byte equality would have failed
and taught us nothing.

### 1d. Reject agreement — 49 cases, **0 divergences**

Not "does it reject", but "does it reject *the same way*". I compared the return value
**and** the throw/no-throw decision for each case. Divergence count: **0**.

| class | cases | result |
|---|---|---|
| malformed pubkey lengths 0,1,2,31,33,34,64,65 | 8 | both throw |
| `0x05`+all-zero, `0x05`+0xff | 2 | both throw |
| wrong version byte 0,1,4,6,255 | 5 | both return `false` |
| signature truncations 0,1,2,31,32,33,63 | 7 | both throw |
| signature 65 bytes | 1 | both throw |
| all-zero / all-ff 64-byte signature | 2 | both return `false` |
| bit flip at bit 0, bit 63 | 2 | both return `false` |
| signature over a different message | 1 | both return `false` |
| signature from a different key | 1 | both return `false` |
| low-order points (6, incl. identity, order-2, order-4, order-8, p-1, p) | 6 | both return `false` |
| `null` / `undefined` pubkey, msg, sig | 6 | both throw |
| `string` / `number` / `array` pubkey, msg, sig | 9 | both throw |
| `Uint8Array` msg, empty msg, happy path | 3 | both `true` |

Only the **error message text** differs (`"wrong public key length: 33 (expected 32)"` vs
`"wrong public key length"`). The verdict and the throw/return decision are identical, and
`lib/Utils/crypto.js` collapses every throw to `false` anyway, so the boundary behaves
identically.

### 1e. Degenerate secret keys

All-zero, all-ff, `01` followed by 31 zeros, and random secrets: both sign, both
cross-verify, and both reject a forgery. Agreement holds for degenerate scalars, not just
well-formed ones.

### 1f. DH byte-exactness (task item 4)

500 random keypairs, `node:crypto` agreement vs the native `sharedKey`:
**500 / 500 byte-identical**, 0 all-zero shared secrets.

**Verdict: the reviewer is correct, and the delegation is safe.**

---

## 2. Approach and why

`lib/Modded/curve-native.js` now loads **two** native bindings in independent
`createRequire` + `try/catch` blocks, and dispatches XEdDSA to the first that exists.

- **`oktz-signal` first**, as instructed. Beyond the broader prebuild coverage, preferring
  it means the delegated path is the one exercised on `linux-x64`, so CI actually tests it.
  Preferring `oktz-curve25519` would have left the delegation completely untested on any
  platform I can run.
- **`oktz-curve25519` second**, so an install with its prebuild keeps the path that was
  already proven. The chain fails closed, ending in the typed throw.
- **Keygen and DH untouched.** `oktz-signal`'s `curveGenerateKeypair` has a different
  contract, and `node:crypto` is already proven byte-exact (500/500). The finding is about
  XEdDSA; the change stays that narrow.

### Loaded via the CJS subpath, not the package

`require('oktz-signal')` works on this Node 22.23 (`require(esm)`), but the package declares
`engines: node >=20.0.0` and `require(esm)` only landed in **20.19 / 22.12**. Relying on it
would have made "supported" quietly depend on the Node minor version. `require('oktz-signal/native/signal/index.cjs')`
is plain CJS and works on every supported Node. The package has no `exports` map, so the
subpath resolves; and `lib/Signal/Group/group_cipher.js:1` already deep-imports
`oktz-signal/src/crypto.js`, so this is an established pattern here, not a new one.

The shape of the binding is checked, not just its existence (`typeof … === 'function'` for
both), so a binding that loads without its XEdDSA functions fails closed rather than
producing a `TypeError` deep in a request path.

**No new runtime dependency.** `oktz-signal` is already in `dependencies` and already loaded.

---

## 3. RED

`tests/curve-xeddsa-delegation.test.mjs` reproduces the regressed platform: `oktz-curve25519`
redirected at a copy with no `.node` beside it, `oktz-signal` fully present. Before the fix:

```
ok 1  - the reproduction is oktz-curve25519 without a prebuild, with oktz-signal present
not ok 2  - calculateSignature produces a real signature with no oktz-curve25519 prebuild
  error: 'XEdDSA sign/verify is unavailable on linux-x64: the oktz-curve25519 prebuild
          could not be loaded. Only curve25519.linux-x64-gnu.node is published and
          node:crypto has no XEdDSA, so this platform is unsupported for signing...'
not ok 3  - verifySignature accepts a signature made on a prebuild-less oktz-curve25519
not ok 4  - verifySignature still rejects a forged signature on that platform
not ok 5  - Curve.sign/Curve.verify round-trip, so pairing is possible again
not ok 6  - a signature from a different key is still rejected
not ok 7  - signedKeyPair works, so pairing is not blocked by a missing prebuild
not ok 8  - group send signing works: getSignature is Curve.sign over the 33-byte public key
not ok 9  - a native-install signature is byte-compatible with a prebuild-less one
not ok 10 - the noise handshake no longer sees a false "invalid certificate"
# tests 10   # pass 1   # fail 9
```

Every failure traces to the single `xeddsaUnavailable()` throw, and the failure text names
the defect: *"this platform is unsupported for signing"*, on a platform that can sign.

---

## 4. The change

### `lib/Modded/curve-native.js`

- loads `oktz-signal/native/signal/index.cjs` alongside `oktz-curve25519`, each in its own
  `try/catch`, shape-checked;
- `xeddsaSign` / `xeddsaVerify` prefer `signalNative.curveSign/curveVerify`, fall back to
  `native.sign/verify`, and throw `XEdDsaUnavailableError` only when neither exists;
- `calculateSignature` / `verifySignature` no longer branch on `!native`. **Argument
  validation still runs first**, so a malformed key is still an ordinary `Invalid public key`
  rejection and is never reported as a broken platform (pinned by a test);
- new exported `XEdDsaUnavailableError` with `name` and `code: 'ONIGI_XEDDSA_UNSUPPORTED'`.

### `lib/Utils/crypto.js`

```js
-const isXEdDsaUnsupported = (error) => /XEdDSA sign\/verify is unavailable/.test(error?.message || '');
+const isXEdDsaUnsupported = (error) => error?.code === 'ONIGI_XEDDSA_UNSUPPORTED';
```

The reviewer's string-matching fragility is gone. Classification is now a **code**, which a
reworded message cannot break. Duck-typed rather than `instanceof` on purpose: `curve-native.js`
can legitimately be loaded more than once in one process, and each copy would get a distinct
class object. `Curve.verify` remains fail-closed and never throws.

---

## 5. GREEN

### Delegation (the regression itself)
```
ok 1  - the reproduction is oktz-curve25519 without a prebuild, with oktz-signal present
ok 2  - calculateSignature produces a real signature with no oktz-curve25519 prebuild
ok 3  - verifySignature accepts a signature made on a prebuild-less oktz-curve25519
ok 4  - verifySignature still rejects a forged signature on that platform
ok 5  - Curve.sign/Curve.verify round-trip, so pairing is possible again
ok 6  - a signature from a different key is still rejected
ok 7  - signedKeyPair works, so pairing is not blocked by a missing prebuild
ok 8  - group send signing works: getSignature is Curve.sign over the 33-byte public key
ok 9  - a native-install signature is byte-compatible with a prebuild-less one
ok 10 - the noise handshake no longer sees a false "invalid certificate"
# tests 10   # pass 10   # fail 0
```

### All curve files
```
# tests 64   # pass 64   # fail 0
```

### Full suite
```
1..403
# tests 403
# pass  403
# fail  0
```

A normal `import('./lib/index.js')` now emits **no warning at all** — the
"unsupported platform" warning that used to fire spuriously is gone on a supported platform.

---

## 6. What is supported, and what is not

### Supported for X25519 keygen, DH, and XEdDSA sign/verify

| platform | before | after |
|---|---|---|
| `linux-x64` (gnu + musl) | supported | supported (now via `oktz-signal`, byte-identical) |
| **`linux-arm64` (gnu + musl)** | **broken — hard throw** | **supported** |
| any other linux arch (`arm`, `ppc64`, `s390x`, `riscv64`, `loong64`) | `oktz-curve25519` prebuild absent; `oktz-signal` publishes none | unchanged — see below |

Keygen and DH were already fixed by `aa82b8e`'s `node:crypto` fallback and are unaffected by
this change; they work on **every** platform Node itself runs on, including darwin and win32.

### Still unsupported: `darwin` and `win32`

This is the residual limitation, stated plainly rather than papered over. Neither package
publishes a prebuild for them, so `xeddsaSign` / `xeddsaVerify` end in
`XEdDsaUnavailableError`. The guarantee that survives is the one that matters: **a loud throw,
never a fabricated signature and never a verdict that was not computed.** Pinned by
`tests/curve-xeddsa-unsupported.test.mjs`.

**And the honest caveat:** on darwin and win32 the library does not load at all, before
`curve-native.js` is ever consulted. `lib/Signal/libsignal.js:2` opens with a **static**
`import * as libsignal from 'oktz-signal'`, and `oktz-signal/index.js:4` `require`s its
binding at module scope. I verified this directly: with the `oktz-signal` binding redirected
at a prebuild-less copy, `import('./lib/Utils/crypto.js')` and `import('./lib/index.js')` both
throw `Cannot find native binding`. So darwin/win32 support requires making that import
lazy — a change in `lib/Signal/**`, **outside this finding's ownership** and not attempted
here. This also explains *why* the old warning was unavoidable-looking: on every platform
where `lib/Utils/crypto.js` could still load, an XEdDSA implementation was reachable.

### On the misleading `noise certificate signature invalid`

On `linux-arm64` — the platform this finding is about — `noise-handler.js:180` no longer
produces the misleading Boom for a well-formed certificate, because `Curve.verify` now
returns a real verdict. That is the fix.

For a genuinely unsupported platform (darwin/win32), `noise-handler.js:183` still emits the
same `noise certificate signature invalid` for "I cannot verify" and for "this signature is
forged". **I did not fix that**, because `noise-handler.js` is outside this finding's
ownership. What I could do within scope, and did:

- the condition now carries a distinct `code` (`ONIGI_XEDDSA_UNSUPPORTED`) instead of being
  inferable only from prose, so the layer above can tell the two apart without string
  matching;
- it is reported once per process, naming the platform, through a warn channel that
  `crypto.js` owns;
- it is no longer reachable on any platform where the library loads at all.

Distinguishing the two conditions *at the Boom* needs an edit to `noise-handler.js` and should
be filed as its own finding. Flagging it rather than leaving it implied.

---

## 7. Tests

| file | before | after | what it now pins |
|---|---|---|---|
| `tests/curve-xeddsa-delegation.test.mjs` | — | 10 | **the R7 regression**: no `oktz-curve25519` prebuild, signing/verification/pairing/group-send/noise-cert all work |
| `tests/curve-xeddsa-dispatch.test.mjs` | — | 7 | a **counting proxy** proves `oktz-signal` is the code path actually taken, not a comment's claim; 300 keypairs both directions; degenerate keys; `oktz-curve25519` still usable as source two |
| `tests/curve-xeddsa-unsupported.test.mjs` | — | 7 | the residual case: loads anyway, keygen/DH work, XEdDSA throws loudly and typed, validation still runs first |
| `tests/curve-verify.test.mjs` | 6 | 13 | **56 adversarial inputs** → `false`, never throwing; genuine match `true` for 32- and 33-byte forms; 200 random round trips; DH vs `node:crypto` |
| `tests/curve-verify-diagnosis.test.mjs` | 4 | 7 | unsupported case now reproduces with **both** bindings stripped; typed error asserted; classification is code-based |
| `tests/curve-platform-fallback.test.mjs` | 10 | 13 | same keygen/DH fallback plus the delegation; 100-pair DH byte-exactness against the native module |

No existing assertion was weakened. Four assertions in
`curve-platform-fallback.test.mjs` and one in `curve-verify-diagnosis.test.mjs` asserted that
a prebuild-less `oktz-curve25519` is an unsupported platform. That premise is the defect, so
those conditions were **moved to the state that is actually unsupported** (both bindings
missing) with every guarantee intact — `instanceof Error`, `/XEdDSA/i`, platform named, throws
rather than returns, fail-closed — plus assertions for the newly-typed error. The
original conditions now assert the stronger property: that the platform works.

One simulation artifact, documented in the test: the diagnosis test strips the `oktz-signal`
binding only for the subpath `curve-native.js` requires, not for the relative require inside
`oktz-signal/index.js`. Stripping both would stop `lib/Utils/crypto.js` loading at all, so
this is the only way to reach the warn channel. `curve-xeddsa-unsupported.test.mjs` covers the
`curve-native.js` boundary without the artifact.

## 8. Housekeeping

- Only `lib/Modded/curve-native.js`, `lib/Utils/crypto.js` and `tests/curve-*.test.mjs` were
  modified. `lib/Socket/**`, `lib/Signal/**`, `lib/WABinary/**`, `lib/WAM/**` and all `.d.ts`
  were left alone; the dirty entries in `git status` are another agent's in-flight work.
- `stash@{0}: On rc/10.1.0: lid-wip` untouched. `git stash` never run.
- No new runtime dependency.
