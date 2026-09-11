<div align="center">

# Onigi-Baileys

**Library bot WhatsApp ringan — rebase penuh ke `@whiskeysockets/baileys` 7.0.0-rc14**

[![Version](https://img.shields.io/badge/npm-10.0.2-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://www.npmjs.com/package/onigis)
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

## Performa (benchmark vs Baileys upstream)

Diukur pada Node v20.19.1, Linux x64, loop in-process, bentuk pesan realistis (20 partisipan, buffer 96–128B). Semua script bisa direproduksi; verifikasi: test suite Onigi 31 pass + oracle interop oktz-signal bit-exact vs libsignal v6.

### E2EE Signal Protocol (engine swap: oktz-signal vs libsignal)

| Skenario | Onigi (oktz-signal, Rust) | Upstream (libsignal, JS) | Pemenang |
|---|---:|---:|---|
| **Build session penuh** (X3DH + PKMsg enc/dec, kunci acak) | **3,5 ms** | 31,8 ms | **Onigi 9× lebih cepat** |
| **Steady-state per pesan** (ratchet enc+dec dua arah) | **195–330 µs** | 570–695 µs | **Onigi 2–3,5× lebih cepat** |
| XEdDSA sign | 165,6 µs | 30,7 ms | **186× lebih cepat** |
| XEdDSA verify | 138,9 µs | 32,3 ms | **233× lebih cepat** |
| X25519 DH | 330,8 µs | 308,2 µs | ~par (keduanya native) |

> Dalam praktik: setiap prekey message masuk dan setiap pembentukan session — operasi yang terjadi saat pairing device baru, setelah reinstall, dan saat peer rotasi key — 9× lebih murah di CPU. Untuk bot multi-chat yang sibuk, ini beda antara event-loop jank terlihat dan tidak sama sekali.

### WABinary (codec binary protobuf-XML, rust encode default)

| Implementasi | µs/op roundtrip | ops/s | vs upstream |
|---|---:|---:|---|
| **Onigi — Rust encode (default)** | **146,4** | 6.832 | **+5,7% lebih cepat** |
| Onigi — JS fallback (`ONIGI_RUST_WABINARY=0`) | 155,7 | 6.422 | ~par |
| Upstream baileys rc14 | 154,7 | 6.465 | baseline |
| Onigi — Rust decode (`ONIGI_RUST_WABINARY_DECODE=1`, opt-in) | ~255 | ~3.900 | 65% lebih lambat — benar default OFF |

### Keunggulan Onigi vs upstream rc14 (terverifikasi di kode)

- **TC-token**: implementasi paritas penuh WA Web (persist index, merge write, prune 24 jam, bucket expiry 28 hari, re-issue setelah identity change, recovery 463, gating AB props) — upstream rc14 hanya parsial.
- **Sistem retry (gaya whatsmeow)**: MessageRetryManager dengan deteksi collision baseKey, penjadwalan phone-request, kode error MAC — upstream rc14 tidak punya.
- **Anti-spoof protocolMessage**: SELF_ONLY_TYPES di-drop dari origin non-self (port whatsmeow) — keunggulan security atas upstream.
- **LTHash soft-recovery** saat app-state mismatch (warn + partial state) alih-alih hard-fail seperti upstream.
- **Fix write-amplification**: debounce flush device-list (5 detik, satu `keys.set`), noise burst-concat, lazy stack-capture di timeout.
- **LIDMappingStore** dengan inflight-coalescing (dedupe USync lookup bersamaan); queue offline node dibatasi 5000.

### Celah yang ditemukan audit September 2026 (urut prioritas fix)

| # | Severity | Masalah | Lokasi |
|---|---|---|---|
| 1 | CRITICAL (kebersihan rilis) | `package.json` pin `oktz-signal 0.2.0-rc.1` tapi `node_modules`/lockfile resolve **0.1.7** (`npm ls` → invalid) — versi yang dikirim ke user tidak pernah dites di tree ini | `package.json:38` |
| 2 | HIGH | Bug session-selection oktz-signal (entry pertama BTreeMap, bukan session open) ter-trigger dari `encryptMessage` di setiap pesan keluar saat record punya >1 session (LID migration membuat record multi-session jadi kondisi *normal*). **Mitigasi di wrapper**: prune ke 1 session open sebelum encrypt | `lib/Signal/libsignal.js:115-124` |
| 3 | HIGH | `process.nextTick(async …)` di `emitOwnEvents` **tanpa `.catch()`** — listener user yang throw jadi unhandledRejection (crash process di default Node 20) | `lib/Socket/messages-send.js:1202-1206` |
| 4 | MEDIUM | `relayMessage` menahan mutex transaksi per-akun sepanjang pipeline termasuk RTT network — semua send terserial total saat load | `lib/Socket/messages-send.js:493-918` |
| 5 | MEDIUM | `sender-key-memory` di-write unconditional per group send (seluruh map dipersist walau tidak ada recipient baru) | `lib/Socket/messages-send.js:609` |
| 6 | MEDIUM | WAM telemetry: 831KB konstanta mati termuat ke module graph via `export * from './WAM/index.js'` — tidak pernah dipakai runtime | `lib/WAM/constants.js` |
| 7 | MEDIUM | `historyCache` di event-buffer tanpa hard cap antar-flush — initial sync akun besar menahan setiap key yang pernah dilewati | `lib/Utils/event-buffer.js:27-79` |
| 8 | MEDIUM | `+countChild.attrs.value` crash diam-diam bila child `<count>` absen (cek pre-key-low mati senyap) | `lib/Socket/messages-recv.js:560-561` |

Hasil audit memory leak: **praktis bersih** — lifecycle cleanup socket menutup semua cache/timer, keyed mutex pakai refcount cleanup, `end()` idempotent. Sisa LOW: `setTimeout` 8 detik tanpa `unref()`, Map `fileLocks` level modul, dan gap historyCache di atas.

Catatan gap test coverage: **jalur Signal/E2EE roundtrip punya nol test** — padahal komponen inilah yang diganti total. Menambah test roundtrip encrypt→decrypt adalah test bernilai tertinggi yang bisa dimiliki repo ini.

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
