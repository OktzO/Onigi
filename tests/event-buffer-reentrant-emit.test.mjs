import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEventBuffer } from '../lib/Utils/event-buffer.js';

/*
 * ev.emit is synchronous, so a listener that reacts to a flush by calling back
 * into emit() runs while flush() is still mid-flight. Both swap sites retired
 * the buffer *after* the emit: the re-entrant append landed in the object being
 * retired and the next line dropped it, so the listener's event never reached
 * anyone. A listener has to re-arm the buffer first (buffer() then emit()),
 * because flush() has already set isBuffering = false by the time listeners run.
 */

const logger = { debug() {}, trace() {}, warn() {}, error() {} };
const msg = id => ({ key: { remoteJid: '1@s', id, fromMe: false }, messageTimestamp: 1, message: { conversation: id } });

const upsert = (eb, id, type = 'notify') => eb.emit('messages.upsert', { messages: [msg(id)], type });

const collect = eb => {
	const seen = [];
	eb.process(map => { for (const ev in map) { seen.push([ev, map[ev]]); } });
	return seen;
};

const upsertIds = seen => seen
	.filter(([ev]) => ev === 'messages.upsert')
	.flatMap(([, v]) => v.messages.map(m => m.key.id));

test('an emit from a flush listener survives the next flush', () => {
	const eb = makeEventBuffer(logger);
	const seen = collect(eb);
	let reentered = false;
	eb.on('event', map => {
		// only on the flush we caused, not on our own re-entrant emit
		if (reentered || !map['messages.upsert']) {
			return;
		}
		reentered = true;
		eb.buffer();
		upsert(eb, 'reentrant');
	});
	eb.buffer();
	upsert(eb, 'first');
	eb.flush();
	assert.deepEqual(upsertIds(seen), ['first'], 'precondition: the flushed batch came out once');
	eb.flush();
	assert.deepEqual(upsertIds(seen), ['first', 'reentrant'], 'the re-entrant event was dropped by the flush it was emitted from');
	eb.destroy();
});

test('an emit from a type-mismatch flush listener survives the next flush', () => {
	const eb = makeEventBuffer(logger);
	const seen = collect(eb);
	let reentered = false;
	eb.on('event', map => {
		// only for the 'append' batch the mismatch flush emits
		if (reentered || map['messages.upsert']?.type !== 'append') {
			return;
		}
		reentered = true;
		eb.buffer();
		upsert(eb, 'reentrant', 'notify');
	});
	eb.buffer();
	upsert(eb, 'first', 'append');
	// type mismatch: emits the buffered 'append' batch from inside emit()
	upsert(eb, 'second', 'notify');
	eb.flush();
	// 'reentrant' enters the live buffer during the mismatch emit, so it precedes
	// the 'second' that emit() appends on its way out.
	assert.deepEqual(upsertIds(seen), ['first', 'reentrant', 'second'], 'the re-entrant event was dropped by the reset that ran after the emit');
	eb.destroy();
});