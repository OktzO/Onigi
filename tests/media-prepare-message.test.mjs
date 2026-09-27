import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { prepareWAMessageMedia } from '../lib/Utils/messages.js';

// (b) the newsletter branch awaited fs.unlink(filePath) *after* options.upload()
// with no finally, so a rejected upload leaked the temp file forever. The
// non-newsletter branch at :184 already does this correctly.
//
// (c) assertColor had no `return` on the numeric branch, so a numeric
// backgroundColor resolved to undefined and backgroundArgb was silently
// dropped for PTT audio at :176.

const NEWSLETTER_JID = '120363000000000000@newsletter';
const USER_JID = '6281234567890@s.whatsapp.net';

const uploadOk = (seen) => async (filePath) => {
    seen.push(filePath);
    return { mediaUrl: 'https://mmg.whatsapp.net/x', directPath: '/v/x' };
};

const noopCache = { get: async () => undefined, set: async () => { } };
const silent = { debug() { }, info() { }, warn() { }, error() { } };

test('a failed newsletter upload does not leak the temp file', async () => {
    const seen = [];
    await assert.rejects(
        () => prepareWAMessageMedia({ image: Buffer.alloc(2048, 7) }, {
            jid: NEWSLETTER_JID,
            upload: async (filePath) => {
                seen.push(filePath);
                throw new Error('upload rejected by server');
            },
            mediaCache: noopCache,
            logger: silent
        }),
        /upload rejected by server/
    );
    assert.equal(seen.length, 1, 'the uploader must have been reached');
    assert.equal(existsSync(seen[0]), false, `temp file leaked: ${seen[0]}`);
});

test('a successful newsletter upload removes the temp file', async () => {
    const seen = [];
    const obj = await prepareWAMessageMedia({ image: Buffer.alloc(2048, 7) }, {
        jid: NEWSLETTER_JID,
        upload: uploadOk(seen),
        mediaCache: noopCache,
        logger: silent
    });
    assert.equal(seen.length, 1);
    assert.equal(existsSync(seen[0]), false);
    assert.ok(obj.imageMessage?.url);
});

test('a numeric backgroundColor reaches backgroundArgb for PTT audio', async () => {
    const seen = [];
    const obj = await prepareWAMessageMedia({ audio: Buffer.alloc(4096, 3), ptt: true, seconds: 1 }, {
        jid: USER_JID,
        backgroundColor: 0x11223344,
        upload: uploadOk(seen),
        mediaCache: noopCache,
        logger: silent
    });
    assert.equal(obj.audioMessage?.backgroundArgb, 0x11223344);
});

test('a negative numeric backgroundColor reaches backgroundArgb for PTT audio', async () => {
    const seen = [];
    const obj = await prepareWAMessageMedia({ audio: Buffer.alloc(4096, 3), ptt: true, seconds: 1 }, {
        jid: USER_JID,
        backgroundColor: -16777216,
        upload: uploadOk(seen),
        mediaCache: noopCache,
        logger: silent
    });
    assert.equal(obj.audioMessage?.backgroundArgb, 0xFF000000);
});

test('a string backgroundColor still reaches backgroundArgb for PTT audio', async () => {
    const seen = [];
    const obj = await prepareWAMessageMedia({ audio: Buffer.alloc(4096, 3), ptt: true, seconds: 1 }, {
        jid: USER_JID,
        backgroundColor: '#ff0000',
        upload: uploadOk(seen),
        mediaCache: noopCache,
        logger: silent
    });
    assert.equal(obj.audioMessage?.backgroundArgb, 0xFFFF0000);
});

test('a failed non-newsletter upload still removes the temp file', async () => {
    const seen = [];
    await assert.rejects(
        () => prepareWAMessageMedia({ image: Buffer.alloc(2048, 7) }, {
            jid: USER_JID,
            upload: async (filePath) => {
                seen.push(filePath);
                throw new Error('upload rejected by server');
            },
            mediaCache: noopCache,
            logger: silent
        }),
        /upload rejected by server/
    );
    assert.equal(seen.length, 1);
    assert.equal(existsSync(seen[0]), false, `temp file leaked: ${seen[0]}`);
});
