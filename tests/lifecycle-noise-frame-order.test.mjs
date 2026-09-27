import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { deflate } from 'node:zlib';
import { hkdf, aesEncryptGCM, Curve } from '../lib/Utils/crypto.js';
import { makeNoiseHandler } from '../lib/Utils/noise-handler.js';
import { NOISE_MODE, NOISE_WA_HEADER } from '../lib/Defaults/index.js';
import { encodeBinaryNode } from '../lib/WABinary/encode.js';

/*
 * processData() suspends on `await decodeBinaryNode(...)` while `inBytes` stays
 * a shared binding:
 *
 *     const processData = async (onFrame) => {
 *         ...
 *         while (true) {
 *             ...
 *             let frame = inBytes.subarray(3, size + 3);
 *             inBytes = inBytes.subarray(size + 3);
 *             if (transport) {
 *                 const result = transport.decrypt(frame);
 *                 frame = await decodeBinaryNode(result);
 *             }
 *             onFrame(frame);
 *         }
 *     };
 *
 * Two ws messages in the same tick mean two processData invocations, and the
 * second one finds inBytes drained by the first. It installs its own bytes and
 * enters its own loop. When the first loop resumes it reads the *second*
 * message's remaining bytes out of the shared inBytes, so the two loops are now
 * each holding a frame from the other's message and whichever decode finishes
 * first emits first. Frames come out in whatever order the decodes completed.
 *
 * Honest scope of the claim: the audit could not reproduce this end to end (the
 * transport keys need a live handshake) and rated the impact as ordering only.
 * What is reproduced here is the mechanism -- two concurrent loops over one
 * shared buffer -- driven through the real makeNoiseHandler with a real
 * TransportState installed by finishInit(), and the real decoder, so the only
 * thing standing in for a live handshake is that the keys are ours.
 *
 * The observable is the order frames reach the consumer, which is what
 * messages.upsert vs chats.upsert ordering inside one batch rides on.
 */
const deflateAsync = promisify(deflate);

const noopLogger = () => {
	const rec = level => () => { };
	return {
		level: 'silent',
		trace: rec('trace'),
		debug: rec('debug'),
		info: rec('info'),
		warn: rec('warn'),
		error: rec('error'),
		child() { return this; }
	};
};

const node = id => ({ tag: 'message', attrs: { id, from: '99999:1@s.whatsapp.net', t: '1700000000' } });

/** a big, highly compressible stanza: its decode goes through zlib's threadpool */
const bigNode = id => {
	const filler = 'x'.repeat(200_000);
	return {
		tag: 'message',
		attrs: { id, from: '99999:1@s.whatsapp.net', t: '1700000000' },
		content: [{ tag: 'body', attrs: {}, content: Buffer.from(filler, 'utf-8') }]
	};
};

const uncompressedPayload = id => encodeBinaryNode(node(id));
const compressedPayload = async id => {
	const encoded = encodeBinaryNode(bigNode(id));
	// the decoder reads a leading byte: 0x00 uncompressed, 0x02 deflated
	return Buffer.concat([Buffer.of(0x02), await deflateAsync(encoded.subarray(1))]);
};

/**
 * The transport's decrypt key, derived the way finishInit() derives it: salt is
 * NOISE_MODE and never moves (only mixIntoKey moves it, and this handler has not
 * called it), and the read half is what TransportState was constructed with as
 * decKey. Reproduced here because a handler cannot open what it encrypted --
 * the client writes with one half and reads with the other -- so the frames have
 * to be sealed with the read half for the real decrypt path to accept them.
 */
const transportReadKey = () => Buffer.from(
	hkdf(Buffer.alloc(0), 64, { salt: Buffer.from(NOISE_MODE), info: '' }).subarray(32)
);

/** the transport IV: 12 bytes, read counter big-endian in the last four */
const ivFor = (counter) => { const iv = Buffer.alloc(12); iv.writeUInt32BE(counter, 8); return iv; };

