# onigis 10.1.0-rc.7

A fork of [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) — a WhatsApp Web multi-device library — with the Signal engine swapped to `oktz-signal` and a security remediation applied throughout.

```bash
npm install onigis
```

> **Read this before upgrading from `10.1.0-rc.6`.** That version is published
> and **contains all of the critical defects below**. The `v10.1.0-rc.6` tag
> points at the same vulnerable code. Upgrade for that reason alone.

---

## Critical

Four defects that an attacker could reach, each with a regression test that was
observed failing first.

### `Curve.verify` returned `true` unconditionally — FIXED

`lib/Utils/crypto.js` discarded the boolean returned by
`curve.verifySignature` and returned `true` unconditionally. The native layer
*returns* `false` on mismatch rather than throwing — upstream `curve25519-js`
throws, so the try/catch idiom was kept while the contract changed underneath
it.

```
valid signature      -> true
1-bit-flipped sig    -> true
all-zero sig         -> true
sig by DIFFERENT key -> true
random garbage sig   -> true
```

Consequence: the Noise handshake's server-certificate chain check was a no-op,
so **the socket's transport was unauthenticated**. Any party able to serve the
`wss://` endpoint — DNS, `/etc/hosts`, a proxy, BGP, or any user-set
`waWebSocketUrl`, which is an advertised feature — could complete the handshake
with a self-minted key and terminate the session. The ADV device-identity
signature on the pairing path was never checked either.

### Every member of a group collided on one sender-key slot — FIXED

`lib/Signal/Group/sender-key-name.js` serialised the sender as
`${this.sender.id}`, but `oktz-signal`'s `ProtocolAddress` exposes `name`, not
`id`. Device `0` is every member's primary device, so one store slot served the
whole group:

```
120363@g.us::undefined::0   (member A)
120363@g.us::undefined::0   (member B)
```

Consequences, neither requiring an attacker:
- **Group sending failed permanently.** After decrypting one group message,
  `getSenderKeyState()` with no keyId returned the *remote* member's state,
  whose signing private key is empty, so `calculateSignature` threw
  `Incorrect private key length: 0`. `hasSenderKey` returned `true`, so the
  create path never ran — only manual deletion of the store entry recovered.
- **Chain-key disclosure.** `getSenderKeyDistributionMessage` then broadcast
  the remote member's keyId, chain-key seed and signing public key as the local
  user's own to every device in the group.

Root cause: `lib/Signal/Group/*` is byte-identical to baileys `7.0.0-rc.14`,
written against `libsignal`'s `ProtocolAddress`. The engine was swapped and the
API assumption was not updated. The store-key change is self-healing — a miss
makes `hasSenderKey` false, the create path runs, a fresh sender key is created
and a new distribution message is sent.

### Session state was persisted before the ciphertext was authenticated — FIXED

`lib/Signal/libsignal.js` called `saveIdentity` *before* the decrypt, and
`saveIdentity` deletes the session and overwrites the stored identity key.
`parsedKeys.transaction` is a mutex, not a rollback.

With a healthy established session, a pkmsg carrying a fresh base key and a
flipped MAC byte is correctly rejected with `MAC verification failed` — yet the
stored record became `{closed:<ts>, -1}` and **every later real message from
that peer failed**. No attacker was required: a peer re-initialising with an
already-consumed one-time prekey reaches the same state. A synthetic pkmsg could
also overwrite a peer's stored identity key with 33 attacker-chosen bytes.

`isTrustedIdentity: () => true` also meant the engine performed no trust check
at all. It is inert — `oktz-signal` never calls it — but the live gap was the
TOFU write, which now happens only after the MAC verifies.

### A deferred event flush could kill the process — FIXED

`createBufferedFunction` flushed on a `setTimeout` outside any `try`/`catch`. A
throw in a user handler is an uncaught exception in a timer callback: no
promise, no rejection handler, and Node 22's `--unhandled-rejections=throw`
default takes the process down. Reproduced: `exit 1`.

`ev.flush()` in `processNodeWithBuffer` ran bare, outside the guarded region, and
the ignored-JID ack at `messages-recv.js:1608` had no `.catch()` where every
other ack site did. All are now contained.

## High

- **The resend budget was charged twice per receipt**, so
  `maxMsgRetryCount: 5` bought 2 resends. The cap is now charged once, on the
  ids that actually reach the wire.
- **`markRetrySuccess` ran before the resend**, deleting the retry counter and
  evicting the cached message ~80 lines before `relayMessage`. A failed resend
  could no longer be served.
- **`sender-key-memory` was persisted before the stanza was sent.** A failed
  `sendNode` left the distribution marked delivered, so the next group send
  shipped no distribution message and those devices could never decrypt another
  group message.
