import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBinaryNode } from '../lib/WABinary/encode.js';
import { decodeBinaryNode } from '../lib/WABinary/decode.js';
import { TOKEN_MAP } from '../lib/WABinary/constants.js';

const roundTrip = async (node) => decodeBinaryNode(encodeBinaryNode(node));

const PROTO_MEMBERS = ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'];

test('TOKEN_MAP has a null prototype so Object.prototype members are not tokens', () => {
    assert.equal(Object.getPrototypeOf(TOKEN_MAP), null);
    for (const member of PROTO_MEMBERS) {
        assert.equal(TOKEN_MAP[member], undefined, `${member} must not resolve to a token`);
    }
});

test('Object.prototype member names survive an encode/decode round trip', async () => {
    for (const name of PROTO_MEMBERS) {
        const decoded = await roundTrip({ tag: 'x', attrs: { name } });
        assert.equal(decoded.attrs.name, name, `attribute "${name}" was dropped from the wire`);
    }
});

test('single-byte and double-byte tokens still encode in token form', async () => {
    // 'text' is a single-byte token, 'subject' a double-byte one. Both must keep
    // the dictionary form rather than fall through to a raw string.
    const single = encodeBinaryNode({ tag: 'x', attrs: { name: 'text' } });
    assert.deepEqual([...single], [0x00, 0xf8, 0x03, 0xfc, 0x01, 0x78, TOKEN_MAP['name'].index, TOKEN_MAP['text'].index]);

    const dbl = encodeBinaryNode({ tag: 'x', attrs: { subject: 'text' } });
    assert.deepEqual([...dbl], [0x00, 0xf8, 0x03, 0xfc, 0x01, 0x78, 0xec, TOKEN_MAP['subject'].index, TOKEN_MAP['text'].index]);

    assert.equal((await roundTrip({ tag: 'x', attrs: { name: 'text', subject: 'text' } })).attrs.name, 'text');
});
