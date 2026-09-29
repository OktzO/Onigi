# Quickstart

Two paths, and the difference between them matters.

- **[With a real account](#with-a-real-account)** — what you write. Connects to
  `wss://web.whatsapp.com/ws/chat`, pairs by QR, sends a message. Requires a
  phone number and network access.
- **[Without one](#without-a-real-account)** — what you can verify right now.
  Every example here runs with no credentials, no network and no WhatsApp
  account, and `npm run docs:verify` runs all of them in CI.

---

## With a real account

Install and connect:

```bash
npm install onigis
```

```js illustrative
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'onigis';

const { state, saveCreds } = await useMultiFileAuthState('auth_info');

const sock = makeWASocket({
  auth: state,
  // the default browser identity; change it if you like
  browser: ['Chrome', 'Desktop', '1.0.0']
});

sock.ev.on('creds.update', saveCreds);
```

`useMultiFileAuthState` is a plain-file implementation of the `auth.keys` store
the library requires. Any store with `get`, `set`, `del` and `transaction` works;
`transaction` must be a per-key mutex (a promise chain), not a rollback — see
[protocol.md §6](protocol.md#6-session-and-key-storage).

### Pairing

`connection.update` carries the QR as a base64 string. Render it however you
like:

```js illustrative
sock.ev.on('connection.update', ({ connection, qr }) => {
  if (qr) {
    console.log('scan this QR:\n', qr);   // feed it to any qr terminal renderer
  } else if (connection === 'close') {
    const { error } = sock.ev.lastDisconnect ?? {};
    const status = error?.output?.statusCode;
    if (status === DisconnectReason.loggedOut) {
      console.log('this device was unlinked — delete auth_info and pair again');
    } else {
      console.log('connection closed, reconnecting:', error?.message);
    }
  }
});
```

There is a working, credential-free version of the connection path in
[examples/01-connect.mjs](../examples/01-connect.mjs). It runs the real
handshake and asserts on the real bytes; the only thing it cannot do is finish,
because the server side needs WhatsApp's signing key. The reason is explained
in [protocol.md §2](protocol.md#observation-the-handshake-cannot-complete-against-a-local-server).

### Receiving

```js illustrative
sock.ev.on('messages.upsert', async ({ messages, type }) => {
  for (const msg of messages) {
    if (!msg.message || msg.key.fromMe) {
      continue;
    }
    const text = msg.message.conversation
      ?? msg.message.extendedTextMessage?.text
      ?? '';

    if (text === '!ping') {
      await sock.sendMessage(msg.key.remoteJid, { text: 'pong' }, { quoted: msg });
    }
  }
});
```

`type` is `'notify'` when the message arrived while you were online and
`'append'` when it was fetched from the phone because the phone was
unavailable. Messages that failed to decrypt arrive with
`messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT` and a
`messageStubParameters` describing why — they are not dropped.

### Sending

```js illustrative
// text
await sock.sendMessage(jid, { text: 'hello' });

// image with a caption
await sock.sendMessage(jid, {
  image: { url: 'https://example.com/photo.jpg' },
  caption: 'Hello!'
});

// voice note — needs the optional peer dependency
await sock.sendMessage(jid, {
  audio: { url: './voice.ogg' },
  mimetype: 'audio/ogg; codecs=opus',
  ptt: true
});
```

`jid` is whatever the message came back on: `…@s.whatsapp.net` for a phone
number, `…@lid` for the opaque identifier, `…@g.us` for a group. Do not
translate one to the other yourself — see [api.md §7](api.md#7-addressing-pn-lid-hosted).

---

## Without a real account

Everything below runs offline. Run them:

```bash
node examples/01-connect.mjs           # the Noise handshake, on real bytes
node examples/02-e2ee-roundtrip.mjs    # X3DH, ratchet, group sender key
node examples/03-wabinary.mjs          # the wire format, and what it refuses
node examples/04-rich-messages.mjs     # buttons, lists, inline HTML
node examples/05-addressing.mjs        # PN / LID / hosted JIDs
node examples/06-media.mjs             # what works with no optional dependency
```

Or all of them, plus every runnable block in these docs:

```bash
npm run docs:verify
```

### What each one actually proves

| example | what is real | what is *not* |
|---|---|---|
| `01-connect` | the clientHello on the wire, the Noise XX key schedule in both directions, the client's certificate refusal | the handshake cannot complete — the local server cannot sign a chain with WhatsApp's root key, and the client is right to refuse |
| `02-e2ee-roundtrip` | X3DH handshake, ratchet encrypt/decrypt, MAC rejection of a forged ciphertext, group sender key, one-time prekey consumption | nothing — this is the production code path, with two repositories in one process |
| `03-wabinary` | the exact bytes of a `<message>` stanza, and encoder/decoder parity | nothing |
| `04-rich-messages` | the built objects encode to the protobuf this library ships | **whether a WhatsApp client renders a card.** That is Meta's behaviour, and nothing in this repository can observe it |
| `05-addressing` | what the JID helpers do with every domain shape | that Meta's servers answer consistently — needs a live usync |
| `06-media` | `getMp4Duration` on a byte-exact MP4 atom tree, `probeMedia` on a generated WAV | the `sharp` / `ffmpeg` paths, which need optional peers that are not installed |

### A runnable E2EE round trip

This is `examples/02-e2ee-roundtrip.mjs`, condensed. Two real repositories, one
real prekey bundle, no network:

```js run
import assert from 'node:assert/strict';
import { makeLibSignalRepository } from 'onigis/lib/Signal/libsignal.js';
import { Curve, generateSignalPubKey, signedKeyPair } from 'onigis/lib/Utils/crypto.js';

const silent = { level: 'silent', trace() { }, debug() { }, info() { }, warn() { }, error() { }, child() { return this; } };

const memoryKeyStore = () => {
  const buckets = new Map();
  const chains = new Map();
  const bucket = type => {
    let b = buckets.get(type);
    if (!b) buckets.set(type, b = new Map());
    return b;
  };
  return {
    get: async (type, ids) => {
      const b = bucket(type);
      if (ids === undefined) return Object.fromEntries(b);
      const out = {};
      for (const id of ids) if (b.has(id)) out[id] = b.get(id);
      return out;
    },
    set: async patch => {
      for (const [type, entries] of Object.entries(patch)) {
        const b = bucket(type);
        for (const [id, value] of Object.entries(entries)) {
          if (value === null) b.delete(id); else b.set(id, value);
        }
      }
    },
    del: async key => { for (const b of buckets.values()) b.delete(key); },
    transaction: (exec, key) => {
      const previous = chains.get(key) || Promise.resolve();
      const next = previous.then(exec, exec);
      chains.set(key, next.then(() => { }, () => { }));
      return next;
    }
  };
};

const makeEnd = (registrationId) => {
  const identityKeyPair = Curve.generateKeyPair();
  const signedPreKey = signedKeyPair(identityKeyPair, 1);
  const keys = memoryKeyStore();
  const repository = makeLibSignalRepository(
    { creds: { registrationId, signedIdentityKey: identityKeyPair, signedPreKey }, keys },
    silent,
    async () => null
  );
  return { identityKeyPair, signedPreKey, keys, repository, registrationId };
};

const ALICE = '15559876543@s.whatsapp.net';
const BOB = '15551234567@s.whatsapp.net';
const alice = makeEnd(11111);
const bob = makeEnd(22222);

// Bob publishes a prekey bundle — the shape lib/Utils/signal.js:63 extracts
// from a device list.
const oneTimePreKey = Curve.generateKeyPair();
await bob.keys.set({ 'pre-key': { 7: oneTimePreKey } });
await alice.repository.injectE2ESession({
  jid: BOB,
  session: {
    registrationId: bob.registrationId,
    identityKey: generateSignalPubKey(bob.identityKeyPair.public),
    signedPreKey: {
      keyId: bob.signedPreKey.keyId,
      publicKey: generateSignalPubKey(bob.signedPreKey.keyPair.public),
      signature: bob.signedPreKey.signature
    },
    preKey: { keyId: 7, publicKey: generateSignalPubKey(oneTimePreKey.public) }
  }
});

// The first message to an unknown peer is a PreKeyWhisperMessage: that is the
// X3DH handshake, and `type` is how you see it.
const first = await alice.repository.encryptMessage({ jid: BOB, data: Buffer.from('hello') });
assert.equal(first.type, 'pkmsg');
const received = await bob.repository.decryptMessage({ jid: ALICE, type: first.type, ciphertext: first.ciphertext });
assert.equal(received.toString(), 'hello');

// The session exists now, so the reply is a plain WhisperMessage.
const reply = await bob.repository.encryptMessage({ jid: ALICE, data: Buffer.from('and a reply') });
assert.equal(reply.type, 'msg');
const replyRead = await alice.repository.decryptMessage({ jid: BOB, type: reply.type, ciphertext: reply.ciphertext });
assert.equal(replyRead.toString(), 'and a reply');

// The one-time prekey is consumed, so it cannot be replayed.
assert.equal((await bob.keys.get('pre-key', ['7']))['7'], undefined);

// A forged ciphertext does not decrypt. A fresh message, because the ratchet has
// already consumed the key for the one above.
const toForge = await bob.repository.encryptMessage({ jid: ALICE, data: Buffer.from('do not tamper') });
const forged = Buffer.from(toForge.ciphertext);
forged[forged.length - 1] ^= 0x01;
let rejected = false;
try {
  await alice.repository.decryptMessage({ jid: BOB, type: toForge.type, ciphertext: forged });
} catch {
  rejected = true;
}
assert.ok(rejected, 'a one-bit-flipped ciphertext must not decrypt');

// …and the untampered original still does, so the rejection was the forgery.
const intact = await alice.repository.decryptMessage({ jid: BOB, type: toForge.type, ciphertext: toForge.ciphertext });
assert.equal(intact.toString(), 'do not tamper');

console.log('X3DH established, ratchet round-tripped, forgery rejected, prekey consumed');
```

### A runnable WABinary round trip

Also from `examples/03-wabinary.mjs`:

```js run
import assert from 'node:assert/strict';
import { encodeBinaryNode, decodeBinaryNode, proto } from 'onigis';

const stanza = {
  tag: 'message',
  attrs: { to: '15551234567@s.whatsapp.net', id: 'ONIGI0001', t: '1700000000' },
  content: [{
    tag: 'plaintext',
    attrs: {},
    content: proto.Message.encode(proto.Message.fromObject({ conversation: 'hello' })).finish()
  }]
};
const frame = encodeBinaryNode(stanza);
const back = await decodeBinaryNode(frame);
assert.equal(back.tag, 'message');
assert.deepEqual(back.attrs, stanza.attrs);
assert.equal(proto.Message.decode(back.content[0].content).conversation, 'hello');

// A non-string attribute is rejected rather than silently dropped: the
// list-size prefix already counted it, so a skipped value desyncs the frame.
assert.throws(() => encodeBinaryNode({ tag: 'x', attrs: { a: 1700000000 } }), /invalid attribute "a"/);

// undefined and null are absent, not present-and-wrong.
const holes = await decodeBinaryNode(encodeBinaryNode({ tag: 'x', attrs: { a: 'kept', b: undefined, c: null } }));
assert.deepEqual(holes.attrs, { a: 'kept' });

// A remote attribute value that happens to be an Object.prototype name used to
// vanish, because the token table inherited from Object.prototype.
for (const name of ['toString', 'constructor', '__proto__', 'valueOf']) {
  assert.equal((await decodeBinaryNode(encodeBinaryNode({ tag: 'x', attrs: { name } }))).attrs.name, name);
}

// A hostile frame is refused, and a real one is not.
const wrap = Buffer.from([0xf8, 0x02, 0xfc, 0x01, 0x77, 0xf8, 0x01]);
const leaf = Buffer.from([0xf8, 0x01, 0xfc, 0x01, 0x78]);
const nested = depth => Buffer.concat([Buffer.from([0x00]), ...Array.from({ length: depth }, () => wrap), leaf]);
let tooDeep = null;
try { await decodeBinaryNode(nested(2000)); } catch (e) { tooDeep = e; }
assert.ok(tooDeep && !(tooDeep instanceof RangeError) && /too deep/.test(tooDeep.message));
assert.equal((await decodeBinaryNode(nested(64))).tag, 'w');

console.log(`stanza: ${frame.length} bytes; first 12: ${[...frame.subarray(0, 12)].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
```

---

## Troubleshooting

**`ONIGI_SIGNAL_ENGINE_UNSUPPORTED` on the first send.** No native prebuild for
`oktz-signal` on this platform. The library imported fine — the engine loads on
first use — and every non-E2EE path still works. See
[api.md §8](api.md#8-platform-support-what-is-actually-shipped).

**`Curve.verify failed closed: …` in a warning.** Same root cause, different
surface: this platform has no XEdDSA implementation, so signature *verification*
answers `false`. That is fail-closed and correct, but it means a Noise handshake
cannot succeed. `ONIGI_XEDDSA_UNSUPPORTED` is the code on the error.

**A message arrives as `CIPHERTEXT`.** The session could not decrypt it. The
reason is in `messageStubParameters`; the full error context is logged with the
message key. Common causes: the peer's device list changed and prekeys are
stale, or `useMultiFileAuthState` was deleted partway so the session store is
empty while `creds` survived.

**Group sending fails with `Incorrect private key length: 0`.** You are on a
store written by a build older than commit `4ca7553`, where every group member
collapsed onto one sender-key slot. It is self-healing in the sense that the
slot no longer matches, so a new sender key is created — but the stale slot
should be deleted from your key store so the old record is not read again.

**`npm test` picks up `native/curve25519`.** Use `npm test`. Bare `node --test`
descends into the vendored Rust project, which has its own test that needs a
build. See [api.md §9](api.md#9-running-the-tests).
