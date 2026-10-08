import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEventBuffer } from '../lib/Utils/event-buffer.js';
import { WAMessageStatus } from '../lib/Types/index.js';

const logger = { debug() {}, trace() {}, warn() {}, error() {} };

const JID = '1@s';
const ID = 'sticky-ts';
const DECODED_TS = 1700000000; // the notify's own decoded messageTimestamp
const RECEIPT_TS = 1600000000; // a receipt's own wall clock, not the message's

// The buffer never clones, so every scenario needs its own objects.
const msgKey = () => ({ remoteJid: JID, id: ID, fromMe: false });

// a notify carrying a real decoded messageTimestamp
const notify = () => ({
	key: msgKey(),
	messageTimestamp: DECODED_TS,
	message: { conversation: 'hi' }
});

// A receipt, as messages-recv.js:1286 emits one: `update` *always* carries a
// messageTimestamp, derived from the receipt's own attrs.t. When the receipt
// carries no usable time that arrives as 0, never as undefined -- so 'absent',
// 'undefined' and 0 all have to leave an already decoded value alone.
const receipt = timestamp => {
	const update = { status: WAMessageStatus.READ };
	if (timestamp !== 'absent') {
		update.messageTimestamp = timestamp;
	}
	return { key: msgKey(), update };
};

// a history-set copy of the same message that never got a timestamp decoded
const historyCopy = () => ({
	key: msgKey(),
	message: { conversation: 'hi' }
});

// notify first -> the receipt meets a buffered message in messages.update
const NOTIFY_FIRST = timestamp => [
	['messages.upsert', { messages: [notify()], type: 'notify' }],
	['messages.update', [receipt(timestamp)]]
];
// receipt first -> there is nothing to merge into, so messages.update parks it
// and messages.upsert later absorbs it. A separate overwrite site.
const RECEIPT_FIRST = timestamp => [
	['messages.update', [receipt(timestamp)]],
	['messages.upsert', { messages: [notify()], type: 'notify' }]
];

// drive one buffer through the given emits and hand back the single message a
// consumer ends up seeing
const consolidated = steps => {
	const eb = makeEventBuffer(logger);
	const seen = [];
	eb.process(map => { for (const ev in map) seen.push([ev, map[ev]]); });
	eb.buffer();
	for (const [event, data] of steps) {
		eb.emit(event, data);
	}
	eb.flush();
	// a message can end up consolidated under either event: a history-set copy
	// that a later upsert absorbed stays in the history set
	const messages = seen
		.filter(([ev]) => ev === 'messages.upsert' || ev === 'messaging-history.set')
		.flatMap(([, v]) => v.messages);
	assert.equal(messages.length, 1, 'exactly one consolidated message');
	return messages[0];
};

test('a receipt cannot overwrite a decoded messageTimestamp', () => {
	// nothing to overwrite -- regression guard on the plain absorb
	assert.equal(consolidated(NOTIFY_FIRST('absent')).messageTimestamp, DECODED_TS);
	// a receipt that decodes to no time at all must not erase the decode
	assert.equal(consolidated(NOTIFY_FIRST(undefined)).messageTimestamp, DECODED_TS);
	// ...and neither must the receipt's own clock, which is what actually
	// happens when the receipt carries no attrs.t (toNumber(0) === 0)
	assert.equal(consolidated(NOTIFY_FIRST(0)).messageTimestamp, DECODED_TS);
	// a receipt carrying a different real timestamp is still not authoritative
	assert.equal(consolidated(NOTIFY_FIRST(RECEIPT_TS)).messageTimestamp, DECODED_TS);
});

test('arrival order does not change the outcome', () => {
	assert.equal(consolidated(RECEIPT_FIRST('absent')).messageTimestamp, DECODED_TS);
	assert.equal(consolidated(RECEIPT_FIRST(undefined)).messageTimestamp, DECODED_TS);
	assert.equal(consolidated(RECEIPT_FIRST(0)).messageTimestamp, DECODED_TS);
	assert.equal(consolidated(RECEIPT_FIRST(RECEIPT_TS)).messageTimestamp, DECODED_TS);

	// Same rule for the third arrival order. A history-set copy that carries no
	// timestamp must not wipe the notify's own decode when the upsert absorbs it.
	assert.equal(consolidated([
		['messaging-history.set', {
			chats: [],
			messages: [historyCopy()],
			contacts: [],
			syncType: 'INITIAL_BOOTSTRAP',
			progress: null,
			chunkOrder: 1,
			peerDataRequestSessionId: null
		}],
		['messages.upsert', { messages: [notify()], type: 'notify' }]
	]).messageTimestamp, DECODED_TS);
});
