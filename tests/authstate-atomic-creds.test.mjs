import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BufferJSON } from '../lib/Utils/generics.js';
import { useMultiFileAuthState } from '../lib/Utils/use-multi-file-auth-state.js';

// writeFile() truncates creds.json in place, so a crash mid-write leaves a
// short file; readData then swallowed every read error into `null`, which
// became initAuthCreds() — a torn write was indistinguishable from "no
// session" and silently produced a brand-new identity.

const scratch = () => mkdtempSync(join(tmpdir(), 'authstate-'));

const registeredCreds = () => ({
    noiseKey: { private: { type: 'Buffer', data: Array.from(Buffer.alloc(32, 9)) }, public: { type: 'Buffer', data: Array.from(Buffer.alloc(32, 8)) } },
    pairingEphemeralKeyPair: { private: { type: 'Buffer', data: Array.from(Buffer.alloc(32, 7)) }, public: { type: 'Buffer', data: Array.from(Buffer.alloc(32, 6)) } },
    signedIdentityKey: { public: { type: 'Buffer', data: Array.from(Buffer.alloc(32, 5)) } },
    signedPreKey: { keyPair: { public: { type: 'Buffer', data: Array.from(Buffer.alloc(32, 4)) } }, signature: Buffer.alloc(64, 3), keyId: 1 },
    registrationId: 424242,
    advSecretKey: 'aWR2LXNlY3JldA==',
    processedHistoryMessages: [],
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: { unarchiveChats: false },
    registered: true,
    me: { id: '6281234567890:12@s.whatsapp.net', name: 'Onigi' },
    lid: '123456789012345@lid',
    platform: 'android',
    keepAliveIntervalMs: 25000
});

test('a missing creds.json still yields a fresh, unregistered identity', async () => {
    const { state } = await useMultiFileAuthState(scratch());
    assert.equal(state.creds.registered, false);
    assert.equal(state.creds.registrationId < 16384, true);
    assert.ok(state.creds.noiseKey.private);
});

test('a complete creds.json round-trips', async () => {
    const folder = scratch();
    const expected = registeredCreds();
    writeFileSync(join(folder, 'creds.json'), JSON.stringify(expected, BufferJSON.replacer));
    const { state } = await useMultiFileAuthState(folder);
    assert.equal(state.creds.registered, true);
    assert.equal(state.creds.registrationId, 424242);
    assert.equal(state.creds.me.name, 'Onigi');
    assert.equal(state.creds.lid, '123456789012345@lid');
});

test('a truncated creds.json is rejected, not replaced by a fresh identity', async () => {
    const folder = scratch();
    const full = JSON.stringify(registeredCreds(), BufferJSON.replacer);
    assert.ok(full.length > 1000, `fixture must exceed the audit's 1182-byte creds, got ${full.length}`);
    writeFileSync(join(folder, 'creds.json'), full.slice(0, 40));
    await assert.rejects(
        () => useMultiFileAuthState(folder),
        (err) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /creds\.json/);
            assert.ok(err.cause, 'the underlying read/parse error must be preserved as cause');
            return true;
        }
    );
});

test('an unparseable creds.json is rejected', async () => {
    const folder = scratch();
    writeFileSync(join(folder, 'creds.json'), 'not json at all');
    await assert.rejects(() => useMultiFileAuthState(folder), /creds\.json/);
});

test('a creds.json that exists but is unreadable is rejected, not treated as absent', async () => {
    const folder = scratch();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(folder, 'creds.json'));
    await assert.rejects(
        () => useMultiFileAuthState(folder),
        (err) => {
            assert.match(err.message, /creds\.json/);
            assert.notEqual(err.cause?.code, 'ENOENT', 'EISDIR must not be laundered into "no session"');
            return true;
        }
    );
});

test('an EACCES read error is rejected, not treated as absent', async (t) => {
    if (process.getuid?.() === 0) {
        t.skip('root bypasses file permissions');
        return;
    }
    const folder = scratch();
    const credsPath = join(folder, 'creds.json');
    writeFileSync(credsPath, JSON.stringify(registeredCreds(), BufferJSON.replacer));
    chmodSync(credsPath, 0o000);
    try {
        await assert.rejects(
            () => useMultiFileAuthState(folder),
            (err) => {
                assert.match(err.message, /creds\.json/);
                assert.equal(err.cause?.code, 'EACCES');
                return true;
            }
        );
    } finally {
        chmodSync(credsPath, 0o600);
    }
});

test('saveCreds replaces creds.json atomically instead of rewriting it in place', async () => {
    const folder = scratch();
    const credsPath = join(folder, 'creds.json');
    writeFileSync(credsPath, JSON.stringify(registeredCreds(), BufferJSON.replacer));
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    state.creds.accountSyncCounter = 5;
    const before = statSync(credsPath).ino;
    await saveCreds();
    const after = statSync(credsPath);
    assert.notEqual(after.ino, before, 'creds.json must be swapped in by rename, not truncated and rewritten');
    assert.equal(after.size > 0, true);
});

test('saveCreds leaves no temp file behind', async () => {
    const folder = scratch();
    const { saveCreds } = await useMultiFileAuthState(folder);
    await saveCreds();
    assert.throws(() => statSync(join(folder, 'creds.json.tmp')));
});

test('saveCreds writes the whole object even when it is large', async () => {
    const folder = scratch();
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    state.creds.processedHistoryMessages = Array.from({ length: 4000 }, (_, i) => `msg-${i}-${'x'.repeat(200)}`);
    await saveCreds();
    const written = JSON.parse(readFileSync(join(folder, 'creds.json'), 'utf-8'), BufferJSON.reviver);
    assert.equal(written.processedHistoryMessages.length, 4000);
    assert.equal(written.processedHistoryMessages[3999], state.creds.processedHistoryMessages[3999]);
});
