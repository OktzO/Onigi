<div align="center">

# Onigi-Baileys

**Library bot WhatsApp ringan — rebase penuh ke `@whiskeysockets/baileys` 7.0.0-rc14**

[![Version](https://img.shields.io/badge/npm-10.0.1-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://www.npmjs.com/package/onigis)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Baileys](https://img.shields.io/badge/Base-Baileys%207.0.0--rc14-blue?style=for-the-badge)](https://github.com/WhiskeySockets/Baileys)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

**[Read in English → README.md](README.md)**

</div>

Library WhatsApp Multi-Device yang direbase penuh ke Baileys v7 rc14, dengan engine E2EE Signal Protocol berlisensi **MIT** (`oktz-signal` + `oktz-curve25519`, native Rust) sebagai pengganti `libsignal` (GPL-3.0).

Fokus proyek ini: **bot WhatsApp multi-media** — kirim/terima audio, video, gambar, stiker, dan **Rich WebUI** (antarmuka HTML inline di dalam bubble chat), dengan konfigurasi default yang hemat RAM.

---

## Fitur Utama

- **Paritas Baileys 7.0.0-rc14** — TC-token lengkap (trusted contact token dengan expiry & re-issue), Signal Repository API v7 (`getSessionInfo`, `hasSenderKey`, `getSenderKeyDistributionMessage`), format QR/pairing terbaru, penanganan reachout timelock.
- **E2EE MIT** — tanpa keterikatan GPL `libsignal`; backend kriptografi native Rust via `oktz-signal`.
- **Pipeline multi-media terpusat** — utilitas `media-processor` (ffmpeg/sharp/audio-decode, lazy-load).
- **Rich WebUI** — render antarmuka HTML/CSS/JS langsung di bubble chat via `sendInlineWebUI`.
- **RAM-friendly by default** — `syncFullHistory: false`, `enableRecentMessageCache: false`, TTL cache moderat.

---

## Syarat

| Kebutuhan | Versi |
|---|---|
| Node.js | >= 20.0.0 |

### Dukungan platform

| OS / Arsitektur | Status |
|---|---|
| Linux x86_64 (glibc) — Ubuntu, Debian, Fedora, dll | **Didukung penuh** |
| Linux ARM64 / Alpine (musl) | Perlu build native tambahan |
| Windows / macOS | Perlu build native tambahan |

> Native module (`oktz-signal`, `oktz-curve25519`) saat ini baru dipublish untuk **linux-x64-gnu**. Untuk platform lain, ikuti panduan build native (`BuildNative-Windows.md`, `BuildNative-macOS.md`, `BuildNative-Linux.md`, `BuildNative-CI-Matrix.md`).

---

## Instalasi

```bash
npm install onigis
```

### Dependency opsional (install sesuai fitur)

| Package | Untuk fitur |
|---|---|
| `audio-decode` | Waveform voice note (`ptt: true`) — **wajib untuk voice note** |
| `sharp` | Resize/kompres gambar |
| `fluent-ffmpeg` | Konversi video/audio, thumbnail video |
| `jimp` | Thumbnail alternatif (tanpa sharp) |
| `link-preview-js` | Link preview |

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

## Contoh: Multi-Media

### Kirim gambar dengan caption

```js
await sock.sendMessage(jid, {
  image: { url: 'https://example.com/foto.jpg' },
  caption: 'Halo!'
});
```

### Kirim voice note (PTT)

```js
// butuh: npm install audio-decode
await sock.sendMessage(jid, {
  audio: { url: './voice.ogg' },
  mimetype: 'audio/ogg; codecs=opus',
  ptt: true
});
```

### Konversi video/audio sebelum kirim (media-processor)

```js
import { convertToWhatsAppVideo, convertToOpusAudio, getVideoThumbnail, resizeImage } from 'onigis';

// Video apapun -> MP4/H.264 kompatibel WhatsApp (butuh fluent-ffmpeg)
const mp4 = await convertToWhatsAppVideo(bufferMentah);
await sock.sendMessage(jid, { video: mp4, caption: 'Video terkonversi' });

// Audio apapun -> OGG/Opus untuk voice note
const opus = await convertToOpusAudio(bufferAudio);

// Thumbnail video & resize gambar (butuh sharp)
const thumb = await getVideoThumbnail(mp4, 1);
const small = await resizeImage(imageBuffer, { width: 300, height: 300 });
```

### Probe metadata media

```js
import { probeMedia, getMp4Duration } from 'onigis';

const meta = await probeMedia(buffer, 'audio/mpeg'); // { duration, bitrate, container, codec }
const dur = getMp4Duration(mp4Buffer); // tanpa ffmpeg — parse atom langsung
```

---

## Contoh: Rich WebUI (HTML inline di bubble chat)

Kirim antarmuka HTML/CSS/JS yang **ter-render langsung di dalam pesan** — cocok untuk menu interaktif, mini-app, dashboard:

```js
import { sendInlineWebUI } from 'onigis';

const html = `<!DOCTYPE html>
<html><head><style>body{background:#111b21;color:#fff;font-family:sans-serif;padding:16px}</style></head>
<body><h2>Menu Bot</h2><button onclick="alert('hai')">Tekan aku</button></body></html>`;

await sendInlineWebUI(sock, jid, html, 'Menu Bot');

// Identitas bisa di-override (default: Meta AI)
await sendInlineWebUI(sock, jid, html, 'Menu Bot', {
  botJid: '12345@bot',
  forwardOrigin: 'CUSTOM'
});
```

> Catatan: nama primitive HTML (`GenAIaeacdsnwHtmlPrimitive`) adalah identifier obfuscated WhatsApp Web dan bisa berubah antar versi. Jika WebUI berhenti ter-render, update identifier dari bundle WA Web terbaru.

---

## Konfigurasi Default (RAM-friendly)

```js
const sock = makeWASocket({
  auth: state,
  // default sudah irit; override bila perlu:
  syncFullHistory: false,          // tidak menarik riwayat chat penuh
  enableRecentMessageCache: false, // tidak menyimpan pesan terbaru di RAM
});
```

---

## Breaking Changes dari 9.x (oktz-baileys lama)

- Base direbase ke Baileys **7.0.0-rc14** (bukan lagi ourin-baileys 9.0.21).
- Modul yang **dihapus**: `lib/VoIP/*` (call client WebRTC), `Modded/message_builder.js`, `Utils/rich-messages.js`, `Socket/dugong.js`, `Utils/sticker-pack.js`.
  - `rejectCall` tetap tersedia (core `messages-recv`).
  - Pengganti rich message lama: `rich-webui.js` (`sendInlineWebUI`, `buildWebuiMessage`).
- Default config berubah: `syncFullHistory` dan `enableRecentMessageCache` kini `false`.
- `protobufjs-cli` dipin ke `^1.1.3` (fix konflik peer dependency); `link-preview-js` ke `^5.0.0` (fix advisory SSRF).

---

## Testing

```bash
npm test
```

Termasuk unit test: JID utils (PN/LID/hosted), Rich WebUI (build + roundtrip proto encode/decode).

---

## Kredit

- **[KzorArsuy](https://github.com/rozzak2009)** — audit, rebase rc14, optimasi, multimedia & WebUI
- **[OktzO](https://github.com/OktzO)** — fork awal `oktz-baileys` & engine `oktz-signal`/`oktz-curve25519`
- **[WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys)** — upstream library

---

## Lisensi

**MIT** — bebas dari pembatasan GPL `libsignal`.
