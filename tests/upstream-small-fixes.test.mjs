import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptMessageNode } from '../lib/Utils/decode-wa-message.js';
import { normalizeMessageContent } from '../lib/Utils/messages.js';
import { generateLoginNode } from '../lib/Utils/validate-connection.js';
import { proto } from '../WAProto/index.js';

/*
 * Three small upstream drifts, each one silent:
 *
 * 1. PLATFORM_MAP advertised WebSubPlatform.WIN32 for a Windows Desktop full
 *    history sync. WIN32 is retired; the live value is WIN_HYBRID. This only
 *    reads when config.syncFullHistory is true, which defaults to false, so it
 *    is correctness rather than an observed behaviour change -- but a caller
 *    that opts into full history sync gets a sub-platform the server no longer
 *    recognises.
 *
 * 2. normalizeMessageContent unwraps a message through getFutureProofMessage,
 *    whose `||` chain did not list lottieStickerMessage. A lottie sticker has
 *    the same FutureProofMessage shape as every other entry (a nested `message`),
 *    so it stayed wrapped and the loop fell through with the sticker still
 *    inside the outer envelope.
 *
 * 3. The deviceSentMessage unwrap replaced `msg` with the inner message
 *    wholesale. The outer messageContextInfo -- which is where the sender puts
 *    messageSecret (see messages-send.js) -- went with the wrapper, so a linked
 *    device's own edit or event lost the secret that process-message.js needs to
 *    decrypt the event/poll response it carries.
 */

const FROM = '99999:1@s.whatsapp.net';
const ME = '11111:1@s.whatsapp.net';

const silent = () => ({ info: () => { }, debug: () => { }, warn: () => { }, error: () => { } });

const stanza = (content) => ({
	tag: 'message',
	attrs: { id: 'MSG1', from: FROM, t: '1700000000' },
	content
});

// a non-plaintext <enc> is unpadded before decode: unpadRandomMax16 reads the pad
// count off the last byte, so the fixture has to carry one
const enc = (message) => Buffer.concat([
	proto.Message.encode(proto.Message.fromObject(message)).finish(),
	Buffer.alloc(16, 16)
]);

const repository = (plaintext) => ({
	lidMapping: {
		getLIDForPN: async () => null,
		storeLIDPNMappings: async () => { }
	},
	migrateSession: async () => { },
	decryptMessage: async () => plaintext,
	processSenderKeyDistributionMessage: async () => { }
});

const decode = async (message) => {
	const { fullMessage, decrypt } = decryptMessageNode(
		stanza([{ tag: 'enc', attrs: { type: 'msg', v: '2' }, content: enc(message) }]),
		ME, '', repository(enc(message)), silent()
	);
	await decrypt();
	return fullMessage.message;
};

test('PLATFORM_MAP advertises WIN_HYBRID for Windows Desktop', () => {
	const { WIN32, WIN_HYBRID } = proto.ClientPayload.WebInfo.WebSubPlatform;
	const payload = generateLoginNode(ME, {
		version: [2, 3000, 1043857760],
		browser: ['Windows', 'Desktop'],
		syncFullHistory: true,
		countryCode: 'US'
	});
	assert.equal(payload.webInfo.webSubPlatform, WIN_HYBRID);
	assert.notEqual(payload.webInfo.webSubPlatform, WIN32, 'WIN32 is retired');
});

test('normalizeMessageContent keeps a lottieStickerMessage', () => {
	const sticker = { lottieStickerMessage: { message: { conversation: 'a lottie' } } };
	const normalized = normalizeMessageContent(sticker);
	assert.notEqual(normalized, undefined, 'the sticker fell through the chain');
	assert.deepEqual(normalized, { conversation: 'a lottie' });
});

test('a linked-device edit keeps the outer messageContextInfo', async () => {
	const secret = Buffer.alloc(32, 9);
	const linked = await decode({
		deviceSentMessage: { destinationJid: FROM, message: { conversation: 'edited' } },
		messageContextInfo: { messageSecret: secret }
	});
	assert.equal(linked.conversation, 'edited');
	assert.ok(linked.messageContextInfo?.messageSecret, 'the outer messageSecret was dropped');
	assert.ok(Buffer.from(linked.messageContextInfo.messageSecret).equals(secret));

	// an inner secret is authoritative: the outer one must not overwrite it
	const own = Buffer.alloc(32, 4);
	const both = await decode({
		deviceSentMessage: {
			destinationJid: FROM,
			message: { conversation: 'edited', messageContextInfo: { messageSecret: own } }
		},
		messageContextInfo: { messageSecret: secret }
	});
	assert.ok(Buffer.from(both.messageContextInfo.messageSecret).equals(own));
});