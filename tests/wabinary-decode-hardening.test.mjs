import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBinaryNode, decodeDecompressedBinaryNode, decompressingIfRequired } from '../lib/WABinary/decode.js';
import { TAGS } from '../lib/WABinary/constants.js';
import { getBinaryNodeChildUInt } from '../lib/WABinary/generic-utils.js';
import { encodeBinaryNode } from '../lib/WABinary/encode.js';
import { encodeBinaryNodeRust } from '../lib/WABinary/rust-adapter.js';
import * as constants from '../lib/WABinary/constants.js';

// <x/>            listSize 1, odd, so no content
const LEAF = Buffer.from([TAGS.LIST_8, 0x01, TAGS.BINARY_8, 0x01, 0x78]);
// <w>[ one child ] listSize 2, even, content is a LIST_8 holding the child
const WRAP = Buffer.from([TAGS.LIST_8, 0x02, TAGS.BINARY_8, 0x01, 0x77, TAGS.LIST_8, 0x01]);
const nested = (depth) => Buffer.concat([Buffer.from([0x00]), ...Array.from({ length: depth }, () => WRAP), LEAF]);

const MAX_DEPTH = 128;

// --- (a) recursion depth ---

test('a deeply nested frame is rejected cleanly instead of overflowing the stack', async () => {
    // 2000-deep overflowed the stack on a 14 KB frame here, and the audit measured
    // it at ~1500 on 7.5 KB. Both surfaces came back as a RangeError that
    // noise-handler.js:130 does not catch, so it reached socket.js:702 and tore
    // down the connection. A remote frame must not be able to do that.
    for (const depth of [2000, 5000, 100000, 1000000]) {
        const err = await decodeBinaryNode(nested(depth)).then(() => null, e => e);
        assert.ok(err, `depth ${depth} must be rejected`);
        assert.ok(!(err instanceof RangeError), `depth ${depth} must not surface a RangeError, got ${err}`);
        assert.equal(err.constructor, Error);
        assert.match(err.message, /too deep/);
    }
});

test('the depth cap rejects only past the cap, and real nesting still decodes', async () => {
    for (const depth of [1, 2, 10, 64, 100, MAX_DEPTH]) {
        const node = await decodeBinaryNode(nested(depth));
        assert.equal(node.tag, 'w', `depth ${depth} must decode`);
    }
    const err = await decodeBinaryNode(nested(MAX_DEPTH + 1)).then(() => null, e => e);
    assert.ok(err, 'one past the cap must be rejected');
    assert.match(err.message, /too deep/);
});

test('the deepest frame the library itself builds still decodes', async () => {
    // the fixtures in tests/rust-wabinary.test.mjs nest 4 levels; the deepest
    // structure any real stanza uses is far below the cap
    let node = { tag: 'leaf', attrs: { k: 'v' } };
    for (let i = 0; i < 12; i++) node = { tag: 'n', attrs: {}, content: [node] };
    const decoded = await decodeBinaryNode(encodeBinaryNode(node));
    let depth = 0;
    for (let n = decoded; Array.isArray(n.content); n = n.content[0]) depth++;
    assert.equal(depth, 12);
});

// --- (b) zero-length frame ---

test('a zero-length frame is an end-of-stream error, not a RangeError', async () => {
    // buffer.readUInt8() on a 0-byte buffer was the only RangeError class in the
    // whole truncation corpus: 258 of 4000 truncated frames hit it, all at cut 0
    for (const frame of [Buffer.alloc(0)]) {
        const err = await decodeBinaryNode(frame).then(() => null, e => e);
        assert.ok(err, 'an empty frame must be rejected');
        assert.ok(!(err instanceof RangeError), `must not be a RangeError, got ${err}`);
        assert.equal(err.message, 'end of stream');
    }
    const err = await decompressingIfRequired(Buffer.alloc(0)).then(() => null, e => e);
    assert.ok(!(err instanceof RangeError), `decompressingIfRequired must not throw a RangeError, got ${err}`);
    assert.equal(err.message, 'end of stream');
});

test('a compression prefix with no payload is still an end-of-stream error', async () => {
    const err = await decodeBinaryNode(Buffer.from([0x00])).then(() => null, e => e);
    assert.equal(err.message, 'end of stream');
});

