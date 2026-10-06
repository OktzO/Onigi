# Changelog

All notable changes to `oktz-curve25519`. This directory is vendored into the
`Onigi` repository and has its own CI (`.github/workflows/ci.yml` and
`release.yml`) and its own `napi.config.json`; the commits below are the real
ones from `git log -- native/curve25519`, and the file lists are the real
ones in this tree. The seven hashless bullets in the `next` section below are
the ones in the commits that write this file: a commit cannot contain its own
hash, so those seven are identified by subject rather than by identifier.

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
  `vk.verify`. That equation accepts a forgery whenever the public key is a
  small-order point: `u = 0` converts through `MontgomeryPoint::to_edwards` to
  the Edwards order-2 point `(0, -1)`, and there `R = A, S = 0` satisfies
  `[S]B = R + [k]A` for about **half** of messages, not for every message: `k`
  has to be odd, because that `A` is its own inverse. Letting `R` range over all
  eight low-order points still covers only about three quarters of messages. No
  secret is needed for any of it: a caller handed a bogus 32-byte "public key"
  could get `true` back for a signature nobody signed, by choosing a message and
  retrying until one lands. `verify` now calls `vk.verify_strict`
  (`src/lib.rs:206`), which rejects a small-order `R` and a weak `A`.
  `oktz-signal` has been strict at the same point all along
  (`native/signal/src/curve.rs:175-178`, in that crate's checkout, which this
  repository does not vendor); the two implementations have to agree,
  because callers fall back between them. Added
  `tests/loworder-forgery.test.cjs`, which asserts `false` for exactly that
  forgery under four messages.
- **`958c3a5` — `fix(curve): draw the XEdDSA nonce from a CSPRNG instead of
  SHA512(sk‖m)`.** With no third argument, `sign` derived the nonce as
  `SHA512(sk ‖ m) mod L` — a deterministic function of the secret key. With
  `sk` fixed, `S = r + h·a` is affine in the nonce, so two signatures over
  chosen messages give enough equations to recover `a`: the
  hidden-number-problem lattice attack documented at
  `native/signal/src/curve.rs:123-126` (in that crate's checkout, which this
  repository does not vendor). The `None` arm now fills a 64-byte
  buffer from `getrandom` (`src/lib.rs:113-121`). A CSPRNG failure propagates
  out of `sign` rather than falling back to a predictable nonce, so
  `sign_internal` returns `Result` (`src/lib.rs:93`) — and there is no code
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
  (`src/lib.rs:103`, `src/lib.rs:118`, `src/lib.rs:127`, `src/lib.rs:132`)
  rather than zeroized by hand at chosen points, which makes the wipe
  unconditional on every exit path — including the CSPRNG error return the
  previous entry added. `h` and `s` are wrapped too, though neither is secret
  (`h = SHA512(R ‖ A ‖ m)` over public values, `S` is published in the
  signature); the rule is uniform rather than per-variable. The arithmetic is
  written `&*r + &*h * &*a`, not `*r + *h * *a`, because `Scalar` is `Copy` and
  the by-value form would copy the secrets back out of the guarded buffers. No
  observable behaviour change — the 48-signature explicit-`rnd` grid above was
  re-measured against a build of `0bd9500` and is byte-identical — and the note
  at `src/lib.rs:209` records what is deliberately *not* covered: dalek's
  internal limb temporaries, the unwiped `h·a` product, and the caller-owned
  `Uint8Array`. Two residues that note records are actual secret bytes, and
  neither can be closed from this crate: `Scalar::from_bytes_mod_order` takes its 32
  bytes by value, so the deref at `src/lib.rs:103` materialises an unwiped
  `[u8; 32]` of the clamped secret for the duration of that call (dalek offers
  no `&[u8; 32]` constructor), and the `Sha512` state in `nonce_rnd` absorbs `sk`
  at `src/lib.rs:63` and is dropped unwiped, because sha2 0.10.9 implements
  neither `Drop` nor `Zeroize` anywhere.
