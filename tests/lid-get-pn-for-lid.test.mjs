import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIDMappingStore } from '../lib/Signal/lid-mapping.js';

/*
 * The two directions of the store disagreed about device 0.
 *
 *   getLIDsForPNs  (lid-mapping.js:118)  `${lidUser}${!!pnDevice ? `:${pnDevice}` : ``}@...`
 *   getPNsForLIDs  (lid-mapping.js:230)  `${pnUser}:${lidDevice}@...`      <- always
 *
 * So a device-0 LID came back as a device-0 PN, with an explicit `:0` that
 * jidEncode never produces and that no jid the store was asked about carried.
 * Every in-tree caller normalises before use, which is why it went unnoticed,
 * but getPNForLID/getPNsForLIDs are public: the value they hand back is what
 * a consumer puts in a jid, and `x:0@s.whatsapp.net` is a different string
 * from `x@s.whatsapp.net` for every `===`, Map key and cache lookup on it.
 */

const PN_USER = '1111111111';
const LID_USER = '22222222222';

const makeLogger = () => ({
    warn: () => { }, trace: () => { }, debug: () => { }, info: () => { }, error: () => { }
});

const makeKeys = () => {
    const data = {};
    return {
        data,
        get: async (id, keys) => {
            const out = {};
            for (const k of keys) {
                if (data[k] !== undefined) {
                    out[k] = data[k];
                }
            }
            return out;
        },
        set: async obj => { Object.assign(data, obj['lid-mapping']); },
        transaction: async fn => fn()
    };
};

const makeStore = async () => {
    const keys = makeKeys();
    const store = new LIDMappingStore(keys, makeLogger(), async () => null);
    await store.storeLIDPNMappings([{ lid: `${LID_USER}@lid`, pn: `${PN_USER}@s.whatsapp.net` }]);
    return { keys, store };
};

test('a device 0 LID resolves to a PN with no device suffix', async () => {
    const { store } = await makeStore();
    assert.equal(await store.getPNForLID(`${LID_USER}@lid`), `${PN_USER}@s.whatsapp.net`);
});

test('a non-zero device LID keeps its device suffix', async () => {
    const { store } = await makeStore();
    assert.equal(await store.getPNForLID(`${LID_USER}:2@lid`), `${PN_USER}:2@s.whatsapp.net`);
});

test('an explicit :0 on the way in does not force a :0 on the way out', async () => {
    const { store } = await makeStore();
    assert.equal(await store.getPNForLID(`${LID_USER}:0@lid`), `${PN_USER}@s.whatsapp.net`);
});

test('the PN direction is symmetric with the LID direction', async () => {
    const { store } = await makeStore();
    const forwards = await store.getLIDsForPNs([`${PN_USER}@s.whatsapp.net`]);
    const backwards = await store.getPNsForLIDs([`${LID_USER}@lid`]);
    assert.deepEqual(forwards, [{ lid: `${LID_USER}@lid`, pn: `${PN_USER}@s.whatsapp.net` }]);
    assert.deepEqual(backwards, [{ lid: `${LID_USER}@lid`, pn: `${PN_USER}@s.whatsapp.net` }]);
});

test('a LID with no stored mapping resolves to null, not a fabricated number', async () => {
    const { store } = await makeStore();
    assert.equal(await store.getPNForLID('99999999999@lid'), null);
    assert.equal(await store.getPNForLID('99999999999@hosted.lid'), null);
    assert.equal(await store.getPNForLID('99999999999:2@lid'), null);
});

test('a batch of LIDs comes back with no stray device suffixes', async () => {
    const { store } = await makeStore();
    const pairs = await store.getPNsForLIDs([`${LID_USER}@lid`, `${LID_USER}:2@lid`]);
    assert.deepEqual(pairs, [
        { lid: `${LID_USER}@lid`, pn: `${PN_USER}@s.whatsapp.net` },
        { lid: `${LID_USER}:2@lid`, pn: `${PN_USER}:2@s.whatsapp.net` }
    ]);
});
