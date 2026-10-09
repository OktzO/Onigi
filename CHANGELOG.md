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

Three follow-ups to the gap closure, each with a test:

- **The event buffer no longer drops events emitted re-entrantly from a flush**
  (`96e8c65`). `flush()` reassigned the live buffer only *after* its synchronous
  emit, so a listener that reacted by calling `emit()` again had its event
  appended to a buffer that was then discarded. The same shape in the
  `messages.upsert` type-mismatch path was fixed alongside it
  (`lib/Utils/event-buffer.js:186-224`).

- **`requestPlaceholderResend` no longer races itself** (`d1a3d55`). The
  read-decide-write against the placeholder cache was unsynchronised, so two
  concurrent requests for one message both saw "not yet requested" and both put
  a `placeholderMessageResendRequest` on the wire. The three steps now run under
  a per-message-id lock, released before the settle delay so it never serialises
  unrelated sends. A message with no id is rejected outright instead of being
  filed under the shared `undefined` cache key.

- **A call reject is skipped when there is no identity** (`5d4a663`). The reject
  stanza is addressed from `creds.me.id`; with no identity the stanza was
  malformed rather than the call being rejected. Two sibling reads of
  `creds.me.id` were deliberately left alone — both already sit inside a handler
  that logs and nacks, so a guard there would trade a visible throw for a silent
  dropped message.


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
- **`deviceSentMessage` keeps the outer `messageContextInfo`** — the unwrap in
  `lib/Utils/decode-wa-message.js` replaced the decoded message with the inner
one wholesale, discarding the wrapper's `messageContextInfo`. That field is
  where a sender puts `messageSecret` (`lib/Socket/messages-send.js:592-596`), and
  it is what `lib/Utils/process-message.js:497` needs to decrypt the
  event/poll creation the message references — so any message a linked device
  sent lost the secret that decrypts it. The secret is now read before the unwrap and
  re-attached when the inner message has none of its own; an inner secret is
  left alone.
- **A lottie sticker normalises to its content** — `normalizeMessageContent`
  unwraps through `getFutureProofMessage`, whose `||` chain omitted
  `lottieStickerMessage`, so a sticker of the same `FutureProofMessage` shape as
  every other entry stayed wrapped.
- **Windows Desktop advertises `WebSubPlatform.WIN_HYBRID`** — `PLATFORM_MAP`
  named the retired `WIN32`. Correctness only: this value is read only when
  `syncFullHistory` is true, which defaults to `false`, so no default
  configuration changes on the wire.

- **A media download that dies mid-stream rejects instead of killing the
  process** (`ea2dde4`). `downloadEncryptedContent` ended with
  `return fetched.pipe(output, { end: true })`, and `pipe()` attaches no
  `'error'` listener to the source. When the socket died part-way through — the
  undici body from `getHttpStream` emits `TypeError: terminated` — nothing in the
  chain was listening, so the event went uncaught and took the process down. For
  an unattended consumer that is a crash from any transient network blip. The
  chain is now `stream.pipeline`, which puts every stream under an error
  listener, destroys the decrypting `Transform` with the source error and covers
  premature close; the failure reaches the caller as a rejection on the returned
  stream, which is what the `for await` consumers and `history.js` already
  expected (`lib/Utils/messages-media.js:543`).

- **The media re-upload retry actually runs** (`47040f4`, `1f08d25`). Two
  independent defects, both of which had to be fixed for the 404/410 path to
  work at all:
  - `lib/Utils/messages.js:855` read the HTTP status off `error.status`, but a
    `@hapi/boom` error carries it on `output.statusCode` — verified on the
    installed 9.1.4, whose `Object.keys(err)` is
    `data, isBoom, isServer, output` and has no `.status`. The guard never
    matched, so a media download answered with an expired URL threw `Boom 410`
    straight at the caller and the re-upload branch was unreachable. `error.status`
    remains as the fallback, because `ctx` is third-party-owned and a caller's own
    `downloadContentFromMessage` can throw a plain object carrying a bare status.
  - `getMediaRetryKey` passed a `mediaKey` to `hkdf` as-is. A `mediaKey` is a
    proto `bytes` field, which survives a `toJSON` round-trip as a base64
    *string*, so the persisted shape was hashed as UTF-8 bytes and encrypt and
    decrypt derived different keys. The string is now decoded as base64,
    stripping a `data:;base64,` prefix the same way `getMediaKeys`
    (`lib/Utils/messages-media.js:86`) does, so there is one string-normalisation
    rule in the file instead of two that can drift
    (`lib/Utils/messages-media.js:729-737`).

  The recovery log line is optional-chained as well (`lib/Utils/messages.js:861`):
  it is reachable for the first time in this tree's history now that the guard
  above it is live, and a caller passing `{ reuploadRequest }` without a logger
  got a `TypeError` instead of the `Boom` — the recovery defeated by the
  recovery.

