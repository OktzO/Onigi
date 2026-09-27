import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * processNodeWithBuffer guarded only exec() -- ev.flush() ran bare, and flush()
 * drives user handlers (messages.upsert, chats.update, ...) and is what closes
 * the batch. A throw out of it escaped processNode, escaped the bare
 * ws.on('CB:message', async node => { await processNode(...) }) and became an
 * unhandled rejection: the process died and every in-flight and subsequent
 * message was lost.
 *
 * The trigger is config.logger again -- ev.flush() logs through logger.debug
 * before it emits anything, so a logger whose debug() throws escapes from
 * inside flush() with no user handler involved at all.
 */
const FLUSH_FAILURE = `
const logger = noopLogger();
const failures = [];
logger.debug = obj => {
	if (obj && typeof obj === 'object' && 'bufferCount' in obj) {
		throw new Error('logger.debug is broken');
	}
};
logger.error = (...args) => { failures.push(args); };
const h = await startHarness({ logger });
h.sock.ev.on('messages.upsert', () => { throw new Error('user handler boom'); });
let delivered = 0;
h.sock.ev.on('chats.upsert', () => { delivered++; });
`;

test('a failing ev.flush() in processNodeWithBuffer does not kill the process', async () => {
	const { code, stdout, stderr } = await runScenario(FLUSH_FAILURE + `
h.sock.ws.emit('CB:message', PLAINTEXT_STANZA('MSG1'));
await tick(400);
console.log('survived');
process.exit(0);
`);
	assert.equal(code, 0, `processNode let the flush failure escape: ${stderr}`);
	assert.match(stdout, /survived/);
});

test('a failing ev.flush() in processNodeWithBuffer is reported, not swallowed', async () => {
	const { code, stdout, stderr } = await runScenario(FLUSH_FAILURE + `
h.sock.ws.emit('CB:message', PLAINTEXT_STANZA('MSG1'));
await tick(400);
const reported = failures.filter(a => a[0]?.err?.message === 'logger.debug is broken');
console.log('reportedFlushFailures=' + reported.length);
console.log('context=' + (reported[0]?.[1] ?? 'none'));
process.exit(0);
`);
	assert.equal(code, 0, `processNode let the flush failure escape: ${stderr}`);
	assert.match(stdout, /reportedFlushFailures=1/, 'the flush failure must reach onUnexpectedError');
	assert.match(stdout, /context=.*processing message/);
});

/*
 * Characterization, not a defect: the missed-call generator registered at
 * ev.on('call', ...) used to be assumed to be an unguarded emit. It is not --
 * ev.on routes through the buffer's attach() wrapper, which owns the rejected
 * promise, and its only emit site (messages-recv.js, inside handleCall) sits in
 * a try/catch. Pinned so a future refactor that bypasses attach() fails here
 * instead of in production.
 */
test('a throwing handler on the generated missed-call upsert is contained', async () => {
	const { code, stdout, stderr } = await runScenario(`
const h = await startHarness();
const seen = [];
h.sock.ev.on('error', (err, events) => { seen.push(err.message + ':' + events.join(',')); });
h.sock.ev.on('messages.upsert', () => { throw new Error('user handler boom'); });
h.sock.ws.emit('CB:call', {
	tag: 'call',
	attrs: { from: '99999:1@s.whatsapp.net', t: '1700000000' },
	content: [{ tag: 'terminate', attrs: { 'call-id': 'C1', from: '99999:1@s.whatsapp.net', reason: 'timeout' }, content: [] }]
});
await tick(400);
console.log('seen=' + JSON.stringify(seen));
console.log('survived');
process.exit(0);
`);
	assert.equal(code, 0, `the call handler let a failure escape: ${stderr}`);
	assert.match(stdout, /seen=\["user handler boom:messages\.upsert"\]/);
	assert.match(stdout, /survived/);
});
