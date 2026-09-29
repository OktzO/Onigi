# API

`lib/index.js` exports **282 symbols**. This document does not list them one by
one. A 282-row table that nobody checked is worse than no table, and the honest
thing is to say what each group is for, where it lives, and how to read the exact
signature.

Two places have exact, generated truth:

- `lib/**/*.d.ts` — 99 hand-maintained declaration files (98 under `lib/`, 1 under
  `WAProto/`). There is no `tsconfig.json` and no `tsc` in this tree, so these
  are **not** build output; they are committed artifacts that
  `tests/dts-declarations.test.mjs` keeps honest against the runtime. Read the
  `.d.ts` next to the module for a signature.
- `WAProto/WAProto.proto` — the protobuf definitions. `WAProto/index.d.ts` is
  generated from it and is the authoritative list of message types.

## How to read a symbol in this document

| notation | means |
|---|---|
| `name(sig)` | read from the `.d.ts` next to the implementation |
| `file:line` | verified line in the implementation at the commit this was written |

Anything not marked with a `file:line` is a grouping, not a claim about a
specific function.

---

## 1. The socket

`makeWASocket(config)` is the default export. It merges your config over
`DEFAULT_CONNECTION_CONFIG` (`lib/Socket/index.js:4`) and returns a socket
composed of eight layers, each spreading the one below it:

```
communities → business → newsletter → groups → messages → chats → socket
```

It has **170 own properties**. They are grouped below by concern; the full list
is what `Object.keys(sock)` prints, and the tests in `tests/` build a real socket
to do it.

### Connection

| member | file:line | notes |
|---|---|---|
| `sock.user` | `lib/Socket/socket.js:1028` | a **getter** returning `authState.creds.me`. It has `.id` and optionally `.lid`. There is no `sock.user.jid` in this library — code that reads it gets `undefined` and stamps a null participant onto group messages. Use `normalizeUserJid(sock)`. |
| `sock.type` | `lib/Socket/socket.js:1023` | the string `'md'` |
| `sock.ws` | `lib/Socket/socket.js:1024` | the `WebSocketClient`. Emits `'open'`, `'close'`, `'error'`, `'message'`, and the internal `'frame'`, `'TAG:<id>'`, `'CB:<tag>'` channels. |
| `sock.ev` | `lib/Socket/socket.js:1025` | see §2 |
| `sock.authState` | `lib/Socket/socket.js:1026` | `{ creds, keys }` |
| `sock.signalRepository` | `lib/Socket/socket.js:1027` | see §5 |
| `sock.query(node, timeoutMs?)` | `lib/Socket/socket.js:127` | send an `<iq>` and await the `<iq type="result">` with the same id |
| `sock.waitForMessage(msgId, timeoutMs?)` | `lib/Socket/socket.js:89` | await a specific `TAG:` answer |
| `sock.waitForSocketOpen()` | `lib/Socket/socket.js:587` | |
| `sock.waitForConnectionUpdate` | `lib/Socket/socket.js:1050` | pre-bound, returns a promise for the next `connection.update` |
| `sock.end(error?)` | `lib/Socket/socket.js:507` | teardown. Idempotent, flushes the event buffer, rejects every in-flight query. |
| `sock.logout()` | `lib/Socket/socket.js:650` | unlink this device, then tear down. Resolves only after the teardown finishes. |
| `sock.registerSocketEndHandler(fn)` | | run `fn` on every teardown |
| `sock.onUnexpectedError(fn)` | `lib/Socket/socket.js:307` | replace the default error reporter |
| `sock.sendNode(node)` | `lib/Socket/socket.js:75` | WABinary-encode and send one frame |
| `sock.sendRawMessage(buffer)` | `lib/Socket/socket.js:59` | send bytes as one Noise frame |
| `sock.executeUSyncQuery(query)` | `lib/Socket/socket.js:174` | the usync primitive |
| `sock.onWhatsApp(...jids)` | `lib/Socket/socket.js:224` | see §7 |
| `sock.sendPresenceUpdate(...)` | `lib/Socket/chats.js:626` | |
| `sock.presenceSubscribe(...jids)` | `lib/Socket/chats.js:677` | |
| `sock.serverProps` | | whatever the server announced at login |
| `sock.requestPairingCode(phone)` | | pair by 8-character code instead of QR |
| `sock.uploadPreKeys(count?)` | `lib/Socket/socket.js:383` | |
| `sock.uploadPreKeysToServerIfRequired()` | | |
| `sock.digestKeyBundle()` \| `rotateSignedPreKey()` \| `updateServerTimeOffset()` | | session maintenance |
| `sock.wamBuffer` / `sendWAMBuffer(buffer)` | | WhatsApp-Met analytics buffer |
| `sock.fetchAccountReachoutTimelock()` | `lib/Socket/socket.js:1003` | |
| `sock.fetchNewChatMessageCap()` | `lib/Socket/socket.js:1019` | |
| `sock.fetchPrivacySettings()` | `lib/Socket/chats.js` | and one setter per privacy key |
| `sock.createCallLink()` | | |

