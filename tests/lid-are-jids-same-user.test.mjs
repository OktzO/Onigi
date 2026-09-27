import test from 'node:test';
import assert from 'node:assert/strict';
import { areJidsSameUser } from '../lib/WABinary/index.js';

/*
 * areJidsSameUser compared only the user part, and compared it with `===` on
 * possibly-undefined operands, so two missing jids compared equal:
 *
 *   areJidsSameUser(undefined, undefined) === true
 *
 * Every current call site either short-circuits on a defined jid or only uses
 * the result for a non-mutating branch, so the defect is latent rather than
 * exploitable today — but messages-recv.js:1172/1611 and relayMessage:697 pass
 * `creds.me?.lid` straight in and get a meaningful-looking `true` out of two
 * undefineds when me.lid has not been paired yet.
 *
 * The comparison stays deliberately domain-agnostic: "same user" means the
 * same user whichever namespace they are addressed in, which is what
 * messages-recv.js:658 (`id` vs actingParticipantLid || actingParticipantPn)
 * and decode-wa-message.js:116-117 (`jid` vs meId || meLid) depend on.
 */

test('two missing jids are not the same user', () => {
    assert.equal(areJidsSameUser(undefined, undefined), false);
    assert.equal(areJidsSameUser(undefined, null), false);
});

test('a missing jid never matches a present one', () => {
    assert.equal(areJidsSameUser(undefined, '1111111111@s.whatsapp.net'), false);
    assert.equal(areJidsSameUser('1111111111@s.whatsapp.net', undefined), false);
});

test('a jid that names no user never matches', () => {
    assert.equal(areJidsSameUser('@s.whatsapp.net', '@s.whatsapp.net'), false);
    assert.equal(areJidsSameUser('@s.whatsapp.net', '1111111111@s.whatsapp.net'), false);
    assert.equal(areJidsSameUser('not-a-jid', 'not-a-jid'), false);
});

test('the same user in the same domain matches, device suffix aside', () => {
    assert.equal(areJidsSameUser('1111111111@s.whatsapp.net', '1111111111@s.whatsapp.net'), true);
    assert.equal(areJidsSameUser('1111111111:2@s.whatsapp.net', '1111111111:0@s.whatsapp.net'), true);
    assert.equal(areJidsSameUser('1111111111:3@lid', '1111111111@lid'), true);
    assert.equal(areJidsSameUser('1111111111@hosted', '1111111111:2@hosted'), true);
});

test('the same user across addressing domains still matches, by design', () => {
    assert.equal(areJidsSameUser('1111111111@lid', '1111111111@s.whatsapp.net'), true);
    assert.equal(areJidsSameUser('1111111111@s.whatsapp.net', '1111111111@lid'), true);
    assert.equal(areJidsSameUser('1111111111@c.us', '1111111111@s.whatsapp.net'), true);
});

test('a group or broadcast jid is never a user, whatever its user part reads', () => {
    assert.equal(areJidsSameUser('1111111111@lid', '1111111111@g.us'), false);
    assert.equal(areJidsSameUser('1111111111@s.whatsapp.net', '1111111111@g.us'), false);
    assert.equal(areJidsSameUser('1111111111@g.us', '1111111111@g.us'), false);
    assert.equal(areJidsSameUser('1111111111@s.whatsapp.net', '1111111111@broadcast'), false);
    assert.equal(areJidsSameUser('1111111111@s.whatsapp.net', '1111111111@newsletter'), false);
});

test('different users never match', () => {
    assert.equal(areJidsSameUser('1111111111@lid', '2222222222@lid'), false);
    assert.equal(areJidsSameUser('1111111111@lid', '11111111111@lid'), false);
    assert.equal(areJidsSameUser('1111111111@s.whatsapp.net', '2222222222@lid'), false);
});
