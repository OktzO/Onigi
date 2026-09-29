import assert from 'node:assert/strict';
import { test } from 'node:test';
import { native } from 'oktz-signal';
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js';
import { jidDecode, WAJIDDomains } from '../lib/WABinary/index.js';

// SenderKeyName.serialize() read `this.sender.id`. oktz-signal's ProtocolAddress
// has no such field, so every sender serialized as `<group>::undefined::<device>`
// and every member of a group collapsed onto a single store slot. The name is
// correct now, which is the point: the store is keyed per sender.
//
// That strands state written by the previous release. loadSenderKey answers a
// miss with a fresh EMPTY SenderKeyRecord rather than null, so group_cipher's
// `if (!record)` guard can never fire, and the failure surfaces one line later
// as "No session found to decrypt message" — naming sessions when the sender
// key is what is missing, and pointing an operator at nothing they can act on.
//
// The tests below model the real exchange: a sender repository encrypts, and a
// separate recipient repository holds the sender key it learned from the
// distribution message. The recipient's copy is then moved to the name the
// previous release would have written, and decryption is attempted. Before the
// fallback that throws the production error.

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
            chains.set(key, next.then(() => { }, () => { }));
            return next;
        },
        bucket: (type) => data.get(type) || new Map()
    };
}

const silentLogger = { trace() { }, debug() { }, info() { }, warn() { }, error() { } };

const GROUP = '120363@g.us';
const SENDER = '1111111111@s.whatsapp.net';
const OTHER = '2222222222@s.whatsapp.net';
const LEGACY = `${GROUP}::undefined::0`;
const PLAINTEXT = 'halo dari grup';
// oktz-signal's encrypt() runs every argument through asBuffer(), which rejects
// a string. The real caller passes encodeWAMessage() output, a Buffer; text here
// would fail for a reason unrelated to what is under test.
const PLAINTEXT_BYTES = Buffer.from(PLAINTEXT, 'utf8');

function makeRepo() {
    const keys = makeKeyStore();
    // Real keypairs: the distribution message is signed with the identity key,
    // so a fabricated prekey fails verification before the behaviour under test
    // is ever reached.
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
    return { keys, repo: makeLibSignalRepository({ creds, keys }, silentLogger, async () => null) };
}

const currentKeyFor = (sender) => {
    const { user, device, domainType } = jidDecode(sender);
    const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user;
    return `${GROUP}::${signalUser}::${device || 0}`;
};

/**
 * Encrypt as SENDER, and hand back the sender key exactly as a recipient would
 * hold it: taken before the encrypt, because encrypting advances the chain and
 * the recipient's copy is the pre-message state.
 */
async function encryptedFromSender() {
    const sender = makeRepo();
    // Creates and persists the sender key at chain iteration 0.
    await sender.repo.getSenderKeyDistributionMessage({ group: GROUP, meId: SENDER });
    const shared = sender.keys.bucket('sender-key').get(currentKeyFor(SENDER));
    assert.ok(shared, 'test setup: the sender key must exist');
    const { ciphertext } = await sender.repo.encryptGroupMessage({ group: GROUP, meId: SENDER, data: PLAINTEXT_BYTES });
    return { ciphertext, senderKeyRecord: shared };
}

/**
 * A recipient holding `senderKeyRecord` under `name`.
 *
 * Written through set(), not bucket().set(): bucket() answers a missing bucket
 * with a fresh Map that it does NOT store, so a direct .set() on a fresh
 * recipient's bucket would land in a throwaway and the test would pass or fail
 * for a reason that has nothing to do with the fallback.
 */
function recipientWith(senderKeyRecord, name) {
    const recipient = makeRepo();
    recipient.keys.set({ 'sender-key': { [name]: senderKeyRecord } });
    return recipient;
}

test('a group message decrypts when the sender key is only under the legacy name', async () => {
    const { ciphertext, senderKeyRecord } = await encryptedFromSender();
    const recipient = recipientWith(senderKeyRecord, LEGACY);

    const out = await recipient.repo.decryptGroupMessage({ group: GROUP, authorJid: SENDER, msg: ciphertext });

    assert.equal(
        Buffer.from(out).toString('utf8'), PLAINTEXT,
        'a sender key written by the previous release must still decrypt, not fail as ' +
        '"No session found to decrypt message"'
    );
});

test('the legacy slot is matched per device, the way the old name encoded it', async () => {
    const { ciphertext, senderKeyRecord } = await encryptedFromSender();
    // device 2: the old name carried the device, so a device 2 key lived under
    // "::undefined::2" and must not be looked for in the device 0 slot.
    const recipient = recipientWith(senderKeyRecord, `${GROUP}::undefined::2`);

    const out = await recipient.repo.decryptGroupMessage({ group: GROUP, authorJid: '1111111111:2@s.whatsapp.net', msg: ciphertext });

    assert.equal(Buffer.from(out).toString('utf8'), PLAINTEXT);
});

test('a sender with no key at all still reports the missing sender key', async () => {
    const { ciphertext } = await encryptedFromSender();
    const recipient = recipientWith(Buffer.from(JSON.stringify([]), 'utf8'), LEGACY);

    await assert.rejects(
        recipient.repo.decryptGroupMessage({ group: GROUP, authorJid: OTHER, msg: ciphertext }),
        /No session found to decrypt message/,
        'the fallback must not fabricate a usable key for a sender that never sent one'
    );
});

test('the current name is preferred over the legacy slot', async () => {
    const { ciphertext, senderKeyRecord } = await encryptedFromSender();
    // Both names present, as happens partway through the transition. Reading the
    // legacy slot first would hand back a stale key; the current one must win.
    const recipient = recipientWith(senderKeyRecord, LEGACY);
    recipient.keys.bucket('sender-key').set(currentKeyFor(SENDER), senderKeyRecord);

    const out = await recipient.repo.decryptGroupMessage({ group: GROUP, authorJid: SENDER, msg: ciphertext });

    assert.equal(Buffer.from(out).toString('utf8'), PLAINTEXT);
});

test('an unknown sender rejects with an Error, never a store TypeError', async () => {
    const recipient = makeRepo();

    await assert.rejects(
        recipient.repo.decryptGroupMessage({ group: GROUP, authorJid: OTHER, msg: Buffer.from('not-a-real-message') }),
        (err) => {
            assert.ok(err instanceof Error, 'must reject with an Error');
            return true;
        }
    );
});
