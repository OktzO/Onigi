import test from 'node:test';
import assert from 'node:assert/strict';
import { jidNormalizedUser } from '../lib/WABinary/index.js';

/*
 * jidNormalizedUser returned '' for anything it could not parse, and happily
 * re-encoded a jid that has no user at all:
 *
 *   jidNormalizedUser('62812345678')  === ''      (no '@' at all)
 *   jidNormalizedUser('@c.us')        === '@s.whatsapp.net'
 *
 * Both are indistinguishable from a real answer at a call site that only checks
 * truthiness, so groups.js turned a bare-number `creator` attr into
 * `owner: ''` — a group that reads as having no owner — and messages-recv.js:607
 * wrote that '' straight into msg.key.participant.
 *
 * The contract is now: undefined means "this is not a jid with a user in it".
 */

test('a jid with no user normalises to undefined, not an empty jid', () => {
    assert.equal(jidNormalizedUser('@c.us'), undefined);
    assert.equal(jidNormalizedUser('@s.whatsapp.net'), undefined);
    assert.equal(jidNormalizedUser('@lid'), undefined);
    assert.equal(jidNormalizedUser('@g.us'), undefined);
});

test('a string with no server at all normalises to undefined', () => {
    assert.equal(jidNormalizedUser('62812345678'), undefined);
    assert.equal(jidNormalizedUser('not-a-jid'), undefined);
    assert.equal(jidNormalizedUser(''), undefined);
    assert.equal(jidNormalizedUser(undefined), undefined);
    assert.equal(jidNormalizedUser(null), undefined);
});

test('a real jid still normalises, dropping the device', () => {
    assert.equal(jidNormalizedUser('62812345678@s.whatsapp.net'), '62812345678@s.whatsapp.net');
    assert.equal(jidNormalizedUser('62812345678:3@s.whatsapp.net'), '62812345678@s.whatsapp.net');
    assert.equal(jidNormalizedUser('111222333444@lid'), '111222333444@lid');
    assert.equal(jidNormalizedUser('111222333444:2@lid'), '111222333444@lid');
    assert.equal(jidNormalizedUser('120363000000000000@g.us'), '120363000000000000@g.us');
});

test('the legacy c.us server still folds to s.whatsapp.net', () => {
    assert.equal(jidNormalizedUser('62812345678@c.us'), '62812345678@s.whatsapp.net');
    assert.equal(jidNormalizedUser('62812345678:1@c.us'), '62812345678@s.whatsapp.net');
});

test('a hosted jid keeps its hosted server', () => {
    assert.equal(jidNormalizedUser('62812345678@hosted'), '62812345678@hosted');
    assert.equal(jidNormalizedUser('111222333444@hosted.lid'), '111222333444@hosted.lid');
});
