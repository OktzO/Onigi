import test from 'node:test';
import assert from 'node:assert/strict';
import { extractGroupMetadata } from '../lib/Socket/groups.js';

/*
 * The participant rows the runtime produces carry a raw `admin` string and
 * nothing else. `isAdmin` / `isSuperAdmin` are declared in
 * lib/Types/GroupMetadata.d.ts:4-5 and were simply never populated, so the
 * only way to ask "is this member an admin" was to string-compare the raw
 * attribute, and a consumer reading the declared boolean got undefined — which
 * reads as "definitely not an admin" and silently skipped the admin path.
 *
 * The same test covers the jidNormalizedUser change at the group call site: a
 * bare-number `creator` used to normalise to '', which is falsy at every
 * `? :` downstream and was copied into msg.key.participant by
 * messages-recv.js:607 for a group-create stub.
 */

const groupNode = (attrs, content = []) => ({
    tag: 'group',
    attrs: { id: '120363000000000000@g.us', subject: 'the group', s_t: '1700000000', size: '1', creation: '1600000000', ...attrs },
    content
});

const metadataOf = (group) => extractGroupMetadata({ tag: 'iq', attrs: { type: 'result' }, content: [group] });

const participant = attrs => ({ tag: 'participant', attrs: { jid: '62812345678@s.whatsapp.net', ...attrs } });

test('a superadmin is an admin and a superadmin', () => {
    const meta = metadataOf(groupNode({}, [participant({ jid: '1111111111@lid', type: 'superadmin' })]));
    assert.equal(meta.participants[0].isAdmin, true);
    assert.equal(meta.participants[0].isSuperAdmin, true);
    assert.equal(meta.participants[0].admin, 'superadmin');
});

test('a plain admin is an admin but not a superadmin', () => {
    const meta = metadataOf(groupNode({}, [participant({ type: 'admin' })]));
    assert.equal(meta.participants[0].isAdmin, true);
    assert.equal(meta.participants[0].isSuperAdmin, false);
    assert.equal(meta.participants[0].admin, 'admin');
});

test('an ordinary member is neither, and says so with false', () => {
    const meta = metadataOf(groupNode({}, [participant({})]));
    assert.equal(meta.participants[0].isAdmin, false);
    assert.equal(meta.participants[0].isSuperAdmin, false);
    assert.equal(meta.participants[0].admin, null);
});

test('a superadmin on a LID-addressed group is still recognised', () => {
    const meta = metadataOf(groupNode({ addressing_mode: 'lid' }, [
        { tag: 'participant', attrs: { jid: '1111111111@lid', type: 'superadmin', phone_number: '62812345678@s.whatsapp.net' } }
    ]));
    assert.equal(meta.addressingMode, 'lid');
    assert.equal(meta.participants[0].isSuperAdmin, true);
    assert.equal(meta.participants[0].id, '1111111111@lid');
    assert.equal(meta.participants[0].phoneNumber, '62812345678@s.whatsapp.net');
});

test('a bare-number creator attr leaves the owner absent, not empty', () => {
    const meta = metadataOf(groupNode({ creator: '62812345678', creator_pn: '62812345678@s.whatsapp.net' }));
    assert.equal(meta.owner, undefined);
    assert.equal(meta.ownerPn, '62812345678@s.whatsapp.net');
});

test('a real creator attr is still normalised', () => {
    const meta = metadataOf(groupNode({ creator: '62812345678@s.whatsapp.net', creator_pn: '62812345678@s.whatsapp.net' }));
    assert.equal(meta.owner, '62812345678@s.whatsapp.net');
    assert.equal(meta.ownerPn, '62812345678@s.whatsapp.net');
});

test('a bare-number description participant leaves the owner absent', () => {
    const meta = metadataOf(groupNode({}, [
        { tag: 'description', attrs: { participant: '62812345678', id: '1', t: '1700000000' }, content: [{ tag: 'body', content: 'hi' }] }
    ]));
    assert.equal(meta.descOwner, undefined);
    assert.equal(meta.descOwnerPn, undefined);
    assert.equal(meta.desc, 'hi');
});