### Messages

| member | file:line | notes |
|---|---|---|
| `sock.sendMessage(jid, content, options?)` | `lib/Socket/messages-send.js:1194` | the one you will use most. See below. |
| `sock.relayMessage(jid, message, opts)` | `lib/Socket/messages-send.js:512` | send an already-built `proto.Message`. |
| `sock.readMessages(keys)` | `lib/Socket/messages-send.js:159` | mark as read |
| `sock.sendReceipt(...)` / `sendReceipts` / `sendMessageAck` | | delivery and read receipts |
| `sock.assertSessions(jids, force?)` | `lib/Socket/messages-send.js:327` | make sure a session exists. Throws on a jid it cannot fetch one for. |
| `sock.updateMediaMessage(key, media)` | | re-upload a message after the media key expired |
| `sock.messageRetryManager` | `lib/Socket/messages-send.js` | the whatsmeow-style retry queue |
| `sock.sendRetryRequest(msg)` | `lib/Socket/messages-recv.js` | placeholder resend |
| `sock.requestPlaceholderResend(key)` | | |
| `sock.fetchMessageHistory(count, oldest, options?)` | `lib/Socket/messages-recv.js` | |
| `sock.rejectCall(id, callFrom)` | | |
| `sock.refreshMediaConn(message)` | | re-establish a media connection |
| `sock.createParticipantNodes(...)` | | |
| `sock.sendPeerDataOperationMessage(...)` | | |
| `sock.getUSyncDevices(jids, useCache)` | `lib/Socket/messages-send.js` | device lists, which drive prekey fetch |

#### `sendMessage(jid, content, options)`

`content` is a `proto.IMessage` shape. The fields this library reads:

`text`, `conversation`, `image`, `video`, `audio`, `document`, `sticker`,
`caption`, `mimetype`, `ptt`, `ptv`, `gif`, `ephemeral`, `viewOnce`,
`disappearingMessagesInChat`, `buttonsMessage`, `listMessage`,
`interactiveMessage`, `nativeFlowMessage`, `templateMessage`, `poll`, `location`,
`contact`, `reaction`, `protocolMessage`, `botForwardedMessage`, and the
`Mentions` array inside `contextInfo`.

`options`:

| option | effect |
|---|---|
| `quoted` | the message key being quoted |
| `mentions` | JIDs to @-mention |
| `linkPreview` | override link-preview generation |
| `upload` | override the media uploader |
| `mediaCache`, `options` | passed through to `generateWAMessage` |
| `useCachedGroupMetadata` | skip a metadata fetch; defaults to `true` |
| `statusJidList` | fan-out destinations for a status post |

