import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { hkdf } from '../lib/Utils/crypto.js';
import { downloadMediaMessage } from '../lib/Utils/messages.js';
import { decryptMediaRetryData, encryptMediaRetryRequest, getMediaKeys } from '../lib/Utils/messages-media.js';
import { proto } from '../WAProto/index.js';

// Two independent ways media recovery was unreachable on an unattended bot.
//
// (a) getHttpStream (messages-media.js:311) throws @hapi/boom with
//     `{ statusCode }`. On the installed @hapi/boom 9.1.4 a Boom carries no
//     `.status` property at all -- its enumerable keys are
//     `data, isBoom, isServer, output`, and the status lives on
//     `error.output.statusCode`. The guard at messages.js:848 therefore never
//     fired, ctx.reuploadRequest() was dead code, and expired media (410 Gone /
//     404) could never be re-uploaded by the phone. Upstream: PRs #2834/#2835,
//     issue #2767.
//
// (b) getMediaRetryKey (messages-media.js:729) hands `mediaKey` straight to
//     hkdf(). A proto `bytes` field survives proto.Message#toJSON persistence as
//     a *base64 string* (the same conversion generic-utils.js:78 and
//     messages-recv.js:344 perform in-tree), and hkdf() then derives a different
//     retry key from that string than from the bytes -- so encryptMediaRetryRequest
//     and decryptMediaRetryData disagreed with the phone about the
//     "WhatsApp Media Retry Notification" key.
//
// Both are silent in the worst way: no crash, no log, just media that never
// recovers. So neither test may pass by the fix swallowing the error -- each
// asserts that the recovery is reached AND that a genuine failure is still
// reported to the caller.

// ---------------------------------------------------------------- (a) the 410

const mediaKey = randomBytes(32);
const plainBytes = randomBytes(3000); // not a multiple of 16: exercises PKCS7 unpad

const messageKey = (id) => ({ remoteJid: '1234567890@s.whatsapp.net', fromMe: false, id });

const imageMessage = (url) => ({
    key: messageKey('MEDIAREUP01'),
    message: {
        imageMessage: {
            url,
            mimetype: 'image/jpeg',
            mediaKey // bytes, exactly as proto.Message#decode hands them over
        }
    }
});

// A real 410 off a real socket rather than a hand-made error object: the point
// is that the status survives getHttpStream's own Boom construction, and only a
// server proves which field the fetch failure lands on.
const server = createServer(async (req, res) => {
    if (req.url === '/gone' || req.url === '/missing') {
        res.writeHead(req.url === '/gone' ? 410 : 404, { 'content-type': 'text/plain' });
        res.end('media expired');
        return;
    }
    const { cipherKey, iv } = await getMediaKeys(mediaKey, 'image');
    const aes = createCipheriv('aes-256-cbc', cipherKey, iv);
    const body = Buffer.concat([aes.update(plainBytes), aes.final()]);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(body.length) });
    res.end(body);
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

const noopLogger = { info() { }, debug() { }, warn() { }, error() { }, trace() { } };
const settle = (promise) => promise.then((value) => ({ value }), (err) => ({ err }));

test('a 410 from getHttpStream triggers a reupload request', async () => {
    const escaped = [];
    const onEscaped = (err) => { escaped.push(err); };
    process.on('uncaughtException', onEscaped);
    process.on('unhandledRejection', onEscaped);
    try {
        // recovery: the reuploaded message points at fresh media. Before the fix
        // the 410 was rethrown untouched and reuploadRequest was never called.
        let reuploads = 0;
        const recovered = await settle(downloadMediaMessage(imageMessage(`${base}/gone`), 'buffer', {}, {
            logger: noopLogger,
            reuploadRequest: async (message) => {
                reuploads++;
                assert.equal(message.key.id, 'MEDIAREUP01', 'the reupload request must carry the failing message');
                return imageMessage(`${base}/fresh`);
            }
        }));

        assert.equal(recovered.err, undefined, `the reupload must recover, got ${recovered.err?.constructor?.name}: ${recovered.err?.message}`);
        assert.equal(reuploads, 1, 'the 410 must reach ctx.reuploadRequest exactly once');
        assert.ok(Buffer.isBuffer(recovered.value), 'the retried download must still return a buffer');
        assert.ok(recovered.value.equals(plainBytes), 'the reuploaded media must decrypt byte-for-byte');

        // 404 is the other member of REUPLOAD_REQUIRED_STATUS and has to travel the
        // same path, so a fix that special-cases 410 is caught here.
        let notFounds = 0;
        const missing = await settle(downloadMediaMessage(imageMessage(`${base}/missing`), 'buffer', {}, {
            logger: noopLogger,
            reuploadRequest: async () => { notFounds++; return imageMessage(`${base}/fresh`); }
        }));
        assert.equal(notFounds, 1, 'a 404 must reach ctx.reuploadRequest exactly once');
        assert.ok(missing.value?.equals(plainBytes), `the 404 reupload must recover, got ${missing.err?.constructor?.name}: ${missing.err?.message}`);

        // a reupload that also fails must still surface the failure: the retry may
        // not end in a resolved promise carrying no media (silent data loss), and
        // may not escape the call (a process kill when driven from an event
        // handler).
        let retried = 0;
        const stuck = await settle(downloadMediaMessage(imageMessage(`${base}/gone`), 'buffer', {}, {
            logger: noopLogger,
            reuploadRequest: async () => { retried++; return imageMessage(`${base}/gone`); }
        }));

        assert.equal(stuck.err?.isBoom, true, `a reupload that also 410s must reject with the Boom, got ${stuck.err?.constructor?.name}: ${stuck.err?.message}`);
        assert.equal(stuck.err.output?.statusCode ?? stuck.err.status, 410, 'the caller must still see the 410');
        assert.equal(retried, 1, 'the retry must happen once, not in a loop');
        assert.deepEqual(escaped.map((e) => `${e?.constructor?.name}: ${e?.message}`), [],
            'a media failure escaped as an uncaught exception or unhandled rejection');
    } finally {
        process.off('uncaughtException', onEscaped);
        process.off('unhandledRejection', onEscaped);
        server.closeAllConnections();
        server.close();
    }
});

