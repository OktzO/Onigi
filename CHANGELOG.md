# Changelog

All notable changes to `onigis`.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org/spec/v2.0.0.html) with `-rc.N` pre-release
suffixes.

Entries are written from the commit history. Where an entry describes a security
fix, the commit hash is given so the diff can be read.

---

## Read this before upgrading from 10.1.0-rc.5 or earlier

Five defects in the 10.1.0-rc.5 line were fixed in the 10.1.0-rc.6 work. They
are not cosmetic, and three of them are exploitable by a remote peer:

| defect | effect | fixed in |
|---|---|---|
| `Curve.verify` returned `true` unconditionally | the Noise certificate chain and the ADV pairing signature were never checked, so the websocket carried no authentication of the peer at all | `42d416d` |
| every group member shared one sender-key store slot | group sending wedged permanently with no self-heal, and a member's chain-key seed was rebroadcast to the whole group | `4ca7553` |
| the TOFU identity key was persisted before the ciphertext was authenticated | one unauthenticated `pkmsg` could permanently brick a conversation and poison a stored identity key | `9c64fc7` |
| the WABinary encoder emitted frames its own decoder rejected | a node with a non-string attribute desynced the frame | `5755440` |
| `TOKEN_MAP` inherited from `Object.prototype` | a remote attribute value of `toString` / `constructor` / `__proto__` vanished from the wire | `282fcdb` |

`10.1.0-rc.6` itself was tagged before these fixes landed; they are unreleased
at the time of writing. **Pin to a version at or after the fixes below, or audit
your deployment.** Details, with the reasoning and the failing tests, are in
each commit message and in [docs/protocol.md](docs/protocol.md).

One operational note for anyone upgrading: the sender-key store key format
changed. It is self-healing — a miss makes `hasSenderKey` answer `false`, a fresh
sender key is created and a new distribution message is sent — but a stale slot
left by `4ca7553` should be deleted from your key store so the old record is not
read again.

---

## [Unreleased]

### Security

- **`Curve.verify` returns the native verification result** (`42d416d`).
  `lib/Utils/crypto.js` discarded the boolean from `oktz-curve25519` — which
  returns `false` on a mismatch rather than throwing the way `curve25519-js`
  did — and hardcoded `return true`. Every signature of a plausible shape
  verified. That made two checks no-ops:

  - the Noise certificate chain in `lib/Utils/noise-handler.js:180-181`, and
  - the ADV account signature in `lib/Utils/validate-connection.js:157`.

  The websocket therefore authenticated nothing about its peer. The `try`/`catch`
  is kept deliberately: a wrong-length public key still throws in
  `scrubPubKeyFormat` and must answer `false`, not propagate.

  *Not claimed:* that the chain matches WhatsApp's server. That needs a live
  server, and no test here can observe it.

- **The TOFU identity key is persisted only after the pkmsg MAC verifies**
  (`9c64fc7`). A `pkmsg` wrapper's `identityKey` field is not covered by the MAC
  that `ratchetDecryptPkmsg` checks, and `auth.keys.transaction` is a per-key
  mutex rather than a rollback. `decryptMessage` called `saveIdentity` *before*
  decrypting, so a single unauthenticated `pkmsg` could delete an established
  session and overwrite the stored identity key for that address before the MAC
  ever failed. The key is now read up front and written only after a successful
  decrypt, and `saveIdentity` no longer clears the session — by that point the
  engine has already stored a session derived from the very message that
  authenticated, so clearing would discard a working session on every
  legitimate re-key.

