import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * `offline` on a stanza is the STRING '0' or '1', never a boolean, so every
 * truthiness test on it read '0' as offline:
 *
 *     const isOffline = !!node.attrs.offline;                 // messages-recv.js:1680
 *     if (isOffline) { offlineNodeProcessor.enqueue(type, node); }
 *     else { await processNodeWithBuffer(node, identifier, exec); }
 *
 *     offline: !!attrs.offline,                                // :1527 (handleCall)
 *     await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify');   // :1480
 *     await upsertMessage(protoMsg, call.offline ? 'append' : 'notify');   // :1732
 *
 * Three sites, two routes. :1680 decides whether the node is queued at all --
 * so a live message lost processNodeWithBuffer's buffer()/flush() pair and its
 * events sat in the buffer with nothing to release them. :1480/:1527 decide the
 * emitted type, so a live message reached the consumer as 'append', i.e. it
 * read as history backfill.
 *
 * Two routes, one polarity. Only the '0' cases fail before the fix; the '1'
 * cases pass either way and are what pin the direction -- a helper written
 * backwards turns every live message into a backfill.
 */

/** A message node whose plaintext child needs no signal session to decrypt. */
const MESSAGE = (id, offline) => `
h.sock.ws.emit('CB:message', {
	tag: 'message',
	attrs: { id: '${id}', from: '99999:1@s.whatsapp.net', t: '1700000000', offline: '${offline}' },
	content: [{ tag: 'plaintext', attrs: {}, content: proto.Message.encode(proto.Message.fromObject({ conversation: 'hello' })).finish() }]
});`;

/** A finished call: handleCall turns the timeout into a missed-call upsert. */
const CALL = (id, offline) => `
h.sock.ws.emit('CB:call', {
	tag: 'call',
	attrs: { from: '99999:1@s.whatsapp.net', t: '1700000000', offline: '${offline}' },
	content: [{ tag: 'terminate', attrs: { 'call-id': '${id}', from: '99999:1@s.whatsapp.net', reason: 'timeout' }, content: [] }]
});`;

const PRELUDE = `
const h = await startHarness();
await tick(50);
const delivered = [];
h.sock.ev.on('messages.upsert', e => delivered.push(e.messages.map(m => m.key.id).join(',') + ':' + e.type));
`;

const EPILOGUE = `
console.log('delivered=' + JSON.stringify(delivered));
console.log('buffering=' + h.sock.ev.isBuffering());
await h.close();
process.exit(0);
`;

// --- the upsert site (messages-recv.js:1480), reached via CB:message ----------

test("offline='0' on a message is emitted as notify", async () => {
	const { code, stdout, stderr } = await runScenario(`
${PRELUDE}${MESSAGE('M0', '0')}
await tick(400);
${EPILOGUE}`);
	assert.equal(code, 0, stderr);
	// '0' means the message was live. 'append' reads as history backfill.
	assert.match(stdout, /delivered=\["M0:notify"\]/);
	// the live route wraps the handler in buffer()/flush(), so the batch is
	// released by the time the handler returns
	assert.match(stdout, /buffering=false/);
});

test("offline='1' on a message is emitted as append", async () => {
	const { code, stdout, stderr } = await runScenario(`
${PRELUDE}${MESSAGE('M1', '1')}
await tick(400);
// the offline route never flushes; only an explicit flush releases the batch
console.log('beforeFlush=' + JSON.stringify(delivered) + ' buffering=' + h.sock.ev.isBuffering());
h.sock.ev.flush();
await tick(200);
${EPILOGUE}`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /beforeFlush=\[\] buffering=true/);
	assert.match(stdout, /delivered=\["M1:append"\]/);
});

// --- the event-buffer seeding site (:1680), reached via CB:call ---------------

test("offline='0' on a call takes the buffered live route", async () => {
	const { code, stdout, stderr } = await runScenario(`
${PRELUDE}
h.sock.ev.on('call', e => console.log('callOffline=' + e[0].offline));
${CALL('C0', '0')}
await tick(400);
${EPILOGUE}`);
	assert.equal(code, 0, stderr);
	// !!'0' is true, so a live call was flagged offline in the call event...
	assert.match(stdout, /callOffline=false/);
	// ...and the emitted type followed it
	assert.match(stdout, /delivered=\["C0:notify"\]/);
	assert.match(stdout, /buffering=false/);
});

test("offline='1' on a call is queued for the offline processor", async () => {
	const { code, stdout, stderr } = await runScenario(`
${PRELUDE}
h.sock.ev.on('call', e => console.log('callOffline=' + e[0].offline));
${CALL('C1', '1')}
await tick(400);
console.log('beforeFlush=' + JSON.stringify(delivered) + ' buffering=' + h.sock.ev.isBuffering());
h.sock.ev.flush();
await tick(200);
${EPILOGUE}`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /callOffline=true/);
	assert.match(stdout, /beforeFlush=\[\] buffering=true/);
	assert.match(stdout, /delivered=\["C1:append"\]/);
});
