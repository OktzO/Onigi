import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * WebSocketClient.close() was:
 *
 *     async close() {
 *         if (!this.socket) { return; }
 *         const closePromise = new Promise(resolve => { this.socket?.once('close', resolve); });
 *         this.socket.close();
 *         await Promise.race([
 *             closePromise,
 *             delay(5000).then(() => this.socket?.terminate())
 *         ]);
 *         this.socket = null;
 *     }
 *
 * Two things go wrong, both of them about the process outliving the socket:
 *
 *  - the 5s terminate fallback is never cancelled. It wins the race, or it
 *    loses it, and either way its handle stays live: the audit saw close()
 *    resolve in 40ms with 1 Timeout handle still on the process, gone only
 *    5.7s later. end() and logout() both go through here, so a teardown
 *    pinned the host's event loop for 5s after the socket was gone.
 *
 *  - a socket that is already CLOSED emits no further 'close', so closePromise
 *    never resolves and close() blocks for the full fallback. The audit timed
 *    it at 5002ms. With 10.4 that state is now reachable from a dropped
 *    socket as well as from close() itself.
 *
 * The contract: close() returns as soon as the socket is closed, holds no
 * timer once it has, and still terminates a socket whose peer never completes
 * the close handshake.
 */
const PRELUDE = `import { WebSocketServer } from 'ws';
import { WebSocketClient } from '/home/user/noddjs/Onigi/lib/Socket/Client/index.js';

const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(res => wss.once('listening', res));
const url = 'ws://127.0.0.1:' + wss.address().port + '/ws/chat';
const client = new WebSocketClient(new URL(url), { connectTimeoutMs: 5000 });
const opened = () => new Promise(res => client.once('open', res));
const settle = ms => new Promise(res => setTimeout(res, ms));
const timers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
const timed = async (label, body) => {
	const t0 = Date.now();
	await body();
	console.log(label + 'Elapsed=' + (Date.now() - t0));
};`;

test('close() leaves no timer behind it', async () => {
	const { code, stdout, stderr } = await runScenario(`
${PRELUDE}
client.connect();
await opened();
const before = timers();
await timed('close', () => client.close());
console.log('timersBefore=' + before);
console.log('timersAfter=' + timers());
console.log('socketNull=' + (client.socket === null));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	// the audit: close() resolved in 40ms, then 1 Timeout handle remained
	const after = Number(stdout.match(/timersAfter=(\d+)/)[1]);
	const before = Number(stdout.match(/timersBefore=(\d+)/)[1]);
	assert.equal(after, before, `close() changed the timer count: ${before} -> ${after}`);
	assert.match(stdout, /socketNull=true/);
	assert.match(stdout, /closeElapsed=\d{1,3}\b/);
});

test('close() on an already-closed socket returns immediately', async () => {
	const { code, stdout, stderr } = await runScenario(`
${PRELUDE}
client.connect();
await opened();
const raw = client.socket;
const rawClosed = new Promise(res => raw.once('close', res));
const clientClosed = new Promise(res => client.once('close', res));
raw.close();
await Promise.all([rawClosed, clientClosed]);
// fb72399 makes the client drop the reference on close, so the natural source of
// this state is gone -- but the state is still reachable (an overlapping close()
// that reads this.socket before the first one nulls it, or a caller that has
// held its own reference), and close() must not depend on a 'close' event that
// cannot arrive
client.socket = raw;
console.log('readyStateBefore=' + client.socket.readyState);
await timed('close', () => client.close());
console.log('socketNull=' + (client.socket === null));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /readyStateBefore=3/);
	// old: 5002ms -- the wait was on a 'close' that would never be re-emitted
	assert.match(stdout, /closeElapsed=\d{1,3}\b/);
	assert.match(stdout, /socketNull=true/);
});

test('close() on a client that never connected is a no-op', async () => {
	const { code, stdout, stderr } = await runScenario(`
${PRELUDE}
await timed('close', () => client.close());
console.log('timers=' + timers());
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /closeElapsed=\d{1,3}\b/);
	assert.match(stdout, /timers=0/);
});

test('close() still terminates a peer that never finishes the close handshake', async () => {
	const { code, stdout, stderr } = await runScenario(`
${PRELUDE}
client.connect();
await opened();
// stand in for a dead TCP. A local ws server always answers a close frame, so
// the handshake can only be made uncompletable by not asking: the close frame
// never goes out, so no 'close' can arrive and only the fallback can end it
const raw = client.socket;
raw.close = () => { };
let terminated = false;
raw.terminate = () => { terminated = true; };
await timed('close', () => client.close());
console.log('terminated=' + terminated);
console.log('timers=' + timers());
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	// clearTimeout on close must not disarm the dead-TCP protection
	assert.match(stdout, /terminated=true/);
	assert.match(stdout, /closeElapsed=[45]\d{3}|closeElapsed=5\d{3}/);
}, { timeout: 30000 });

test('end() does not leave the terminate fallback running behind it', async () => {
	const { code, stdout, stderr } = await runScenario(`
const h = await startHarness();
await tick(50);
const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
await h.sock.end(new Error('bye'));
console.log('timersBefore=' + before);
console.log('timersAfter=' + process.getActiveResourcesInfo().filter(r => r === 'Timeout').length);
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	const after = Number(stdout.match(/timersAfter=(\d+)/)[1]);
	const before = Number(stdout.match(/timersBefore=(\d+)/)[1]);
	assert.ok(after < before, `end() left the terminate fallback running: ${after} timers, expected fewer than the ${before} before end()`);
}, { timeout: 30000 });
