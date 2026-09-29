<div align="center">

# onigis

**Library WhatsApp multi-device, fork dari `@whiskeysockets/baileys` 7.0.0-rc14, dengan engine E2EE diganti ke Rust native berlisensi MIT.**

[![npm](https://img.shields.io/badge/npm-10.1.0--rc.6-25D366?style=flat-square&logo=npm)](https://www.npmjs.com/package/onigis)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodemon)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![tests](https://img.shields.io/badge/tests-428%20pass-informational?style=flat-square)](#pengujian)

**[English → README.md](README.md)**

</div>

---

## Apa ini

`onigis` adalah fork dari [Baileys](https://github.com/WhiskeySockets/Baileys)
di 7.0.0-rc14. Engine Signal Protocol — bagian yang mengenkripsi pesan Anda —
diganti ke [`oktz-signal`](https://github.com/OktzO/oktz-signal) plus
`oktz-curve25519`, keduanya Rust berlisensi MIT di belakang NAPI, menggantikan
`libsignal` GPL-3.0. Selain engine itu, desain upstream tidak ditulis ulang.

Fokus proyek: bot chat multi-media — pipeline audio, video, gambar, dan stiker,
plus antarmuka HTML inline yang ter-render di dalam gelembung pesan.

## Apa yang tidak akan diceritakan README ini

Tiga hal yang biasanya diklaim README sejenis, dan yang tidak diklaim di sini:

- **Tidak ada angka performa.** Tidak ada benchmark di repositori ini. Versi
  lama file ini memuat tabel — "9× lebih cepat dari upstream", "186× lebih cepat
  XEdDSA", "+5,7% di WABinary" — tanpa satu pun skrip reproduksi di dalam repo.
  Angka itu dihapus karena tidak ada yang bisa mereproduksinya, dan angka yang
  tidak bisa diperiksa lebih buruk daripada tidak ada.
- **Tidak ada klaim bahwa kartu ter-render.** Apakah klien WhatsApp tertentu
  menggambar `buttonsMessage` adalah perilaku Meta. Tidak ada test di repositori
  ini yang bisa mengamatinya, jadi tidak diklaim di mana pun.
- **Tidak ada klaim konformitas protokol terhadap server sungguhan.** Yang
  diverifikasi adalah aritmetikanya: tanda tangan forged ditolak, ciphertext
  forged tidak bisa didekripsi, dan frame yang library ini hasilkan bisa dibaca
  oleh decoder-nya sendiri. Lihat [docs/protocol.md](docs/protocol.md) untuk apa
  yang tercakup dan apa yang tidak.

---

## Kebutuhan

| | |
|---|---|
| Node.js | `>= 20.0.0` (dideklarasikan di `engines`; dites di 20 dan 22) |
| E2EE native | `linux-x64` atau `linux-arm64`, glibc atau musl |

### Dukungan platform

Permukaan native adalah tiga paket dengan cakupan **berbeda-bed**. Disatakan
persis, karena salah di sini mudah terjadi ke dua arah:

| paket | peran | cara dikirim | platform |
|---|---|---|---|
| `oktz-signal` 0.3.0-rc.1 | E2EE, XEdDSA | `.node` via `optionalDependencies` | `linux-arm64-{gnu,musl}`, `linux-x64-{gnu,musl}` — **empat, dan tidak ada yang lain** |
| `oktz-curve25519` 0.0.4 | keygen dan DH X25519 | satu `.node`, tanpa `optionalDependencies` | `linux-x64-gnu` saja |
| `whatsapp-rust-bridge` 0.5.4 | encoder WABinary | **WebAssembly**, di-inline di `dist/index.js` | platform mana pun dengan WebAssembly |
| `node:crypto` | AES-GCM, SHA-256, HMAC, X25519, PBKDF2 | bawaan Node | semua |

Yang menghasilkan:

| platform | `import 'onigis'` | permukaan non-E2EE | E2EE |
|---|---|---|---|
| `linux-x64` (glibc) | jalan | jalan | jalan |
| `linux-arm64` (glibc atau musl) | jalan | jalan | jalan |
| `darwin` (macOS) | jalan | jalan | **gagal di pemakaian E2EE pertama** |
| `win32` (Windows) | jalan | jalan | **gagal di pemakaian E2EE pertama** |
| `android-arm64` | jalan | jalan | **gagal di pemakaian E2EE pertama** |

**macOS dan Windows bukan platform yang tidak didukung — itu platform tanpa
engine E2EE.** Sejak commit `cb02e9e` library ini bisa di-import dengan bersih
di sana, dan semua yang tidak involve enkripsi tetap jalan: JID, encode/decode
WABinary, seluruh permukaan protobuf, metadata grup, dan semua builder pesan.
Kegagalan datang di pemanggilan E2EE pertama, sebagai error bertipe:

```js illustrative
try {
  await sock.sendMessage(jid, { text: 'hai' }, { messageId });
} catch (error) {
  if (error.code === 'ONIGI_SIGNAL_ENGINE_UNSUPPORTED') {
    // name: 'SignalEngineUnavailableError'
    // message menyebut platform, engine, dan paket yang harus di-install
    // cause: error loader aslinya
  }
}
```

**Klasifikasikan lewat `code`, jangan lewat teks pesan.** Pesannya ditulis untuk
manusia dan bisa diubah wording-nya. Ada kode kedua yang lebih sempit,
`ONIGI_XEDDSA_UNSUPPORTED`, artinya tidak ada binding yang punya prebuild sehingga
XEdDSA sign *dan* verify sama-sama tidak tersedia; `Curve.verify` lalu menjawab
`false` dan memberi peringatan sekali — itu fail-closed dan benar, tapi artinya
handshake Noise tidak bisa diselesaikan.

`tests/signal-lazy-engine.test.mjs` mereproduksi install darwin/win32 secara
persis dan memverifikasi semua di atas, termasuk bahwa engine yang hilang tidak
pernah dilaporkan sebagai "sesi tidak ada" atau "identitas tidak ada".

**Apa yang benar-benar dieksekusi CI** dinyatakan di setiap job summary: suite
jalan di `ubuntu-latest` (x64, glibc), di Node 20 dan Node 22. **Tidak ada job
CI yang jalan di arm64 dan tidak ada yang jalan di musl.** Baris arm64 dan musl
di matriks ada agar celah itu terlihat di laporan, bukan untuk mengklaim cakupan.

---

## Instalasi

```bash
npm install onigis
```

`oktz-signal` adalah prarilis. Di registry, `0.3.0-rc.1` berada di dist-tag
`rc`; `latest` masih menunjuk ke `0.1.7`. Kalau npm me-resolve `0.1.7`,
install versinya secara eksplisit.

### Dependency opsional

Empat fitur butuh paket yang bukan dependency library ini. Semuanya optional
peer, dimuat dengan dynamic `import()` di dalam `try`, jadi proses yang tidak
pernah memakai fitur itu juga tidak pernah memuatnya.

| paket | membuka | tanpa itu |
|---|---|---|
| `sharp` | `resizeImage`, `getVideoThumbnail` | `Error: Package "sharp" … npm install sharp` |
| `fluent-ffmpeg` | `convertToWhatsAppVideo`, `convertToOpusAudio`, `getVideoThumbnail` | `Error: … npm install fluent-ffmpeg` |
| `jimp` | thumbnail alternatif | — |
| `audio-decode` | waveform voice note (`ptt: true`) | — |
| `link-preview-js` | link preview | — |

`fluent-ffmpeg` juga butuh `ffmpeg` dan `ffprobe` di `PATH`; paketnya saja tidak
cukup. `music-metadata` adalah dependency wajib, jadi `probeMedia` selalu jalan.

Periksa apa yang benar-benar termuat di mesin Anda:

```bash
node -e "import('oktz-signal').then(m => console.log('signal:', typeof m.native.ratchetEncrypt))"
node -e "import('oktz-curve25519').then(m => console.log('curve:', typeof m.sign))"
node -e "import('whatsapp-rust-bridge').then(m => console.log('wabinary:', typeof m.expandAppStateKeys))"
```

`function` dari ketiganya berarti permukaan native ada. Dua yang pertama `.node`;
yang ketiga WebAssembly dan jalan di mana saja.

---

## Mulai cepat

```js illustrative
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'onigis';

const { state, saveCreds } = await useMultiFileAuthState('auth_info');

const sock = makeWASocket({ auth: state });

sock.ev.on('creds.update', saveCreds);

// Tidak ada sock.ev.lastDisconnect: alasannya datang di event itu sendiri.
sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
  if (qr) {
    console.log(qr);            // render sesuka Anda
  } else if (connection === 'close') {
    const status = lastDisconnect?.error?.output?.statusCode;
    console.log(status === DisconnectReason.loggedOut
      ? 'ter-unlink — hapus auth_info lalu pair lagi'
      : 'menghubungkan ulang');
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

`sock.user` adalah `creds.me` dan punya `.id`. Tidak ada `sock.user.jid` di
library ini; kode yang membacanya dapat `undefined` dan menempelkan participant
null ke pesan grup. Pakai `normalizeUserJid(sock)`, yang menerima jid, sock, atau
objek user.

`sock.ev` bukan Node `EventEmitter` — ia punya `on`, `off`, `removeAllListeners`
dan `emit`, tanpa `once`.

Panduan lengkap: **[docs/quickstart.md](docs/quickstart.md)**.

---

## Coba tanpa akun WhatsApp

Enam program di `examples/` jalan tanpa kredensial, tanpa jaringan, dan tanpa
akun:

```bash
node examples/01-connect.mjs           # handshake Noise, atas byte sungguhan
node examples/02-e2ee-roundtrip.mjs    # X3DH, ratchet, sender key grup
node examples/03-wabinary.mjs          # format wire, dan apa yang ditolaknya
node examples/04-rich-messages.mjs     # tombol, list, HTML inline
node examples/05-addressing.mjs        # JID PN / LID / hosted
node examples/06-media.mjs             # yang jalan tanpa dependency opsional
```

Atau semuanya, plus setiap blok kode yang bisa dijalankan di dokumen ini:

```bash
npm run docs:verify
```

`docs:verify` menjalankan masing-masing di proses sendiri dan gagal pada error
apa pun. Blok ````js` yang di dokumentasi, baik bertanda `run` maupun
`illustrative`, juga akan menggagalkan run — verifier tidak menjalankannya dan
tidak mengabaikannya diam-diam.

### Apa yang sebenarnya ditunjukkan `examples/01-connect.mjs`

Ia menjalankan `makeWASocket` sungguhan terhadap WebSocket server lokal yang
mimplementasikan separuh server dari `Noise_XX_25519_AESGCM_SHA256`, lalu
memverifikasi byte yang benar-benar ditulis klien. Hasilnya adalah **kegagalan**,
dan justru itu yang menarik:

```
clientHello: 36 bytes, ephemeral 32 bytes, re-encodes identically
client refused the server certificate: "noise intermediate certificate signature invalid"
```

Jadwal kunci cocok di kedua arah — klien mendekripsi `static` dan `payload` dari
server, yang tidak mungkin dilakukan kalau server menghitung jadwalnya berbeda.
Yang gagal adalah pemeriksaan sertifikat, karena `WA_CERT_DETAILS.PUBLIC_KEY`
adalah kunci jangka panjang asli milik WhatsApp dan separuh privatnya tidak ada
di repositori ini.

Penolakan itu adalah hasil yang benar, dan example-nya memverifikasi status code
dan pesan persisnya sehingga pelemahan di `lib/Utils/noise-handler.js:183` akan
menggagalkan test. Kunci transport karena itu tidak pernah dinegosiasikan di
example mana pun, dan tidak ada example yang mengklaim menunjukkan `sendMessage`
di atas transport sungguhan.

---

## Pesan kaya

`buttonsMessage` dan `listMessage` adalah template bawaan WhatsApp. Library ini
membangunnya; apakah klien tertentu menggambarnya adalah hal yang tidak bisa
diuji atau diklaim repositori ini.

```js illustrative
import { buildButtonsMessage, buildListMessage, sendClassicMessage } from 'onigis';

await sendClassicMessage(sock, jid, buildButtonsMessage({
  text: 'Pilih satu opsi',
  footer: '© onigis',
  buttons: [
    { buttonId: '.owner', buttonText: 'Owner' },
    { buttonId: '.menu', buttonText: 'Semua menu' }
  ]
}));

await sendClassicMessage(sock, jid, buildListMessage({
  title: 'Menu',
  buttonText: 'Buka',
  sections: [{
    title: 'Kategori',
    rows: [{ title: 'main', description: '19 perintah', rowId: '.menucat main' }]
  }]
}));
```

`relayMessage` menempelkan ulang node `<biz>` otomatis untuk payload seperti ini,
kecuali Anda sudah menyediakannya sendiri — tanpanya server menerima stanza tapi
klien tidak menggambar kartunya, dan pengiriman dilaporkan sukses.

### HTML inline di dalam gelembung pesan

```js illustrative
import { sendInlineWebUI } from 'onigis';

await sendInlineWebUI(sock, jid,
  '<!DOCTYPE html><html><body><h2>Menu</h2><button onclick="alert(1)">Go</button></body></html>',
  'Menu Bot'
);
```

HTML-nya dibawa sebagai base64-encoded JSON di bawah primitive typename
`GenAIaeacdsnwHtmlPrimitive`, di-forward dari jid Meta AI secara default. Nama
typename itu adalah identifier obfuscated WhatsApp Web dan bisa berubah antar
versi WhatsApp; kalau antarmukanya berhenti ter-render, konstanta itulah yang
perlu diperbarui (`WEBUI_PRIMITIVE_TYPENAME`, `lib/Utils/rich-webui.js:15`).
Payload di atas 64 KiB akan memberi peringatan.

---

## Media

```js illustrative
import { convertToWhatsAppVideo, convertToOpusAudio, getVideoThumbnail, resizeImage, probeMedia, getMp4Duration } from 'onigis';

const mp4 = await convertToWhatsAppVideo(buffer);          // butuh ffmpeg
const opus = await convertToOpusAudio(buffer);            // butuh ffmpeg
const thumb = await getVideoThumbnail(mp4, 1);            // butuh ffmpeg + sharp
const small = await resizeImage(imageBuffer, { width: 300, height: 300 });   // butuh sharp

const meta = await probeMedia(buffer, 'audio/mpeg');      // selalu tersedia
const dur = getMp4Duration(mp4Buffer);                    // selalu tersedia — parse atom MP4 langsung
```

`getMp4Duration` tidak butuh apa pun selain `node:buffer`. Ia menelusuri atom
`moov`/`mvhd` sendiri. Mengembalikan `0` untuk apa pun yang bukan MP4 secara
default, karena ia dijalankan pada byte dari pemanggil; teruskan
`{ silent: false }` untuk error yang menyebut guard mana yang kepicu.

`examples/06-media.mjs` menguji kedua sisi — jalur bebas dependency di atas MP4
byte-exact yang dibangun repositori ini sendiri, dan kontrak dependency opsional
dengan memverifikasi teks error persis saat `sharp` dan `ffmpeg` tidak ada.

---

## Addressing

WhatsApp meng-address satu orang dengan dua cara: nomor telepon
(`…@s.whatsapp.net`, "PN") dan identifier opaque (`…@lid`). Device 99 tinggal di
domain ketiga, `hosted`; pasangannya untuk LID adalah `hosted.lid`.

Library memperlakukan ini sebagai **domain berbeda, bukan dua nama untuk hal
yang sama**, dan tidak pernah mengarang konversi:

- `isPnUser` / `isLidUser` adalah tes domain. LID bukan nomor telepon.
- `areJidsSameUser(a, b)` membandingkan bagian user dan menolak operand mana pun
  yang bukan user — jid grup, broadcast, status, atau newsletter bukan user
  bagaimanapun bagian user-nya terbaca. Ia mengembalikan `false`, tidak pernah
  menebak, ketika salah satu sisi tidak menamai user.
- Alamat Signal adalah `name.deviceId`, dan untuk domain non-PN namanya adalah
  `user_<domainType>`, sehingga alamat LID dan alamat PN tidak bisa bertabrakan
  di session store.
- `sendMessage` menurunkan identitas pengirim dari addressing **chat**-nya,
  bukan dari tipe pesan, dan menempelkan nilai yang sama ke
  `contextInfo.participant`.

`onWhatsApp(...jids)` menjawab satu entri per input, sesuai urutan input, dengan
`jid` yang dikembalikan persis seperti yang pemanggil tulis, dan `exists` tiga
nilai:

| nilai | arti |
|---|---|
| `true` | server mengembalikan baris kontak |
| `false` | server mengembalikan baris yang bukan kontak |
| `null` | **tidak bisa ditentukan** |

`null` adalah jawaban sungguhan, bukan `false` yang malas. Ia mencakup `@lid`
tanpa mapping nomor telepon, dan baris yang tidak pernah dijawab server. Versi
sebelumnya mengembalikan jid milik server untuk setiap input — jadi pemanggil
yang mengirim `@lid` dapat nomor telepon kembali — dan menyamakan kedua kasus itu
dengan "tidak ada di WhatsApp".

**Dukungan LID tidak diklaim lengkap.** Resolusi butuh round trip usync sungguhan,
dan apakah server Meta menjawab konsisten di setiap kasus adalah hal yang tidak
bisa diuji repositori ini. `examples/05-addressing.mjs` menunjukkan apa yang
dilakukan helper untuk keenam bentuk jid, lalu menyatakan, di output-nya sendiri,
persis apa yang tidak dibuktikan.

Detail: [docs/api.md §7](docs/api.md#7-addressing-pn-lid-hosted).

---

## Catatan keamanan

Lima cacat di lini 10.1.0-rc.5 diperbaiki setelah tag `v10.1.0-rc.6`. **Kalau
Anda memakai rilis sampai dan termasuk `10.1.0-rc.6`, tiga di antaranya bisa
dijangkau oleh peer jarak jauh.** Semuanya didaftarkan lengkap dengan apa yang
membukakannya bagi penyerang, dan dengan commit yang memperbaikinya, di
[CHANGELOG.md](CHANGELOG.md#read-this-before-upgrading-from-1010-rc5-or-earlier).

Dua yang paling sering diremeh:

**Verifikasi tanda tangan adalah no-op.** `Curve.verify` membuang boolean yang
dikembalikan library native — yang menjawab `false` pada ketidakcocokan alih-alih
melempar error, berbeda dari `curve25519-js` yang digantikannya — lalu
hardcode `return true`. Setiap tanda tangan dengan bentuk yang masuk akal
terverifikasi. Itu membuat rantai sertifikat Noise dan tanda tangan pairing ADV
menjadi no-op, sehingga websocket tidak mengautentikasi apa pun tentang peer-nya.
`42d416d`.

**Satu pesan forged bisa membuat satu percakapan mati total.** Field `identityKey`
pada pembungkus `pkmsg` tidak dicakup MAC yang diperiksa saat dekripsi, dan
`auth.keys.transaction` adalah mutex per-key, bukan rollback. Kunci identitas
disimpan *sebelum* dekripsi, sehingga satu `pkmsg` yang tidak terautentikasi
bisa menghapus sesi yang sudah mapan dan menimpa kunci identitas yang tersimpan
sebelum MAC-nya sempat gagal. `9c64fc7`.

**Yang tidak diklaim.** Library ini tidak punya test terhadap server WhatsApp
sungguhan. Bahwa rantai sertifikat tervalidasi dengan benar terhadap yang asli,
bahwa interoperabilitas terjaga dengan klien WhatsApp terkini, dan bahwa tidak
ada cacat protokol lain yang tersisa — semuanya di luar jangkauan apa pun yang
ada di repositori ini.

---

## Pengujian

```bash
npm test              # 428 test, 74 file
npm run docs:verify   # setiap example, setiap blok dokumen yang bisa dijalankan
```

Keduanya jalan di CI pada Node 20 dan Node 22.

Dua jebakan pemanggilan yang sudah pernah menimpa repositori ini, dan keduanya
membikin CI rusak:

- **Jangan pernah `node --test` polos.** Ia turun ke `native/curve25519`, proyek
  Rust yang di-vendor dengan suite test sendiri yang butuh build dan gagal di
  sini. Ia mengambil `native/curve25519/tests/platform-loader.test.cjs` seolah
  itu milik kita.
- **Jangan pernah positional glob yang diapit**, `node --test 'tests/**/*.test.mjs'`.
  Dukungan glob bawaan Node untuk argumen posisional itu Node 22+; di Node 20
  perintah yang sama gagal dengan `Could not find 'tests/**/*.test.mjs'`.

`npm test` memakai glob *shell*, yang diekspansi shell sebelum Node melihatnya,
jadi jalan di keduanya. Itulah sebabnya script itu ditulis begitu.

Dua environment variable mengubah perilaku:

| variabel | efek |
|---|---|
| `ONIGI_RUST_WABINARY=0` | pakai encoder WABinary JS, bukan yang native |
| `ONIGI_RUST_WABINARY_DECODE=1` | pakai decoder native (opt-in; mati secara default) |

`whatsapp-rust-bridge` adalah modul WebAssembly dengan `dist/index.js`
men-inline wasm sebagai base64, jadi jalur encode jalan di platform mana pun
dengan WebAssembly. `lib/WABinary/rust-adapter.js:21` mengarahkan dua bentuk
yang divergen antara encoder native dan JS — atribut non-string, dan atribut
string kosong — ke encoder JS, sehingga keduanya tidak pernah tercampur dalam satu
frame.

---

## Dokumentasi

| | |
|---|---|
| [docs/quickstart.md](docs/quickstart.md) | connect, kirim, terima; dan jalur offline |
| [docs/api.md](docs/api.md) | 170 anggota socket dan 282 export teratas, dikelompokkan |
| [docs/protocol.md](docs/protocol.md) | format wire dan pemeriksaannya, dikutip per `file:line` |
| [CHANGELOG.md](CHANGELOG.md) | apa yang berubah, dan apa yang salah |
| [examples/](examples/) | enam program yang bisa dijalankan |

`lib/index.js` meng-export 282 simbol. `docs/api.md` mengelompokkannya, bukan
mencantumkan satu per satu, karena tabel 282 baris yang tidak pernah diperiksa
lebih buruk daripada tabel terkelompok dengan penunjuk ke `.d.ts`. Ada 99 file
`.d.ts` yang dipelihara manual dan tidak ada `tsc` di repo ini, jadi itu artefak
yang di-commit, bukan output build; `tests/dts-declarations.test.mjs` menjaga
konsistensinya dengan runtime.

---

## Kredit

- **[KzorArsuy](https://github.com/rozzak2009)** — audit, rebase rc14, optimasi, multimedia dan WebUI
- **[OktzO](https://github.com/OktzO)** — fork `oktz-baileys` asli, dan engine `oktz-signal` / `oktz-curve25519`
- **[WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys)** — upstream

## Lisensi

MIT.
