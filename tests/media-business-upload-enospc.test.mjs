import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Readable } from 'node:stream';

// business.js:201 creates the temp write stream with no 'error' listener, so
// ENOSPC on a small tmpfs (or EACCES, or a read-only mount) turned into an
// unhandled 'error' event and killed Node with exit 1. /dev/full is a real
// character device whose writes always fail with ENOSPC, so redirecting
// createWriteStream at it reproduces the disk-full case without needing a
// full filesystem.
//
// node --test gives each test file its own process, and the ESM namespace for
// a builtin is built from its CJS exports on first import, so patching
// require('fs') before the dynamic import below is enough to redirect every
// later createWriteStream call.

const require = createRequire(import.meta.url);
const realCreateWriteStream = require('fs').createWriteStream;
require('fs').createWriteStream = () => realCreateWriteStream('/dev/full');

const { uploadingNecessaryImages } = await import('../lib/Utils/business.js');

const payload = (bytes) => {
    const buf = Buffer.alloc(16384, 0x41);
    return Readable.from((function* () {
        for (let sent = 0; sent < bytes; sent += 16384) {
            yield buf;
        }
    })());
};

test('ENOSPC while writing the temp file surfaces as a rejection, not a process kill', async () => {
    const escaped = [];
    const onUncaught = (err) => escaped.push(err);
    process.on('uncaughtException', onUncaught);
    try {
        await assert.rejects(
            () => uploadingNecessaryImages([{ stream: payload(1024 * 1024) }], async () => {
                assert.fail('uploader must not be reached when the write failed');
            }),
            (err) => {
                assert.equal(err.code, 'ENOSPC', `expected ENOSPC, got ${err.code ?? err.message}`);
                return true;
            }
        );
        assert.deepEqual(escaped, [], 'the write error escaped as an uncaught exception');
    } finally {
        process.off('uncaughtException', onUncaught);
    }
});

test('the uploader is never called after a write failure', async () => {
    const called = [];
    await assert.rejects(
        () => uploadingNecessaryImages([{ stream: payload(1024 * 1024) }], async (p) => {
            called.push(p);
            return { directPath: '/v/x' };
        }),
        /ENOSPC|exceeds/
    );
    assert.deepEqual(called, []);
});
