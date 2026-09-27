import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Readable } from 'node:stream';

// messages-media.js created its three temp write streams (getRawMediaUploadData
// at :36, encryptedStream's encFileWriteStream at :318 and originalFileStream
// at :323) with no 'error' listener. `events.once(ws, 'finish')` only covers
// the window while it is pending, so a failure on open() that landed while the
// source stream was between chunks had nowhere to go: the 'error' event became
// uncaught and Node exited (the audit saw UNCAUGHT -> ENOENT, exit 9).
//
// Pointing createWriteStream at a path under a directory that does not exist
// makes open() fail with ENOENT for real. The source stream delays before its
// first chunk so the failure lands outside any pending once().

const require = createRequire(import.meta.url);
const realCreateWriteStream = require('fs').createWriteStream;
const BAD_DIR = '/nonexistent-onigi-test-dir-9f2a';
require('fs').createWriteStream = (...args) => realCreateWriteStream(`${BAD_DIR}/${args[0]}`);

const escaped = [];
process.on('uncaughtException', (err) => escaped.push(err));

const { encryptedStream, getRawMediaUploadData } = await import('../lib/Utils/messages-media.js');

const slowPayload = (bytes) => {
    const buf = Buffer.alloc(16384, 0x42);
    return Readable.from((async function* () {
        await new Promise((r) => setTimeout(r, 60));
        for (let sent = 0; sent < bytes; sent += 16384) {
            yield buf;
        }
    })());
};

const assertNothingEscaped = () => {
    assert.deepEqual(escaped.map((e) => e.code ?? e.message), [], 'a temp-file write error escaped as an uncaught exception');
    escaped.length = 0;
};

test('getRawMediaUploadData surfaces a temp-file open failure as a rejection', async () => {
    await assert.rejects(
        () => getRawMediaUploadData({ stream: slowPayload(65536) }, 'image', undefined),
        (err) => {
            assert.equal(err.code, 'ENOENT');
            return true;
        }
    );
    assertNothingEscaped();
});

test('encryptedStream surfaces an enc temp-file open failure as a rejection', async () => {
    await assert.rejects(
        () => encryptedStream({ stream: slowPayload(65536) }, 'image', { saveOriginalFileIfRequired: false }),
        (err) => {
            assert.equal(err.code, 'ENOENT');
            return true;
        }
    );
    assertNothingEscaped();
});

test('encryptedStream surfaces an original temp-file open failure as a rejection', async () => {
    await assert.rejects(
        () => encryptedStream({ stream: slowPayload(65536) }, 'image', { saveOriginalFileIfRequired: true }),
        (err) => {
            assert.equal(err.code, 'ENOENT');
            return true;
        }
    );
    assertNothingEscaped();
});