- **Presence is announced only on an actual name change** (`5b3e93c`). The
  `creds.update` handler compared the incoming `name` against `creds.me?.name`,
  but `creds` is the merged state, whose `me.name` outlives every partial
  update — so the event payload was the only thing that could say whether a name
  had been received. Any other `creds.update` (key churn, for instance) fired the
  comparison, and the resulting attribute-less `<presence/>` reads as "available":
  the account was held announced online and WhatsApp stopped pushing to the
  phone. The comparison now also requires the event to carry a name
  (`lib/Socket/socket.js:978`).

- **`offline='0'` is treated as a live message** (`73e4fa7`). `offline` is the
  string `'0'` or `'1'`, not a boolean, and three sites tested it for truthiness.
  A live message therefore read as a history backfill: `messages.upsert` was
  emitted with `type: 'append'` instead of `'notify'`, and the stanza was queued
  to the offline processor instead of dispatched. The one predicate,
  `isOfflineNode` (`lib/Utils/offline-node-processor.js:6`), matches `'1'`
  exactly, so an unexpected value falls through to the live path
  (`lib/Socket/messages-recv.js:1554`, `:1601`, `:1754`).

- **A notification that arrives before login is acked** (`e6d0782`).
  `sendMessageAck` read `authState.creds.me.id` unguarded, so a pre-login
  notification — a `companion_reg_refresh`, for instance — threw a `TypeError`
  inside the ack, the error was logged as "failed to ack notification", and no
  ack stanza went out at all. `me` is now optional-chained
  (`lib/Socket/messages-recv.js:385`); `buildAckStanza` uses `meId` only for a
  message-class `attrs.from`, so an absent `me` still yields a valid stanza
  rather than `to: undefined`.

- **The per-socket `AsyncLocalStorage` is released when the socket ends**
  (`245a5ac`, `9a8143c`, `ebcb13a`). `addTransactionCapability` creates one
  `AsyncLocalStorage` per socket and never disabled it; an enabled store stamps
  every live async resource process-wide, so a reconnecting consumer leaked one
  instance per socket. `end()` now disposes it
  (`lib/Socket/socket.js:1051`, `lib/Utils/auth-utils.js:222`), and the dispose
  is sequenced rather than immediate: it never lands on top of a running
  transaction (which would detach that transaction from its own staged cache and
  lose writes), and never inside the mutex it is trying to protect. Calling it
  from inside a transaction — which is what `end()` does — takes the lock-free
  path, because that frame provably already holds the mutex.

- **The transaction mutex is one per store, not one per caller-supplied
  string** (`4b85ee0`, `00ee356`). `transaction(work, key)` took a key and took
  a mutex from a map keyed by it, so two transactions under different keys
  mutated the same key store concurrently and could interleave their commits.
  The string also let a caller partition the mutex without meaning to, which
  silently re-opened the race. `transaction` now takes only `work` and is
  serialised on one mutex per store (`lib/Utils/auth-utils.js:90`,
  `lib/Types/Auth.d.ts:108`); the per-key map remains for the read path only.

- **A pre-lock read can no longer clobber a populated `SenderKeyRecord`**
  (`c30071f`). `processSenderKeyDistributionMessage` did a `get('sender-key')`
  plus a `storeSenderKey(new SenderKeyRecord())` for a miss *outside* the
  transaction, then repeated the pair inside it. A transaction that committed a
  populated record in between was clobbered by that pre-lock empty write, so the
  group lost its sender key and its chain. Only the in-transaction pair remains
  (`lib/Signal/libsignal.js:112-116`).

