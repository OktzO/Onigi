import test from 'node:test';
import assert from 'node:assert/strict';
import { USyncQuery, USyncUser } from '../lib/WAUSync/index.js';

/*
 * The protocol parsers signal "this protocol told us nothing" by returning
 * null — but USyncLIDProtocol.parser returns `node.attrs.val`, which is
 * undefined when the server sent a <lid/> with no val. The filter in
 * USyncQuery.js:58 only dropped `null`, so the entry survived with the key
 * present and the value undefined:
 *
 *   'lid' in entry  === true      entry.lid === undefined
 *
 * Every in-tree consumer happens to write `!!a.lid`, so nothing broke — but
 * the public shape of a usync result said "there is a lid here, and it is
 * undefined", and a consumer using `in`, `Object.keys` or a spread of the
 * entry gets a false positive. Absent has to mean absent.
 */

const resultFor = users => ({
    tag: 'iq',
    attrs: { type: 'result' },
    content: [{ tag: 'usync', attrs: {}, content: [{ tag: 'list', attrs: {}, content: users }] }]
});

const user = (jid, content) => ({ tag: 'user', attrs: { jid }, content });

test('a <lid/> with no val is absent, not present-and-undefined', () => {
    const parsed = new USyncQuery()
        .withLIDProtocol()
        .withUser(new USyncUser().withId('62812345678@s.whatsapp.net'))
        .parseUSyncQueryResult(resultFor([user('62812345678@s.whatsapp.net', [{ tag: 'lid', attrs: {} }])]));

    assert.equal(parsed.list.length, 1);
    assert.equal('lid' in parsed.list[0], false);
    assert.deepEqual(Object.keys(parsed.list[0]), ['id']);
});

test('a <lid/> with a val is present and valued', () => {
    const parsed = new USyncQuery()
        .withLIDProtocol()
        .withUser(new USyncUser().withId('62812345678@s.whatsapp.net'))
        .parseUSyncQueryResult(resultFor([
            user('62812345678@s.whatsapp.net', [{ tag: 'lid', attrs: { val: '111222333444@lid' } }])
        ]));

    assert.equal('lid' in parsed.list[0], true);
    assert.equal(parsed.list[0].lid, '111222333444@lid');
});

test('a user with no protocol content at all still appears with just its id', () => {
    const parsed = new USyncQuery()
        .withLIDProtocol()
        .withUser(new USyncUser().withId('62812345678@s.whatsapp.net'))
        .parseUSyncQueryResult(resultFor([user('62812345678@s.whatsapp.net', [])]));

    assert.deepEqual(parsed.list, [{ id: '62812345678@s.whatsapp.net' }]);
});

test('a protocol that answers false is kept — only null/undefined is dropped', () => {
    const parsed = new USyncQuery()
        .withContactProtocol()
        .withUser(new USyncUser().withPhone('+62812345678'))
        .parseUSyncQueryResult(resultFor([user('62812345678@s.whatsapp.net', [{ tag: 'contact', attrs: {} }])]));

    assert.deepEqual(parsed.list, [{ contact: false, id: '62812345678@s.whatsapp.net' }]);
});

test('one empty lid row does not strip the lid from a sibling that has one', () => {
    const parsed = new USyncQuery()
        .withLIDProtocol()
        .withUser(new USyncUser().withId('1@s.whatsapp.net'))
        .withUser(new USyncUser().withId('2@s.whatsapp.net'))
        .parseUSyncQueryResult(resultFor([
            user('1@s.whatsapp.net', [{ tag: 'lid', attrs: {} }]),
            user('2@s.whatsapp.net', [{ tag: 'lid', attrs: { val: '222222222222@lid' } }])
        ]));

    assert.deepEqual(parsed.list, [
        { id: '1@s.whatsapp.net' },
        { lid: '222222222222@lid', id: '2@s.whatsapp.net' }
    ]);
});