- **Group sender-key slots are keyed by sender again** (`4ca7553`).
  `lib/Signal/Group/*` was carried over from `@whiskeysockets/baileys` 7.0.0-rc14
  and written against `libsignal`'s `ProtocolAddress`, which names the sender
  field `.id`. The engine in this tree, `oktz-signal`, names it `.name`. So
  `SenderKeyName.serialize()` emitted `undefined` for every sender and every
  member of a group collided on one store slot:

  ```
  group member A key: 120363@g.us::undefined::0
  group member B key: 120363@g.us::undefined::0
  ```

  Two consequences, both unrecoverable without manual intervention:

  1. **Group sending wedged permanently.** After one group message was
     decrypted, `getSenderKeyState()` returned the *remote* member's state, whose
     `senderSigningKey.private` is empty, so `calculateSignature` threw
     `Incorrect private key length: 0`. `hasSenderKey` still answered `true` —
     the slot exists — so the create path was never taken and nothing self-healed.
  2. **A member's chain-key seed was disclosed to the whole group.**
     `getSenderKeyDistributionMessage` rebroadcast the remote member's keyId,
     chain-key seed and signing public key as the local user's own, to every
     device in the group.

  The serialisation also disagreed with `equals()` and `hashCode()` in the same
  file, which already resolved the sender through `toString()`.

- **WABinary rejects non-string attribute values** (`5755440`). The list-size
  prefix at the head of a node counts every attribute, so an encoder that
  declared a token and then skipped writing a non-string value produced a frame
  the library's own decoder desynced on. `undefined` and `null` remain *absent*
  attributes and are still filtered; only a present-and-non-string value is now
  an error. `lib/WABinary/rust-adapter.js:21` routes the same shapes to the JS
  encoder so the two never mix inside one frame.

- **`TOKEN_MAP` has a null prototype** (`282fcdb`). As an object literal it
  inherited `Object.prototype`, so a remote attribute value of `toString`,
  `constructor` or `__proto__` resolved to a dictionary token and disappeared
  from the wire. `lib/WABinary/constants.js:1295` and the lookup at
  `lib/WABinary/encode.js:151` are both fixed.

- **Hostile frames are bounded** (`37dce9f`). Inflate output is capped at 16 MiB
  (a compression bomb could exhaust the heap); node nesting is capped at 128
  levels, because a 7.5 KB frame reached ~1500 and overflowed the stack with a
  `RangeError` that the socket layer did not catch, tearing down the connection;
  an empty frame is refused rather than decoded to a phantom node; and
  `bufferToUInt` is bounds-checked.

- **WAM telemetry validates its input** (`6c54336`): malformed input is rejected
  with real `Error` objects instead of something that throws later.

- **Reversed LID↔PN pairs are rejected** (`e7fc85e`) rather than persisted
  inverted.

- **A self-only `protocolMessage` from a non-self origin is dropped**
  (`lib/Utils/process-message.js:228`), with a warning. This is a defence
  against a peer injecting `HISTORY_SYNC_NOTIFICATION`,
  `APP_STATE_SYNC_KEY_SHARE`, `LID_MIGRATION_MAPPING_SYNC` or
  `PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE` as though it came from you.
  `REVOKE`, `MESSAGE_EDIT`, `EPHEMERAL_SETTING` and
  `GROUP_MEMBER_LABEL_CHANGE` are **not** in the set, because they legitimately
  arrive from other users; the comment at `:218` cites whatsmeow's dispatch
  shape for the reasoning.

- **A present-but-unusable `creds.json` no longer forges an identity**
  (`ff243c3`, `2b13e78`). `creds.json` writes are atomic, and a read error or a
  truncated file is treated as *no* creds rather than as a fresh identity — a
  silent reset of the device identity is worse than a visible failure.