- **Documentation corrected to match.** The README still described
  `sign()` as deterministic, `verify()` as cofactorless, "no test in this
  repository distinguishes the two behaviours", and the nonce mitigation as a
  reader's choice; all four statements were false as of the two commits
  above, and the README's own measured test count said 5 tests in a suite of
  12. Also refreshed the `src/lib.rs:NNN` references that the line shifts
  left behind, in `README.md`, `docs/api.md` and `docs/encoding.md`. Two
  follow-ups in this commit: every citation of
  `native/signal/src/curve.rs` — a file that is not vendored in this
  repository — now says so rather than leaving the line number looking
  verifiable here, and `examples/verify_debug.rs` calls `verify_strict` rather
  than the cofactorless `Verifier::verify`.
- **Three more secret-equivalent buffers are now zeroized, and the note's scope
  was wrong.** The criterion the previous entry used — "derived from the secret"
  — is weaker than the one that matters: a buffer is secret-equivalent if
  whoever holds it can recover `a` from the public `S = r + h·a`, given
  `r = SHA512(...) mod L`. Three buffers passed the weaker test and were
  therefore missed: the `SHA512` digest in `nonce_rnd` (`src/lib.rs:66`), the
  CSPRNG nonce `generated` (`src/lib.rs:113`), and the caller-supplied
  `opt_random` nonce `rnd` (`src/lib.rs:159`). Each is a preimage of `r`, so
  each is as sensitive as `a`, and the note's own claim that `generated` was
  "not secret" was wrong for exactly that reason. All three are now in
  `Zeroizing`; `digest` in `challenge` (`src/lib.rs:83`) is wrapped too, though
  every input to it is public, so that the rule has no exceptions to remember.
  This is a fix in code, not another disclosure: `from_bytes_mod_order_wide`
  takes `&[u8; 64]`, so wrapping the digest costs nothing and the residue is
  gone. `rnd` is caller-supplied, but so is `sk` at `src/lib.rs:164` and that was
  already wrapped, so treating them differently would have been the
  inconsistency. Two further corrections fall out of the same finding. The
  note's "inside dalek" wording stopped one crate short: the `Sha512` state is
  the second secret-bearing buffer this crate cannot reach, and it is in sha2,
  so the sentence now covers both dependencies. And the two superlatives that
  called the by-value argument slot *the* one secret-bytes residue have been
  retracted — there are two, and `src/lib.rs` and `README.md` now say so. Still
  no behaviour change: the 48-signature explicit-`rnd` grid re-measured against
  a build of `69df139` is byte-identical, `npm test` is 12, and `docs:verify` is
  20 blocks + 4 examples with 0 failures.
