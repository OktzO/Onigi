import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Transform } from 'node:stream';
import { downloadEncryptedContent } from '../lib/Utils/messages-media.js';

// downloadEncryptedContent used to end with `return fetched.pipe(output, { end: true })`.
// pipe() does not forward a source error: when the socket dies mid-download,
// `fetched` -- an undici body from getHttpStream (:311) -- emits 'error' with
// TypeError: terminated, nothing in the chain listens for it, and the 'error'
// event goes uncaught and kills the process. On an unattended bot that is a
// remote crash-DoS from any transient network blip (upstream baileys: PR #2838,
// issue #2750).
//
// A local server that declares a Content-Length it never finishes sending,
// ships one chunk, then destroys the socket reproduces it for real -- no fetch
// stub needed, because the failure has to land on the actual undici body.
//
// The fix forwards the failure onto `output` (the stream we hand back), so the
// three in-tree consumers all see it as a rejection: `for await` in
// chat-utils.js:290 and messages.js:884, and pipeline() in history.js:33.

const cipherKey = randomBytes(32);
const iv = randomBytes(16);
const plaintext = randomBytes(3000); // not a multiple of 16: exercises PKCS7 unpad

const encrypt = () => {
    const aes = createCipheriv('aes-256-cbc', cipherKey, iv);
    return Buffer.concat([aes.update(plaintext), aes.final()]);
};

const TRUNCATED_LENGTH = 1024 * 1024; // promised, never delivered
const socketDeathDelay = 120; // long enough for the consumer to attach first

const server = createServer((req, res) => {
    if (req.url === '/full') {
        const body = encrypt();
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(body.length) });
        res.end(body);
        return;
    }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(TRUNCATED_LENGTH) });
    res.write(encrypt().subarray(0, 16384));
    setTimeout(() => { res.socket?.destroy(); }, socketDeathDelay).unref();
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

// A truncation that is not forwarded leaves the consumer awaiting a chunk that
// will never arrive, so every wait is raced against a deadline: the failure has
// to surface as a rejection, not as a hang.
const deadline = async (label, work, ms = 5000) => {
    let timer;
    try {
        return await Promise.race([
            work(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} never settled`)), ms); })
        ]);
    } finally {
        clearTimeout(timer);
    }
};

const collect = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) { chunks.push(chunk); }
    return Buffer.concat(chunks);
};

const isSocketDeath = (err) => {
    const text = `${err?.message ?? ''} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`;
    return /terminated|socket|aborted|ECONNRESET|EPIPE|UND_ERR/i.test(text);
};

test('a socket death mid-download is delivered to the consumer instead of killing the process', async () => {
    const escaped = [];
    const onUncaught = (err) => { escaped.push(err); };
    process.on('uncaughtException', onUncaught);
    try {
        // the whole download must still work: a fix that forwards errors by
        // swallowing the stream would pass the assertion below while breaking
        // every media download, so the happy path is checked in the same test
        const complete = await deadline('the complete download', async () => {
            const stream = await downloadEncryptedContent(`${base}/full`, { cipherKey, iv });
            assert.ok(stream instanceof Transform, 'downloadEncryptedContent must still hand back the decrypting Transform');
            return { stream, plain: await collect(stream) };
        });
        assert.equal(complete.plain.length, plaintext.length);
        assert.ok(complete.plain.equals(plaintext), 'the completed download must decrypt byte-for-byte');

        const delivered = [];
        await deadline('the truncated download', async () => {
            const stream = await downloadEncryptedContent(`${base}/truncated`, { cipherKey, iv });
            try {
                const partial = await collect(stream);
                delivered.push({ truncated: true, bytes: partial.length });
            } catch (err) {
                delivered.push({ err });
            }
        });

        assert.equal(delivered.length, 1, 'the truncated download must settle exactly once');
        assert.equal(delivered[0].truncated, undefined, `the truncated download silently resolved with ${delivered[0].bytes} bytes`);
        assert.ok(delivered[0].err, 'the truncated download must reject');
        assert.ok(isSocketDeath(delivered[0].err), `expected the socket failure, got ${delivered[0].err?.message}`);
        assert.deepEqual(escaped.map((e) => e?.message), [], 'the download failure escaped as an uncaught exception');
    } finally {
        process.off('uncaughtException', onUncaught);
        server.closeAllConnections();
        server.close();
    }
});