- **A missing native prebuild no longer blocks the import** (`cb02e9e`). See
  [Platform](#platform-support-what-is-actually-shipped) below.

### Added

- **Documentation that executes.** `docs/quickstart.md`, `docs/api.md` and
  `docs/protocol.md`, six runnable programs under `examples/`, and
  `npm run docs:verify`, which runs every example and every runnable code block
  and fails if any of them errors. An unmarked ```js``` block *fails* the run;
  `illustrative` is the only opt-out and has to be spelled out.

- **A local WhatsApp stand-in for the handshake**
  (`examples/helpers/local-wa-server.mjs`): the server half of
  `Noise_XX_25519_AESGCM_SHA256`, so the client side can be exercised with no
  credentials and no network. It cannot complete the handshake — the chain it
  signs is signed by a local key, not WhatsApp's root — and
  `examples/01-connect.mjs` asserts the resulting refusal rather than hiding it.

### Fixed

Roughly forty further fixes landed in the same window. Grouped by what they
were:

- **Lifecycle and teardown** — `end()` delivers the buffered event burst instead
  of dropping it, tears the buffer down even when the close notification fails,
  and rejects the queries it orphans; `logout()` does not resolve before the
  teardown it started; a `WebSocketClient.close()` cannot outlive the socket it
  closes, and a closed socket cannot make `connect()` a no-op; every timer is
  cleaned up.
- **Unhandled rejections** — the `process.nextTick(async …)` in `emitOwnEvents`
  had no `.catch()`, so a throwing user listener became a process-level
  unhandled rejection; `emitOwnEvents`, the event buffer's deferred flush, a
  failing error reporter, a non-`Error` throw from `decode-wa-message`, the
  `ev.flush()` that `processNodeWithBuffer` ran bare, the pair-device and
  `offline_preview` `CB:` handlers, and the `sock.ev` in `messages-recv` are all
  caught now. The event buffer also owns its handler promises, so one rejecting
  handler cannot kill the process, and the error reporter cannot re-report into
  its own listener.
- **Queries that never got answered** — `waitForMessage` now rejects on timeout
  instead of resolving `undefined`, so "answered" and "said nothing for 60 s"
  are no longer the same observation. A pre-key dedupe guard outlives its upload
  timeout; a pre-key-low check no longer dies silently when `<count>` is absent;
  the pre-key upload is deduplicated across concurrent callers; a
  retry-counter cap says when it drops a budget instead of destroying what it
  caps; and the resend budget is charged once per retry receipt, on the ids that
  reach the wire.
- **Locks** — the retry queue no longer holds a chat's lock while it drains, the
  media retry request is written after the stanza is on the wire, the noise
  receive path runs one `processData` loop at a time over the shared buffer, and
  a chat's `ev.flush()` is guarded.
- **Addressing** — `sendMessage` derives the sender identity from the *chat's*
  addressing rather than testing the message type, so a LID-addressed group no
  longer signs with a phone-number identity while stamping
  `addressing_mode="lid"` on the stanza; `sendPresenceUpdate` no longer
  announces the wrong identity; the retry resend picks whichever of `meLid` /
  `meId` already has a sender-key slot and re-attaches the distribution message;
  device 0 is normalised in the reverse LID→PN direction too; `jidNormalizedUser`
  returns `undefined` rather than an empty jid; and `areJidsSameUser` requires a
  user on both sides.
- **`onWhatsApp` answers one entry per input, in the caller's domain**
  (`83ec50a`). It used to return the server's `jid` for every input, so a caller
  that passed a `@lid` got a phone number back, and it could not distinguish
  "not on WhatsApp" from "we could not ask". It now echoes the caller's own jid
  and answers `exists: true | false | null`, where `null` means undetermined.
- **Media and business** — a temp-file write failure is surfaced instead of
  being swallowed, newsletter uploads no longer leak temp files, the business
  image write finishes before the upload starts, and `ENOSPC` during a business
  upload is an error rather than a process death.
- **USync** — a protocol that answered nothing leaves no key behind; the
  bot-profile parser no longer discards the whole query over one bad row; a
  `NEWSLETTER_JID` create response that is a partial is a `Boom`, not a
  `TypeError`; and the hosted-domain flag is kept per device rather than per user.
- **TC tokens** — "no index" is no longer treated as the same answer as "nothing
  to prune".
- **Groups** — the `admin`, `isAdmin` and `isSuperAdmin` fields that
  `GroupMetadata` declares are all populated, and the participant id is no
  longer ignored when deciding "that is me".
- **App state** — the shared LT-hash accumulator cannot bleed between accounts.
- **Crypto** — a platform that cannot verify a signature is no longer
  indistinguishable from one that found a bad signature: the first occurrence
  warns with a typed code instead of passing for a forgery.

### Changed

- **`oktz-signal` is now `^0.3.0-rc.1`**, resolved to `0.3.0-rc.1` in both
  `node_modules` and `package-lock.json`, with `npm ls oktz-signal` reporting a
  single clean `0.3.0-rc.1`. The 10.0.x line declared `0.2.0-rc.1` while the
  lockfile resolved `0.1.7`, so the version that shipped was not the version
  that was tested; that mismatch is gone.

  Two things a consumer should know, neither of which this repository can
  verify for you:

  - `0.3.0-rc.1` is a pre-release. On the registry it is published under the
    `rc` dist-tag, not `latest`; `latest` still points at `0.1.7`. Installing it
    therefore needs the version or the tag spelled out.
  - `oktz-signal` 0.1.7 is what a bare `npm install` inside this tree has been
    observed to leave behind, and 7 tests fail against it. If you develop here,
    re-sync from a local checkout of `oktz-signal` at `0.3.0-rc.1` rather than
    letting npm resolve it.

### Platform support: what is actually shipped

The native surface is three packages with different coverage. This is stated
exactly because the previous README got it wrong in both directions.

| package | role | how it ships | platforms |
|---|---|---|---|
| `oktz-signal` 0.3.0-rc.1 | E2EE, XEdDSA | `.node` via `optionalDependencies` | `linux-arm64-{gnu,musl}`, `linux-x64-{gnu,musl}` — **four, and no others** |
| `oktz-curve25519` 0.0.4 | X25519 keygen and DH | one `.node`, **no `optionalDependencies`** | `linux-x64-gnu` only |
| `whatsapp-rust-bridge` 0.5.4 | WABinary encode | **WebAssembly**, inlined in `dist/index.js` | any platform with WebAssembly |
| `node:crypto` | AES-GCM, SHA-256, HMAC, X25519, PBKDF2 | Node built-in | any |

Consequences:

- **Since `cb02e9e`, `import 'onigis'` succeeds on macOS and Windows.** Before
  that, `lib/Signal/libsignal.js` opened with a top-level
  `import * as libsignal from 'oktz-signal'`, and that package's loader throws
  `Cannot find native binding` off Linux. A top-level ESM import is evaluated
  while the module graph is built, so the throw took down `lib/index.js` itself:
  the library was **unimportable** on darwin, win32 and android-arm64, for code
  paths that never touch E2EE.
- **E2EE is not available on those platforms.** The engine now loads on first
  use (`lib/Signal/libsignal.js:44`), so the failure moves to the first E2EE
  operation and arrives as a typed error carrying
  `code: 'ONIGI_SIGNAL_ENGINE_UNSUPPORTED'`, a message naming the platform, the
  engine and the package to install, and the loader's own error as `cause`.
  Classify on `code`, never on the message text.
- **A failed load is cached**, so a platform with no prebuild does not re-enter
  the loader once per message.
- **linux-arm64 works**, including musl: `oktz-signal` ships prebuilds for it,
  X25519 falls back to `node:crypto` when `oktz-curve25519`'s single prebuild is
  absent, and XEdDSA delegates to `oktz-signal`.
- **WABinary works everywhere**, because it is WebAssembly.

`tests/signal-lazy-engine.test.mjs` simulates the exact shape of a darwin/win32
install and asserts all of the above. `tests/curve-platform-fallback.test.mjs`
asserts the arm64 shape.

---

## [10.1.0-rc.6] — 2026-09-22

Address the LID work. **This tag predates every fix in [Unreleased] above** and
carries all five security defects listed at the top of this file.

- `onWhatsApp` resolves a `@lid` input through `lidMapping.getPNForLID` rather
  than fabricating a phone number.
- `sendMessage` stamps `creds.me.lid` for LID-addressed chats.
- Reply and group `participant` is set to a `userJid` consistent with the chat's
  addressing.
- Device 0 is normalised in the reverse LID→PN direction.

## [10.1.0-rc.5] — 2026-09-12

A crash-DoS and write-amplification pass, on top of the 10.1.0-rc.4 audit fixes:

- An inbound async receive failure is caught instead of becoming an
  unhandled rejection.
- `receiptMutex` is keyed per JID.
- The event buffer's scalar gate and maps are O(1) and null-prototype.
- `pruneSessionRecord` gates on a scalar before parsing.
- Noise receive is zero-copy; GCM is single-allocation; unpadding is view-only.
- 4-byte reads are unsigned.
- Inflate output is capped at 16 MiB.
- The app-state MAC comparison is timing-safe.
- Pre-key generation is chunked and non-blocking.
- `appStateMacVerification` defaults to `true`.
- Caches gained `maxKeys`.

## [10.1.0-rc.4] — 2026-09-11

- The `process.nextTick(async …)` in `emitOwnEvents` gained a `.catch()`.
- The pre-key-low check no longer dies when `<count>` is absent.
- The lockfile pins `oktz-signal` 0.2.0-rc.2.

## [10.1.0-rc.3] — 2026-09-08

- A websocket lifecycle pass: close, reconnect and teardown ordering.
- A write-amplification pass: the device-list flush is debounced into a single
  `keys.set`, noise bursts are concatenated once, and stack capture in timeouts
  is lazy.

## [10.1.0-rc.2] — 2026-09-06

- `oktz-signal` pinned to 0.2.0-rc.1 for release-candidate testing.

## [10.1.0-rc.1] — 2026-09-05

- First release candidate. Pre-audit fixes, and the Rust WABinary encoder
  enabled by default with `ONIGI_RUST_WABINARY=0` to fall back to JS.

---

## Earlier

### [10.0.2]

- `relayMessage` re-attaches the `<biz>` stanza node automatically for
  `buttonsMessage`, `listMessage` and `interactiveMessage` + `nativeFlowMessage`
  payloads, unless the caller already supplied one. Without that node the server
  accepts the stanza and the receiving client never renders the card — the send
  succeeds and the message never appears. This regressed in the rebase to
  Baileys 7 and was the cause of invisible button menus.

### [10.0.1]

- Added `lib/Utils/rich-classic.js`: `buildButtonsMessage`, `buildListMessage`,
  `sendClassicMessage`, `normalizeUserJid`.

### [10.0.0]

- Renamed from `onigi-baileys` to `onigis`.
- Rebased onto `@whiskeysockets/baileys` 7.0.0-rc14.
- Replaced the GPL-3.0 `libsignal` engine with `oktz-signal` +
  `oktz-curve25519`, both MIT.
- `syncFullHistory` and `enableRecentMessageCache` now default to `false`.
- `protobufjs-cli` pinned to `^1.1.3`; `link-preview-js` to `^5.0.0`.

### 9.x

The `oktz-baileys` line, on `ourin-baileys` 9.0.21. Notable:

- `9.1.0` — the `libsignal` → `oktz-signal` swap.
- `9.1.2`–`9.1.6` — a series of one-time prekey fixes in the engine
  (33-byte ephemeral key handling, session reuse by baseKey, always rebuilding
  the session for a `pkmsg`).
- `9.0.25` — `lib/Modded/curve-native.js`, a drop-in for
  `libsignal/src/curve.js` backed by `node:crypto` and `oktz-curve25519`.
- `9.0.24` — `oktz-curve25519` aliased as a direct dependency.
- `9.0.22` — the fork was renamed to `@oktzo/oktz-baileys` and published to GitHub
  Packages, native curve25519 wrapper included.
- `9.0.21` — initial fork of `ourin-baileys` 9.0.21.

Modules removed in the 10.0.0 rebase: `lib/VoIP/*` (the WebRTC call client),
`Modded/message_builder.js`, `Utils/rich-messages.js`, `Socket/dugong.js`,
`Utils/sticker-pack.js`. `rejectCall` remains, in the core `messages-recv`.

## License

MIT.
