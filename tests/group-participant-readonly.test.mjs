import test from 'node:test';
import assert from 'node:assert/strict';
import processMessage from '../lib/Utils/process-message.js';
import { WAMessageStubType } from '../lib/Types/index.js';

/*
 * participantsIncludesMe read `jid.phoneNumber`, but the participant rows built
 * in messages-recv.js:649 only carry `phoneNumber` when the row's own jid is a
 * LID *and* the server also sent phone_number. `id` — always present — was
 * ignored, so the predicate was permanently false in every PN-addressed group
 * (and in LID groups where the server omits phone_number).
 *
 * Consequence: chat.readOnly was never set to true on your own removal/leave,
 * and never cleared when you were added back, so a bot kept writing to a group
 * it had been removed from and refused to write after being re-invited.
 */

const ME_PN = '62812345678:1@s.whatsapp.net';
const ME_LID = '111222333444:1@lid';
const GROUP = '120363000000000000@g.us';

const run = async (stubType, participants) => {
    const emitted = [];
    const ev = {
        on: () => { },
        off: () => { },
        emit: (event, data) => { emitted.push({ event, data }); }
    };
    await processMessage({
        key: { remoteJid: GROUP, id: 'STUB1', fromMe: false, participant: '62899999999:1@s.whatsapp.net' },
        message: { protocolMessage: undefined },
        messageStubType: stubType,
        messageStubParameters: participants.map(p => JSON.stringify(p))
    }, {
        shouldProcessHistoryMsg: false,
        placeholderResendCache: { generatePlaceholderResendMessage: () => undefined, matchesPlaceholderResend: () => false },
        ev,
        creds: { me: { id: ME_PN, lid: ME_LID }, accountSettings: {} },
        signalRepository: { lidMapping: { getPNForLID: async () => null, getLIDsForPNs: async () => null } },
        keyStore: { get: async () => ({}), set: async () => { }, bind: fn => fn({ get: async () => ({}), set: async () => { }, del: async () => { } }) },
        logger: { level: 'silent', trace() { }, debug() { }, info() { }, warn() { }, error() { } },
        options: {},
        getMessage: async () => undefined
    });
    const update = emitted.filter(e => e.event === 'chats.update').flatMap(e => e.data);
    return update.find(c => c.id.includes(GROUP));
};

test('being removed in a PN group marks the chat read only', async () => {
    const chat = await run(WAMessageStubType.GROUP_PARTICIPANT_REMOVE, [
        { id: ME_PN.split(':')[0] + '@s.whatsapp.net', admin: null }
    ]);
    assert.equal(chat?.readOnly, true);
});

test('leaving on my own marks the chat read only', async () => {
    const chat = await run(WAMessageStubType.GROUP_PARTICIPANT_LEAVE, [
        { id: '62812345678@s.whatsapp.net', admin: null }
    ]);
    assert.equal(chat?.readOnly, true);
});

test('being added to a PN group clears read only', async () => {
    const chat = await run(WAMessageStubType.GROUP_PARTICIPANT_ADD, [
        { id: '62812345678@s.whatsapp.net', admin: null }
    ]);
    assert.equal(chat?.readOnly, false);
});

test('being invited to a PN group clears read only', async () => {
    const chat = await run(WAMessageStubType.GROUP_PARTICIPANT_INVITE, [
        { id: '62812345678@s.whatsapp.net', admin: null }
    ]);
    assert.equal(chat?.readOnly, false);
});

test('a LID row for me matches even when the server sent no phone_number', async () => {
    const chat = await run(WAMessageStubType.GROUP_PARTICIPANT_REMOVE, [
        { id: '111222333444@lid', admin: null }
    ]);
    assert.equal(chat?.readOnly, true);
});

test('a LID row for me still matches on the phone_number the server did send', async () => {
    const chat = await run(WAMessageStubType.GROUP_PARTICIPANT_REMOVE, [
        { id: '111222333444@lid', phoneNumber: '62812345678@s.whatsapp.net', admin: null }
    ]);
    assert.equal(chat?.readOnly, true);
});

test('another member being removed does not mark the chat read only', async () => {
    const chat = await run(WAMessageStubType.GROUP_PARTICIPANT_REMOVE, [
        { id: '62899999999@s.whatsapp.net', admin: null }
    ]);
    assert.equal(chat?.readOnly, undefined);
});

test('another member being added does not clear read only', async () => {
    const chat = await run(WAMessageStubType.GROUP_PARTICIPANT_ADD, [
        { id: '555666777888@lid', phoneNumber: '62899999999@s.whatsapp.net', admin: null }
    ]);
    assert.equal(chat?.readOnly, undefined);
});

test('being re-added after a leave clears read only again', async () => {
    const chat = await run(WAMessageStubType.GROUP_PARTICIPANT_ADD, [
        { id: '111222333444@lid', admin: null }
    ]);
    assert.equal(chat?.readOnly, false);
});
