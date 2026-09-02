<div align="center">

# ⚡ oktz-baileys

### Fork ourin-baileys — E2EE Signal Protocol via `oktz-signal` (MIT)

[![Version](https://img.shields.io/badge/npm-9.1.5-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://www.npmjs.com/package/oktz-baileys)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Signal](https://img.shields.io/badge/Signal-oktz--signal%200.1.7-red?style=for-the-badge&logo=signal&logoColor=white)](https://www.npmjs.com/package/oktz-signal)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

</div>

**oktz-baileys** adalah fork dari `ourin-baileys` (turunan `@whiskeysockets/baileys`) yang mengganti implementasi E2EE Signal Protocol.

**Perubahan utama:** dependency `libsignal` (GPL-3.0) → `oktz-signal` (MIT). Semua fungsi Signal (`SessionCipher`, `SessionBuilder`, `SessionRecord`, `ProtocolAddress`, `GroupCipher`, `SenderKeyDistributionMessage`) tetap di-export lewat `lib/Signal/libsignal.js` — hanya backend kriptografi yang diganti.

---

## ⚠️ Status: UNSTABLE / EXPERIMENTAL

> **Fork ini masih dalam tahap produksi awal.** Perubahan di atas `ourin-baileys` terbatas pada swap E2EE engine, tapi belum ada audit keamanan.

- **Wire compatibility** terhadap WhatsApp Web server **belum diverifikasi untuk semua edge case** — bug interop ditemukan & diperbaiki di `oktz-signal` secara iteratif.
- **Session API** bisa berubah jika ada ketidakcocokan dengan `libsignal` v6 yang ditemukan kemudian.
- **Group sender key** (`GroupCipher`) menggunakan `oktz-signal` helpers — jalur yang kurang teruji dibanding session cipher.
- Gunakan di lingkungan non-produksi dulu sampai stabilitas terverifikasi.

---

## Fitur

- **MIT license** — aman untuk proyek komersial, tidak terikat GPL `libsignal`.
- **Drop-in replacement** — semua kode konsumen (`ourin-md`, dll) tidak perlu perubahan.
- **Native Rust crypto** — X3DH, Double Ratchet, curve X25519/XEdDSA via `oktz-signal`; curve helpers group sender key via `oktz-curve25519` (native napi-rs).
- **Group sender key** — `GroupCipher`, `GroupSessionBuilder`, `SenderKeyDistributionMessage` tetap berfungsi.
- **LID–PN session migration** — migration session antar JID (PN → LID).

## Instalasi

```bash
npm install oktz-baileys
```

## Perbedaan dari `ourin-baileys`

| Aspek | ourin-baileys | oktz-baileys |
|-------|---------------|--------------|
| Signal engine | `libsignal` (GPL-3.0) | `oktz-signal` (MIT) |
| Curve helpers | JS (`libsignal` curve) | `oktz-curve25519` (native napi-rs) |
| Implementasi | JavaScript/TS | Rust native (napi-rs) |
| License | GPL (via libsignal) | MIT (full) |
| Curve key format | 33-byte (0x05 prefix) | Fix 0.1.7: 33-byte |
| Session rebuild | — | Fix 0.1.7: by baseKey |

## Testing

```bash
npm test
```

## Lisensi

**MIT** — bebas dari GPL restriction `libsignal`.