/*
 * examples/03-wabinary.mjs — the wire format, and what it refuses to encode.
 *
 * Run: node examples/03-wabinary.mjs
 *
 * WABinary is the tag/attribute/protobuf hybrid WhatsApp Web puts inside a
 * Noise frame. It is the only part of this library you can inspect without a
 * server, so this example is a faithful look at the bytes.
 *
 * Three properties, each one a fix, each asserted here:
 *
 *   1. A non-string attribute value is *rejected*, not silently coerced. The
 *      list-size prefix (lib/WABinary/encode.js:184) counts every attribute, so
 *      an encoder that declared a token and then skipped writing it produced a
 *      frame the library's own decoder could not read.
 *   2. An attribute value that happens to be a name on `Object.prototype` —
 *      `toString`, `constructor`, `__proto__` — survives the round trip. The
 *      token table is null-prototype (lib/WABinary/constants.js:1295); a remote
 *      value of `__proto__` used to vanish.
 *   3. The native encoder (whatsapp-rust-bridge, a WASM module) is
 *      byte-identical to the JS encoder on every shape both accept. The adapter
 *      routes the shapes where they diverge back to the JS encoder, so the two
 *      are never mixed inside one frame.
 */

import assert from 'node:assert/strict';
import { encodeBinaryNode, decodeBinaryNode } from '../lib/WABinary/index.js';
import { encodeBinaryNodeRust } from '../lib/WABinary/rust-adapter.js';
import { encodeNode } from 'whatsapp-rust-bridge';
import { TOKEN_MAP } from '../lib/WABinary/constants.js';
import { proto } from '../WAProto/index.js';

const main = async () => {
	// --- a real stanza, byte for byte ---------------------------------------------

	const stanza = {
		tag: 'message',
		attrs: { to: '15551234567@s.whatsapp.net', id: 'ONIGI0001', t: '1700000000' },
		content: [{
			tag: 'plaintext',
			attrs: {},
			content: proto.Message.encode(
				proto.Message.fromObject({ conversation: 'hello' })
			).finish()
		}]
	};
	const frame = encodeBinaryNode(stanza);
	const back = await decodeBinaryNode(frame);
	assert.equal(back.tag, 'message');
	assert.deepEqual(back.attrs, stanza.attrs);
	assert.equal(proto.Message.decode(back.content[0].content).conversation, 'hello');
	console.log('a <message> stanza encodes to', frame.length, 'bytes and round-trips');
	console.log('  first 12 bytes:', [...frame.subarray(0, 12)].map(b => b.toString(16).padStart(2, '0')).join(' '));
	console.log('  0x00 = uncompressed, 0xf8 = LIST_8 of 8 tokens (tag + 3 attrs x2 + content)');

	// The Rust encoder must produce the identical frame.
	const rustFrame = encodeBinaryNodeRust(structuredClone(stanza));
	assert.equal(Buffer.compare(rustFrame, frame), 0, 'the native encoder must be byte-identical here');
	console.log('  the native (WASM) encoder produced the same bytes');

	// --- 1. non-string attribute values are rejected --------------------------------

	const rejected = [
		['number', 1700000000],
		['boolean', true],
		['object', { a: 1 }],
		['Buffer', Buffer.from('z')],
		['array', ['z']],
		['function', () => 'z']
	];
	for (const [label, value] of rejected) {
		assert.throws(
			() => encodeBinaryNode({ tag: 'x', attrs: { a: value } }),
			/invalid attribute "a"/,
			`a ${label} attribute must be rejected`
		);
		// and the adapter must reject it identically, not route it to WASM
		assert.throws(() => encodeBinaryNodeRust({ tag: 'x', attrs: { a: value } }), /invalid attribute "a"/);
	}
	console.log(`\n${rejected.length} non-string attribute types are rejected by both encoders`);

	// null and undefined are different: they are *absent*, not present-and-wrong.
	const withHoles = await decodeBinaryNode(
		encodeBinaryNode({ tag: 'x', attrs: { a: 'kept', b: undefined, c: null } })
	);
	assert.deepEqual(withHoles.attrs, { a: 'kept' });
	console.log('undefined and null attribute values are dropped as absent, not rejected');

	// --- 2. Object.prototype names survive the wire ---------------------------------

	assert.equal(Object.getPrototypeOf(TOKEN_MAP), null, 'TOKEN_MAP must have a null prototype');
	const protoNames = ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty'];
	for (const name of protoNames) {
		assert.equal(TOKEN_MAP[name], undefined, `${name} must not resolve to a token`);
		const decoded = await decodeBinaryNode(encodeBinaryNode({ tag: 'x', attrs: { name } }));
		assert.equal(decoded.attrs.name, name, `attribute "${name}" was dropped`);
	}
	console.log(`${protoNames.length} Object.prototype names round-trip intact:`, protoNames.join(', '));

	// --- 3. the divergence the adapter exists for -----------------------------------

	// An empty-string attribute: the WASM encoder drops it, the JS encoder keeps
	// it. Both encode without throwing, so the adapter has to decide by shape.
	const emptyAttr = { tag: 'x', attrs: { a: '' } };
	assert.notEqual(
		Buffer.compare(Buffer.from(encodeNode(structuredClone(emptyAttr))), encodeBinaryNode(structuredClone(emptyAttr))),
		0,
		'precondition: the two encoders genuinely disagree on an empty-string attribute'
	);
	const adapted = encodeBinaryNodeRust(structuredClone(emptyAttr));
	assert.equal(Buffer.compare(adapted, encodeBinaryNode(structuredClone(emptyAttr))), 0,
		'the adapter must return the JS encoding, not the diverging native one');
	assert.equal((await decodeBinaryNode(adapted)).attrs.a, '');
	console.log('an empty-string attribute: the encoders diverge, and the adapter picks the JS one');

	// --- 4. the decoder refuses hostile frames --------------------------------------

	// Recursion: a 2000-deep frame used to overflow the stack with a RangeError
	// that the socket layer did not catch, tearing down the connection.
	const wrap = Buffer.from([0xf8, 0x02, 0xfc, 0x01, 0x77, 0xf8, 0x01]);
	const leaf = Buffer.from([0xf8, 0x01, 0xfc, 0x01, 0x78]);
	const nested = depth => Buffer.concat([
		Buffer.from([0x00]),
		...Array.from({ length: depth }, () => wrap),
		leaf
	]);
	for (const depth of [2000, 100000]) {
		const error = await decodeBinaryNode(nested(depth)).then(() => null, e => e);
		assert.ok(error, `depth ${depth} must be rejected`);
		assert.ok(!(error instanceof RangeError), `depth ${depth} must not surface a RangeError`);
		assert.match(error.message, /too deep/);
	}
	// and real nesting still decodes
	for (const depth of [1, 10, 100, 128]) {
		assert.equal((await decodeBinaryNode(nested(depth))).tag, 'w');
	}
	assert.match(
		(await decodeBinaryNode(nested(129)).then(() => null, e => e)).message,
		/too deep/
	);
	console.log('nesting is capped at 128 levels: a hostile frame is refused, a real one is not');

	// An empty frame is refused too, rather than decoding to a phantom node.
	assert.match((await decodeBinaryNode(Buffer.alloc(0)).then(() => null, e => e)).message, /end of stream/);
	console.log('an empty frame is refused with "end of stream"');

	console.log('\nok — the wire format, the rejections, and the encoder parity, all asserted against the bytes.');
};

await main();
