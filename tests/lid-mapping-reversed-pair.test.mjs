import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIDMappingStore } from '../lib/Signal/lid-mapping.js';

// storeLIDPNMappings accepted a reversed pair (isPnUser(lid) && isLidUser(pn))
// but then read the `lid` field as the LID unconditionally, so a reversed pair
// was persisted inverted — manufacturing exactly the fabricated PN<->LID
// mapping that commit 9173c4e set out to eliminate. The public
// ev.emit('lid-mapping.update', { lid, pn }) path (lib/Socket/chats.js:1132)
// does not enforce the order that all three in-tree callers happen to use.

const PN_USER = '1111111111';
const LID_USER = '22222222222';
const PN_JID = `${PN_USER}@s.whatsapp.net`;
const LID_JID = `${LID_USER}@lid`;

const makeLogger = () => {
    const warnings = [];
    const record = (msg) => (...args) => { warnings.push([msg, ...args].join(' ')); };
    return {
        warnings,
        warn: record('warn'),
        trace: () => {},
        debug: () => {},
        info: () => {},
        error: () => {}
    };
};

const makeKeys = () => {
    const data = {};
    return {
        data,
        get: async (id, keys) => {
            const out = {};
            for (const k of keys) {
                if (data[k] !== undefined)
                    out[k] = data[k];
            }
            return out;
        },
        set: async obj => { Object.assign(data, obj['lid-mapping']); },
        transaction: async fn => fn()
    };
};

const makeStore = () => {
    const keys = makeKeys();
    const logger = makeLogger();
    return { keys, logger, store: new LIDMappingStore(keys, logger, async () => null) };
};

test('a reversed pair is rejected, not persisted inverted', async () => {
    const { keys, store } = makeStore();
    await store.storeLIDPNMappings([{ lid: PN_JID, pn: LID_JID }]);
    assert.deepEqual(keys.data, {});
});

test('a reversed pair does not fabricate a reverse PN for the LID', async () => {
    const { store } = makeStore();
    await store.storeLIDPNMappings([{ lid: PN_JID, pn: LID_JID }]);
    assert.equal(await store.getPNForLID(LID_JID), null);
});

test('a reversed pair does not fabricate a LID for the PN', async () => {
    const { store } = makeStore();
    await store.storeLIDPNMappings([{ lid: PN_JID, pn: LID_JID }]);
    assert.equal(await store.getLIDForPN(PN_JID), null);
});

test('a reversed pair is reported as invalid', async () => {
    const { logger, store } = makeStore();
    await store.storeLIDPNMappings([{ lid: PN_JID, pn: LID_JID }]);
    assert.ok(
        logger.warnings.some(w => w.includes('Invalid LID-PN mapping')),
        logger.warnings.join('\n')
    );
});

test('a correctly ordered pair is still stored and round-trips', async () => {
    const { keys, store } = makeStore();
    await store.storeLIDPNMappings([{ lid: LID_JID, pn: PN_JID }]);
    assert.equal(keys.data[PN_USER], LID_USER);
    assert.equal(keys.data[`${LID_USER}_reverse`], PN_USER);
    assert.equal(await store.getPNForLID(LID_JID), `${PN_USER}:0@s.whatsapp.net`);
    assert.equal(await store.getLIDForPN(PN_JID), `${LID_USER}@lid`);
});

test('a correctly ordered pair survives a store/lookup round trip', async () => {
    const { keys, store } = makeStore();
    await store.storeLIDPNMappings([{ lid: LID_JID, pn: PN_JID }]);
    const reopened = new LIDMappingStore(keys, makeLogger(), async () => null);
    assert.equal(await reopened.getPNForLID(LID_JID), `${PN_USER}:0@s.whatsapp.net`);
});

test('a batch containing one reversed pair persists only the valid pair', async () => {
    const { keys, store } = makeStore();
    await store.storeLIDPNMappings([
        { lid: LID_JID, pn: PN_JID },
        { lid: '3333333333@s.whatsapp.net', pn: '44444444444@lid' }
    ]);
    assert.deepEqual(keys.data, { [PN_USER]: LID_USER, [`${LID_USER}_reverse`]: PN_USER });
});

test('pairs that are neither a PN/LID pair nor reversed are still rejected', async () => {
    const { keys, store } = makeStore();
    await store.storeLIDPNMappings([
        { lid: PN_JID, pn: '5555555555@s.whatsapp.net' },
        { lid: '66666666666@lid', pn: '77777777777@lid' },
        { lid: PN_JID, pn: 'not-a-jid' }
    ]);
    assert.deepEqual(keys.data, {});
});