/** what the wire carries: a 24-bit length followed by the transport ciphertext */
const wireFrame = (readKey, payload, counter) => {
	const sealed = aesEncryptGCM(payload, readKey, ivFor(counter), Buffer.alloc(0));
	const header = Buffer.allocUnsafe(3);
	header[0] = (sealed.length >>> 16) & 0xff;
	header[1] = (sealed.length >>> 8) & 0xff;
	header[2] = sealed.length & 0xff;
	return Buffer.concat([header, sealed]);
};

const handler = async () => {
	const noise = makeNoiseHandler({
		keyPair: Curve.generateKeyPair(),
		NOISE_HEADER: NOISE_WA_HEADER,
		logger: noopLogger()
	});
	await noise.finishInit();
	return { noise, readKey: transportReadKey() };
};

test('two ws messages in one tick emit their frames in wire order', async () => {
	const { noise, readKey } = await handler();
	const seen = [];
	const onFrame = frame => { seen.push(frame?.attrs?.id); };

	// message 1: compressed, so its decode genuinely suspends on the threadpool.
	// message 2: uncompressed, so its decode resolves within a couple of
	// microtasks -- i.e. before message 1's decode comes back
	const first = wireFrame(readKey, await compressedPayload('A'), 0);
	const second = wireFrame(readKey, uncompressedPayload('B'), 1);

	// the ws emits both messages from one read: the second decodeFrame runs
	// before the first has finished, exactly as socket.js's handler does
	const one = noise.decodeFrame(first, onFrame);
	const two = noise.decodeFrame(second, onFrame);
	await Promise.all([one, two]);

	assert.deepEqual(seen, ['A', 'B'],
		'frames were emitted out of wire order: the two processData loops interleaved over one inBytes');
});

test('three frames split across two ws messages keep their order', async () => {
	const { noise, readKey } = await handler();
	const seen = [];
	const onFrame = frame => { seen.push(frame?.attrs?.id); };

	const msg1 = Buffer.concat([
		wireFrame(readKey, uncompressedPayload('A'), 0),
		wireFrame(readKey, uncompressedPayload('B'), 1)
	]);
	const msg2 = wireFrame(readKey, await compressedPayload('C'), 2);

	const one = noise.decodeFrame(msg1, onFrame);
	const two = noise.decodeFrame(msg2, onFrame);
	await Promise.all([one, two]);

	assert.deepEqual(seen, ['A', 'B', 'C']);
});

test('a burst delivered as separate messages keeps its order', async () => {
	const { noise, readKey } = await handler();
	const seen = [];
	const onFrame = frame => { seen.push(frame?.attrs?.id); };

	const frames = ['A', 'B', 'C', 'D'].map((id, i) => wireFrame(readKey, uncompressedPayload(id), i));
	// no awaits between them: the whole burst lands in one tick
	await Promise.all(frames.map(f => noise.decodeFrame(f, onFrame)));

	assert.deepEqual(seen, ['A', 'B', 'C', 'D']);
});

/*
 * Not a RED: green in both runs, and load-bearing for the fix. The serialisation
 * puts every frame through a chain, so a chain that propagated a rejection would
 * wedge the handler -- no frame after a bad one would ever be looked at again.
 */
test('a frame that fails to decode does not wedge the ones behind it', async () => {
	const { noise, readKey } = await handler();
	const seen = [];
	const onFrame = frame => { seen.push(frame?.attrs?.id); };

	// 0x00 prefix then garbage: the decoder throws on it
	const bad = wireFrame(readKey, Buffer.concat([Buffer.of(0x00), Buffer.from('not a node')]), 1);
	const outcomes = [];
	// one message at a time: this is about the chain surviving, not about two
	// loops sharing a buffer
	outcomes.push(await noise.decodeFrame(wireFrame(readKey, uncompressedPayload('A'), 0), onFrame)
		.then(() => 'ok', () => 'err'));
	outcomes.push(await noise.decodeFrame(bad, onFrame).then(() => 'ok', () => 'err'));
	outcomes.push(await noise.decodeFrame(wireFrame(readKey, uncompressedPayload('B'), 2), onFrame)
		.then(() => 'ok', () => 'err'));

	assert.deepEqual(outcomes, ['ok', 'err', 'ok']);
	assert.deepEqual(seen, ['A', 'B']);
});
