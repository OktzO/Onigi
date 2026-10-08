import assert from 'node:assert/strict';
import { test } from 'node:test';
import { native } from 'oktz-signal';
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js';
import { SenderKeyRecord } from '../lib/Signal/Group/sender-key-record.js';

// Regression test for task 8: processSenderKeyDistributionMessage used to do a
// get('sender-key') + storeSenderKey(new SenderKeyRecord()) pair OUTSIDE the
// transaction, then repeat it in-lock. A concurrent transaction that committed
// a populated record in between was clobbered by that pre-lock empty write.
//
// The test parks the first call at its pre-lock empty-record write, lets a
// second call for the same sender key run to completion (committing a
// populated record), and then releases the parked write — exactly the race
// window. It asserts the concurrently-committed state survives.

const silentLogger = { trace() { }, debug() { }, info() { }, warn() { }, error() { } };
const GROUP = '120363@g.us';
const SENDER = '1111111111@s.whatsapp.net';
const KEY_NAME = `${GROUP}::1111111111::0`;

function makeRawStore(persisted) {
    return {
        get: async (type, ids) => {
            const bucket = persisted.get(type) || new Map();
            const out = {};
            for (const id of ids) if (bucket.has(id)) out[id] = bucket.get(id);
            return out;
        },
        set: async (patch) => {
            for (const [type, entries] of Object.entries(patch)) {
                let bucket = persisted.get(type);
                if (!bucket) persisted.set(type, bucket = new Map());
                for (const [id, value] of Object.entries(entries)) {
                    if (value === null) bucket.delete(id);
                    else bucket.set(id, value);
                }
            }
        }
    };
}

// Minimal keys with the same store-global transaction semantics T7 introduced:
// a single shared mutex chain across every wrapper, so transactions on
// different repository instances still serialize against one store.
// Inside a transaction, get/set hit the raw store directly (as far as this
// test's choreography is concerned every in-lock write is a raw write).
function makeKeys(rawStore, sharedChain, hooks, self) {
    let inTx = false;
    return {
        get: async (type, ids) => {
            hooks?.get?.(type, ids, inTx);
            return rawStore.get(type, ids);
        },
        set: async (data) => {
            if (hooks?.set) await hooks.set(data, inTx);
            return rawStore.set(data);
        },
        isInTransaction: () => inTx,
        transaction: async (fn) => {
            const prev = sharedChain.get('tx') || Promise.resolve();
            const next = prev.then(async () => {
                inTx = true;
                try {
                    return await fn();
                } finally {
                    inTx = false;
                    hooks?.txEnd?.();
                }
            });
            sharedChain.set('tx', next.catch(() => { }));
            return next;
        }
    };
}

function makeCreds() {
    const idPriv = Buffer.alloc(32, 0x11), idPub = native.curveGenerateKeypair(idPriv)[0];
    const spkPriv = Buffer.alloc(32, 0x22), spkPub = native.curveGenerateKeypair(spkPriv)[0];
    const with05 = (b32) => Buffer.concat([Buffer.from([0x05]), b32]);
    return {
        registrationId: 42,
        signedIdentityKey: { private: idPriv, public: with05(idPub) },
        signedPreKey: {
            keyId: 5,
            private: spkPriv,
            public: with05(spkPub),
            signature: native.curveSign(idPriv, with05(spkPub), null)
        },
        advanced: { key: Buffer.alloc(32, 7) }
    };
}

function makeRepo(persisted, sharedChain, hooks) {
    const rawStore = makeRawStore(persisted);
    const keys = makeKeys(rawStore, sharedChain, hooks);
    return makeLibSignalRepository({ creds: makeCreds(), keys }, silentLogger, async () => null);
}

test('a concurrently committed sender-key record is not clobbered by a pre-lock empty write', async () => {
    const persisted = new Map();
    const sharedChain = new Map();

    // Sender-side repo produces the real SKDMs: iteration 0, then iteration 1
    // after encrypting one group message.
    const sender = makeRepo(new Map(), new Map(), null);
    const skdm0 = await sender.getSenderKeyDistributionMessage({ group: GROUP, meId: SENDER });
    await sender.encryptGroupMessage({ group: GROUP, meId: SENDER, data: Buffer.from("x") }); const skdm1 = await sender.getSenderKeyDistributionMessage({ group: GROUP, meId: SENDER });

    const isEmptyRecordPayload = (data) =>
        !!data['sender-key'] && Object.values(data['sender-key']).every((v) => v && Buffer.from(v).equals(Buffer.from('[]')));

    // S2: repository A's first empty-record sender-key write outside its
    // transaction. Pre-fix this is the pre-lock clobber; post-fix it never
    // fires because every sender-key write happens inside the lock.
    let releaseWrite;
    const writeBlocked = new Promise((res) => { releaseWrite = () => res(true); });
    let aPrelockWriteBlocked = null;
    const s2 = new Promise((res) => { aPrelockWriteBlocked = res; });
    // S3: repository A's first transaction completed (releases the tx mutex).
    let aFirstTxDone = null;
    const s3 = new Promise((res) => { aFirstTxDone = res; });
    let s2Fired = false;
    let s3Fired = false;

    const hooksA = {
        set(data, inTx) {
            if (isEmptyRecordPayload(data) && !inTx && !s2Fired) {
                s2Fired = true;
                aPrelockWriteBlocked();
                return writeBlocked;
            }
            return null;
        },
        txEnd() {
            if (!s3Fired) {
                s3Fired = true;
                aFirstTxDone();
            }
        }
    };

    const repoA = makeRepo(persisted, sharedChain, hooksA);
    const repoB = makeRepo(persisted, sharedChain, null);

    const processA = () => repoA.processSenderKeyDistributionMessage({ item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: skdm0 }, authorJid: SENDER });
    const processB = () => repoB.processSenderKeyDistributionMessage({ item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: skdm1 }, authorJid: SENDER });

    const pA = processA();
    if (s2Fired) {
        // pre-fix path: A's pre-lock empty write is parked; B commits first, then we release
        const pB = processB();
        await pB;
        releaseWrite();
        await pA;
    } else {
        // post-fix path: A's transaction completed without any pre-lock write
        const pB = processB();
        await pB;
        await pA;
    }

    const buf = persisted.get('sender-key')?.get(KEY_NAME);
    assert.ok(buf, 'a sender key record must survive');
    const rec = SenderKeyRecord.deserialize(buf);
    assert.ok(rec.senderKeyStates.length > 0, 'the surviving record must not be empty');
    assert.ok(
        rec.senderKeyStates.some((s) => s.getSenderChainKey().getIteration() === 1),
        'the concurrently committed populated record (iteration 1) must survive, not be clobbered by an empty record'
    );
});