// ------------------------------------------------- (b) the string mediaKey

// The ciphertext encryptMediaRetryRequest builds: the stanza id, GCM-sealed
// under the "WhatsApp Media Retry Notification" retry key derived from mediaKey.
// Both halves of the round trip go through the two exported functions, so this
// pins public behaviour rather than a private helper.
const sealRetryRequest = (mediaKeyArg) => {
    const node = encryptMediaRetryRequest(messageKey('RETRYNOTIF01'), mediaKeyArg, '111222333@s.whatsapp.net');
    const encryptNode = node.content.find((c) => c.tag === 'encrypt');
    return {
        ciphertext: encryptNode.content.find((c) => c.tag === 'enc_p').content,
        iv: encryptNode.content.find((c) => c.tag === 'enc_iv').content
    };
};

test('getMediaRetryKey agrees for a string mediaKey and its bytes', () => {
    const msgId = 'RETRYNOTIF01';

    // what proto toJSON persistence actually leaves on disk: a base64 string.
    // Pin the encoding here, because the whole fix hinges on it being base64 and
    // not hex.
    const persistedKey = proto.Message.ImageMessage
        .decode(proto.Message.ImageMessage.encode(proto.Message.ImageMessage.create({ mediaKey })).finish())
        .toJSON().mediaKey;
    assert.equal(typeof persistedKey, 'string', 'protobuf toJSON must persist mediaKey as a string');
    assert.ok(Buffer.compare(Buffer.from(persistedKey, 'base64'), mediaKey) === 0,
        'the persisted form must be base64 of the same bytes -- not hex');

    // reference: a request sealed under the key derived from the bytes
    const fromBytes = sealRetryRequest(mediaKey);
    assert.equal(decryptMediaRetryData(fromBytes, mediaKey, msgId).stanzaId, msgId,
        'the byte-derived retry key must open its own ciphertext');

    // The persisted string must derive the identical retry key. Since both the
    // sealing and the opening side go through getMediaRetryKey, "the ciphertext
    // sealed under the bytes opens under the string" IS "the two derived keys
    // are equal". Before the fix this threw "Unsupported state or unable to
    // authenticate data": the two sides silently used different keys.
    const fromString = decryptMediaRetryData(fromBytes, persistedKey, msgId);
    assert.equal(fromString.stanzaId, msgId, 'a base64 mediaKey must derive the same retry key as its bytes');

    // ...and the reverse direction, which is the one that matters for a phone's
    // answer: a ciphertext sealed under the string opens under the bytes.
    assert.equal(decryptMediaRetryData(sealRetryRequest(persistedKey), mediaKey, msgId).stanzaId, msgId,
        'a request sealed with a base64 mediaKey must be readable with the same mediaKey as bytes');

    // Ruling out the lazy fix that only stops the throw: hashing the base64 *text*
    // is still the wrong key, so it must not agree with hashing the bytes.
    const keyOf = (input) => Buffer.from(hkdf(input, 32, { info: 'WhatsApp Media Retry Notification' }));
    assert.notDeepEqual(keyOf(Buffer.from(persistedKey, 'utf8')), keyOf(mediaKey),
        'hashing the base64 text must not be an acceptable substitute for hashing the bytes');
});