- **`clamp_scalar` no longer copies the secret at all, and the criterion that let
  that through now asks a second question.** `clamp_scalar` took `&[u8; 32]` and
  returned `[u8; 32]`, so `src/lib.rs` did two by-value copies of the key on every
  call: `let mut a = *sk;` put the **unclamped** key into a local no `Zeroizing`
  covered, and returning `a` copied it out again into the caller's guard.
  `clamp_scalar` now takes `&mut Zeroizing<[u8; 32]>` and clamps in place;
  `sign_internal` takes that buffer by `&mut` (`src/lib.rs:94`) and `sign` creates
  it at `src/lib.rs:164`. The 32-byte secret now enters this crate into a guard
  once, and the **unclamped** copy is never materialised anywhere else. That is
  a fix in code, not a fifth disclosure — the previous entry's *"Yang benar-benar
  secret dan TIDAK bisa dihindari dari sini: DUA"* stays two (at this round; see
  the entry below for the count it became), and `clamp_scalar`
  is no longer one of them. An earlier draft of this sentence went further and
  said the secret "is never copied again", which was false: the by-value argument
  slot at `src/lib.rs:103` is exactly such a copy, as this same bullet records
  above. The corrected phrasing is the checkable one — a claim about
  `clamp_scalar` and about which bytes exist, not about a copy count. The
  criterion in `src/lib.rs` was rewritten to be two mandatory
  questions rather than one. The first is unchanged: is the buffer
  secret-equivalent, i.e. would whoever holds it be able to recover `a` from the
  public `S`? The second is new, and it is the one that was missing: **every
  by-value argument and every by-value return on the signing path is a copy of
  material into memory this crate does not wipe, whatever its type**, so it
  counts the same as a buffer. (Worded as *material*, not *secret*: public by-value
  returns such as `base_mult_scalar`'s `A` and `s.to_bytes()`'s `S` are copies
  too, and the secret-equivalence question is a separate gate that keeps them out
  of the residue list.) That is not a derivation question, which is
  exactly why the first test could not see `clamp_scalar`: it would have passed
  it silently. Three shapes are now called out by name, because each has to be
  looked for separately — (a) a `let` that initialises an unguarded local from
  guarded material, plus the by-value return that reads it; (b) a by-value
  argument forced by a dependency, whose copy lands in the callee's frame where
  no guard here can reach it; (c) a by-value temporary born of a by-value return
  and then read by something else.
  Re-running the extended criterion over the whole signing path found one residue
  that no list had, and named rather than missed it: the `GenericArray<u8, U64>`
  temporary that `h.finalize().into()` created at `src/lib.rs:66` —
  `FixedOutput::finalize_fixed` allocates `out` and returns it by value, so the
  digest (a preimage of `r`, i.e. secret-equivalent) existed in an unwiped slot
  before `.into()` put it in the guard. Its twin at `src/lib.rs:83` is the same
  code over public inputs. (That residue is gone as of the next entry, which is
  why the sentence here still describes the old shape.) The note also records
  two things that a re-run has to check rather than assume: `finalize_fixed_reset`
  does **not** close the sha2 residue, because `digest_pad`
  (`block-buffer-0.10.4/src/lib.rs:290`) only zeroes bytes *after* the block
  position and `BlockBuffer::reset` (line 180) only rewinds that position, so the
  raw `sk` bytes are still in the block buffer when the hasher is dropped; and
  `Zeroizing` cannot wrap a `GenericArray` here, because `generic-array`'s
  `zeroize` feature is not enabled. Four things the same sweep cleared, all of
  which had to be cleared rather than assumed: the temporaries inside
  `base_mult_scalar` (`p`, `CompressedEdwardsY`) are `a·B` and `A`, both public;
  napi 3.12.2 borrows the caller's `Uint8Array` through
  `napi_get_typedarray_info`, so this crate does not own that memory — though it
  does copy out of those views into guards at `src/lib.rs:162` and `:164`, which
  the sweep counted rather than assumed away; `verify` holds no secret buffer, because everything it takes is already
  public; and the clamping is applied, not skipped — 24 key pairs differing only
  in the clamped bits produce identical signatures, and the three golden vectors
  in `tests/nonce-randomness.test.cjs` (whose keys clamp three different ways)
  still pass. No behaviour change: 848 explicit-`rnd` signatures are byte-identical
  to `7714bf8` — the 48-signature grid above, a 768-signature grid over 32
  arbitrary mostly-unclamped keys × 3 nonces × 8 messages, and 32 signatures over
  deliberately dirty clamp bits compared against `oktz-signal`'s independent
  native `curveSign` — plus 96 cross-implementation verify checks, both
  low-order-forgery probes still rejected, and identical error messages.
  `npm test` is 12 and `docs:verify` is 20 blocks + 4 examples with 0 failures.
