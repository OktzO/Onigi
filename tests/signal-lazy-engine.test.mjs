import { test } from 'node:test';
import assert from 'node:assert/strict';
import module, { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * The last portability blocker, pinned.
 *
 * lib/Signal/libsignal.js opened with a top-level
 * `import * as libsignal from 'oktz-signal'`. oktz-signal's loader throws
 * `Cannot find native binding` on every platform it has no prebuild for --
 * darwin, win32, android-arm64 (its optionalDependencies cover only
 * linux-{arm64,x64}-{gnu,musl}). A top-level ESM import is evaluated while the
 * module graph is built, so the throw took down lib/index.js itself: on those
 * platforms the whole library was unimportable, long before any caller could
 * reach a plain-text send, group metadata, WABinary encode/decode or a plugin.
 *
 * What must hold instead: the engine loads at the FIRST E2EE operation, never
 * at import, and its absence surfaces as a typed error that names the platform
 * and the package to install -- never as a load-time crash, and never as a
 * silent "no session"/"no identity".
 *
 * Simulation: oktz-signal's native binding is redirected, at every route by
 * which it is reached (the bare subpath curve-native.js requires, and the
 * relative requires inside oktz-signal/src/*.js and oktz-signal/index.js), at a
 * stub that throws exactly what the real napi loader throws when no candidate
 * resolves. oktz-signal's real ESM entry and its src/ modules stay in place, so
 * this reproduces the darwin/win32 shape of the install rather than a fake
 * package, and nothing in the repo is touched -- the stub lives in a temp dir.
 */

const BINDING = 'native/signal/index.cjs';
const stubDir = mkdtempSync(join(tmpdir(), 'signal-no-prebuild-'));
const stub = join(stubDir, 'index.cjs');

// Records who required it, then throws exactly what the real napi loader throws
// when no candidate resolves. A module that threw is evicted from the CJS cache,
// so the record is a faithful count of attempts. `module.parent` is what
// distinguishes the engine's own graph from the failure-tolerant probe
// lib/Modded/curve-native.js is entitled to make at import (see engineLoads).
writeFileSync(stub, `globalThis.__signalBindingLoads = globalThis.__signalBindingLoads || [];
globalThis.__signalBindingLoads.push(module.parent && module.parent.filename);
throw new Error('Cannot find native binding. npm has a bug related to optional dependencies.');
`);

const isBindingRequest = (specifier, parentURL) => {
    if (!specifier.includes(BINDING)) {
        return false;
    }
    // A relative specifier only names this binding from inside oktz-signal; any
    // other relative `./.../index.cjs` belongs to somebody else's graph.
    return !specifier.startsWith('.') || (parentURL || '').includes('/oktz-signal/');
};

module.registerHooks({
    resolve(specifier, context, nextResolve) {
        if (isBindingRequest(specifier, context.parentURL)) {
            return { url: new URL(`file://${stub}`).href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    }
});

const platform = `${process.platform}-${process.arch}`;

const settle = (promise) => promise.then((value) => ({ value, error: null }), (error) => ({ value: null, error }));

// Loads made by oktz-signal itself, i.e. the engine. curve-native.js probes the
// same binding at import inside a try/catch and is expected to; only the engine's
// own reach for it is what this change had to remove. These are read after the
// imports below, and read again later, so they have to be declared first.
// Copy, not the live array: the stub keeps appending to it for the rest of the
// process, and these two are meant to be a snapshot of the import alone.
const bindingLoads = () => [...(globalThis.__signalBindingLoads || [])];
const engineLoads = () => bindingLoads().filter((parent) => String(parent).includes('/oktz-signal/'));
const allBindingLoads = () => bindingLoads().length;

// Both imports are settled rather than awaited bare: a regression here used to
// take the whole process down with an uncaught module-job error, which reports
// one failure instead of saying which surface broke.
const index = await settle(import('../lib/index.js'));
const signal = await settle(import('../lib/Signal/libsignal.js'));
const loaded = { namespace: index.value, error: index.error };
const makeLibSignalRepository = signal.value?.makeLibSignalRepository;

// Snapshot taken with nothing but the module graph built, and before the first
// E2EE use below. `engineLoadsAtImport` is what proves the engine is not loaded
// eagerly; `bindingLoadsAtImport` covers the whole graph, so a module that
// reached for the binding some other way would be visible too.
const engineLoadsAtImport = engineLoads();
const bindingLoadsAtImport = bindingLoads();
const ENGINE_UNAVAILABLE = 'ONIGI_SIGNAL_ENGINE_UNSUPPORTED';

function makeKeyStore() {
    const data = new Map();
    const chains = new Map();
    return {
        get: async (type, ids) => {
            const bucket = data.get(type) || new Map();
            const out = {};
            for (const id of ids) if (bucket.has(id)) out[id] = bucket.get(id);
            return out;
        },
        set: async (patch) => {
            for (const [type, entries] of Object.entries(patch)) {
                let bucket = data.get(type);
                if (!bucket) data.set(type, bucket = new Map());
                for (const [id, value] of Object.entries(entries)) {
                    if (value === null) bucket.delete(id);
                    else bucket.set(id, value);
                }
            }
        },
        transaction: (exec, key) => {
            const prev = chains.get(key) || Promise.resolve();
            const next = prev.then(exec, exec);
            chains.set(key, next.then(() => {}, () => {}));
            return next;
        }
    };
}

const silentLogger = new Proxy({}, { get: () => () => {} });

// Key material is never reached: every operation below must fail on the missing
// engine, before any of it is read.
const makeRepo = async (seed) => {
    const keys = makeKeyStore();
    const creds = {
        registrationId: 222,
        signedIdentityKey: { private: Buffer.alloc(32, 0x22), public: Buffer.alloc(32, 0x23) },
        signedPreKey: { keyPair: { private: Buffer.alloc(32, 0x33), public: Buffer.alloc(32, 0x34) } }
    };
    if (seed) {
        await keys.set(seed);
    }
    return makeLibSignalRepository({ creds, keys }, silentLogger, async () => null);
};

const assertEngineUnavailable = (error) => {
    assert.ok(error instanceof Error, 'must be a real Error, never a silent value');
    assert.equal(error.code, ENGINE_UNAVAILABLE, 'must be classifiable by code, not by message text');
    assert.equal(error.name, 'SignalEngineUnavailableError');
    assert.match(error.message, /E2EE/i, 'the message must say what is unavailable');
    assert.ok(error.message.includes(platform), `error must name the platform, got: ${error.message}`);
    assert.match(error.message, /oktz-signal/, 'the message must name the engine that is missing');
    assert.ok(
        error.message.includes(`@oktz-signal/signal-${platform}`),
        `error must name the package to install, got: ${error.message}`
    );
    assert.ok(error.cause, 'the loader error must be preserved as `cause`');
    assert.match(String(error.cause?.message ?? error.cause), /Cannot find native binding/);
    return true;
};

const JID = '15551@s.whatsapp.net';

// The first E2EE use in this process, driven from the top level so that no test
// body can have warmed the engine cache before it. The counts around it turn
// "loaded at first use, exactly once" into a measurement.
const firstUse = makeLibSignalRepository
    ? await settle(makeRepo().then((repo) => repo.encryptMessage({ jid: JID, data: Buffer.from('first') })))
    : { error: new Error('lib/Signal/libsignal.js did not load') };
const engineLoadsAfterFirstUse = engineLoads().length;

test('importing the library succeeds with no native signal prebuild', () => {
    assert.equal(
        index.error, null,
        `lib/index.js must import on a platform with no prebuild, got: ${index.error?.stack ?? index.error}`
    );
    assert.equal(signal.error, null, `lib/Signal/libsignal.js must import, got: ${signal.error?.stack ?? signal.error}`);
    assert.equal(typeof loaded.namespace.makeWASocket, 'function');
    assert.equal(typeof loaded.namespace.jidDecode, 'function');
    assert.equal(typeof makeLibSignalRepository, 'function');
});

test('importing the library does not load the engine at all', () => {
    assert.deepEqual(engineLoadsAtImport, [],
        'oktz-signal must not be loaded while the module graph is built');
    // curve-native.js is entitled to its own failure-tolerant probe (that is what
    // its try/catch is for). No other module in the graph may reach for the
    // binding at import: the one that matters is the engine, the rest would be a
    // second route to the same crash.
    assert.deepEqual(
        bindingLoadsAtImport.filter((parent) => !String(parent).includes('/Modded/curve-native.js')),
        [],
        'only lib/Modded/curve-native.js may probe the native binding at import'
    );
});

test('the first E2EE use in the process is what loads the engine, exactly once', () => {
    assert.equal(engineLoadsAfterFirstUse - engineLoadsAtImport.length, 1,
        'the first E2EE operation must be the one and only reach for the engine');
    assert.ok(firstUse.error, 'the first E2EE operation in the process must have failed loudly');
    assert.equal(firstUse.error.code, ENGINE_UNAVAILABLE);
    assertEngineUnavailable(firstUse.error);
});

test('non-E2EE surface still works with no native signal prebuild', async () => {
    const { jidDecode, jidEncode, encodeBinaryNode, decodeBinaryNode, proto } = loaded.namespace;
    assert.equal(jidDecode(JID).user, '15551');
    const { user, server } = jidDecode(JID);
    assert.equal(jidEncode(user, server), JID);
    assert.equal(proto.Message.decode(proto.Message.encode(proto.Message.create({ conversation: JID })).finish()).conversation,
        JID, 'protobuf encode/decode must round-trip');
    const node = { tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'get', id: 'A1' }, content: [{ tag: 'query', attrs: { xmlns: 'w' } }] };
    const roundtripped = await decodeBinaryNode(encodeBinaryNode(node));
    assert.equal(roundtripped.tag, node.tag);
    assert.deepEqual(roundtripped.attrs, node.attrs);
    assert.equal(roundtripped.content[0].tag, 'query');
    assert.deepEqual(roundtripped.content[0].attrs, { xmlns: 'w' });
});

test('the default repository factory and the synchronous address helper are unchanged', async () => {
    const { DEFAULT_CONNECTION_CONFIG } = loaded.namespace;
    assert.equal(DEFAULT_CONNECTION_CONFIG.makeSignalRepository, makeLibSignalRepository,
        'the lazily-loaded engine must not change which factory the default config holds');
    // jidToSignalProtocolAddress is synchronous in the public repository shape,
    // so ProtocolAddress must stay reachable without the engine.
    assert.equal((await makeRepo()).jidToSignalProtocolAddress(JID), '15551.0');
});

test('the address helper uses the engine\'s own ProtocolAddress, not a local copy', async () => {
    // ProtocolAddress is the one engine symbol imported statically, so that
    // jidToSignalProtocolAddress can stay synchronous. That is only parity-safe
    // while the subpath resolves to the very module the engine entry re-exports
    // from -- a local reimplementation, or a package that stops shipping the
    // subpath, would silently change the address type the engine stores.
    const entry = await readFile(
        createRequire(import.meta.url).resolve('oktz-signal'), 'utf8'
    );
    assert.match(entry, /src\/protocol-address\.js/,
        'oktz-signal must still re-export ProtocolAddress from src/protocol-address.js');
    const { ProtocolAddress } = await import('oktz-signal/src/protocol-address.js');
    const repo = await makeRepo();
    assert.equal(repo.jidToSignalProtocolAddress(JID), new ProtocolAddress('15551', 0).toString());
});

test('pair-wise E2EE operations fail with the typed, platform-naming error', async () => {
    const repo = await makeRepo();
    const operations = {
        encryptMessage: () => repo.encryptMessage({ jid: JID, data: Buffer.from('hi') }),
        decryptMessage: () => repo.decryptMessage({ jid: JID, type: 'pkmsg', ciphertext: Buffer.alloc(2) }),
        injectE2ESession: () => repo.injectE2ESession({ jid: JID, session: {} }),
        getSessionInfo: () => repo.getSessionInfo(JID),
        validateSession: () => repo.validateSession(JID)
    };
    for (const [name, run] of Object.entries(operations)) {
        await assert.rejects(run, (error) => {
            assert.equal(error?.code, ENGINE_UNAVAILABLE, `${name} must report the missing engine`);
            return assertEngineUnavailable(error);
        }, `${name} must reject, not resolve`);
    }
});

test('a bulk PN→LID migration with work to do fails with the same error', async () => {
    // migrateSession is the one pair-wise path with early returns, so it is the
    // one place a missing engine could pass for a completed migration.
    const repo = await makeRepo({
        'device-list': { 15551: ['0', '1'] },
        session: { '15551.0': '{"_sessions":{}}', '15551.1': '{"_sessions":{}}' }
    });
    await assert.rejects(() => repo.migrateSession(JID, '12345@lid'), assertEngineUnavailable);
});

test('a migration with nothing to do still answers with its counts', async () => {
    // The engine is resolved past the PN→LID guards on purpose: a call that was
    // never going to move a session must keep returning its no-op counts rather
    // than start failing on a platform that has no engine.
    const empty = await makeRepo();
    assert.deepEqual(await empty.migrateSession(JID, '12345@lid'), { migrated: 0, skipped: 0, total: 0 });
    assert.deepEqual(await empty.migrateSession(JID, JID), { migrated: 0, skipped: 0, total: 0 });
    assert.deepEqual(await empty.migrateSession('12345@lid', '99999@lid'), { migrated: 0, skipped: 0, total: 1 });
    assert.deepEqual(await empty.migrateSession(undefined, '12345@lid'), { migrated: 0, skipped: 0, total: 0 });
});

test('a missing engine is never reported as missing session or identity state', async () => {
    const repo = await makeRepo();
    // Both of these swallow every error they see. A missing engine that reached
    // them as a catch would read as "no session" and quietly disable E2EE
    // instead of telling the user their platform has no engine.
    assert.rejects(() => repo.getSessionInfo(JID), assertEngineUnavailable);
    assert.rejects(() => repo.validateSession(JID), assertEngineUnavailable);
});

test('decryption never reports a missing identity key when the engine is absent', async () => {
    // extractIdentityFromPkmsg is wrapped in a catch that returns undefined, and
    // an undecoded pkmsg is exactly that. It must not be reachable without an
    // engine, or a re-key check would silently never fire.
    const repo = await makeRepo();
    const versioned = Buffer.concat([Buffer.from([0x33]), Buffer.alloc(80)]);
    await assert.rejects(
        () => repo.decryptMessage({ jid: JID, type: 'pkmsg', ciphertext: versioned }),
        assertEngineUnavailable
    );
});

test('group E2EE is not gated behind the lazy engine', async () => {
    // The Group path needs only oktz-signal/src/crypto.js (node:crypto) and
    // curve-native (which has its own fallbacks). It must not be made
    // unavailable by this change -- whatever it does, it must not fail with the
    // engine error.
    const repo = await makeRepo();
    for (const [name, run] of Object.entries({
        encryptGroupMessage: () => repo.encryptGroupMessage({ group: 'g@g.us', meId: JID, data: Buffer.from('hi') }),
        getSenderKeyDistributionMessage: () => repo.getSenderKeyDistributionMessage({ group: 'g@g.us', meId: JID })
    })) {
        const error = await run().then(() => null, (e) => e);
        assert.notEqual(error?.code, ENGINE_UNAVAILABLE, `${name} must not require the lazy engine`);
    }
});

test('a failed load is cached, not retried per message', async () => {
    const repo = await makeRepo();
    const before = allBindingLoads();
    await assert.rejects(() => repo.encryptMessage({ jid: JID, data: Buffer.from('one') }));
    await assert.rejects(() => repo.encryptMessage({ jid: JID, data: Buffer.from('two') }));
    await assert.rejects(() => repo.decryptMessage({ jid: JID, type: 'msg', ciphertext: Buffer.alloc(4) }));
    assert.equal(allBindingLoads(), before,
        'a missing engine must not re-enter the loader on every message');
});