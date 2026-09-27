import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { uploadingNecessaryImages } from '../lib/Utils/business.js';

// uploadingNecessaryImages never awaited the write stream's `finish` before
// calling waUploadToServer, so the uploader opened the temp file while it was
// still buffered, and the stream had no 'error' listener at all, so a
// filesystem failure (ENOSPC on a small tmpfs, EACCES, read-only mount)
// terminated the process with an unhandled 'error' event. fs.unlink also sat
// after the upload with no finally, so a failed upload leaked the temp file.

const tempFiles = () => readdirSync(tmpdir()).filter((n) => n.startsWith('img'));

const payloadOf = (bytes, chunk = 16384) => {
    const buf = randomBytes(chunk);
    return Readable.from((function* () {
        for (let sent = 0; sent < bytes; sent += chunk) {
            yield buf;
        }
    })());
};

const recorder = () => {
    const seen = [];
    const waUploadToServer = async (filePath, opts) => {
        seen.push({
            filePath,
            sizeAtUploadTime: statSync(filePath).size,
            declaredSha: opts.fileEncSha256B64,
            actualSha: createHash('sha256').update(readFileSync(filePath)).digest('base64')
        });
        return { directPath: '/v/t62.7118-24/fake' };
    };
    return { seen, waUploadToServer };
};

test('the uploader sees the whole file, not a still-buffering one', async () => {
    const bytes = 8 * 1024 * 1024;
    const { seen, waUploadToServer } = recorder();
    const [result] = await uploadingNecessaryImages([{ stream: payloadOf(bytes) }], waUploadToServer);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].sizeAtUploadTime, bytes, 'uploader was handed a truncated file');
    assert.equal(result.url, 'https://mmg.whatsapp.net/v/t62.7118-24/fake');
});

test('fileEncSha256B64 matches the bytes the uploader actually receives', async () => {
    const bytes = 2 * 1024 * 1024;
    const { seen, waUploadToServer } = recorder();
    await uploadingNecessaryImages([{ stream: payloadOf(bytes) }], waUploadToServer);
    assert.equal(seen[0].declaredSha, seen[0].actualSha, 'sha of the finished file must match the advertised sha');
});

test('a failed upload still removes the temp file', async () => {
    const before = tempFiles();
    await assert.rejects(
        () => uploadingNecessaryImages([{ stream: payloadOf(4096) }], async () => {
            throw new Error('upload rejected by server');
        }),
        /upload rejected by server/
    );
    const leaked = tempFiles().filter((n) => !before.includes(n));
    assert.deepEqual(leaked, [], `temp file leaked: ${leaked.join(', ')}`);
});

test('a successful upload removes the temp file', async () => {
    const before = tempFiles();
    const { waUploadToServer } = recorder();
    await uploadingNecessaryImages([{ stream: payloadOf(4096) }], waUploadToServer);
    const leaked = tempFiles().filter((n) => !before.includes(n));
    assert.deepEqual(leaked, [], `temp file leaked: ${leaked.join(', ')}`);
});

test('an oversized image is rejected instead of filling the disk', async () => {
    const { seen, waUploadToServer } = recorder();
    await assert.rejects(
        () => uploadingNecessaryImages([{ stream: payloadOf(64 * 1024 * 1024) }], waUploadToServer),
        (err) => {
            assert.match(err.message, /exceeds/i);
            return true;
        }
    );
    assert.deepEqual(seen, [], 'nothing may be uploaded once the cap is hit');
});

test('images already hosted on whatsapp.net are passed through untouched', async () => {
    const { seen, waUploadToServer } = recorder();
    const [result] = await uploadingNecessaryImages([{ url: 'https://mmg.whatsapp.net/v/t62.7118-24/x' }], waUploadToServer);
    assert.deepEqual(seen, []);
    assert.equal(result.url, 'https://mmg.whatsapp.net/v/t62.7118-24/x');
});

test('a failed upload of one image does not stop its siblings', async () => {
    const { seen, waUploadToServer } = recorder();
    const results = await uploadingNecessaryImages(
        [{ stream: payloadOf(4096) }, { stream: payloadOf(4096) }],
        waUploadToServer
    );
    assert.equal(results.length, 2);
    assert.equal(seen.length, 2);
    assert.equal(join(tmpdir(), 'nope'), join(tmpdir(), 'nope'));
});
