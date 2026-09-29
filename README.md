<div align="center">

# onigis

**A WhatsApp multi-device library, forked from `@whiskeysockets/baileys` 7.0.0-rc14, with the E2EE engine swapped to MIT-licensed native Rust.**

[![npm](https://img.shields.io/badge/npm-10.1.0--rc.6-25D366?style=flat-square&logo=npm)](https://www.npmjs.com/package/onigis)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodemon)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![tests](https://img.shields.io/badge/tests-428%20pass-informational?style=flat-square)](#testing)

**[Bahasa Indonesia → README.id.md](README.id.md)**

</div>

---

## What this is

`onigis` is a fork of [Baileys](https://github.com/WhiskeySockets/Baileys) at
7.0.0-rc14. The Signal Protocol engine — the part that encrypts your messages —
is [`oktz-signal`](https://github.com/OktzO/oktz-signal) plus
`oktz-curve25519`, both MIT-licensed Rust behind NAPI, in place of `libsignal`
at GPL-3.0. Nothing else about the upstream design was rewritten.

The project focus is multimedia chat bots: audio, video, image and sticker
pipelines, plus inline HTML interfaces rendered inside a message bubble.

## What this README will not tell you

Three things a README like this usually claims, and this one does not:

- **No performance numbers.** There is no benchmark in this repository. An
  earlier version of this file published tables — "9× faster than upstream",
  "186× faster XEdDSA", "+5.7% on WABinary" — with no reproduction script in the
  tree. They are gone because nothing here can reproduce them, and a number
  nobody can check is worse than no number.
- **No claim that a card renders.** Whether a WhatsApp client draws a
  `buttonsMessage` is Meta's behaviour. No test in this repository can observe
  it, so it is not asserted anywhere.
- **No claim of protocol conformance against a live server.** What *is* verified
  is the arithmetic: that a forged signature is rejected, that a forged
  ciphertext does not decrypt, that a frame the library emits is a frame its own
  decoder reads. See [docs/protocol.md](docs/protocol.md) for what that does and
  does not cover.

---

## Requirements

| | |
|---|---|
| Node.js | `>= 20.0.0` (declared in `engines`; tested on 20 and 22) |
| Native E2EE | `linux-x64` or `linux-arm64`, glibc or musl |

### Platform support

The native surface is three packages with **different** coverage. Stating it
exactly, because getting it wrong is easy in both directions:

| package | role | how it ships | platforms |
|---|---|---|---|
| `oktz-signal` 0.3.0-rc.1 | E2EE, XEdDSA | `.node` via `optionalDependencies` | `linux-arm64-{gnu,musl}`, `linux-x64-{gnu,musl}` — **four, and no others** |
| `oktz-curve25519` 0.0.4 | X25519 keygen and DH | one `.node`, no `optionalDependencies` | `linux-x64-gnu` only |
| `whatsapp-rust-bridge` 0.5.4 | WABinary encode | **WebAssembly**, inlined in `dist/index.js` | any platform with WebAssembly |
| `node:crypto` | AES-GCM, SHA-256, HMAC, X25519, PBKDF2 | Node built-in | any |

Which gives:

| platform | `import 'onigis'` | non-E2EE surface | E2EE |
|---|---|---|---|
| `linux-x64` (glibc) | works | works | works |
| `linux-arm64` (glibc or musl) | works | works | works |
| `darwin` (macOS) | works | works | **fails at first E2EE use** |
| `win32` (Windows) | works | works | **fails at first E2EE use** |
| `android-arm64` | works | works | **fails at first E2EE use** |

**macOS and Windows are not unsupported platforms — they are platforms without
an E2EE engine.** Since commit `cb02e9e` the library imports cleanly there, and
everything that does not encrypt still works: JIDs, WABinary encode and decode,
the whole protobuf surface, group metadata, and all the message builders. The
failure arrives at the first E2EE call, as a typed error:

```js illustrative
try {
  await sock.sendMessage(jid, { text: 'hi' }, { messageId });
} catch (error) {
  if (error.code === 'ONIGI_SIGNAL_ENGINE_UNSUPPORTED') {
    // name: 'SignalEngineUnavailableError'
    // message names the platform, the engine, and the package to install
    // cause: the loader's own error
  }
}
```

**Classify on `code`, never on the message text.** The message is written for a
human and will be reworded. There is a second, narrower code,
`ONIGI_XEDDSA_UNSUPPORTED`, meaning neither binding has a prebuild and XEdDSA
sign *and* verify are both unavailable; `Curve.verify` then answers `false` and
warns once, which is fail-closed and correct but does mean a Noise handshake
cannot complete.

`tests/signal-lazy-engine.test.mjs` reproduces a darwin/win32 install exactly and
asserts all of the above, including that a missing engine is never reported as a
missing session or a missing identity key.

**What CI actually executes** is stated in every job summary: the suite runs on
`ubuntu-latest` (x64, glibc), on Node 20 and Node 22. **No CI job runs on arm64
and none runs against musl.** The arm64 and musl rows in the matrix exist to
make that gap visible in the report, not to claim coverage.

---

## Install

```bash
npm install onigis
```

`oktz-signal` is a pre-release. On the registry `0.3.0-rc.1` sits under the `rc`
dist-tag; `latest` still points at `0.1.7`. If npm resolves `0.1.7`, install the
version explicitly.

### Optional dependencies

Four features need a package that is not a dependency of this one. They are
optional peers, each loaded with a dynamic `import()` inside a `try`, so a
process that never touches a feature never loads it.

| package | unlocks | without it |
|---|---|---|
| `sharp` | `resizeImage`, `getVideoThumbnail` | `Error: Package "sharp" … npm install sharp` |
| `fluent-ffmpeg` | `convertToWhatsAppVideo`, `convertToOpusAudio`, `getVideoThumbnail` | `Error: … npm install fluent-ffmpeg` |
| `jimp` | alternative thumbnails | — |
| `audio-decode` | voice-note waveform (`ptt: true`) | — |
| `link-preview-js` | link previews | — |

`fluent-ffmpeg` also needs `ffmpeg` and `ffprobe` on `PATH`; the package alone
is not enough. `music-metadata` is a hard dependency, so `probeMedia` always
works.

Check what actually loaded on your machine:

```bash
node -e "import('oktz-signal').then(m => console.log('signal:', typeof m.native.ratchetEncrypt))"
node -e "import('oktz-curve25519').then(m => console.log('curve:', typeof m.sign))"
node -e "import('whatsapp-rust-bridge').then(m => console.log('wabinary:', typeof m.expandAppStateKeys))"
```

`function` from all three means the native surface is present. The first two are
`.node`; the third is WebAssembly and works anywhere.

---

## Quick start

```js illustrative
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'onigis';

const { state, saveCreds } = await useMultiFileAuthState('auth_info');

const sock = makeWASocket({ auth: state });

sock.ev.on('creds.update', saveCreds);

// There is no sock.ev.lastDisconnect: the reason arrives on the event itself.
sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
  if (qr) {
    console.log(qr);            // render this however you like
  } else if (connection === 'close') {
    const status = lastDisconnect?.error?.output?.statusCode;
    console.log(status === DisconnectReason.loggedOut
      ? 'unlinked — delete auth_info and pair again'
      : 'reconnecting');
  }
});

sock.ev.on('messages.upsert', async ({ messages }) => {
  for (const msg of messages) {
    if (!msg.message || msg.key.fromMe) continue;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (text === '!ping') {
      await sock.sendMessage(msg.key.remoteJid, { text: 'pong' }, { quoted: msg });
    }
  }
});
```

`sock.user` is `creds.me` and has `.id`. There is no `sock.user.jid` in this
library; code that reads it gets `undefined` and stamps a null participant onto
group messages. Use `normalizeUserJid(sock)`, which accepts a jid, a sock, or a
user object.

`sock.ev` is not a Node `EventEmitter` — it has `on`, `off`,
`removeAllListeners` and `emit`, and no `once`.

Full walkthrough: **[docs/quickstart.md](docs/quickstart.md)**.

---

## Try it without a WhatsApp account

Six programs under `examples/` run with no credentials, no network and no account:

```bash
node examples/01-connect.mjs           # the Noise handshake, on real bytes
node examples/02-e2ee-roundtrip.mjs    # X3DH, ratchet, group sender key
node examples/03-wabinary.mjs          # the wire format, and what it refuses
node examples/04-rich-messages.mjs     # buttons, lists, inline HTML
node examples/05-addressing.mjs        # PN / LID / hosted JIDs
node examples/06-media.mjs             # what works with no optional dependency
```

Or all of them, plus every runnable code block in these docs:

```bash
npm run docs:verify
```

`docs:verify` runs each in its own process and fails on any error. A fenced
````js` block in the documentation that is neither marked `run` nor marked
`illustrative` also fails the run — the verifier will not execute it and will
not quietly ignore it either.

### What `examples/01-connect.mjs` actually shows

It boots a real `makeWASocket` against a local WebSocket server that implements
the server half of `Noise_XX_25519_AESGCM_SHA256`, and it asserts on the bytes
the client actually writes. The result is a **failure**, and it is the
interesting one:

```
clientHello: 36 bytes, ephemeral 32 bytes, re-encodes identically
client refused the server certificate: "noise intermediate certificate signature invalid"
```

The key schedule matched in both directions — the client decrypted the server's
`static` and `payload`, which it could not have done against a server computing
the schedule differently. What failed is the certificate check, because
`WA_CERT_DETAILS.PUBLIC_KEY` is WhatsApp's real long-term key and its private half
is not in this repository.

That refusal is the correct outcome, and the example asserts the exact status
code and message so that a weakening of `lib/Utils/noise-handler.js:183` fails
the test. The transport keys are therefore never negotiated in any example, and
no example claims to show a `sendMessage` over a live transport.

---

## Rich messages

`buttonsMessage` and `listMessage` are WhatsApp's own templates. This library
builds them; whether a given client draws them is not something this repository
can test or claim.

```js illustrative
import { buildButtonsMessage, buildListMessage, sendClassicMessage } from 'onigis';

await sendClassicMessage(sock, jid, buildButtonsMessage({
  text: 'Pick an option',
  footer: '© onigis',
  buttons: [
    { buttonId: '.owner', buttonText: 'Owner' },
    { buttonId: '.menu', buttonText: 'All menu' }
  ]
}));

await sendClassicMessage(sock, jid, buildListMessage({
  title: 'Menu',
  buttonText: 'Open',
  sections: [{
    title: 'Categories',
    rows: [{ title: 'main', description: '19 commands', rowId: '.menucat main' }]
  }]
}));
```

`relayMessage` re-attaches the `<biz>` stanza node automatically for these
payloads, unless you already supplied one — without it the server accepts the
stanza and the client never draws the card, and the send reports success.

### Inline HTML in a message bubble

```js illustrative
import { sendInlineWebUI } from 'onigis';

await sendInlineWebUI(sock, jid,
  '<!DOCTYPE html><html><body><h2>Menu</h2><button onclick="alert(1)">Go</button></body></html>',
  'Bot Menu'
);
```

The HTML is carried as base64-encoded JSON under the primitive typename
`GenAIaeacdsnwHtmlPrimitive`, forwarded from Meta AI's jid by default. That
typename is an obfuscated WhatsApp Web identifier and can change between WhatsApp
versions; if the interface stops rendering, that constant
(`WEBUI_PRIMITIVE_TYPENAME`, `lib/Utils/rich-webui.js:15`) is the thing to
update. Payloads over 64 KiB warn.

---

## Media

```js illustrative
import { convertToWhatsAppVideo, convertToOpusAudio, getVideoThumbnail, resizeImage, probeMedia, getMp4Duration } from 'onigis';

const mp4 = await convertToWhatsAppVideo(buffer);          // needs ffmpeg
const opus = await convertToOpusAudio(buffer);            // needs ffmpeg
const thumb = await getVideoThumbnail(mp4, 1);            // needs ffmpeg + sharp
const small = await resizeImage(imageBuffer, { width: 300, height: 300 });   // needs sharp

const meta = await probeMedia(buffer, 'audio/mpeg');      // always available
const dur = getMp4Duration(mp4Buffer);                    // always available — parses MP4 atoms directly
```

`getMp4Duration` needs nothing but `node:buffer`. It walks the `moov`/`mvhd`
atoms itself. It returns `0` for anything that is not an MP4 by default, because
it runs on caller-supplied bytes; pass `{ silent: false }` for a thrown error
naming which guard tripped.

`examples/06-media.mjs` exercises both halves — the dependency-free paths on a
byte-exact MP4 this repository builds itself, and the optional-dependency
contract by asserting the exact error text when `sharp` and `ffmpeg` are absent.

---

## Addressing

WhatsApp addresses one person two ways: a phone number (`…@s.whatsapp.net`,
"PN") and an opaque identifier (`…@lid`). Device 99 lives in a third domain,
`hosted`; its LID counterpart is `hosted.lid`.

The library treats these as **different domains, not as two names for one
thing**, and never invents a conversion:

- `isPnUser` / `isLidUser` are domain tests. A LID is not a phone number.
- `areJidsSameUser(a, b)` compares the user part and refuses any operand that is
  not a user — a group, broadcast, status or newsletter jid is not a user
  however its user part reads. It returns `false`, never a guess, when either
  side names no user.
- A Signal address is `name.deviceId`, and for a non-PN domain the name is
  `user_<domainType>`, so a LID address and a PN address cannot collide in the
  session store.
- `sendMessage` derives the sender identity from the **chat's** addressing, not
  from the message type, and stamps that same value into `contextInfo.participant`.

`onWhatsApp(...jids)` answers one entry per input, in input order, with `jid`
echoed back as the caller spelled it, and a three-way `exists`:

| value | meaning |
|---|---|
| `true` | the server returned a contact row |
| `false` | the server returned a row that is not a contact |
| `null` | **could not be determined** |

`null` is a real answer, not a lazy `false`. It covers a `@lid` with no
phone-number mapping, and a row the server never answered. Earlier versions
returned the server's own jid for every input — so a caller passing a `@lid` got
a phone number back — and conflated both cases with "not on WhatsApp".

**LID support is not claimed to be complete.** Resolution needs a live usync
round trip, and whether Meta's servers answer consistently in every case is not
something this repository can test. `examples/05-addressing.mjs` shows what the
helpers do with all six jid shapes and then says, in its own output, exactly what
that does not establish.

Details: [docs/api.md §7](docs/api.md#7-addressing-pn-lid-hosted).

---

## Security notes

Five defects in the 10.1.0-rc.5 line were fixed after the `v10.1.0-rc.6` tag.
**If you are on a release up to and including `10.1.0-rc.6`, three of them are
reachable by a remote peer.** They are listed with what each one let an attacker
do, and with the commit that fixed it, in
[CHANGELOG.md](CHANGELOG.md#read-this-before-upgrading-from-1010-rc5-or-earlier).

The two that are most often understated:

**Signature verification was a no-op.** `Curve.verify` discarded the boolean
returned by the native library — which answers `false` on a mismatch rather than
throwing, unlike the `curve25519-js` it replaced — and hardcoded `return true`.
Every signature of a plausible shape verified. That made the Noise certificate
chain and the ADV pairing signature no-ops, so the websocket authenticated
nothing about the peer. `42d416d`.

**One forged message could brick a conversation.** A `pkmsg` wrapper's
`identityKey` is not covered by the MAC that the decrypt checks, and
`auth.keys.transaction` is a per-key mutex rather than a rollback. The identity
key was persisted *before* the decrypt, so a single unauthenticated `pkmsg` could
delete an established session and overwrite the stored identity key before the
MAC ever failed. `9c64fc7`.

**What is not claimed.** This library has no test against a live WhatsApp
server. That the certificate chain validates correctly against a real one, that
interoperability holds with the current WhatsApp clients, and that no other
protocol flaw remains are all outside what anything in this repository can
establish.

---

## Testing

```bash
npm test              # 428 tests, 74 files
npm run docs:verify   # every example, every runnable doc block
```

Both run in CI on Node 20 and Node 22.

Two invocation traps this repository has already hit, both of which break CI:

- **Never bare `node --test`.** It descends into `native/curve25519`, a vendored
  Rust project with its own test suite that needs a build and fails here. It
  picks up `native/curve25519/tests/platform-loader.test.cjs` as if it were ours.
- **Never a quoted positional glob**, `node --test 'tests/**/*.test.mjs'`. Node's
  own glob support for positional arguments is Node 22+; on Node 20 the same
  command fails with `Could not find 'tests/**/*.test.mjs'`.

`npm test` uses a *shell* glob, which the shell expands before Node sees it, so
it works on both. That is why the script is written the way it is.

Two environment variables change behaviour:

| variable | effect |
|---|---|
| `ONIGI_RUST_WABINARY=0` | use the JS WABinary encoder instead of the native one |
| `ONIGI_RUST_WABINARY_DECODE=1` | use the native decoder (opt-in; off by default) |

`whatsapp-rust-bridge` is a WebAssembly module with its `dist/index.js` inlining
the wasm as base64, so the encode path works on any platform with WebAssembly.
`lib/WABinary/rust-adapter.js:21` routes the two shapes where the native and JS
encoders diverge — a non-string attribute, and an empty-string attribute — to the
JS encoder, so the two are never mixed inside one frame.

---

## Documentation

| | |
|---|---|
| [docs/quickstart.md](docs/quickstart.md) | connect, send, receive; and the offline path |
| [docs/api.md](docs/api.md) | the socket's 170 members and the 282 top-level exports, grouped by concern |
| [docs/protocol.md](docs/protocol.md) | the wire format and the checks, cited to `file:line` |
| [CHANGELOG.md](CHANGELOG.md) | what changed, and what was wrong |
| [examples/](examples/) | six runnable programs |

`lib/index.js` exports 282 symbols. `docs/api.md` groups them rather than listing
each one, because a 282-row table nobody checked is worse than a grouped one with
a pointer to the `.d.ts`. There are 99 hand-maintained `.d.ts` files and no
`tsc` in this tree, so they are committed artifacts, not build output;
`tests/dts-declarations.test.mjs` keeps them honest against the runtime.

---

## Credits

- **[KzorArsuy](https://github.com/rozzak2009)** — audit, the rc14 rebase, optimisation, multimedia and WebUI
- **[OktzO](https://github.com/OktzO)** — the original `oktz-baileys` fork, and the `oktz-signal` / `oktz-curve25519` engines
- **[WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys)** — upstream

## License

MIT.
