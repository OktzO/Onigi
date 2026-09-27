import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBinaryNode } from '../lib/WABinary/encode.js';
import { decodeBinaryNode } from '../lib/WABinary/decode.js';

const NON_STRING_ATTRS = [
    ['number', 1700000000],
    ['negative number', -1],
    ['float', 1.5],
    ['boolean true', true],
    ['boolean false', false],
    ['Buffer', Buffer.from('z')],
    ['Uint8Array', new Uint8Array([1, 2])],
    ['object', { a: 1 }],
    ['array', ['z']],
    ['bigint', 1n],
    ['String object', new String('z')],
    ['function', () => 'z']
];

test('a non-string attribute value is rejected, not silently dropped', () => {
    for (const [label, value] of NON_STRING_ATTRS) {
        assert.throws(
            () => encodeBinaryNode({ tag: 'x', attrs: { a: value }, content: undefined }),
            /invalid attribute "a"/,
            `${label} attribute value must be rejected`
        );
    }
});

test('a non-string attribute alongside a valid one is rejected', () => {
    assert.throws(
        () => encodeBinaryNode({ tag: 'message', attrs: { t: 1700000000, id: 'ABC' }, content: [{ tag: 'x', attrs: {} }] }),
        /invalid attribute "t"/
    );
});

test('the encoded token count matches the tokens actually written', async () => {
    // The prefix at :190 counts every non-null attribute while the body loop
    // only wrote strings, so a numeric attribute declared tokens it never
    // emitted and the library's own decoder desynced on the frame.
    const node = { tag: 'message', attrs: { to: '1@s.whatsapp.net', id: 'ABC', t: '1700000000' }, content: [{ tag: 'x', attrs: {} }] };
    const frame = encodeBinaryNode(node);
    const decoded = await decodeBinaryNode(frame);
    assert.deepEqual(decoded.attrs, node.attrs);
    assert.deepEqual([...frame], [
        0x00, 0xf8, 0x08, // compression prefix, LIST_8, 8 tokens = 2*3 attrs + tag + content
        0x13, // 'message'
        0x11, 0xfa, 0x55, 0x03, // 'to' (token 17), JID_PAIR, '1' (token 85), 's.whatsapp.net' (token 3)
        0x08, 0xfb, 0x82, 0xab, 0xcf, // 'id' (token 8), HEX_8 'ABC'
        0x1a, 0xff, 0x05, 0x17, 0x00, 0x00, 0x00, 0x00, // 't' (token 26), NIBBLE_8 '1700000000'
        0xf8, 0x01, 0xf8, 0x01, 0xfc, 0x01, 0x78 // content list of 1, child <x> with no attrs
    ]);
});

test('undefined and null attribute values are still skipped, not rejected', async () => {
    const node = { tag: 'x', attrs: { a: 'kept', b: undefined, c: null }, content: undefined };
    const frame = encodeBinaryNode(node);
    assert.deepEqual([...frame], [0x00, 0xf8, 0x03, 0xfc, 0x01, 0x78, 0xfc, 0x01, 0x61, 0xfc, 0x04, 0x6b, 0x65, 0x70, 0x74]);
    assert.deepEqual((await decodeBinaryNode(frame)).attrs, { a: 'kept' });
});
