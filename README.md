<div align="center">

# Onigi-Baileys

**Lightweight WhatsApp Bot library — fully rebased onto `@whiskeysockets/baileys` 7.0.0-rc14**

[![Version](https://img.shields.io/badge/npm-10.0.2-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://www.npmjs.com/package/onigis)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Baileys](https://img.shields.io/badge/Base-Baileys%207.0.0--rc14-blue?style=for-the-badge)](https://github.com/WhiskeySockets/Baileys)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

**[Baca dalam Bahasa Indonesia → README.id.md](README.id.md)**

</div>

A WhatsApp Multi-Device library rebased onto Baileys v7 rc14, with the E2EE Signal Protocol engine swapped to the **MIT-licensed** `oktz-signal` + `oktz-curve25519` (native Rust) instead of `libsignal` (GPL-3.0).

Project focus: **multimedia WhatsApp bots** — audio, video, image and sticker pipelines, plus **Rich WebUI** (inline HTML interfaces rendered inside chat bubbles), with RAM-friendly defaults.

---

## Highlights

- **Full Baileys 7.0.0-rc14 parity** — complete TC-token implementation (trusted contact tokens with expiry & re-issue), Signal Repository API v7 (`getSessionInfo`, `hasSenderKey`, `getSenderKeyDistributionMessage`), new QR/pairing format, reachout timelock handling.
- **MIT E2EE** — no GPL `libsignal` dependency; native Rust crypto backend via `oktz-signal`.
- **Centralized multimedia pipeline** — `media-processor` utilities (ffmpeg/sharp/audio-decode, lazy-loaded).
- **Rich WebUI** — render HTML/CSS/JS interfaces directly inside chat bubbles via `sendInlineWebUI`.
- **RAM-friendly by default** — `syncFullHistory: false`, `enableRecentMessageCache: false`, moderate cache TTLs.

---

## Requirements

| Requirement | Version |
|---|---|
| Node.js | >= 20.0.0 |

### Platform support

| OS / Architecture | Status |
|---|---|
| Linux x86_64 (glibc) — Ubuntu, Debian, Fedora, etc. | **Fully supported** |
| Linux ARM64 / Alpine (musl) | Requires additional native build |
| Windows / macOS | Requires additional native build |

> The native modules (`oktz-signal`, `oktz-curve25519`) are currently published for **linux-x64-gnu** only. For other platforms, see the native build guides (`BuildNative-Windows.md`, `BuildNative-macOS.md`, `BuildNative-Linux.md`, `BuildNative-CI-Matrix.md`).

---

## Installation

```bash
npm install onigis
```

### Optional dependencies (install per feature)

| Package | Feature |
|---|---|
| `audio-decode` | Voice note waveform (`ptt: true`) — **required for voice notes** |
| `sharp` | Image resize/compression |
| `fluent-ffmpeg` | Video/audio conversion, video thumbnails |
| `jimp` | Alternative thumbnails (without sharp) |
| `link-preview-js` | Link previews |

---

## Quick Start

```js
import makeWASocket, { useMultiFileAuthState } from 'onigis';

const { state, saveCreds } = await useMultiFileAuthState('auth_info');

const sock = makeWASocket({
  auth: state,
  printQRInTerminal: true
});

sock.ev.on('creds.update', saveCreds);

sock.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages[0];
  if (!msg.message || msg.key.fromMe) return;

  const jid = msg.key.remoteJid;
  const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

  if (text === '!ping') {
    await sock.sendMessage(jid, { text: 'pong' }, { quoted: msg });
  }
});
```

---

## Examples: Multimedia

### Send an image with caption

```js
await sock.sendMessage(jid, {
  image: { url: 'https://example.com/photo.jpg' },
  caption: 'Hello!'
});
```

### Send a voice note (PTT)

```js
// requires: npm install audio-decode
await sock.sendMessage(jid, {
  audio: { url: './voice.ogg' },
  mimetype: 'audio/ogg; codecs=opus',
  ptt: true
});
```

### Convert video/audio before sending (media-processor)

```js
import { convertToWhatsAppVideo, convertToOpusAudio, getVideoThumbnail, resizeImage } from 'onigis';

// Any video -> WhatsApp-compatible MP4/H.264 (requires fluent-ffmpeg)
const mp4 = await convertToWhatsAppVideo(rawBuffer);
await sock.sendMessage(jid, { video: mp4, caption: 'Converted video' });

// Any audio -> OGG/Opus for voice notes
const opus = await convertToOpusAudio(audioBuffer);

// Video thumbnail & image resize (requires sharp)
const thumb = await getVideoThumbnail(mp4, 1);
const small = await resizeImage(imageBuffer, { width: 300, height: 300 });
```

### Probe media metadata

```js
import { probeMedia, getMp4Duration } from 'onigis';

const meta = await probeMedia(buffer, 'audio/mpeg'); // { duration, bitrate, container, codec }
const dur = getMp4Duration(mp4Buffer); // no ffmpeg needed — parses atoms directly
```

---

## Examples: Rich WebUI (inline HTML in chat bubbles)

Send an HTML/CSS/JS interface that **renders directly inside the message bubble** — great for interactive menus, mini-apps and dashboards:

```js
import { sendInlineWebUI } from 'onigis';

const html = `<!DOCTYPE html>
<html><head><style>body{background:#111b21;color:#fff;font-family:sans-serif;padding:16px}</style></head>
<body><h2>Bot Menu</h2><button onclick="alert('hi')">Press me</button></body></html>`;

await sendInlineWebUI(sock, jid, html, 'Bot Menu');

// Identity can be overridden (default: Meta AI)
await sendInlineWebUI(sock, jid, html, 'Bot Menu', {
  botJid: '12345@bot',
  forwardOrigin: 'CUSTOM'
});
```

> Note: the HTML primitive name (`GenAIaeacdsnwHtmlPrimitive`) is an obfuscated WhatsApp Web identifier and may change between WA versions. If the WebUI stops rendering, update the identifier from the latest WA Web bundle.

---

## Examples: Classic buttons & lists (render everywhere, new in 10.0.1)

`interactiveMessage` + `nativeFlowMessage` cards are **no longer rendered** on many WhatsApp clients — `relayMessage` succeeds without error but the message silently doesn't appear. The classic `buttonsMessage` and `listMessage` templates render reliably on **every** client (Android/iOS/Web/Desktop).

`onigis@10.0.1` ships ready-made builders in `lib/Utils/rich-classic.js`:

```js
import { buildButtonsMessage, buildListMessage, sendClassicMessage } from 'onigis';

// 1-3 quick-reply buttons (optionally with a location+thumbnail header)
const buttons = buildButtonsMessage({
  text: 'Hello Brother — pick an option',
  footer: '© My Bot',
  buttons: [
    { buttonId: '.owner', buttonText: '🧀 Owner' },
    { buttonId: '.allmenu', buttonText: '💐 Allmenu' },
  ],
  locationMessage: { jpegThumbnail, name: 'My Bot', address: 'v10.0.1' },
});

// Scrollable list with sections and rows
const list = buildListMessage({
  title: '🍃 Menu — 1271 commands',
  description: 'Pick a category',
  buttonText: '🍃 Pilih Kategori',
  sections: [{
    title: 'Categories',
    rows: [
      { title: '🏠 main', description: '19 commands', rowId: '.menucat main' },
      { title: '🎨 sticker', description: '42 commands', rowId: '.menucat sticker' },
    ],
  }],
});

// Send via relayMessage — userJid is normalized automatically
// (handles sock.user.id vs the legacy non-existent sock.user.jid)
await sendClassicMessage(sock, jid, buttons);
await sendClassicMessage(sock, jid, list);
```

Also exports `normalizeUserJid(sockOrUserOrJid)` — `sock.user.jid` never existed in baileys 7.x (`sock.user` is `creds.me`, which has `.id`); this helper accepts any shape and returns a valid jid.

---

## Default Configuration (RAM-friendly)

```js
const sock = makeWASocket({
  auth: state,
  // already frugal by default; override if needed:
  syncFullHistory: false,          // don't pull full chat history
  enableRecentMessageCache: false, // don't keep recent messages in RAM
});
```

---

## Performance (benchmarked vs upstream Baileys)

Measured on Node v20.19.1, Linux x64, in-process loops, realistic message shapes (20 participants, 96–128B buffers). All scripts reproducible; verification: Onigi test suite 31 pass + oktz-signal oracle interop bit-exact vs libsignal v6.

### E2EE Signal Protocol (the engine swap: oktz-signal vs libsignal)

| Scenario | Onigi (oktz-signal, Rust) | Upstream (libsignal, JS) | Winner |
|---|---:|---:|---|
| **Full session build** (X3DH + PKMsg enc/dec, random keys) | **3.5 ms** | 31.8 ms | **Onigi 9× faster** |
| **Steady-state per message** (bidirectional ratchet enc+dec) | **195–330 µs** | 570–695 µs | **Onigi 2–3.5× faster** |
| XEdDSA sign | 165.6 µs | 30.7 ms | **186× faster** |
| XEdDSA verify | 138.9 µs | 32.3 ms | **233× faster** |
| X25519 DH | 330.8 µs | 308.2 µs | ~par (both native) |

> In real terms: every incoming prekey message and every session establishment — the operations that happen when pairing new devices, after reinstalls, and when peers rotate — is 9× cheaper on CPU. On a busy multi-chat bot this is the difference between visible event-loop jank and none.

### WABinary (protobuf-XML binary codec, default rust encode)

| Implementation | µs/op roundtrip | ops/s | vs upstream |
|---|---:|---:|---|
| **Onigi — Rust encode (default)** | **146.4** | 6,832 | **+5.7% faster** |
| Onigi — JS fallback (`ONIGI_RUST_WABINARY=0`) | 155.7 | 6,422 | ~par |
| Upstream baileys rc14 | 154.7 | 6,465 | baseline |
| Onigi — Rust decode (`ONIGI_RUST_WABINARY_DECODE=1`, opt-in) | ~255 | ~3,900 | 65% slower — correctly OFF by default |

### Where Onigi is ahead of upstream rc14 (verified in code)

- **TC-token**: full WA Web parity implementation (index persist, merge write, 24h prune, 28-day expiry buckets, re-issue after identity change, 463-recovery, AB props gating) — upstream rc14 has this only partially.
- **Retry system (whatsmeow-style)**: MessageRetryManager with baseKey collision detection, phone-request scheduling, MAC-error codes — upstream rc14 has none of it.
- **Anti-spoof protocolMessage**: SELF_ONLY_TYPES dropped from non-self origin (ported from whatsmeow) — security win over upstream.
- **LTHash soft-recovery** on app-state mismatch (warn + partial state) instead of upstream's hard-fail.
- **Write-amplification fixes**: device-list debounce flush (5s, single `keys.set`), noise burst-concat, lazy stack-capture in timeouts.
- **LIDMappingStore** with inflight-coalescing (dedupes concurrent USync lookups); offline node queue capped at 5000.

### Known gaps found in the September 2026 audit (fix-prioritized)

| # | Severity | Issue | Location |
|---|---|---|---|
| 1 | CRITICAL (release hygiene) | `package.json` pins `oktz-signal 0.2.0-rc.1` but `node_modules`/lockfile resolve **0.1.7** (`npm ls` → invalid) — shipped version was never tested against this tree | `package.json:38` |
| 2 | HIGH | oktz-signal session-selection bug (first BTreeMap entry instead of open session) is triggered from `encryptMessage` on every outgoing message when a record holds >1 session (LID migration makes multi-session records *normal*, not edge-case). **Mitigation available wrapper-side**: prune to 1 open session before encrypt | `lib/Signal/libsignal.js:115-124` |
| 3 | HIGH | `process.nextTick(async …)` in `emitOwnEvents` has **no `.catch()`** — a throwing user message-listener becomes an unhandledRejection (process crash on Node 20 defaults) | `lib/Socket/messages-send.js:1202-1206` |
| 4 | MEDIUM | `relayMessage` holds the per-account transaction mutex across the entire pipeline including network RTT — all sends fully serialized under load | `lib/Socket/messages-send.js:493-918` |
| 5 | MEDIUM | `sender-key-memory` written unconditionally per group send (whole map persisted even with no new recipients) | `lib/Socket/messages-send.js:609` |
| 6 | MEDIUM | WAM telemetry: 831KB of dead constants loaded into the module graph via `export * from './WAM/index.js'` — never used at runtime | `lib/WAM/constants.js` |
| 7 | MEDIUM | `historyCache` in event-buffer has no hard cap between flushes — large initial syncs hold every key ever seen | `lib/Utils/event-buffer.js:27-79` |
| 8 | MEDIUM | `+countChild.attrs.value` crashes silently if `<count>` child absent (pre-key-low check dies quietly) | `lib/Socket/messages-recv.js:560-561` |

Memory leak audit result: **essentially clean** — socket cleanup lifecycle closes every cache/timer, keyed mutexes use refcount cleanup, `end()` is idempotent. Remaining LOW items: an 8s `setTimeout` without `unref()`, module-level `fileLocks` Map, and the historyCache gap above.

Test-coverage gap worth noting: **the Signal/E2EE roundtrip path has zero tests** — despite being the component that was swapped entirely. Adding an encrypt→decrypt roundtrip test is the single highest-value test this repo can get.

---

## Breaking Changes from 9.x (legacy oktz-baileys)

- Base rebased to Baileys **7.0.0-rc14** (no longer ourin-baileys 9.0.21).
- Removed modules: `lib/VoIP/*` (WebRTC call client), `Modded/message_builder.js`, `Utils/rich-messages.js`, `Socket/dugong.js`, `Utils/sticker-pack.js`.
  - `rejectCall` remains available (core `messages-recv`).
  - Replacement for the old rich messages: `rich-webui.js` (`sendInlineWebUI`, `buildWebuiMessage`).
- **10.0.1:** added `rich-classic.js` (`buildButtonsMessage`, `buildListMessage`, `sendClassicMessage`, `normalizeUserJid`) — `interactiveMessage`/`nativeFlowMessage` cards no longer render on many clients; use the classic templates for maximum compatibility.
- **10.0.2:** restored the ob9 auto-inject of the `<biz>` stanza node (ported from ourin-baileys 9.0.21) — `relayMessage` now automatically attaches the `biz` interactive node for `buttonsMessage` / `listMessage` / `interactiveMessage`+`nativeFlowMessage` payloads, unless the caller already provides one. Without this node the server accepts the stanza but the receiving client never renders the card (relay succeeds silently, message never appears). This regressed during the rebase to Baileys 7 and was the root cause of invisible button/list menus.
- Default config changed: `syncFullHistory` and `enableRecentMessageCache` are now `false`.
- `protobufjs-cli` pinned to `^1.1.3` (peer dependency conflict fix); `link-preview-js` to `^5.0.0` (SSRF advisory fix).

---

## Testing

```bash
npm test
```

Includes unit tests for: JID utils (PN/LID/hosted), Rich WebUI (build + proto encode/decode roundtrip).

---

## Credits

- **[KzorArsuy](https://github.com/rozzak2009)** — audit, rc14 rebase, optimization, multimedia & WebUI
- **[OktzO](https://github.com/OktzO)** — original `oktz-baileys` fork & `oktz-signal`/`oktz-curve25519` engines
- **[WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys)** — upstream library

---

## License

**MIT** — free from the GPL restrictions of `libsignal`.