`sendMessage` picks the sender identity from the **chat's** addressing, not the
message type (`lib/Socket/messages-send.js:1202`): `creds.me.lid` for a LID chat
or a group whose metadata says `addressing_mode` is `lid`, `creds.me.id`
otherwise. That same value is stamped into `contextInfo.participant`. See
[protocol.md §5](protocol.md#addressing-inside-a-group).

### Chats, contacts, profile

`chatModify` (`lib/Socket/chats.js:835`) is the single entry point for chat
mutations. `upsertMessage` (`:949`), `profilePictureUrl`, `fetchBlocklist`,
`fetchStatus`, `fetchDisappearingDuration`, `updateProfileName`,
`updateProfileStatus`, `updateProfilePicture`, `removeProfilePicture`,
`updateBlockStatus`, `star`, `addOrEditContact`, `removeContact`,
`addOrEditQuickReply`, `removeQuickReply`, `resyncAppState`, `cleanDirtyBits`,
one `update<Setting>Privacy` setter per privacy key, and the label API
(`addLabel`, `addChatLabel`, `addMessageLabel`, and their `remove` counterparts).

### Groups

`groupMetadata` (`lib/Socket/groups.js:19`) and, for a full surface,
`groupCreate`, `groupLeave`, `groupUpdateSubject`,
`groupRequestParticipantsList`, `groupRequestParticipantsUpdate`,
`groupParticipantsUpdate`, `groupUpdateDescription`, `groupInviteCode`,
`groupRevokeInvite`, `groupAcceptInvite`, `groupRevokeInviteV4`,
`groupAcceptInviteV4`, `groupGetInviteInfo`, `groupToggleEphemeral`,
`groupSettingUpdate`, `groupMemberAddMode`, `groupJoinApprovalMode`,
`groupFetchAllParticipating`.

`groupMetadata` returns `GroupParticipant[]` where each entry has `id`, `admin`
and `isAdmin`, `isSuperAdmin`. The `admin` string and the two booleans are all
populated — a participant with no `type` attribute is neither, which is not the
same as "not an admin" and is reported that way
(`tests/group-participant-admin.test.mjs`).

### Communities, newsletters, business

- communities — `communityMetadata` (`lib/Socket/communities.js:19`) plus
  `communityCreate`, `communityCreateGroup`, `communityLeave`,
  `communityLinkGroup`, `communityUnlinkGroup`, `communityFetchLinkedGroups`,
  `communityInviteCode`, `communityAcceptInvite(V4)`, `communityGetInviteInfo`,
  `communityToggleEphemeral`, `communityMemberAddMode`,
  `communityJoinApprovalMode`, and the participant-request trio.
- newsletters — `newsletterCreate` (`lib/Socket/newsletter.js:61`),
  `newsletterUpdate`, `newsletterFollow`, `newsletterUnfollow`, `newsletterMute`,
  `newsletterUnmute`, `newsletterDelete`, `newsletterSubscribers`,
  `newsletterMetadata`, `newsletterFetchMessages`, and the
  name/description/picture setters.
- business — `getBusinessProfile`, `getCatalog`, `getCollections`,
  `getOrderDetails`, `productCreate`, `productDelete`, `productUpdate`,
  `updateBussinesProfile` (sic — the typo is in the upstream surface),
  `updateCoverPhoto`, `removeCoverPhoto`.

---

## 2. Events

`sock.ev` is a `BaileysEventEmitter` with `on`, `off`, `removeAllListeners` and
`emit`. It is **not** a Node `EventEmitter` and has no `once`, no `onceAny`, no
`prependListener`, and no `setMaxListeners`. A one-shot listener is `on` plus
`off`.

There is also no `sock.ev.lastDisconnect`. The disconnect reason arrives on the
`connection.update` payload itself, as `lastDisconnect: { error, date }`, where
`error` is a `@hapi/boom` `Boom` and the status code is at
`error.output.statusCode`. This is checked against a real socket built by
`tests/helpers/ev-socket-harness.mjs`, not inferred.

The full map, with payload shapes, is `lib/Types/Events.d.ts`
(`BaileysEventMap`). The names:

`error` · `connection.update` · `creds.update` · `messaging-history.set` ·
`messaging-history.status` · `chats.upsert` · `chats.update` · `chats.delete` ·
`chats.lock` · `lid-mapping.update` · `presence.update` · `contacts.upsert` ·
`contacts.update` · `messages.upsert` · `messages.update` · `messages.delete` ·
`messages.reaction` · `messages.media-update` · `message-receipt.update` ·
`groups.upsert` · `groups.update` · `group-participants.update` ·
`group.join-request` · `group.member-tag.update` · `blocklist.set` ·
`blocklist.update` · `call` · `labels.edit` · `labels.association` ·
`newsletter.reaction` · `newsletter.view` · `newsletter-participants.update` ·
`newsletter-settings.update` · `message-capping.update` · `settings.update`

### `error` carries two arguments

```ts illustrative
on(event: 'error', listener: (err: Error, events: string[]) => void): void;
```

`events` names the events whose delivery ran the failing handler, so one throw
can be attributed. The library only emits `'error'` when a listener is attached;
an unlistened `'error'` emit throws, so with no listener the failure goes to the
logger instead. `tests/event-buffer-handler-errors.test.mjs` and
`tests/ev-error-channel.test.mjs` pin this.

### Buffering

Events are coalesced by the event buffer (`lib/Utils/event-buffer.js:25`) and
flushed on a timer or on `end()`, whichever comes first. `messages.upsert`,
`chats.*`, `contacts.*`, `messaging-history.set` and friends arrive in a batch
with `type: 'notify'`. `end()` flushes rather than dropping
(`tests/lifecycle-end-flushes-buffer.test.mjs`,
`tests/teardown-deferred-flush-chats.test.mjs`).

---

## 3. Configuration

`DEFAULT_CONNECTION_CONFIG` (`lib/Defaults/index.js:48`) is exported, so you can
read a default rather than guess it:

| option | default | why you would change it |
|---|---|---|
| `browser` | `Browsers.macOS('Chrome')` | the identity announced at login |
| `waWebSocketUrl` | `wss://web.whatsapp.com/ws/chat` | point at a proxy |
| `connectTimeoutMs` | `20000` | |
| `keepAliveIntervalMs` | `30000` | |
| `defaultQueryTimeoutMs` | `60000` | |
| `emitOwnEvents` | `true` | set `false` to stop receiving your own messages |
| `fireInitQueries` | `true` | `false` skips the startup query burst — useful for tests |
| `syncFullHistory` | `false` | already frugal; `true` pulls full history |
| `enableRecentMessageCache` | `false` | already frugal; `true` keeps recent messages in RAM |
| `enableAutoSessionRecreation` | `true` | |
| `generateHighQualityLinkPreview` | `false` | |
| `markOnlineOnConnect` | `true` | |
| `appStateMacVerification` | `{ patch: true, snapshot: true }` | app-state MAC checks |
| `maxMsgRetryCount` | `5` | |
| `retryRequestDelayMs` | `250` | |
| `shouldSyncHistoryMessage` | everything except `FULL` | |
| `shouldIgnoreJid` | `() => false` | |
| `getMessage`, `cachedGroupMetadata`, `patchMessageBeforeSending` | identity | |
| `makeSignalRepository` | `makeLibSignalRepository` | supply your own Signal store |

`printQRInTerminal` is accepted and **deprecated** — it logs a warning and does
nothing. Read the QR from `connection.update` instead.

`mobile: true` and a `tcp:` URL both throw: the mobile API is not supported.

### The auth store

`auth` is `{ creds, keys }`.

`keys` must provide:

```ts illustrative
get(type, ids?: string[]): Promise<Record<string, any>>
set(patch: Record<string, Record<string, any>>): Promise<void>
del(key: string): Promise<void>
transaction<T>(exec: () => Promise<T>, key: string): Promise<T>
```

`transaction` must be a **per-key mutex** — a promise chain — not a rollback. A
rollback would be wrong: the library relies on a write committed inside a
transaction surviving a later failure within the same transaction, which is
exactly what makes the post-MAC identity write in
[protocol.md §4](protocol.md#session-state-is-persisted-after-authentication-not-before)
safe.

`useMultiFileAuthState(folder)` (`lib/Utils/use-multi-file-auth-state.js:32`) is
one implementation. It writes `creds.json` atomically and treats a
present-but-unusable `creds.json` as *no* creds rather than as a fresh identity
(`tests/authstate-atomic-creds.test.mjs`, `tests/authstate-creds-usable.test.mjs`).

---

## 4. Named exports, by concern

These are the 282 top-level symbols, grouped. The group is the useful
information; the file is where the signature is.

| concern | from | examples |
|---|---|---|
| the socket | `lib/Socket/index.js` | `makeWASocket` (default and named) |
| JIDs | `lib/WABinary/jid-utils.js` | `jidDecode`, `jidEncode`, `jidNormalizedUser`, `areJidsSameUser`, `isPnUser`, `isLidUser`, `isHostedPnUser`, `isHostedLidUser`, `isJidGroup`, `isJidNewsletter`, `isJidBroadcast`, `isJidStatusBroadcast`, `isJidMetaAI`, `isJidBot`, `transferDevice`, `getServerFromDomainType`, `WAJIDDomains` |
| the wire format | `lib/WABinary/{encode,decode,generic-utils}.js` | `encodeBinaryNode`, `decodeBinaryNode`, `decompressingIfRequired`, `decodeDecompressedBinaryNode`, `getBinaryNodeChild`, `getBinaryNodeChildren`, `getAllBinaryNodeChildren`, `getBinaryNodeChildString`, `getBinaryNodeChildBuffer`, `getBinaryNodeChildUInt`, `reduceBinaryNodeToDictionary`, `binaryNodeToString` |
| crypto | `lib/Utils/crypto.js`, `lib/Modded/curve-native.js` | `Curve` (`generateKeyPair`, `sharedKey`, `sign`, `verify`), `signedKeyPair`, `generateSignalPubKey`, `aesEncryptGCM`, `aesDecryptGCM`, `aesEncryptCTR`, `aesDecryptCTR`, `aesEncrypt`, `aesDecrypt`, `sha256`, `hmacSign`, `hkdf`, `md5`, `derivePairingCodeKey`, `createSignalIdentity` |
| message building | `lib/Utils/messages.js`, `messages-media.js`, `decode-wa-message.js` | `generateWAMessage`, `generateWAMessageContent`, `generateWAMessageFromContent`, `normalizeMessageContent`, `encodeWAMessage`, `encodeNewsletterMessage`, `decodeMessageNode`, `decryptMessageNode`, `decryptMediaRetryData`, `encryptMediaRetryRequest`, `extractMessageContent`, `downloadMediaMessage`, `downloadContentFromMessage`, `extensionForMediaMessage` |
| the handshake | `lib/Utils/noise-handler.js` | `makeNoiseHandler` |
| auth / connection | `lib/Utils/validate-connection.js` | `generateLoginNode`, `generateRegistrationNode`, `buildPairingQRData`, `configureSuccessfulPairing`, `bindWaitForConnectionUpdate`, `getCodeFromWSError`, `makeCacheableSignalKeyStore` |
| prekeys | `lib/Utils/signal.js` | `getNextPreKeys`, `getNextPreKeysNode`, `generateOrGetPreKeys`, `xmppPreKey`, `xmppSignedPreKey`, `parseAndInjectE2ESessions`, `extractE2ESessionFromRetryReceipt`, `extractDeviceJids`, `getPreKeys` |
| the event buffer | `lib/Utils/event-buffer.js` | `makeEventBuffer` |
| retries | `lib/Utils/message-retry-manager.js` | `MessageRetryManager`, `NACK_REASONS`, `RetryReason` |
| media | `lib/Utils/media-processor.js` | `resizeImage`, `convertToWhatsAppVideo`, `convertToOpusAudio`, `getVideoThumbnail`, `probeMedia`, `getMp4Duration` |
| rich messages | `lib/Utils/rich-classic.js`, `rich-webui.js` | `buildButtonsMessage`, `buildListMessage`, `sendClassicMessage`, `normalizeUserJid`, `buildWebuiMessage`, `sendInlineWebUI`, `generateWebuiMessageId`, `WEBUI_PRIMITIVE_TYPENAME`, `DEFAULT_BOT_JID`, `DEFAULT_FORWARD_ORIGIN`, `WEBUI_MAX_PAYLOAD_BYTES` |
| usync | `lib/WAUSync/` | `USyncQuery`, `USyncUser`, and one protocol per attribute set |
| app state | `lib/Utils/lt-hash.js`, `event-buffer.js` | `makeLtHashGenerator`, `newLTHashState`, `LT_HASH_ANTI_TAMPERING`, `encodeSyncdPatch`, `decodeSyncdPatch`, `decodeSyncdSnapshot`, `decodeSyncdMutations` |
| logging | `lib/Utils/logger.js`, `browser-utils.js` | the default pino logger, `Browsers`, `CompanionWebClientType`, `getCompanionPlatformId`, `getPlatformId` |
| constants | `lib/Defaults/index.js` | `DEFAULT_CONNECTION_CONFIG`, `DEFAULT_CACHE_TTLS`, `NOISE_MODE`, `NOISE_WA_HEADER`, `WA_CERT_DETAILS`, `MEDIA_PATH_MAP`, `MEDIA_HKDF_KEY_MAPPING`, `MEDIA_KEYS`, `TimeMs`, `UNAUTHORIZED_CODES`, `SERVER_ERROR_CODES`, `MISSING_KEYS_ERROR_TEXT`, `NO_MESSAGE_FOUND_ERROR_TEXT`, `PROCESSABLE_HISTORY_TYPES`, `DEF_CALLBACK_PREFIX`, `DEF_TAG_PREFIX`, `DEF_MEDIA_HOST`, `S_WHATSAPP_NET`, `META_AI_JID`, `OFFICIAL_BIZ_JID`, `SERVER_JID`, `PSA_WID`, `STORIES_JID`, `URL_REGEX`, `DICT_VERSION`, `KEY_BUNDLE_TYPE`, `WA_DEFAULT_EPHEMERAL`, `STATUS_EXPIRY_SECONDS`, `PLACEHOLDER_MAX_AGE_SECONDS`, `MIN_PREKEY_COUNT`, `INITIAL_PREKEY_COUNT`, `UPLOAD_TIMEOUT`, `HISTORY_SYNC_PAUSED_TIMEOUT_MS`, `CALL_AUDIO_PREFIX`, `CALL_VIDEO_PREFIX`, `DEFAULT_ORIGIN`, `ACCOUNT_RESTRICTED_TEXT` |
| enums | `lib/Types/index.js` | `DisconnectReason`, `WAMessageStatus`, `WAMessageAddressingMode`, `WAMessageStubType`, `SyncState`, `QueryIds`, `XWAPaths`, `ALL_WA_PATCH_NAMES`, `WEB_GLOBALS`, `WEB_EVENTS`, `FLAG_BYTE`, `FLAG_EVENT`, `FLAG_FIELD`, `FLAG_GLOBAL`, `FLAG_EXTENDED`, `MAX_SYNC_ATTEMPTS` |
| protobuf | `WAProto/index.js` | `proto` — the whole generated schema |

### Protobuf

`proto` is the re-exported `WAProto` namespace. `proto.Message`,
`proto.WebMessageInfo`, `proto.CertChain`, `proto.HandshakeMessage`,
`proto.DeviceIdentity`, `proto.ADVSignedDeviceIdentity` and so on are all
reachable. The `.proto` file is the source of truth.

---

## 5. The Signal repository

`makeSignalRepository` is configurable (`auth` is in
`DEFAULT_CONNECTION_CONFIG`). The default is `makeLibSignalRepository`
(`lib/Signal/libsignal.js:75`), and its shape is
`lib/Types/Signal.d.ts`. Every method is in
[protocol.md §4](protocol.md#the-repository-surface).

`repo.lidMapping` is a `LIDMappingStore`
(`lib/Signal/lid-mapping.js`) with `getPNForLID`, `getLIDForPN`,
`getPNsForLIDs`, `getLIDsForPNs`, `storeLIDPNMappings`, and inflight
coalescing so concurrent lookups for the same jid issue one query.

---

## 6. Optional peer dependencies

Four features need a package this library does not depend on. They are
`peerDependencies` with `peerDependenciesMeta.optional`, and each is loaded with
a dynamic `import()` inside a `try`, so a process that never touches the feature
never loads it.

| package | unlocks | absent |
|---|---|---|
| `sharp` | `resizeImage`, `getVideoThumbnail` | `Error: Package "sharp" tidak terpasang. Jalankan: npm install sharp` |
| `fluent-ffmpeg` | `convertToWhatsAppVideo`, `convertToOpusAudio`, `getVideoThumbnail` | `Error: … Jalankan: npm install fluent-ffmpeg` |
| `jimp` | alternative thumbnails | — |
| `audio-decode` | voice-note waveform (`ptt: true`) | — |
| `link-preview-js` | link previews | — |

`examples/06-media.mjs` asserts those exact messages. Note that the messages are
in Indonesian, because that is the convention throughout the media module; they
are not localised per install.

`music-metadata` is a **hard** dependency — `probeMedia` always works.

`ffmpeg` and `ffprobe` must also be on `PATH` for the ffmpeg-backed functions;
the package is not enough.

---

## 7. Addressing: PN, LID, hosted

WhatsApp addresses one person two ways: a phone number (`…@s.whatsapp.net`,
"PN") and an opaque identifier (`…@lid`). Device 99 lives in a third domain,
`hosted`, and its LID counterpart is `hosted.lid`.

| shape | `jidDecode().domainType` | example |
|---|---|---|
| phone number | `WHATSAPP` (0) | `15551234567@s.whatsapp.net` |
| phone number, device n | `WHATSAPP` (0) | `15551234567:2@s.whatsapp.net` |
| hosted device | `HOSTED` (128) | `999888777666:99@hosted` |
| LID | `LID` (1) | `888777666555@lid` |
| LID, device n | `LID` (1) | `888777666555:3@lid` |
| hosted LID device | `HOSTED_LID` (129) | `777666555444:99@hosted.lid` |

`examples/05-addressing.mjs` runs all six through `jidDecode` and asserts the
result, plus `jidNormalizedUser`, `areJidsSameUser` and `transferDevice`.

### What the library will and will not infer

- `isPnUser` / `isLidUser` are **domain tests**, not an equivalence. A LID is
  not a phone number, and the library never treats one as the other.
- `areJidsSameUser(a, b)` compares the **user** part and refuses any operand that
  is not a user (a group, broadcast, status or newsletter jid is not a user,
  however its user part reads). It returns `false` — never a guess — when
  either side names no user (`tests/lid-are-jids-same-user.test.mjs`).
- A signal address is `name.deviceId`. For a non-PN domain the name is
  `user_<domainType>`, so a LID address and a PN address can never collide in the
  session store ([protocol.md §6](protocol.md#6-session-and-key-storage)).
- `sendMessage` derives the sender identity from the chat's addressing and
  stamps that same value into `contextInfo.participant`
  ([protocol.md §5](protocol.md#addressing-inside-a-group)).

### `onWhatsApp(...jids)`

```ts illustrative
onWhatsApp(...jids: string[]): Promise<{ jid: string; exists: boolean | null }[]>
```

One entry per input, in input order, with `jid` echoed back **as the caller
spelled it**. `exists` is:

| value | meaning |
|---|---|
| `true` | the server returned a contact row for that number |
| `false` | the server returned a row that is not a contact |
| `null` | **could not be determined** |

`null` covers two cases, and conflating either with `false` is a bug this
library deliberately avoids:

- a `@lid` input with no phone-number mapping in `lidMapping` — it is logged and
  skipped, never turned into a fabricated number (`lib/Socket/socket.js:238`);
- a row the server simply did not answer (`lib/Socket/socket.js:266`).

`tests/lid-onwhatsapp-domain.test.mjs` pins all of it: the echo, the index
alignment, and the three-way `exists`.

---

## 8. Platform support: what is actually shipped

The native surface is three packages with **different** platform coverage. This
is the part most likely to be got wrong, so it is stated exactly.

| package | what it does | how it ships | platforms |
|---|---|---|---|
| `oktz-signal` 0.3.0-rc.1 | E2EE: X3DH, ratchet, XEdDSA | `.node` via `optionalDependencies` | `linux-arm64-gnu`, `linux-arm64-musl`, `linux-x64-gnu`, `linux-x64-musl` — **four, and no others** |
| `oktz-curve25519` 0.0.4 | X25519 keygen and DH | one `.node` file, **no `optionalDependencies`** | `linux-x64-gnu` only |
| `whatsapp-rust-bridge` 0.5.4 | WABinary encode | **WebAssembly**, inlined in `dist/index.js` as base64 | any platform with WebAssembly |
| `node:crypto` | AES-GCM, SHA-256, HMAC, X25519, PBKDF2 | Node built-in | any |

### What that means in practice

| platform | import | non-E2EE | E2EE |
|---|---|---|---|
| `linux-x64` (glibc) | works | works | works |
| `linux-arm64` (glibc or musl) | works | works | works — `oktz-signal` ships a prebuild; X25519 falls back to `node:crypto` and XEdDSA to `oktz-signal` |
| `darwin` | works | works | **fails at first E2EE use** |
| `win32` | works | works | **fails at first E2EE use** |
| `android-arm64` | works | works | **fails at first E2EE use** — `oktz-signal` has no Android prebuild, even though its own CI builds one |

**Since commit `cb02e9e`, `import 'onigis'` succeeds on darwin and win32.** Before
that, `lib/Signal/libsignal.js` opened with a top-level
`import * as libsignal from 'oktz-signal'`, and that package's loader throws
`Cannot find native binding` off Linux. A top-level ESM import is evaluated while
the module graph is built, so the throw took down `lib/index.js` itself: the
library was **unimportable**, for code paths that never touch E2EE — a plain-text
send, group metadata, WABinary encode, a plugin.

The engine is now loaded on first use
(`lib/Signal/libsignal.js:44`), so the failure moves to the first E2EE call,
where it is reported as a typed error:

```ts illustrative
class SignalEngineUnavailableError extends Error {
  name: 'SignalEngineUnavailableError';
  code: 'ONIGI_SIGNAL_ENGINE_UNSUPPORTED';
  message: string;   // names the platform, the engine, and the package to install
  cause: unknown;    // the loader's own error
}
```

**Classify on `code`, not on the message text.** The message is written for a
human and will be reworded; the code will not. It is duck-typed rather than
`instanceof`-checked, because the module can be loaded more than once in a
process.

A failed load is cached. A platform with no prebuild does not re-enter the loader
once per message.

What still works on darwin and win32: `jidDecode`, `encodeBinaryNode`,
`decodeBinaryNode`, the whole of `proto`, group metadata, all the builders in
§4, and the WABinary codec — which is WebAssembly, so it does not care.

`tests/signal-lazy-engine.test.mjs` simulates the exact shape of a darwin/win32
install and asserts all of the above, including that a missing engine is never
reported as a missing session or a missing identity key.

There is a second, narrower code: `ONIGI_XEDDSA_UNSUPPORTED`
(`lib/Modded/curve-native.js:100`). It fires only when *neither* `oktz-signal`
nor `oktz-curve25519` loaded, and it means XEdDSA sign and verify are both
unavailable — which is the same set of platforms as above, since `oktz-signal` is
what provides XEdDSA when `oktz-curve25519` is absent. `Curve.verify` answers
`false` and warns once. That is fail-closed and correct, but it does mean a Noise
handshake cannot succeed, because the certificate check is real.

### What CI does and does not test

`.github/workflows/platform-smoke.yml` runs the suite on Node 20 and Node 22, and
publishes a `Runtime status` line into the job summary for every leg stating what
was actually executed. **No leg executes on arm64 and no leg executes against
musl.** The jobs run on `ubuntu-latest` (x64, glibc). The arm64 and musl rows in
the matrix exist to make the gap visible, not to claim coverage — read the
`Runtime status` line, not the job name.

---

## 9. Running the tests

```bash
npm test              # node --test tests/*.test.mjs — 428 tests, 74 files
npm run docs:verify   # every example, and every runnable block in these docs
```

Two invocation traps, both of which have bitten this repository:

- **Never bare `node --test`.** It descends into `native/curve25519`, a
  vendored Rust project with its own test suite that needs a build and fails
  here. It picks up `native/curve25519/tests/platform-loader.test.cjs` as if it
  were one of ours.
- **Never a quoted positional glob**, `node --test 'tests/**/*.test.mjs'`. Node's
  own glob support for positional arguments is Node 22+; on Node 20 the same
  command fails with `Could not find 'tests/**/*.test.mjs'`.

`npm test` uses a **shell** glob, which the shell expands before Node sees it, so
it works on both. That is why the script is written that way.
