<div align="center">

# Onigi-Baileys

**Lightweight WhatsApp Bot library — fully rebased onto `@whiskeysockets/baileys` 7.0.0-rc14**

[![Version](https://img.shields.io/badge/npm-10.0.0--rc1-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://www.npmjs.com/package/onigi-baileys)
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
npm install onigi-baileys
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
import makeWASocket, { useMultiFileAuthState } from 'onigi-baileys';

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
import { convertToWhatsAppVideo, convertToOpusAudio, getVideoThumbnail, resizeImage } from 'onigi-baileys';

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
import { probeMedia, getMp4Duration } from 'onigi-baileys';

const meta = await probeMedia(buffer, 'audio/mpeg'); // { duration, bitrate, container, codec }
const dur = getMp4Duration(mp4Buffer); // no ffmpeg needed — parses atoms directly
```

---

## Examples: Rich WebUI (inline HTML in chat bubbles)

Send an HTML/CSS/JS interface that **renders directly inside the message bubble** — great for interactive menus, mini-apps and dashboards:

```js
import { sendInlineWebUI } from 'onigi-baileys';

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

## Breaking Changes from 9.x (legacy oktz-baileys)

- Base rebased to Baileys **7.0.0-rc14** (no longer ourin-baileys 9.0.21).
- Removed modules: `lib/VoIP/*` (WebRTC call client), `Modded/message_builder.js`, `Utils/rich-messages.js`, `Socket/dugong.js`, `Utils/sticker-pack.js`.
  - `rejectCall` remains available (core `messages-recv`).
  - Replacement for the old rich messages: `rich-webui.js` (`sendInlineWebUI`, `buildWebuiMessage`).
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
