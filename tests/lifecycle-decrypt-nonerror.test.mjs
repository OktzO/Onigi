import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptMessageNode } from '../lib/Utils/decode-wa-message.js';
import { proto } from '../WAProto/index.js';

/*
 * The decrypt catch did:
 *
 *     catch (err) {
 *         logger.error(errorContext, 'failed to decrypt message');
 *         fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT;
 *         fullMessage.messageStubParameters = [err.message.toString()];
 *     }
 *
 * Every other statement in the catch is a statement about the message; that one
 * assumes the thrown value is an Error. It is not a safe assumption: the throw
 * sites reachable here are a repository's decryptMessage/decryptGroupMessage,
 * proto decode, and the `Unknown e2e type` throw, and a repository is a user
 * supplied object. A thrown string, a thrown number, a thrown null and a thrown
 * plain object all have either no `message` or a non-string one.
 *
 * When it throws, the throw escapes decrypt() -- so it is not a degraded
 * message, it is a rejected decrypt() that aborts the whole loop, and every
 * remaining <enc> child of the same stanza is silently never looked at. One bad
 * child costs the caller every good one.
 *
 * The contract: whatever was thrown becomes the stub parameter as text, and the
 * remaining children are still processed.
 */
const FROM = '99999:1@s.whatsapp.net';
const ME = '11111:1@s.whatsapp.net';

const stanza = (children) => ({
	tag: 'message',
	attrs: { id: 'MSG1', from: FROM, t: '1700000000' },
	content: children
});

const enc = (type, content) => ({ tag: 'enc', attrs: { type, v: '2' }, content });

// a non-plaintext <enc> is unpadded before decode: unpadRandomMax16 reads the pad
// count off the last byte, so the fixture has to carry one
const GOOD = Buffer.concat([
	proto.Message.encode(proto.Message.fromObject({ conversation: 'hello' })).finish(),
	Buffer.alloc(16, 16)
]);

const logger = () => ({ info: () => { }, debug: () => { }, warn: () => { }, error: () => { } });

const repository = (decryptMessage) => ({
	lidMapping: {
		getLIDForPN: async () => null,
		storeLIDPNMappings: async () => { }
	},
	migrateSession: async () => { },
	decryptMessage
});

test('a thrown string does not abort the rest of the stanza', async () => {
	const seen = [];
	const { fullMessage, decrypt } = decryptMessageNode(
		stanza([enc('msg', Buffer.from('first')), enc('msg', Buffer.from('second'))]),
		ME, '', repository(async ({ ciphertext }) => {
			seen.push(ciphertext.toString());
			if (ciphertext.toString() === 'first') {
				throw 'a bare string';
			}
			return GOOD;
		}), logger()
	);
	await decrypt();
	assert.deepEqual(seen, ['first', 'second'], 'the second <enc> was never looked at');
	assert.equal(fullMessage.message?.conversation, 'hello');
});

test('the stub parameter is the text of whatever was thrown', async () => {
	const cases = [
		['a bare string', () => { throw 'a bare string'; }],
		['a number', () => { throw 42; }],
		['null', () => { throw null; }],
		['undefined', () => { throw undefined; }],
		['a plain object', () => { throw { code: 'X' }; }],
		['an object with a numeric message', () => { throw { message: 123 }; }],
		['an array', () => { throw []; }]
	];
	for (const [label, thrower] of cases) {
		const { fullMessage, decrypt } = decryptMessageNode(
			stanza([enc('msg', Buffer.from('only'))]),
			ME, '', repository(async () => { thrower(); }), logger()
		);
		await decrypt();
		assert.equal(fullMessage.messageStubType, proto.WebMessageInfo.StubType.CIPHERTEXT, label);
		assert.equal(fullMessage.messageStubParameters.length, 1, label);
		assert.equal(typeof fullMessage.messageStubParameters[0], 'string', label);
	}
});

test('a real Error still produces its message', async () => {
	const { fullMessage, decrypt } = decryptMessageNode(
		stanza([enc('msg', Buffer.from('only'))]),
		ME, '', repository(async () => { throw new Error('No session record'); }), logger()
	);
	await decrypt();
	assert.deepEqual(fullMessage.messageStubParameters, ['No session record']);
});

test('a stanza whose only child fails is still stubbed, not thrown', async () => {
	const { fullMessage, decrypt } = decryptMessageNode(
		stanza([enc('msg', Buffer.from('only'))]),
		ME, '', repository(async () => { throw 'nope'; }), logger()
	);
	await decrypt();
	assert.equal(fullMessage.messageStubType, proto.WebMessageInfo.StubType.CIPHERTEXT);
	assert.deepEqual(fullMessage.messageStubParameters, ['nope']);
});