- **The peer-retry path was dead in the default configuration.** The fork ships
  no store, `enableRecentMessageCache` defaults to `false`, and `getMessage`
  defaults to `async () => undefined` — so a peer's retry receipts were burned
  silently at debug level. Now surfaced.
- **A partial fan-out reported success.** One stale device among five made
  `sendMessage` return a key while that device received nothing.
- **WABinary's encoder emitted frames its own decoder rejected.** The list-size
  prefix counted every non-null attribute while the body emitted only strings, so
  a numeric attribute desynced the frame. Non-string attribute values are now
  rejected rather than silently dropped.
- **`TOKEN_MAP[str]` resolved through `Object.prototype`.** A remote attribute
  value of `toString`, `constructor`, `__proto__`, `valueOf` or
  `hasOwnProperty` was **erased on the wire** — the encoder pushed
  `LIST_EMPTY` instead of the string. Attribute values include message text,
  `pushName`, `subject` and `notify`. The map is now null-prototype with an
  explicit `hasOwnProperty` guard.
- **Decode recursion was unbounded.** ~1500 nested lists in a **7.5 KB** frame
  exhausted the stack, and the resulting `RangeError` propagated to
  `end(err)`, destroying the connection. Now capped.
- **The Rust adapter silently fell back to a non-equivalent JS encoder**, so the
  same node produced different bytes depending on whether the native path
  succeeded — while its own comment claimed the normalisation existed. It does
  now.
- **The bot-profile USync parser discarded the entire query** on a `<bot>` node.
- **`domainType` leaked across devices** in the USync loop, so one hosted device
  flipped every later device of the same user to the hosted domain — silently
  dropping those devices from message fan-out.
- **`creds.json` was written non-atomically** and every read error was swallowed
  into a fresh identity. A torn write was indistinguishable from "no session", so
  the bot re-paired as a new device with no error. Writes are now
  temp-file + `fsync` + `rename`, and a present-but-unusable file is rejected
  rather than silently replaced.
- **A missing `oktz-curve25519` prebuild killed the entire library at import.**
  The library now loads everywhere: X25519 keygen and DH fall back to
  `node:crypto`, and XEdDSA delegates to `oktz-signal`, which is already a
  dependency and byte-compatible in both directions. Only a platform where
  *neither* binding exists throws — and it throws a typed error, not a
  successful-looking `false`.
- **`bufferToUInt` returned `NaN` instead of throwing** on a short buffer, which
  let a remote short `<id>` node inject `keyId: NaN` into the E2EE session store.
- **Untrusted protocol input was reordered, renamed or dropped without error**,
  so messages were applied to the wrong session, presented under the wrong
  sender, or skipped.

## Medium and low

Grouped, because the individual fixes are small next to the above.

- `end()` flushed the event buffer without delivering it, discarding the whole
  initial offline/history burst; it now flushes before teardown, and the teardown
  is unconditional even if a close listener throws.
- `end()` orphaned in-flight `query()` calls, which then reported
  success-by-timeout ~60s later; pending waiters are now rejected explicitly and
  deterministically.
- `waitForMessage` converted a query timeout into a resolved `undefined`, so
  `uploadPreKeys` logged "uploaded pre-keys successfully" while doing nothing.
  Timeouts now reject.
- A stale non-null socket made `connect()` a permanent silent no-op.
- WebSocket teardown kept the event loop alive 5s after close, and `close()` on
  an already-closed socket blocked the full 5s.
- The pre-key dedupe guard was cleared while the upload was still running,
  allowing duplicate uploads that the caller was told had failed.
- `jidNormalizedUser` could return a JID with an empty user, which read as "no
  owner"; `areJidsSameUser` returned `true` for two userless JIDs and across
  domains.
- `storeLIDPNMappings` accepted a reversed LID/PN pair and then persisted it
  inverted — the exact fabricated-mapping shape the preceding commit set out to
  eliminate.
- `onWhatsApp` dropped unmapped inputs and mis-aligned results, so a positional
  caller could mis-attribute a peer's existence. It now returns one entry per
  input, in order, in the caller's domain, distinguishing "not a contact"
  (`exists: false`) from "could not ask" (`exists: null`).
- `participantsIncludesMe` read a field the server often does not send, so
  `readOnly` was never set on your own removal.
- `sendPresenceUpdate` could announce the wrong own-identity for `@hosted.lid`
  chats, and emitted a stanza with no `from` at all when `me.lid` was unset.
- Business image uploads read the file before the write stream finished, and an
  `ENOSPC` terminated the process.
- A 200 MB sticker-pack cache lived outside the V8 heap, was never cleared, and
  could not be evicted. Capped at 32 MB and cleared on disconnect and logout.
- `node-cache`'s `maxKeys` throws rather than evicting; the message listener now
  evicts deterministically instead of dropping the rest of the batch.
- The `groupMetadata` sweep's own 800-entry cap was unreachable, so the cache
  was effectively unbounded.
