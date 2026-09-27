import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * end()'s teardown was:
 *
 *     finally {
 *         ev.removeAllListeners('connection.update');
 *         ev.destroy();
 *     }
 *
 * and ev.destroy() throws the batch away:
 *
 *     destroy() {
 *         ...
 *         data = makeBufferData();
 *         isBuffering = false;
 *         ev.removeAllListeners();
 *     }
 *
 * The whole initial burst -- the offline queue and the history sync that
 * arrives between 'connecting' and CB:ib,,offline -- is still sitting in the
 * buffer when a connection is torn down early, and destroy() drops it. The
 * consumer's connection.update close notification says the connection is gone
 * and it never learns about the messages that were sitting there. The audit
 * saw exactly that: delivered = [connection.update x3], then end() and no
 * messages.upsert at all, isBuffering() === false.
 *
 * The contract: end() releases the batch before it destroys the buffer, and
 * the release cannot be skipped by a failure in the close notification
 * (eecd241) or in a logger that is itself broken (crash-52).
 */
const HELPERS = `const delivered = [];
h.sock.ev.on('messages.upsert', e => delivered.push('m:' + e.messages.map(m => m.key.id).join(',')));
h.sock.ev.on('chats.upsert', e => delivered.push('c:' + e.map(c => c.id).join(',')));
const upsert = (id, remote) => h.sock.ev.emit('messages.upsert', {
	messages: [{ key: { id, remoteJid: remote, fromMe: false }, messageTimestamp: 1700000000 }],
	type: 'notify'
});`;

test('end() delivers the buffered burst instead of dropping it', async () => {
	const { code, stdout, stderr } = await runScenario(`
const h = await startHarness();
await tick(50);
${HELPERS}
upsert('MSG1', '99999:1@s.whatsapp.net');
upsert('MSG2', '99999:1@s.whatsapp.net');
h.sock.ev.emit('chats.upsert', [{ id: '99999:1@s.whatsapp.net' }]);
console.log('buffering=' + h.sock.ev.isBuffering());
console.log('deliveredBefore=' + JSON.stringify(delivered));
await h.sock.end(new Error('bye'));
console.log('deliveredAfter=' + JSON.stringify(delivered));
console.log('bufferingAfter=' + h.sock.ev.isBuffering());
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /buffering=true/);
	assert.match(stdout, /deliveredBefore=\[\]/);
	// old: deliveredAfter=[] and the batch was simply gone
	// (the order inside a consolidated batch belongs to consolidateEvents)
	assert.match(stdout, /deliveredAfter=\["c:99999:1@s\.whatsapp\.net","m:MSG1,MSG2"\]/);
	assert.match(stdout, /bufferingAfter=false/);
});

test('the burst reaches the consumer before the close notification', async () => {
	const { code, stdout, stderr } = await runScenario(`
const h = await startHarness();
await tick(50);
const order = [];
h.sock.ev.on('messages.upsert', e => order.push('data'));
h.sock.ev.on('connection.update', u => { if (u.connection === 'close') { order.push('close'); } });
h.sock.ev.emit('messages.upsert', {
	messages: [{ key: { id: 'MSG1', remoteJid: '99999:1@s.whatsapp.net', fromMe: false }, messageTimestamp: 1 }],
	type: 'notify'
});
await h.sock.end(new Error('bye'));
console.log('order=' + JSON.stringify(order));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	// a consumer that tears itself down on connection: 'close' must still see
	// the messages the buffer was holding
	assert.match(stdout, /order=\["data","close"\]/);
});

test('end() still flushes when the close notification itself fails', async () => {
	const { code, stdout, stderr } = await runScenario(`
const h = await startHarness();
await tick(50);
${HELPERS}
h.sock.ev.on('connection.update', u => { if (u.connection === 'close') { throw new Error('user handler boom'); } });
upsert('MSG1', '99999:1@s.whatsapp.net');
await h.sock.end(new Error('bye'));
console.log('delivered=' + JSON.stringify(delivered));
console.log('survived');
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /delivered=\["m:MSG1"\]/);
	assert.match(stdout, /survived/);
});

test('a failing flush cannot skip the teardown nor escape end()', async () => {
	const { code, stdout, stderr } = await runScenario(`
// crash-52's trigger: config.logger is a user option, and one whose error()
// throws is reachable without any library bug
const logger = noopLogger();
logger.error = () => { throw new Error('logger.error is broken'); };
const h = await startHarness({ logger });
await tick(50);
const delivered = [];
// a consumer handler that throws reaches the buffer's own failure report,
// which lands on the same broken logger
h.sock.ev.on('messages.upsert', () => { throw new Error('handler boom'); });
h.sock.ev.on('messages.upsert', e => delivered.push(e.messages.map(m => m.key.id).join(',')));
h.sock.ev.emit('messages.upsert', {
	messages: [{ key: { id: 'MSG1', remoteJid: '99999:1@s.whatsapp.net', fromMe: false }, messageTimestamp: 1 }],
	type: 'notify'
});
await h.sock.end(new Error('bye'));
console.log('delivered=' + JSON.stringify(delivered));
console.log('isBuffering=' + h.sock.ev.isBuffering());
console.log('survived');
process.exit(0);
`);
	// the uncaught-exception class of bug: only the child's exit code is faithful
	assert.equal(code, 0, `end() let the failure escape: ${stderr}`);
	assert.match(stdout, /survived/);
	// ev.destroy() sets isBuffering false and clears the pending flush timers
	assert.match(stdout, /isBuffering=false/);
});

test('end() with an empty buffer is a no-op', async () => {
	const { code, stdout, stderr } = await runScenario(`
const h = await startHarness();
await tick(50);
const delivered = [];
h.sock.ev.on('messages.upsert', e => delivered.push(e.messages.length));
console.log('buffering=' + h.sock.ev.isBuffering());
await h.sock.end(new Error('bye'));
console.log('deliveredAfter=' + JSON.stringify(delivered));
console.log('survived');
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /buffering=true/, 'makeSocket starts the buffer for a logged-in creds');
	assert.match(stdout, /deliveredAfter=\[\]/);
	assert.match(stdout, /survived/);
});