- **Pre-key counters advance only once the server accepts the upload**
  (`f4b6e3b`). `firstUnuploadedPreKeyId` was advanced at *generation* time,
  conflated with `nextPreKeyId` in one `creds.update`. Two consequences: a
  permanently failing upload orphaned every key it had generated (the counter had
  already skipped past them, so the next upload never retried them and the
  account slowly drained its server-side pre-keys), and
  `available = nextPreKeyId - firstUnuploadedPreKeyId` was structurally `0`, so
  a top-up minted a whole new batch instead of the shortfall. Allocation now
  advances `nextPreKeyId` immediately and only the allocation is emitted;
  `firstUnuploadedPreKeyId` is emitted after the server's `iq` result comes back
  error-free, including for the pre-key a retry receipt carries
  (`lib/Utils/signal.js:182-187`, `lib/Socket/socket.js:392-418`).

  Two follow-ups on the same counters (`5764d63`): a failed allocation now
  restores `nextPreKeyId` by compare-and-swap, since the emit above it had
  already moved the counter over ids that were never written, and both counters
  are clamped against the live `creds` at emit time (`lib/Socket/socket.js:993`)
  — they are computed from a snapshot taken at alloc time, so two interleaved
  consumers could otherwise let the slower one's stale value move a counter
  backwards.

- **A stale LID mapping is reconciled instead of skipped, and compared by user
  not by device** (`e15bfd5`, `41239b3`). On a stanza announcing a
  LID↔PN pair, the mapping was only written when no PN was recorded for that LID
  at all. A *different* PN recorded against the same LID — the stale case — was
  left in place, so the session never moved and every message from the real owner
  was undecryptable. The pair is now overwritten and the session migrated, under
  a per-alt-address mutex so two inbound messages from the same participant
  cannot both migrate it (`lib/Socket/messages-recv.js:38`, `:1414-1420`). The
  comparison itself is by user, because `getPNForLID` fabricates the device-less
  LID's own device onto the stored PN user: comparing raw jids read that device
  mismatch as a stale pair and re-stored and re-migrated on *every* inbound
  message. A missing mapping is still reconciled, since
  `areJidsSameUser(undefined, jid)` is false.