- The profiler's ceilings measured the wrong quantity: `v8.writeHeapSnapshot`
  costs a stable **~6.7×** the resulting file size, not the assumed 2×.
- `noise-handler` could run two `processData` loops concurrently over a shared
  `inBytes`, emitting frames out of wire order.
- A bare `async ([event])` destructure in two connection handlers threw on a
  malformed event.
- `identity-change-handler` armed its 5s debounce before the early-returns, so a
  no-op handler poisoned the debounce for the real notification that followed.
- `readTcTokenIndex` returned `[]` for "no index", which is not the same answer
  as "nothing to prune".
- Newsletter, `tc-token`, and `decode-wa-message` error paths produced bare
  `TypeError`s or silently lost remaining `<enc>` children.
- 96 committed `.d.ts` files had drifted from the runtime; the ones this
  remediation touched are corrected by hand (there is no `tsconfig`, so nothing
  typechecks).

## Breaking behaviour changes

| Before | Now |
|---|---|
| `onWhatsApp` could return fewer entries than inputs | exactly one per input, in order |
| an unmapped `@lid` was dropped | `exists: null` |
| "not a WhatsApp user" was `[]` | `exists: false` |
| `query()` resolved `undefined` on timeout | **rejects** — add `.catch()` |
| `Curve.verify` always `true` | genuinely returns `false` — any code that relied on the old behaviour now fails |
| `sender-key` store key `…::undefined::0` | `…::628…::0` — every entry misses once and re-negotiates |
| `keys.get` returned `null` on a corrupt file | **throws** — guard the call |
| a corrupt `creds.json` fabricated a new identity | **throws**, and names the file |
| `getTcTokenIndex` returned `[]` | returns `undefined` |
| `deriveSecrets(n)` returned 3 blocks for any `n > 3` | returns `n`, or throws |

The `query()` and `Curve.verify` rows are the two most likely to surface on
upgrade. On Node 22 an unhandled rejection terminates the process.

## Platform support

| Platform | Library loads | E2EE |
|---|---|---|
| `linux-x64-gnu` | yes | works |
| `linux-arm64-gnu` / `musl` | yes | works, once CI publishes the binaries |
| `android-arm64` | yes | works, once CI publishes the binary |
| `darwin`, `win32` | **yes** | **fails at first E2EE use** with a typed error carrying `code: ONIGI_SIGNAL_ENGINE_UNSUPPORTED` |

`darwin` and `win32` previously failed at *import*, taking the whole library
with them. They now load; only the E2EE-dependent operations fail, and they say
why.

## Testing

| | Before | Now |
|---|---|---|
| `npm test` | 40 pass, 0 CI | **428 / 428**, in CI |
| `npm test` on Node 22 | `Cannot find module '.../tests'` | works |
| `docs:verify` | did not exist | 8 code blocks executed, 0 failures |
| CI matrix | 3 legs, all `ubuntu-latest`, identical commands | 1 honest leg, labelled for what it actually executes |
| publish artifact | never checked | `npm pack` → offline install → `import` |

The old matrix declared `linux-arm64-gnu` and `linux-arm64-musl` legs that all
ran on `ubuntu-latest` with the same commands. The labels claimed coverage that
did not exist; the new workflow states what is actually executed.

## Documentation

`README.md` and `README.id.md` were rewritten against the code. **10
performance figures and 4 platform-support statements were retracted** —
including "9× faster than upstream", "186× faster XEdDSA" and "+5.7% on
WABinary", none of which had a reproduction script. A version-lockfile claim
was flatly false and dead links to `BuildNative-*.md` files that do not exist
were removed. 118 claims verified, 31 corrected, 90 `file:line` citations
machine-resolved to the line they name.

`docs/quickstart.md`, `docs/api.md` and `docs/protocol.md` cite the
implementation, and `npm run docs:verify` executes the examples in CI so they
cannot rot.

## Known limitations

- **No `arm64` or `musl` binary is published yet.** Both need CI builds, and the
  `@oktz-signal/*` scope is not registered, so the platform-package route is
  currently unavailable.
- **This fork is unaudited.** No third-party review has been performed.
- **The pkmsg `identityKey` is not MAC-covered.** On an *established* session
  the decrypt routes through the stored session without calling `initIncoming`,
  so that field is never checked, and an established peer can rotate our
  identity pointer by replaying a seen pkmsg. Closing it means choosing a trust
  policy — reject outright, safety-number re-key, or keep TOFU — which is a
  product decision, not a bug fix.
- **The sender key does not rotate on group membership change.** A removed
  member retains the chain key and can read future group messages. Also a
  product decision.
- `src/crypto.js` is a second crypto implementation with **unauthenticated**
  AES-CBC helpers. Not a security primitive.
- All 196 committed sourcemaps are dead — each points into a `src/` tree that
  does not exist, none embed `sourcesContent`, and all 98 are stale in content.
