import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as libsignal from 'oktz-signal';
import { SenderKeyName } from '../lib/Signal/Group/sender-key-name.js';
import { jidDecode } from '../lib/WABinary/index.js';
import { WAJIDDomains } from '../lib/WABinary/index.js';

// SenderKeyName.serialize() read `this.sender.id`, but the engine this tree runs
// on (oktz-signal) names that field `name`. Every sender address therefore
// serialized as "...::undefined::<device>", collapsing every member of a group
// onto one sender-key store slot.

const jidToSignalProtocolAddress = (jid) => {
    const decoded = jidDecode(jid);
    const { user, device, server, domainType } = decoded;
    const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user;
    return new libsignal.ProtocolAddress(signalUser, device || 0);
};

test('SenderKeyName serializes the sender name, not undefined', () => {
    const name = new SenderKeyName('120363@g.us', jidToSignalProtocolAddress('1111111111@s.whatsapp.net'));
    assert.equal(name.serialize(), '120363@g.us::1111111111::0');
});

test('SenderKeyName does not leak an undefined sender field', () => {
    const name = new SenderKeyName('120363@g.us', jidToSignalProtocolAddress('1111111111@s.whatsapp.net'));
    assert.ok(!name.serialize().includes('undefined'), name.serialize());
});

test('two members of the same group do not share a sender key slot', () => {
    const group = '120363@g.us';
    const a = new SenderKeyName(group, jidToSignalProtocolAddress('1111111111@s.whatsapp.net'));
    const b = new SenderKeyName(group, jidToSignalProtocolAddress('2222222222@s.whatsapp.net'));
    assert.notEqual(a.serialize(), b.serialize());
});

test('the same member on two devices does not share a sender key slot', () => {
    const group = '120363@g.us';
    const phone = new SenderKeyName(group, jidToSignalProtocolAddress('1111111111@s.whatsapp.net'));
    const web = new SenderKeyName(group, jidToSignalProtocolAddress('1111111111:2@s.whatsapp.net'));
    assert.notEqual(phone.serialize(), web.serialize());
});

test('the same sender on a different group does not share a sender key slot', () => {
    const user = '1111111111@s.whatsapp.net';
    const a = new SenderKeyName('120363@g.us', jidToSignalProtocolAddress(user));
    const b = new SenderKeyName('120364@g.us', jidToSignalProtocolAddress(user));
    assert.notEqual(a.serialize(), b.serialize());
});

test('SenderKeyName agrees with the ProtocolAddress toString it wraps', () => {
    const address = jidToSignalProtocolAddress('1111111111@s.whatsapp.net');
    const name = new SenderKeyName('120363@g.us', address);
    assert.equal(name.serialize(), `120363@g.us::${address.name}::${address.deviceId}`);
});
