import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BufferJSON } from '../lib/Utils/generics.js';
import { useMultiFileAuthState } from '../lib/Utils/use-multi-file-auth-state.js';

// authstate-atomic-creds.test.mjs covers creds.json that throws on read or
// parse. This covers the values that parse cleanly and are then treated as if
// the file were not there: `(await readData('creds.json')) || initAuthCreds()`
// cannot tell "absent" from "present but falsy or not a credentials object",
// so a null / 0 / false / "" / array / string body silently fabricated a brand
// new identity — the same silent-forgery class the atomic write already closed
// for a torn file. A present-but-unusable body must be rejected like a parse
// error; only a genuinely absent file, or a legitimate empty state, may yield
// initAuthCreds().

const scratch = () => mkdtempSync(join(tmpdir(), 'authstate-usable-'));

const withCreds = async (raw) => {
    const folder = scratch();
    writeFileSync(join(folder, 'creds.json'), raw);
    return folder;
};

const UNUSABLE = [
    ['null', 'null'],
    ['zero', '0'],
    ['false', 'false'],
    ['an empty string', '""'],
    ['an array', '[1,2,3]'],
    ['an array of objects', '[{"me":null}]'],
    ['a string', '"hello"'],
    ['a number', '424242']
];

for (const [label, raw] of UNUSABLE) {
    test(`a creds.json holding ${label} is rejected, not replaced by a fresh identity`, async () => {
        const folder = await withCreds(raw);
        await assert.rejects(
            () => useMultiFileAuthState(folder),
            (err) => {
                assert.ok(err instanceof Error);
                assert.match(err.message, /creds\.json/, 'the error must name the offending file');
                return true;
            }
        );
    });
}

test('a creds.json with a null identity is rejected, not read as unpaired', async () => {
    const folder = await withCreds('{"me":null}');
    await assert.rejects(() => useMultiFileAuthState(folder), /creds\.json/);
});

test('a rejected creds.json leaves the file untouched for the operator', async () => {
    const folder = await withCreds('null');
    await assert.rejects(() => useMultiFileAuthState(folder), /creds\.json/);
    assert.equal(JSON.parse(readFileSync(join(folder, 'creds.json'), 'utf-8')), null);
});

test('an empty object is a legitimate empty state, not corruption', async () => {
    const folder = await withCreds('{}');
    const { state } = await useMultiFileAuthState(folder);
    assert.equal(state.creds.registered, undefined, 'an empty state must not claim to be registered');
    assert.notEqual(state.creds.registered, true);
});

test('a full identity still loads after the guard is added', async () => {
    const folder = scratch();
    const expected = {
        noiseKey: { private: { type: 'Buffer', data: Array.from(Buffer.alloc(32, 9)) }, public: { type: 'Buffer', data: Array.from(Buffer.alloc(32, 8)) } },
        registered: true,
        registrationId: 424242,
        me: { id: '6281234567890:12@s.whatsapp.net', name: 'Onigi' },
        lid: '123456789012345@lid'
    };
    writeFileSync(join(folder, 'creds.json'), JSON.stringify(expected, BufferJSON.replacer));
    const { state } = await useMultiFileAuthState(folder);
    assert.equal(state.creds.registered, true);
    assert.equal(state.creds.registrationId, 424242);
    assert.equal(state.creds.me.name, 'Onigi');
    assert.equal(state.creds.lid, '123456789012345@lid');
});
