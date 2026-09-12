import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEventBuffer } from '../lib/Utils/event-buffer.js';

const logger = { debug() {}, trace() {}, warn() {}, error() {} };
const msg = (id, jid) => ({
	key: { remoteJid: jid, id, fromMe: false },
	messageTimestamp: 1,
	message: { conversation: id }
});

const harness = () => {
	const eb = makeEventBuffer(logger);
	const seen = [];
	eb.process(async map => { for (const ev in map) seen.push([ev, map[ev]]); });
	eb.buffer();
	return { eb, seen };
};

test('same upsert type stays buffered; mismatch flushes prior batch', () => {
	const { eb, seen } = harness();
	eb.emit('messages.upsert', { messages: [msg('a', '1@s')], type: 'append' });
	eb.emit('messages.upsert', { messages: [msg('b', '1@s')], type: 'append' });
	assert.equal(seen.length, 0);
	eb.emit('messages.upsert', { messages: [msg('c', '2@s')], type: 'notify' });
	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0][1].messages.map(m => m.key.id), ['a', 'b']);
	assert.equal(seen[0][1].type, 'append');
	eb.flush();
});

test('messageUpsertsCount mirror survives inserts+deletes', () => {
	const { eb, seen } = harness();
	for (const id of ['x', 'y', 'z']) {
		eb.emit('messages.upsert', { messages: [msg(id, 'p')], type: 'notify' });
	}
	eb.emit('messages.delete', {
		keys: [
			{ remoteJid: 'p', id: 'x', fromMe: false },
			{ remoteJid: 'p', id: 'y', fromMe: false }
		]
	});
	eb.flush();
	const ups = seen.find(([e]) => e === 'messages.upsert');
	assert.deepEqual(ups[1].messages.map(m => m.key.id), ['z']);
});

test('"__proto__" jid cannot poison buffer maps', () => {
	const { eb, seen } = harness();
	eb.emit('messages.upsert', { messages: [msg('q', '__proto__')], type: 'append' });
	eb.emit('messages.upsert', { messages: [msg('r', '__proto__')], type: 'append' });
	eb.flush();
	const got = seen.find(([e]) => e === 'messages.upsert');
	assert.ok(got && got[1].messages.length === 2);
	assert.equal({}.messageUpserts, undefined, 'Object.prototype intact');
});
