# Protocol

What this library actually puts on the wire, and what it actually checks.

Every line reference below is `file:line` against the tree at the commit this
document was written. Each claim is stated with what it is — an observation, a
check, a limit. Nothing here is asserted about WhatsApp's servers, because
nothing in this repository can observe them.

Contents:

1. [Frame layers](#1-frame-layers)
2. [The Noise XX handshake](#2-the-noise-xx-handshake)
3. [The WABinary wire format](#3-the-wabinary-wire-format)
4. [Pair-wise E2EE](#4-pair-wise-e2ee)
5. [Group E2EE](#5-group-e2ee)
6. [Session and key storage](#6-session-and-key-storage)
7. [Where the library refuses to proceed](#7-where-the-library-refuses-to-proceed)

---

## 1. Frame layers

A byte on the socket belongs to exactly one of these, outermost first:

```
ws frame
└── Noise frame                     lib/Utils/noise-handler.js:195
    │   3-byte big-endian length, then that many bytes
    │   (the very first write is additionally prefixed with the Noise header)
    └── WABinary node               lib/WABinary/encode.js:3
        │   0x00 = uncompressed, 0x01 = zlib-deflated (lib/WABinary/decode.js:17)
        └── protobuf Message         WAProto/index.js
```

The Noise header is `NOISE_WA_HEADER` = `[87, 65, 6, DICT_VERSION]`
(`lib/Defaults/index.js:25`), prefixed to the first write only. When the auth
state carries a `routingInfo` blob, the first write is instead prefixed with
`ED 0 1 <u8> <u16 len> <routingInfo> <NOISE_HEADER>`
(`lib/Utils/noise-handler.js:60-73`).

Inbound, `decodeFrame` (`:212`) accumulates into one shared buffer and runs a
single `processDataFrames` loop over it (`:121`). Frames are separated by the
3-byte length, not by message boundaries — a burst of ws messages is one byte
stream. The loop is serialised through `processChain` (`:120`) so two ws
messages arriving in one tick cannot interleave: both would find the shared
buffer, and a compressed frame (which inflates on the threadpool) would lose the
race to a later uncompressed one, reordering the stream.

---

## 2. The Noise XX handshake

Mode: `Noise_XX_25519_AESGCM_SHA256` padded to 32 bytes
(`lib/Defaults/index.js:22`). Because the mode string is exactly 32 bytes it is
used as the initial `h` directly rather than being hashed again
(`lib/Utils/noise-handler.js:41`).

### Client side

`socket.js:329` builds the clientHello and `awaitNextMessage` (`:311`) writes it.
Note that `awaitNextMessage` passes the **raw protobuf** to `sendRawMessage` —
the clientHello is not `noise.encrypt`ed, only length-prefixed.

`processHandshake` (`lib/Utils/noise-handler.js:164`) then does, in order:

| # | line | step |
|---|---|---|
| 1 | `:165` | `h = SHA256(h ‖ serverHello.ephemeral)` |
| 2 | `:166` | `mix( DH(client_ephemeral_private, serverHello.ephemeral) )` |
| 3 | `:167` | decrypt `serverHello.static` → the server's static public key |
| 4 | `:168` | `mix( DH(client_ephemeral_private, that key) )` |
| 5 | `:169` | decrypt `serverHello.payload` → the certificate chain |
| 6 | `:180` | verify the **leaf** against the key the intermediate's details carry |
| 7 | `:181` | verify the **intermediate** against `WA_CERT_DETAILS.PUBLIC_KEY` |
| 8 | `:188` | require `issuerSerial === WA_CERT_DETAILS.SERIAL` |
| 9 | `:191` | encrypt the client's noise key under the new key |
| 10 | `:192` | `mix( DH(noise_private, serverHello.ephemeral) )` |

`mixIntoKey` (`:92`) is `hkdf(input, 64, { salt, info: '' })`; the first half
becomes the new salt, the second half becomes both the encrypt and decrypt key,
and the counter resets to zero.

### What step 6 and 7 mean

These two lines are the entire reason this handshake authenticates the server,
and they were not doing anything until commit `42d416d`.

`Curve.verify` (`lib/Utils/crypto.js:36`) delegates to
`curve.verifySignature` (`lib/Modded/curve-native.js:216`). The underlying
`oktz-curve25519` returns `false` on a mismatch rather than throwing the way
`curve25519-js` did. The result was being discarded and the function
`return true`'d unconditionally, so **every signature of a plausible shape
verified**. Both the Noise chain (steps 6, 7) and the ADV pairing signature
(`lib/Utils/validate-connection.js:157`) were no-ops, and the websocket carried
no authentication of the peer at all.

The current shape (`lib/Utils/crypto.js:36-47`):

- returns the native boolean;
- keeps a `try`/`catch` on purpose — `scrubPubKeyFormat`
  (`lib/Modded/curve-native.js:79`) throws on a wrong-length public key, and that
  case must also answer `false`, not propagate;
- on a platform with no XEdDSA implementation at all, the error carries
  `code: 'ONIGI_XEDDSA_UNSUPPORTED'` (`lib/Modded/curve-native.js:100`) and the
  first occurrence is surfaced as a process warning. Before that, an
  unverifiable platform was indistinguishable from a forged signature: both
  surfaced as `noise certificate signature invalid` and both returned `false`.

`tests/curve-verify.test.mjs` pins the four rejections: a 1-bit-flipped
signature, an all-zero signature, a signature made by a different key, and
random bytes. `tests/curve-verify-diagnosis.test.mjs` and
`tests/curve-platform-fallback.test.mjs` cover the platform side.

**What is verified here is the arithmetic.** That the chain is well-formed, that
the signatures check out against the pinned root, and that a forged chain is
rejected. This repository has no test against a live WhatsApp server, and makes
no claim about one.

### Transport state

`finishInit` (`:99`) runs the same `hkdf` with a zero-length input and splits
the output into independent read and write keys. `TransportState` (`:13`) then
uses a 12-byte IV whose last 4 bytes are a big-endian counter, incremented per
frame in each direction, with no AAD.

### OBSERVATION: the handshake cannot complete against a local server

`examples/01-connect.mjs` runs the real handshake against
`examples/helpers/local-wa-server.mjs`, which implements the server half of the
same key schedule. The result is instructive and is reproduced here rather than
papered over:

```
clientHello: 36 bytes, ephemeral 32 bytes, re-encodes identically
client refused the server certificate: "noise intermediate certificate signature invalid"
```

The key schedule matched in both directions — the client decrypted the server's
`static` and `payload` successfully, which it could not have done against a
server that computed the schedule differently. What failed is step 7, because
`WA_CERT_DETAILS.PUBLIC_KEY` (`lib/Defaults/index.js:28`) is WhatsApp's real
long-term key and its private half is not in this repository.

This is the correct outcome, and it is the only honest way to show that step 7
is live. The transport keys are therefore never negotiated in any example, and
no example claims to demonstrate a `sendMessage` over a real transport.

---

## 3. The WABinary wire format

A node is a **list** of tokens (`lib/WABinary/encode.js:190`):

```
list size = 2 × (attribute count) + 1 (the tag) + (1 if there is content)
```

then the tag, then alternating attribute name / value strings, then content.

### String encoding

`writeString` (`lib/WABinary/encode.js:142`) picks, in order:

1. `LIST_EMPTY` byte for `undefined` / `null` (`:136`);
2. a dictionary token, if the string is in `TOKEN_MAP` (`:145`);
3. `NIBBLE_8` packing, if every character is a digit, `-` or `.` (`:150`);
4. `HEX_8` packing, if every character is `0-9A-F` (`:152`);
5. a compact JID form, if the string parses as one (`:156`);
6. otherwise a raw length-prefixed UTF-8 string (`:159`).

### The encoder refuses what it cannot encode faithfully

The list-size prefix counts every non-null attribute. An encoder that declared a
token and then skipped writing the value desyncs the frame — the library's own
decoder rejects it. So a non-string attribute value is a hard error
(`lib/WABinary/encode.js:196`):

```js illustrative
if (typeof attrs[key] !== 'string') {
    throw new Error(`invalid attribute "${key}" for header "${tag}": expected string, got ${typeof attrs[key]}`);
}
```

`undefined` and `null` are *different* from that: they are absent, filtered out
of `validAttributes` at `:189`, and skipped. `tests/wabinary-encode-attr-types.test.mjs`
pins both halves, and pins the exact byte sequence of a well-formed frame.

### The token table has a null prototype

`TOKEN_MAP` is `Object.create(null)` (`lib/WABinary/constants.js:1295`), and
lookups go through `Object.prototype.hasOwnProperty.call`
(`lib/WABinary/encode.js:144`). With an ordinary object literal as the table, a
remote attribute value of `toString`, `constructor` or `__proto__` resolved to a
dictionary token and vanished from the wire.
`tests/wabinary-encode-proto.test.mjs` asserts that each of those eight names
round-trips.

### The decoder refuses hostile frames

| limit | value | line | why |
|---|---|---|---|
| inflate output | 16 MiB | `decode.js:8` | a compression bomb cannot exhaust the heap |
| node nesting | 128 levels | `decode.js:12` | a 7.5 KB frame reached ~1500 levels and overflowed the stack; the `RangeError` is not caught upstream and tore down the socket |
| empty frame | rejected | `decode.js:15` | `end of stream`, not a phantom node |

`tests/wabinary-decode-hardening.test.mjs` asserts all three, and asserts that
the deepest structure the library itself builds still decodes.

### The native encoder

`lib/WABinary/rust-adapter.js` wraps `whatsapp-rust-bridge` 0.5.4, which is a
**WebAssembly** module — its `dist/index.js` inlines the wasm as base64
(`WebAssembly.Module` / `WebAssembly.Instance` are constructed at load, and no
`.wasm` or `.node` file is installed). Two switches:

- `ONIGI_RUST_WABINARY=0` — disable the native encoder entirely (`:7`);
- `ONIGI_RUST_WABINARY_DECODE=1` — opt in to native decoding (`:9`).

Both are off for decode and on for encode by default. Decode is opt-in because
the wrapper's node-to-plain conversion allocates and copies; the comment at `:9`
records that measurement, and it is the only performance statement in this file.

`divergesFromJs` (`:20`) is the reason the adapter is not a straight
pass-through. Two shapes encode **without throwing** and still differ:

- a non-string attribute — the native encoder stringifies it, the JS encoder
  rejects it;
- an empty-string attribute — the native encoder drops it, the JS encoder keeps it.

Neither is visible as an error, so the adapter routes those nodes to the JS
encoder by shape, before calling native at all. `tests/wabinary-rust-adapter-parity.test.mjs`
asserts the byte-equality of the two encoders on the shapes both handle, and
that the adapter returns the JS encoding on exactly the two shapes where they
diverge. A native throw falls back to JS with a rate-limited warning (`:13`).

---

## 4. Pair-wise E2EE

Engine: `oktz-signal` 0.3.0-rc.1, a Rust implementation behind NAPI. It
replaces GPL-3.0 `libsignal`. `lib/Signal/libsignal.js` is the whole wrapper.

### The engine is loaded on first use, never at import

```js illustrative
let enginePromise;
const engine = () => (enginePromise ??= import('oktz-signal').catch((cause) => {
    throw new SignalEngineUnavailableError(cause);
}));
```
`lib/Signal/libsignal.js:44`

A top-level `import * as libsignal from 'oktz-signal'` is evaluated while the
module graph is built, and that package's loader throws `Cannot find native
binding` on any platform outside its four `optionalDependencies`. The throw took
down `lib/index.js` itself, so on darwin and win32 the library was
**unimportable** — for code paths that never touch E2EE. The lazy form moves the
failure to the first E2EE call. A rejected promise is cached too, so a platform
with no prebuild does not re-enter the loader once per message.

One symbol is still imported statically: `ProtocolAddress` from
`oktz-signal/src/protocol-address.js` (`:6`). That keeps
`jidToSignalProtocolAddress` (`:382`) synchronous, which the public repository
shape depends on. `tests/signal-lazy-engine.test.mjs` asserts that the subpath
still resolves to the module the engine entry re-exports from, so a local
reimplementation cannot silently change the address type the engine stores.

### The repository surface

`makeLibSignalRepository` (`:75`) returns:

| method | line | behaviour |
|---|---|---|
| `encryptMessage({jid, data})` | `:161` | `type` is `'pkmsg'` when the engine reports signal type 3, else `'msg'` |
| `decryptMessage({jid, type, ciphertext})` | `:124` | see below |
| `encryptGroupMessage` | `:172` | returns `{ ciphertext, senderKeyDistributionMessage }` |
| `getSenderKeyDistributionMessage` | `:179` | the SKDM alone |
| `hasSenderKey` | `:185` | a store-slot existence check, not a session check |
| `processSenderKeyDistributionMessage` | `:104` | ingests a peer's SKDM |
| `decryptGroupMessage` | `:96` | |
| `getSessionInfo` | `:190` | `{ baseKey, registrationId }` or `null` |
| `validateSession` | `:234` | `{ exists, reason? }` — never fabricates an answer |
| `injectE2ESession` | `:219` | `SessionBuilder.initOutgoing` from a prekey bundle |
| `deleteSession(jids)` | `:252` | one transaction, all jids |
| `migrateSession(from, to)` | `:271` | PN → LID, bulk, cached |
| `lidMapping` | `:233` | the `LIDMappingStore` |
| `close()` | `:267` | |

`validateSession` awaits the engine **outside** its `try` (`:235`): returning
`{ exists: false }` for a platform that simply has no engine would be a
fabricated answer, not a reported failure. The same reasoning is why
`getSessionInfo` (`:191`) parses outside its `try`.

### Session state is persisted after authentication, not before

This is the fix in commit `9c64fc7`, and it is load-bearing.

A `pkmsg` wrapper's `identityKey` field is **not covered** by the MAC that
`ratchetDecryptPkmsg` verifies. And `parsedKeys.transaction` is a promise chain
keyed by jid — `parsedKeys` at `lib/Signal/libsignal.js:78`, first used at
`:97` — is a mutex, not a rollback. So the previous order, which called
`saveIdentity` *before* decrypting, meant a single unauthenticated `pkmsg` could:

1. delete an established session, and
2. overwrite the stored identity key for that address,

before the MAC ever failed. A forged message could permanently brick a
conversation and poison a stored identity.

The current order (`lib/Signal/libsignal.js:135`, `:150-157`):

```js illustrative
const pendingIdentity = type === 'pkmsg'
    ? extractIdentityFromPkmsg(ciphertext, PreKeyWhisperMessage)
    : undefined;
// …decrypt inside the transaction…
const decrypted = await doDecrypt();
if (pendingIdentity) {
    const identityChanged = await storage.saveIdentity(addr.toString(), pendingIdentity);
}
return decrypted;
```

`extractIdentityFromPkmsg` (`:54`) only *reads*. The write happens after
`doDecrypt()` resolved, so the MAC has passed. `saveIdentity` (`:480`) no longer
clears the session: by that point the engine has already stored a session
derived from the very message that authenticated, so clearing would discard a
working session on every legitimate re-key.

`tests/signal-auth-before-persist.test.mjs` pins this. The behaviour is
demonstrated live in `examples/02-e2ee-roundtrip.mjs`.

### Trust model

`isTrustedIdentity: () => true` (`:472`) — trust on first use, the same posture
WhatsApp Web takes. There is no safety-number check in this library and none is
claimed.

### Key material

| what | source | where |
|---|---|---|
| X25519 keygen / DH | `oktz-curve25519`, falling back to `node:crypto` | `lib/Modded/curve-native.js:184`, `:159` |
| XEdDSA sign / verify | `oktz-signal`'s native binding first, then `oktz-curve25519` | `lib/Modded/curve-native.js:115`, `:126` |
| AES-256-GCM | `node:crypto` | `lib/Utils/crypto.js:60` |

The XEdDSA delegation order is deliberate: `oktz-signal` publishes four
prebuilds via `optionalDependencies`, `oktz-curve25519` publishes exactly one
(`curve25519.linux-x64-gnu.node`) with no `optionalDependencies`, so importing it
statically killed the whole library on every other platform
(`lib/Modded/curve-native.js:20-30`). Both are loaded through
`createRequire` inside `try`/`catch`, so a missing prebuild degrades rather than
throws.
`tests/curve-xeddsa-dispatch.test.mjs` asserts the two implementations produce
byte-compatible signatures in both directions.

---

## 5. Group E2EE

`lib/Signal/Group/*` was carried over from `@whiskeysockets/baileys` 7.0.0-rc14
byte for byte, and it was written against `libsignal`'s `ProtocolAddress`, which
exposes the sender as `.id`.

### The sender-key store slot

The engine this tree runs on, `oktz-signal`, names that field `name`
(`oktz-signal/src/protocol-address.js`), and `jidToSignalSenderKeyName`
(`lib/Signal/libsignal.js:395`) builds exactly that type. So
`SenderKeyName.serialize()` read `this.sender.id` and produced `undefined` for
every sender (`lib/Signal/Group/sender-key-name.js:34`):

```
group member A key: 120363@g.us::undefined::0
group member B key: 120363@g.us::undefined::0
```

Every member of a group shared one store slot. Two consequences, both from the
same root:

1. **Group sending wedged permanently.** After one group message was decrypted,
   `getSenderKeyState()` returned the *remote* member's state
   (`sender-key-record.js:18`), whose `senderSigningKey.private` is empty, so
   `calculateSignature` throws `Incorrect private key length: 0`. `hasSenderKey`
   still answered `true` — the slot exists — so the create path in
   `messages-send.js` was never taken, and nothing self-healed.
2. **A member's chain-key seed was disclosed to the whole group.**
   `getSenderKeyDistributionMessage` rebroadcast the remote member's keyId,
   chain-key seed and signing public key as the local user's own, to every
   device in the group.

The serialisation also silently disagreed with `equals()` and `hashCode()` in
the same file, which already resolved the sender through `toString()`
(`name.deviceId`): two members compared *unequal* while serialising *identically*.

The fix is one line — `sender.name`, not `sender.id`
(`lib/Signal/Group/sender-key-name.js:34`, commit `4ca7553`) — and
`tests/sender-key-name-address.test.mjs` pins all six properties, including that
the serialised name agrees with the `toString()` of the address it wraps. No
migration is needed: a key-format change is self-healing, because a miss makes
`hasSenderKey` answer `false`, `GroupSessionBuilder.create` runs
(`group-session-builder.js:14`), a fresh sender key is created and a new SKDM is
sent.

### The group cipher

`GroupCipher` (`lib/Signal/Group/group_cipher.js`):

- `encrypt` (`:11`) takes the current chain-key iteration, derives the message
  key, encrypts under AES-256-CBC with the message key as the key and the IV as
  the IV (`oktz-signal/src/crypto.js`), then **persists the record before
  returning** (`:24`). A crash after the write but before the send costs a
  skipped iteration, never a replay.
- `decrypt` (`:27`) selects state by keyId, verifies the sender signature at
  `:40` **before** touching the ciphertext, then derives the message key.
- `getSenderKey` (`:43`) refuses a message more than 2000 iterations in the
  future (`:56`), and derives forward from the stored chain key, retaining
  skipped message keys so an out-of-order message is still decryptable.
- `SenderKeyRecord` keeps at most `MAX_STATES = 5` states
  (`sender-key-record.js:5`), so a peer that rotates does not grow the record
  without bound.

### Addressing inside a group

`sendMessage` (`lib/Socket/messages-send.js:1194`) stamps `contextInfo.participant`
and the outgoing message with a `userJid` chosen from *the chat's* addressing, not
from the message type. For a LID chat or a LID-addressed group it is
`creds.me.lid`; otherwise `creds.me.id` (`:1202-1217`). The bug this replaced
tested the chat's server, which is never `lid` for a `@g.us` jid, so every group
used the phone-number identity while `relayMessage` used the LID for the sender
key and stamped `addressing_mode="lid"` on the stanza — the message announced one
identity and was signed with another.

On the receive side, `messages-recv.js` derives the same identity from the same
chat addressing, and the sender-key identity for a retry resend is whichever of
`meLid` / `meId` already has a slot (`:756-766`), with the SKDM re-attached to
the resent message (`:766-781`).

---

## 6. Session and key storage

Everything goes through `auth.keys` — an async key/value store with `get`, `set`,
`del` and `transaction`. The store is supplied by the caller.
`useMultiFileAuthState` (`lib/Utils/use-multi-file-auth-state.js:32`) is one
implementation of it, on disk.

| namespace | key shape | written by |
|---|---|---|
| `session` | `<signalAddress>` | `lib/Signal/libsignal.js:468` |
| `identity-key` | `<signalAddress>` | `lib/Signal/libsignal.js:491` |
| `pre-key` | `<preKeyId>` | `lib/Signal/libsignal.js:494` |
| `sender-key` | `<groupId>::<name>::<deviceId>` | `lib/Signal/libsignal.js:520` |
| `device-list` | `<user>` | `messages-send.js` |
| `app-state-sync-key` | `<chatId>` | `messages-recv.js` |

A signal address is `name.deviceId` (`:382`). For a non-PN domain the name is
`user_<domainType>` (`:388`), so `888777666555:2@lid` and
`15551234567:2@s.whatsapp.net` cannot collide.

### `pruneSessionRecord`

`storeSession` runs on nearly every message, so it prunes with a cheap scalar
gate first (`:407`): the JSON is only parsed if it contains more than `keep` (8)
`"indexInfo"` occurrences. When it does parse, closed sessions are dropped
oldest-first by `indexInfo.created` and **open** sessions
(`closed === -1`) are always preserved (`:421`). Malformed input passes through
untouched (`:430`).

### `transaction` is a mutex

It is a per-key promise chain, not a rollback. `tests/` asserts this in several
places; the property that matters is the one in §4 — a write committed before a
later failure survives that failure.

---

## 7. Where the library refuses to proceed

Collected, because "what does it do when it cannot do the thing" is more useful
than a success path.

| condition | result | line |
|---|---|---|
| engine has no native prebuild | `Error` with `code: 'ONIGI_SIGNAL_ENGINE_UNSUPPORTED'`, `name: 'SignalEngineUnavailableError'`, message names the platform, the engine and the package to install, and the loader's own error is kept as `cause` | `lib/Signal/libsignal.js:20` |
| no XEdDSA on this platform at all | `XEdDsaUnavailableError` with `code: 'ONIGI_XEDDSA_UNSUPPORTED'`; `Curve.verify` returns `false` and warns once | `lib/Modded/curve-native.js:100` |
| Noise leaf/intermediate certificate does not verify | `Boom` 400, connection torn down | `lib/Utils/noise-handler.js:182-187` |
| ADV pairing signature does not verify | `Boom('Failed to verify account signature')` | `lib/Utils/validate-connection.js:157` |
| ADV pairing HMAC does not match | `Boom('Invalid account signature')` | `lib/Utils/validate-connection.js:148` |
| non-string attribute on encode | `Error` naming the attribute and the header | `lib/WABinary/encode.js:196` |
| frame nests past 128 levels | `Error('node nesting too deep')` — never a `RangeError` | `lib/WABinary/decode.js:28` |
| inflate would exceed 16 MiB | `zlib` refuses | `lib/WABinary/decode.js:18` |
| `authSession.creds` has no `me.id` | `assertMeId` throws | `lib/Socket/messages-send.js:513` |
| `assertSessions` given a jid it cannot fetch a session for | `Boom` naming the unsupported jids | `lib/Socket/messages-send.js:351` |
| a LID with no phone-number mapping, passed to `onWhatsApp` | `{ jid, exists: null }` — logged, never turned into a fabricated number | `lib/Socket/socket.js:232-241` |
| a server row the query never answered | `{ jid, exists: null }` — distinct from `false` | `lib/Socket/socket.js:266-270` |
| a self-only `protocolMessage` from a non-self origin | dropped, with a warning | `lib/Utils/process-message.js:228-239` |
| a message that fails to decrypt | stub type `CIPHERTEXT`, the error is logged with the full context, the stanza is not lost | `lib/Utils/decode-wa-message.js:285-297` |
| a user event handler that throws or rejects | reported on `'error'` with the list of events whose delivery ran it | `lib/Utils/event-buffer.js` |
| a query the server never answers | rejects; `end()` rejects every in-flight waiter | `lib/Socket/socket.js:89-95`, `:513-540` |

`tests/signal-lazy-engine.test.mjs` is worth calling out specifically: it
simulates the exact shape of a darwin/win32 install by redirecting every route
to `oktz-signal`'s native binding at a stub that throws what the real NAPI
loader throws, then asserts that the import succeeds, that the engine is *not*
loaded at import, that the first E2EE use loads it exactly once, that a failed
load is cached, and that the non-E2EE surface (JIDs, WABinary, protobuf) still
works. It also asserts that a missing engine is never reported as a missing
session or a missing identity key — `getSessionInfo` and `validateSession` both
swallow every error they see, and a missing engine reaching them as a catch would
read as "no session" and silently disable E2EE.