- **The `GenericArray` digest temporary is gone rather than disclosed, and the
  escape clause that waved it through no longer exists.** The previous entry
  named the `GenericArray<u8, U64>` that `h.finalize().into()` created at
  `src/lib.rs:66` and then labelled it unavoidable, on the grounds that sha2
  copies the digest internally on every finalisation path anyway. That was the
  wrong call twice over. The copy sha2 makes is `full_res`, allocated in
  `CtVariableCoreWrapper::finalize_fixed_core`; the `out` that
  `FixedOutput::finalize_fixed` allocates (digest-0.10.7/src/lib.rs:99-103,
  `let mut out = Default::default(); self.finalize_into(&mut out); out`) has its
  *value* moved into the caller, so it belonged to this crate, not to sha2 — and
  three documents credited it to sha2. And "sha2 does it anyway" is a reason a
  residue cannot be eliminated, not a reason not to remove ours. `nonce_rnd` now
  allocates the guard first and finalises straight into it:
  `h.finalize_into_reset(GenericArray::from_mut_slice(&mut digest[..]))`
  (`src/lib.rs:66-67`), so no unwiped slot in this crate's frame is ever
  created. `sha2::digest::generic_array` is a re-export, so `Cargo.toml` is
  unchanged and `generic-array` was **not** added as a dependency;
  `Zeroizing<GenericArray<u8, U64>>` is still unavailable, which is why the fix
  borrows the guard's own `&mut [u8]` instead.
  Three claims that went with the disclosure are corrected rather than kept:
  - The criterion's escape clause (`src/lib.rs:247`) used to read *"...atau
    salinannya memang tidak bisa dihindari lalu dicatat"*, which is
    unfalsifiable — it can be satisfied by asserting a fact. It now requires the
    impossibility to be **demonstrated by naming the absent alternative**, and
    gives the one legitimate use: dalek has no constructor taking `&[u8; 32]`.
    A criterion satisfiable by assertion is what let this residue through.
  - `src/lib.rs` said the product `h·a` was the only thing leaving its buffer.
    It is not: `src/lib.rs:132` has two by-value returns, the product and then
    the sum via `Add<&Scalar> for &Scalar`. Both are public-derived, so neither
    is a residue, but the count was wrong.
  - The residue entry at `src/lib.rs:281-286` told a reader that an unwiped
    `[u8; 32]` exists, with no indication of the standard being asserted. It now
    says so in the shipped text: the claim is **source-level, deliberately, and
    makes no assertion about codegen** — whether a given build's optimiser
    elides that copy is a fact about one rustc/opt-level/target and is not
    something this file pins. That standard used to live only in the commit
    report, which is not where a reader looks.
  The README headline changed with it. "Secret keys are zeroized, in every
  representation the signing path materialises" was contradicted by the same
  bullet: the by-value argument slot at `src/lib.rs:103` is a representation the
  signing path materialises and does not zeroize. It then read "Every buffer this
  crate itself materialises and keeps is wrapped in `Zeroizing`", justified here
  as a claim about ownership rather than about a count — which was wrong twice
  over: dropping "secret" *widened* the quantifier rather than narrowing it, and
  the justification claimed the sentence "stays true whatever the count comes out
  as" when it does not. It is now "Every *secret-equivalent* buffer this crate
  materialises and keeps is wrapped in `Zeroizing`", and that holds: the buffers
  it leaves out are public (`a_bytes`, `r_bytes`, `s_bytes`, `sig`) and are listed
  with reasons at `src/lib.rs:267`. The correction is spelled out in the entry
  below.
  The count of genuinely-secret-and-not-avoidable-from-here was **two** at this
  round — two for a different reason than last time, and the second item smaller.
  (Superseded by the entry below: it is now two *items* covering four allocation
  sites, because dalek's `UnpackedScalar` was missing from the enumeration.)
  The `:103` by-value argument slot is unchanged: ours to place, dalek's to accept,
  and dalek offers no `&[u8; 32]` constructor to place it in instead. The second
  item was previously "sha2's block buffer plus its finalisation buffers", and
  that second half was wrong in two ways at once — it was half ours, and it
  mixed two different allocations. It is now only the two allocations that are not
  ours at all: sha2 0.10.9's block buffer that still holds `sk`, and `full_res` in
  `CtVariableCoreWrapper::finalize_fixed_core` (which is `digest` 0.10.7's generic
  code, `src/core_api/ct_variable.rs:119`, monomorphised for sha2's core), which is
  on the path this fix now
  takes — `CoreWrapper::finalize_into_reset` (wrapper.rs:183-189) calls
  `finalize_fixed_core` and then only adds `core.reset()`/`buffer.reset()`. So
  the fix does not remove `full_res`; it removes the part that was removable.
  No behaviour change: the full byte-identity grid was re-run against this
  round's base `9a17675` and against `7714bf8` two rounds back, and 848
  explicit-`rnd` signatures are byte-identical to both, plus 32 of them also
  identical to `oktz-signal`'s independent native `curveSign`, 96
  cross-implementation verify checks, 24 clamp-invariance pairs, both
  low-order-forgery probes still rejected, and identical error messages.
  `npm test` is 12 and `docs:verify` is 20 blocks + 4 examples with 0 failures.
- **The zeroization note is collapsed instead of extended, and three false
  superlatives and one over-broad headline go with it.** Every round so far found
  one more false superlative in prose. That is the failure mode, so this round
  removes prose rather than adding it: the note at `src/lib.rs:209` goes from 196
  lines to 135, and the duplication is gone rather than trimmed. Specifically,
  the introduction no longer restates the criterion the next section states, and
  the old "Batasnya, jujur" section — which re-derived the sha2 residues that the
  numbered enumeration then re-derived again — is deleted, its unique content
  folded into that single enumeration. No earned distinction was dropped: the
  source-level standard, the escape clause and the `GenericArray` post-mortem
  that earned it, the three shapes of by-value copy, the `E0369` reason there is
  no hidden by-value spelling, and the two unwiped `Scalar` temporaries at
  `src/lib.rs:132` all survive, each now stated exactly once.
  - **The README headline was a broader false claim than the one it replaced.**
    "Every buffer this crate itself materialises and keeps is wrapped in
    `Zeroizing`" dropped "secret", which *widened* the quantifier, and it is
    contradicted by `sig` (`:135`), `a_bytes` (`:105`), `r_bytes` (`:124`) and
    `s_bytes` (`:133`), and by this crate's own note ("PUBLIK, jadi sengaja tidak
    dibungkus"). It now reads "Every *secret-equivalent* buffer this crate
    materialises and keeps is wrapped in `Zeroizing`", and the previous entry's
    justification for it — that it "stays true whatever the count comes out as" —
    was false and is retracted above.
  - **`UnpackedScalar` is now counted.** dalek's `Scalar::unpack()`
    (`scalar.rs:1119`) holds the limbs of `a` and of `r`, has no wipe, and
    dalek 4.1.3 has no `impl Drop` anywhere; it was named in prose but excluded
    from the count, which made "two" read as exhaustive when it was not. It is
    the same shape as the `:103` argument slot — our expression causes it, a
    callee API forces it, there is no alternative spelling — so it sits under
    item 2, "Yang di dalam DEPENDENCY", as sub-entry **2(a)**: item 1 is the one
    allocation that is ours to place, and this one is in dalek's frame. The
    enumeration is now stated as
    **two items covering four allocation sites** at this round — a count that the
    entry below revises again — and the two earlier entries that say "two" carry
    a forward pointer rather than being rewritten.
  - **`src/lib.rs:297-302`'s worked example no longer rests on a signature nobody
    read.** It claimed dalek's "two constructors (scalar.rs:237 and :250) are
    both positional"; `:250` is `from_bytes_mod_order_wide(input: &[u8; 64])`, a
    *reference*, and 64 bytes — the `grep` had matched it as a prefix of
    `from_bytes_mod_order` — and the enumeration also missed the third by-value
    constructor, `from_canonical_bytes([u8; 32])` at `:261`. The load-bearing
    claim (no `&[u8; 32]`-taking constructor exists) is true and item 1 survives,
    but the false sentence was the whole evidence for it, in the direction that
    makes the argument look stronger than it is. It now names all three
    signatures and the one that is absent.
  - **"Every by-value argument and return is a copy of secret bytes" → copy of
    *material*.** False: `base_mult_scalar` returns public `A` by value,
    `s.to_bytes()` returns public `S` by value, and `MontgomeryPoint(*pk)` builds
    by value. It also contradicted this file's own "PASS BY-REFERENCE" list, which
    files `s.to_bytes()` there. Secret-equivalence is stated as the second gate
    that keeps those out of the residue list.
  - **"This crate never copies the caller's bytes at all" → it does, twice.**
    `src/lib.rs:162` and `:164` copy out of the borrowed `&[u8]` views napi
    hands over, which this note's own enumeration already admitted two lines
    below the denial. napi borrows; this crate does not own that memory; it does
    copy out of it, into guards, and those two copies are counted.
  - **Two stale citations, comment-only.** `examples/verify_debug.rs:58` said
    `src/lib.rs:201` (the start of the comment explaining the choice) where the
    choice is made, `src/lib.rs:206`. `tests/nonce-randomness.test.cjs:34` said
    `src/lib.rs:57-58` where the nonce domain separation is `src/lib.rs:61-62`;
    that file is the oracle carrying the three `curve25519-js@0.0.4` /
    `oktz-signal` vectors, and its comment is the maintenance instruction naming
    the lines that define the nonce domain separation, so a stale pointer there
    misdirects whoever edits the one thing that breaks libsignal compatibility.
    One comment line each; no executable line in either file changed.
  - **Citation renumbering, and one fix to the checker that was measuring the
    wrong thing.** The note moved, so every pointer into it moved:
    `src/lib.rs:257` → `:322`, `:367` → `:281-286`, `:332` → `:247`, and `:209`
    still resolves to the note's first line. Re-checked over all eight citing
    files: 105 citation occurrences, of which 94 name this crate's `src/lib.rs`
    and all 94 are in range with 0 out of range; the other 11 name another
    crate's file and are now resolved against the real file on disk rather than
    range-checked against ours, which is what the old checker did — that flaw is
    why `zeroize-1.9.0/src/lib.rs:696` had been reported as an out-of-range hit
    on this crate. 9 of the 11 resolve and are correct; the other 2 are the same
    citation seen twice, `docs/api.md`'s `native/signal/src/lib.rs:40-45` plus
    this entry's reference to it, which points into `oktz-signal`'s crate, is not
    vendored here, and now says so in place.
  - **No behaviour change, and the binary proves it.** The rebuilt
    `libcurve25519_rs.so` is byte-identical to the `.node` this tree shipped
    before this round — sha256
    `ac73a9a17fbf0ee6649c1f134e44c5f499a5a5f220a8a49f7e05c7bd48836f79` — so
    the comment and prose edits changed no code path at all. The 936-signature
    explicit-`rnd` grid is byte-identical both to the pre-change baseline and to
    the grid recorded for `aa029fb`, 0 differing bytes, and all three golden
    vectors reproduce. `npm test` is 12 and `docs:verify` is 20 blocks +
    4 examples with 0 failures.
- **The rejection surface is pinned where a reader meets it, the two
  implementations are pinned against each other, and the residue note stops
  claiming a count it cannot support.** Three separate things, no library
  behaviour change.
  - **The low-order-key forgery is in the measured rejection list, not only in a
    test.** `examples/02-rejection.mjs` now runs it — an all-zero public key with
    `R = A, S = 0`, under three messages — and asserts `false` beside the other
    rejections. The 32 bytes of `R` are derived in the file's comment from
    `(0 − 1)/(0 + 1) = −1 mod (2²⁵⁵ − 19)` rather than pasted. This is the
    rejection on that list where "returns `false`" is the security property
    rather than a convenience, and it is the one the disclosure discussed in
    prose while the measured list omitted.
  - **A test proves this crate and `oktz-signal` agree.** The last case in
    `tests/platform-loader.test.cjs` loads
    `oktz-signal/native/signal/index.cjs` through `createRequire`, asserts that
    both implementations reject that same forgery, and then checks each one
    against the other's signatures — byte-identical output on a pinned 64-byte
    nonce, and verified in both directions over three keys that clamp three
    different ways. It skips, printing the reason, if the optional prebuild is
    absent, so a missing prebuild cannot fail the suite; it was verified both ways
    round, by making `oktz-signal` resolve to nothing (skip, 0 failures) and by
    making it resolve to a stand-in with the cofactorless behaviour (fail).
    Nothing in this repository did that check before, and that is exactly how the
    `verify_strict` fix went unnoticed: `tests/curve-xeddsa-delegation.test.mjs`
    blocks `oktz-curve25519` resolution outright, and
    `lib/Modded/curve-native.js:126-134` prefers `oktz-signal` for verify, so
    this crate's `verify` was never run against a real `oktz-signal` signature.
  - **The load-time coupling is documented, and the fallback is still silent.**
    `README.md` now has a section saying what the security note above could not:
    `verify` is only as strong as the binding that loaded, and in the enclosing
    repository that binding is chosen outside this package. Since `verify_strict`
    landed, both are strict; but nothing warns when exactly one of the two loads,
    and `lib/Modded/curve-native.js` only warns when neither does. Turning that
    into a warning is recorded as the follow-up it is — and deliberately not
    done here, since the decision belongs to the adaptor and no file in this
    package should change behaviour to make it.
  - **Three corrections the previous round's review adjudicated but never landed
    in source.** (a) A fifth residue was named in that round's report and not in
    the note: `base_mult_scalar` (`:105`, `:124`) computes `B * a`, which reaches
    `variable_base_mul` and so `Scalar::as_radix_16()` (`scalar.rs:985`), and that
    returns an unwiped `[i8; 64]` of radix-16 digits of `a` and `r`. It is
    secret-equivalent, in dalek's frame, and it is not conditional on the CPU:
    `backend/mod.rs:227` picks the serial or the SIMD backend and **both**
    branches call `as_radix_16()` (serial `variable_base.rs:20`, vector `:29`).
    It is now counted, as 2(a2). (b) Two superlatives in the sentences written to
    fix the previous superlatives are gone. `impl Scalar` has four
    reference-taking entry points (`from_bytes_mod_order_wide` `:250`,
    `hash_from_bytes` `:625`, `from_hash` `:671`, `random` `:597`), not one;
    `from_bits` `:278` is a third 32-byte by-value constructor, behind
    `legacy_compatibility` and deprecated, and the one `&[u8; 32]`-taking
    function in the crate — `Scalar52::from_bytes`
    (backend/serial/u64/scalar.rs:65) — is named in the note rather than left
    out, because its `pack()` is private and so it is not the alternative the
    note claims is absent. And dalek's wipe sites are not one: `batch_invert`'s
    scratch (`scalar.rs:834`), `prev_bit` in the Montgomery ladder
    (`montgomery.rs:186`) and `scalar_digits` in straus
    (`backend/serial/scalar_mul/straus.rs:141`), all opt-in per call site, none
    of them on this crate's path. The load-bearing claim — no
    `&[u8; 32]`-taking `Scalar` constructor — survives
    and is now argued from the signatures rather than from a `grep`. (c) The
    completeness hedge existed in that round's message and here, and in neither
    `src/lib.rs` nor `README.md`; both carry it now, directly above the count.
  - **Two smaller corrections, both in claims that were pointing at code that
    does not do what they said.** `src/lib.rs` and `README.md` said
    `Scalar::unpack()` was reached from `from_bytes_mod_order_wide`. It is not:
    that constructor calls `UnpackedScalar::from_bytes_wide(input).pack()`, and
    `pack()` (`scalar.rs:1141`) calls `as_bytes()`. The residue at `:68`/`:84` is
    real and is now attributed to the allocation it actually comes from — a
    `UnpackedScalar` returned by value from `from_bytes_wide` — which is a
    different allocation from the limb temporaries, and is counted as 2(a3). And
    the previous entry in this file said `UnpackedScalar` "sits in the same
    numbered item" as `:103`; it sits in item 2 as 2(a). Its own citation of
    "`src/lib.rs:238-239`'s worked example" pointed at a line that had become the
    criterion's list of by-value shapes; the worked example is `:297-302`.
  - **The count moves from four allocation sites to six, and is now qualified.**
    One is the `:103` argument slot, three are dalek's (`unpack()`'s
    `UnpackedScalar`, `as_radix_16()`'s `[i8; 64]`, `from_bytes_wide`'s
    `UnpackedScalar`), one is sha2's block buffer, one is `full_res`. The number
    is a result of the criterion applied to the code as it stands, not a proof
    that nothing else is there; dependency-internal allocations the enumeration
    does not name, and anything reachable only through a dependency's own call
    graph, would not appear in any count made this way — and both
    `src/lib.rs:287-293` and the README say so next to the number instead of
    leaving it bare.
  - **No behaviour change, and the binary proves it.** The rebuilt
    `libcurve25519_rs.so` is byte-identical to the `.node` this tree shipped
    before this round — sha256
    `ac73a9a17fbf0ee6649c1f134e44c5f499a5a5f220a8a49f7e05c7bd48836f79` — so
    the example and note edits changed no code path at all. All three
    `curve25519-js@0.0.4` vectors reproduce, `npm test` is 13 (the count is 12
    plus the one interop case), and `docs:verify` is 20 blocks + 4 examples with
    0 failures.

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