- **The retry budget is spent exactly once per receipt** (`cfdb44e`,
  `13054b9`). Three defects in one counter:
  - The key was `${id}:${participant}` unconditionally, so every stanza without
    a participant — that is, every 1:1 message — was counted under the literal
    string `"<id>:undefined"`, and two call sites that disagreed about the key
    addressed different entries of the same budget. The key is built in one
    place, with the participant omitted when there is none
    (`lib/Socket/messages-recv.js:26`).
  - The read, the test and the write were separate awaits, so two retries for one
    message arriving on different lock chains both read the old count and one
    charge was lost — the cap bought more resends than it says. The whole
    get/test/set is now one critical section on a keyed mutex, for both the
    inbound retry counter and the resend budget
    (`lib/Socket/messages-recv.js:49`, `:1106`).
  - A miss in a *caller-supplied* `msgRetryCounterCache` was read as "refused",
    which silenced every inbound retry request for anyone who passed a plain
    `NodeCache` — the shape the `CacheStore` type invites, and the only answer
    such a cache has for a key it has never seen. A miss is a miss: to refuse a
    retry, record a count at or above `maxMsgRetryCount` under the message's key,
    and the refusal is then left in place and logged at `warn` rather than
    swallowed at `debug` (`lib/Socket/messages-recv.js:466`). See
    [Changed](#changed) for the contract as types now state it.

- **A redelivered message is processed once** (`c42ac57`, `4384165`). A duplicate
  stanza — a retry-receipt loop, a repeated frame — re-ran the whole dispatch and
  emitted a second `messages.upsert`, a second receipt and a second history
  append. Messages are now marked processed in a 10-minute cache keyed on the
  chat, the id and a short hash of the re-encoded body, so an identical
  redelivery dedupes while a *different* message that reuses an id still goes
  through; an unencodable body yields no key and no dedupe rather than risking a
  dropped message. The mark is written only after the dispatch succeeded, so a
  message whose prerequisites were not ready yet stays unmarked and can still be
  redelivered and retried. The ordinary-message `messages.upsert` in `chats.js`
  fires before `processMessage` and needed its own check on the same cache
  (`lib/Utils/process-message.js:208`, `lib/Socket/chats.js:89`, `:968`). The
  outbound `sendReceipt` still runs once per redelivery and is left as a known
  gap.

- **A receipt can no longer overwrite a decoded `messageTimestamp`** (`6d8b18c`).
  When the event buffer merged a buffered `messages.update` into a message it had
  already decoded, a receipt carried the *receipt's* clock — `0` when the receipt
  has no usable time — and replaced a timestamp that had been decoded correctly.
  A `messageTimestamp` that is already set is now sticky: whoever sets one first
  keeps it, and a later arrival only fills the field if nothing has set it
  (`lib/Utils/event-buffer.js:743`, used at `:518` and `:545`).

- **A retry resend is encrypted exactly once** (`4a0e9bd`). The retry
  participant was both encrypted for by the generic per-device fan-out and, a few
  lines later, by the retry branch's bare `<enc>`, so one resend carried two
  mutually exclusive shapes for the same device — `<participants>` and a bare
  `<enc>` — which the server answers `479`. It also advanced the double ratchet
  twice for one message, so the peer could decrypt only one of the two. The
  participant is no longer added to the device fan-out, its session is asserted
  immediately before the single encrypt (so a receipt carrying no key bundle
  still gets one fetched), and that encrypt is under a per-participant mutex
  (`lib/Socket/messages-send.js:858`, `:867`).

- **A 1:1 send resolves PN→LID in one identity space** (`4a0e9bd`, `143ac8d`).
  On a migrated account the server rejects a 1:1 destination still spelled
  `@s.whatsapp.net`, so the destination is resolved to the peer's LID once one is
  mapped — but the *sender* identity was derived from the caller's PN, so the
  stanza could be stamped with one address and delivered to another. The
  destination is now resolved once, in the caller, and the same value feeds the
  stanza address, the device enumeration and `contextInfo.participant`; addressing
  then follows the destination, so a resolved send goes out from your own LID
  identity (`lib/Socket/messages-send.js:549`). Group, status, newsletter,
  AppStateSync peer messages and the retry resend keep the caller's jid.

  A PN/LID store that throws now degrades to the jid it was given, with a
  warning, instead of aborting the whole stanza over a lookup
  (`lib/Utils/tc-token-utils.js:87`).

- **A status broadcast's recipients are resolved to their LID** (`2612eeb`). Each
  recipient in `statusJidList` is a peer, and on a migrated account its session
  is stored under its LID, so encrypting to the caller's PN failed for that
  recipient. They go through the same PN→LID resolution as the destination, which
  returns an already-LID jid untouched and falls back to the given jid when
  nothing maps, so no address is invented
  (`lib/Socket/messages-send.js:681`).

- **A media send during `CONNECTING` waits, and a failed `media_conn` no longer
  disables media for the socket's life** (`2af56e7`). A media fetch is two round
  trips, so it is the send most likely to find the socket not yet open; the
  `media_conn` `iq` then rejected with `Boom('Connection Closed')` on a socket
  that had no `'close'` event to recover from, so the fetch now waits for the
  socket to open first (`lib/Socket/messages-send.js:92`,
  `lib/Socket/socket.js:617`).
  Separately, `mediaConn` is a promise: one failed `media_conn` `iq` left a
  *rejected* promise in the slot, every later caller re-awaited it and rethrew,
  and media was dead until the socket was recreated. The rejected promise is now
  dropped and the next caller refetches — the error still reaches the caller that
  triggered the failing fetch (`lib/Socket/messages-send.js:82`).

### Changed

- **`SignalKeyStoreWithTransaction.transaction` no longer takes a key**
  (`4b85ee0`, `00ee356`). The signature is now `transaction<T>(exec)`: the
  library serialises its own transactions on one mutex per store rather than
  partitioning them by a caller-supplied string, so the string was only ever able
  to weaken the guarantee. A key store that implemented the two-argument form
  still satisfies the new one — the library simply stops passing the key — but a
  store that relied on the key to serialise *its own* callers' work has to do
  that itself. The same type gains
  `disposeTransactionStorage: () => Awaitable<void>`, which the socket calls at
  `end()`; a store without it is fine, the call is optional-chained
  (`lib/Types/Auth.d.ts:103-108`).

  *Note:* `docs/api.md` and `docs/quickstart.md` still document the old
  two-argument `transaction`; those pages have not been updated in this batch.

- **`msgRetryCounterCache`: a miss is a miss, and a refusal is the caller's
  record** (`f3539d0`, `fc2514a`). The documented contract, now stated at
  `lib/Types/Socket.d.ts:88-105`: a cache passed here is the caller's authority
  over inbound retry requests *and the library keeps counting into it*, so from
  the first retry onwards it holds the same count the library would have kept
  internally. To refuse the retry for a message, record a count at or above
  `maxMsgRetryCount` under its key (`<id>` for a 1:1 message,
  `<id>:<participant>` otherwise) before the stanza arrives; the request is then
  not sent, the record is left in place, and the refusal is logged at `warn`. A
  key with no entry is not a refusal. The resend budget for outgoing messages is
  a separate counter on the same cache and is written and read by one function
  only.

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