// --- (c) bufferToUInt bounds ---

test('a short buffer is rejected rather than read as NaN', () => {
    // `a = 256*a + e[i]` with e[i] undefined returns NaN, and signal.js:109
    // (extractKey) has no Number.isInteger guard, so a remote short <id> node
    // injected keyId: NaN into the E2E session store. signal.js:77,82 and
    // messages-recv.js:1098 guard it; this makes the guard unnecessary.
    const node = (bytes) => ({ content: [{ tag: 'id', content: Buffer.from(bytes) }] });
    assert.equal(getBinaryNodeChildUInt(node([0, 0, 1]), 'id', 3), 1);
    assert.equal(getBinaryNodeChildUInt({ content: [] }, 'id', 3), undefined, 'no child means undefined, not a throw');
    assert.throws(() => getBinaryNodeChildUInt(node([1]), 'id', 3), /cannot hold 3/);
    assert.throws(() => getBinaryNodeChildUInt(node([1, 2]), 'id', 3), /cannot hold 3/);
    assert.throws(() => getBinaryNodeChildUInt(node([]), 'id', 3), /cannot hold 3/);
});

test('every length a caller asks for is either an integer or a throw, never NaN', () => {
    for (const len of [1, 2, 3, 4, 8]) {
        for (const size of [0, 1, 2, 3, 4, 8]) {
            const node = { content: [{ tag: 'v', content: Buffer.alloc(size, 0x01) }] };
            let got;
            try { got = getBinaryNodeChildUInt(node, 'v', len); } catch { got = 'threw'; }
            assert.ok(got === 'threw' || Number.isInteger(got), `len=${len} size=${size} produced ${got}`);
        }
    }
});

// --- (d) __proto__ as a remote attribute key ---

const frameWithKey = (key) => Buffer.concat([
    Buffer.from([0x00, TAGS.LIST_8, 0x03, TAGS.BINARY_8, 0x01, 0x78]),
    Buffer.from([TAGS.BINARY_8, key.length]), Buffer.from(key, 'ascii'),
    Buffer.from([TAGS.BINARY_8, 0x05]), Buffer.from('value', 'ascii')
]);

test('a remote __proto__ attribute key is kept, not silently dropped', async () => {
    // `attrs[key] = value` hit the __proto__ setter, which ignores a string, so
    // the attribute vanished. No pollution was possible (({}).x stayed undefined)
    // — this was a silent-drop bug, not a pollution bug.
    const decoded = await decodeBinaryNode(frameWithKey('__proto__'));
    assert.deepEqual(Object.getOwnPropertyNames(decoded.attrs), ['__proto__']);
    assert.equal(Object.getOwnPropertyDescriptor(decoded.attrs, '__proto__').value, 'value');
    assert.equal({}.x, undefined, 'no prototype pollution');
    assert.equal(Object.getPrototypeOf({}), Object.prototype, 'Object.prototype is intact');
});

test('other Object.prototype member names stay ordinary attributes', async () => {
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
        const decoded = await decodeBinaryNode(frameWithKey(key));
        assert.equal(decoded.attrs[key], 'value', `${key} must decode to its value`);
    }
});

test('the attribute object keeps a normal prototype for consumers', () => {
    const node = decodeDecompressedBinaryNode(
        Buffer.from([TAGS.LIST_8, 0x03, TAGS.BINARY_8, 0x01, 0x78, TAGS.BINARY_8, 0x02, 0x69, 0x64, TAGS.BINARY_8, 0x01, 0x78]),
        constants
    );
    assert.equal(Object.getPrototypeOf(node.attrs), Object.prototype);
    assert.deepEqual(node.attrs, { id: 'x' });
});

// --- (e) non-finite numbers must not be stringified onto the wire ---

test('Infinity and NaN never reach the wire as "inf" and "NaN"', () => {
    // the native encoder stringified them while the JS path corrupted the frame
    for (const value of [Infinity, -Infinity, NaN]) {
        assert.throws(() => encodeBinaryNodeRust({ tag: 'x', attrs: { a: value } }), /invalid attribute "a"/,
            `${value} must be rejected, not encoded`);
    }
    assert.throws(() => encodeBinaryNode({ tag: 'x', attrs: { a: Infinity } }), /invalid attribute "a"/);
});
