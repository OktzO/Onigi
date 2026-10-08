import assert from 'node:assert/strict';
import { test } from 'node:test';
import { native } from 'oktz-signal';
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js';
import { SenderKeyRecord } from '../lib/Signal/Group/sender-key-record.js';
import { addTransactionCapability } from '../lib/Utils/auth-utils.js';

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

// The clobber lives at the raw store, so the raw store is what is observed.
// `makeCacheableSignalKeyStore`'s NodeCache is deliberately omitted: in-tx
// reads would be served from the transaction's own ctx.cache (and behind that,
// the NodeCache), masking the store value the parked pre-lock write clobbered.
//
// addTransactionCapability is the real transaction wrapper used in production
// (lib/Socket/socket.js). One instance is created PER REPOSITORY over the
// shared raw store, NOT a single shared instance: a shared instance serializes
// out-of-transaction writes per key type through its PQueue, so B's pre-lock
// write would queue behind A's parked one and the choreography could never
// run B to completion — it would deadlock instead of reaching the assertion.
// Two instances give each repo its own queue/mutex while the raw store
// (and its writes) remain shared, which is exactly what the race exercises.
function makeRawState(persisted, parkedFirst) {
    return {
        get: async (type, ids) => {
            const bucket = persisted.get(type) || new Map();
            const out = {};
            for (const id of ids) if (bucket.has(id)) out[id] = bucket.get(id);
            return out;
        },
        set: async (patch) => {
            if (parkedFirst.setCalled !== true && parkedFirst.isEmpty(patch)) {
                parkedFirst.setCalled = true;
                parkedFirst.signal();
                await parkedFirst.blocked;
            }
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

function makeRepo(state) {
    const rawStore = state;
    const keys = addTransactionCapability(rawStore, silentLogger, { maxCommitRetries: 1, delayBetweenTriesMs: 1 });
    const idPriv = Buffer.alloc(32, 0x11), idPub = native.curveGenerateKeypair(idPriv)[0];
    const spkPriv = Buffer.alloc(32, 0x22), spkPub = native.curveGenerateKeypair(spkPriv)[0];
    const with05 = (b32) => Buffer.concat([Buffer.from([0x05]), b32]);
    const creds = {
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
    return makeLibSignalRepository({ creds, keys }, silentLogger, async () => null);
}

test('a concurrently committed sender-key record is not clobbered by a pre-lock empty write', async () => {
    const persisted = new Map();

    // Sender-side repo produces the real SKDMs: iteration 0, then iteration 1
    // after encrypting one group message.
    const senderState = new Map();
    const sender = makeRepo(makeRawState(senderState, { setCalled: false, isEmpty: () => false, signal() { }, blocked: Promise.resolve() }));
    const skdm0 = await sender.getSenderKeyDistributionMessage({ group: GROUP, meId: SENDER });
    await sender.encryptGroupMessage({ group: GROUP, meId: SENDER, data: Buffer.from("x") });
    const skdm1 = await sender.getSenderKeyDistributionMessage({ group: GROUP, meId: SENDER });

    const isEmptyRecordPayload = (data) =>
        !!data['sender-key'] && Object.values(data['sender-key']).every((v) => v && Buffer.from(v).equals(Buffer.from('[]')));

    // Park the FIRST empty-record raw sender-key write: pre-fix that is A's
    // pre-lock write; post-fix no such write ever reaches the raw store (the
    // in-tx '[]' is overwritten by the populated record before commit).
    let parkedSignal, releaseWrite;
    const s2 = new Promise((res) => { parkedSignal = res; });
    const blocked = new Promise((res) => { releaseWrite = res; });
    let s2Fired = false;
    const parkedFirst = {
        setCalled: false,
        isEmpty: isEmptyRecordPayload,
        signal: () => { s2Fired = true; parkedSignal(); },
        blocked,
    };

    const state = makeRawState(persisted, parkedFirst);
    const repoA = makeRepo(state);
    const repoB = makeRepo(state);

    const processA = () => repoA.processSenderKeyDistributionMessage({ item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: skdm0 }, authorJid: SENDER });
    const processB = () => repoB.processSenderKeyDistributionMessage({ item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: skdm1 }, authorJid: SENDER });

    const pA = processA();
    // Give A a chance to reach its pre-lock write (pre-fix) or finish (post-fix).
    await Promise.race([s2, pA]);
    try {
        if (s2Fired) {
            // pre-fix path: A's pre-lock empty write is parked; B commits first,
            // then the parked write is released.
            const pB = processB();
            await pB;
            releaseWrite();
            await pA;
        } else {
            // post-fix path: A's transaction completed without any pre-lock write.
            const pB = processB();
            await pB;
            await pA;
        }
    } finally {
        // Never leave a parked write unreleased — a failing run must reach the
        // assertions, not deadlock the runner.
        releaseWrite();
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
