import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDeviceJids } from '../lib/Utils/signal.js';
import { jidEncode, WAJIDDomains } from '../lib/WABinary/index.js';

/*
 * extractDeviceJids hoisted `domainType` out of the per-device loop and let
 * `isHosted` overwrite it without ever restoring it, so the first hosted device
 * of a user relabelled every later device of the same user as HOSTED. The
 * caller (messages-send getUSyncDevices) builds the wire JID from the
 * `server` this function returns, so devices 1 and 2 came out as
 * `628123456789:1@hosted`, fail to encrypt, and are dropped at
 * messages-send.js:442 - silently never receiving the message.
 */

const ME = '11111111111:1@s.whatsapp.net';
const ME_LID = '99999999999:1@lid';

const devicesFor = (id, deviceList) => [{ id, devices: { deviceList } }];

const jidsOf = extracted => extracted.map(d => jidEncode(d.user, d.server, d.device));

test('one hosted device does not relabel the later devices of the same PN user', () => {
    const extracted = extractDeviceJids(devicesFor('628123456789@s.whatsapp.net', [
        { id: 0, keyIndex: '1', isHosted: true },
        { id: 1, keyIndex: '1' },
        { id: 2, keyIndex: '1' }
    ]), ME, ME_LID, false);

    // jidEncode drops a zero device suffix, so device 0 encodes as a bare jid
    assert.deepEqual(jidsOf(extracted), [
        '628123456789@hosted',
        '628123456789:1@s.whatsapp.net',
        '628123456789:2@s.whatsapp.net'
    ]);
});

test('one hosted device does not relabel the later devices of the same LID user', () => {
    const extracted = extractDeviceJids(devicesFor('628123456789@lid', [
        { id: 0, keyIndex: '1', isHosted: true },
        { id: 1, keyIndex: '1' },
        { id: 2, keyIndex: '1' }
    ]), ME, ME_LID, false);

    assert.deepEqual(jidsOf(extracted), [
        '628123456789@hosted.lid',
        '628123456789:1@lid',
        '628123456789:2@lid'
    ]);
});

test('the hosted device is still reported as hosted', () => {
    const extracted = extractDeviceJids(devicesFor('628123456789@s.whatsapp.net', [
        { id: 0, keyIndex: '1', isHosted: true }
    ]), ME, ME_LID, false);

    assert.equal(extracted[0].domainType, WAJIDDomains.HOSTED);
    assert.equal(extracted[0].server, 'hosted');
});

test('hosted state does not leak across users in one usync result', () => {
    const extracted = extractDeviceJids([
        ...devicesFor('628123456789@s.whatsapp.net', [{ id: 0, keyIndex: '1', isHosted: true }]),
        ...devicesFor('111222333444@s.whatsapp.net', [{ id: 0, keyIndex: '1' }])
    ], ME, ME_LID, false);

    assert.deepEqual(jidsOf(extracted), [
        '628123456789@hosted',
        '111222333444@s.whatsapp.net'
    ]);
});
