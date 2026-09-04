import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    jidDecode,
    jidEncode,
    isLidUser,
    isPnUser,
    isHostedPnUser,
    isHostedLidUser,
    transferDevice,
    WAJIDDomains
} from '../lib/WABinary/jid-utils.js';

test('jidDecode: PN user biasa', () => {
    const d = jidDecode('6281234567890@s.whatsapp.net');
    assert.equal(d.user, '6281234567890');
    assert.equal(d.server, 's.whatsapp.net');
    assert.equal(d.domainType, WAJIDDomains.WHATSAPP);
    assert.equal(d.device, undefined);
});

test('jidDecode: PN dengan device', () => {
    const d = jidDecode('6281234567890:3@s.whatsapp.net');
    assert.equal(d.user, '6281234567890');
    assert.equal(d.device, 3);
});

test('jidDecode: LID user', () => {
    const d = jidDecode('123456789012345@lid');
    assert.equal(d.domainType, WAJIDDomains.LID);
    assert.equal(isLidUser('123456789012345@lid'), true);
    assert.equal(isPnUser('123456789012345@lid'), false);
});

test('jidDecode: hosted variants', () => {
    const pn = jidDecode('6281234567890:99@hosted');
    assert.equal(pn.domainType, WAJIDDomains.HOSTED);
    assert.equal(isHostedPnUser('6281234567890:99@hosted'), true);
    const lid = jidDecode('123456789012345:99@hosted.lid');
    assert.equal(lid.domainType, WAJIDDomains.HOSTED_LID);
    assert.equal(isHostedLidUser('123456789012345:99@hosted.lid'), true);
});

test('jidEncode roundtrip', () => {
    assert.equal(jidEncode('6281234567890', 's.whatsapp.net'), '6281234567890@s.whatsapp.net');
    assert.equal(jidEncode('6281234567890', 's.whatsapp.net', 3), '6281234567890:3@s.whatsapp.net');
});

test('transferDevice: PN -> LID mempertahankan device', () => {
    const lid = transferDevice('6281234567890:7@s.whatsapp.net', '123456789012345@lid');
    assert.equal(lid, '123456789012345:7@lid');
    const lid0 = transferDevice('6281234567890@s.whatsapp.net', '123456789012345@lid');
    assert.equal(lid0, '123456789012345@lid');
});
