import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * end() did this, in this order:
 *
 *     ws.removeAllListeners('close');
 *     ws.removeAllListeners('open');
 *     ws.removeAllListeners('message');
 *     signalRepository.close?.();
 *     if (!ws.isClosed && !ws.isClosing) { await ws.close(); }
 *
 * The 'close'/'error' listeners an in-flight waitForMessage is parked on are
 * gone before the socket is even asked to close, so every pending TAG:<id>
 * waiter is orphaned: it keeps its own promiseTimeout timer, and whichever
 * happens first decides what the caller sees.
 *
 * The audit saw both, and they are race dependent:
 *   - the raw ws 'close' event wins: EventEmitter clones the handler array
 *     before iterating, so the waiter's own onErr still fires during that emit
 *     and the query rejects immediately -- but with whatever the emitter passed
 *     as `err`, and the ws library passes the numeric close code, so the caller
 *     received a bare Number;
 *   - end() wins: nothing rejects the waiter, so it sits out its defaultQuery-
 *     TimeoutMs and resolves undefined.
 *
 * The contract: end() owns its pending waiters. It rejects them with the same
 * Boom the close path is meant to produce, through the promiseTimeout's own
 * reject so the timer is cancelled with it, and the answer is the same in both
 * orderings.
 */
const HELPERS = `const report = p => p.then(
	v => 'RESOLVED ' + JSON.stringify(v),
	e => 'REJECTED ' + (e?.output?.statusCode) + ' ' + (e?.message)
);
// bounded so an orphaned waiter shows up as STILL-PENDING instead of hanging the child
const settle = p => Promise.race([report(p), tick(4000).then(() => 'STILL-PENDING')]);
const pending = (h, id) => h.sock.query({
	tag: 'iq',
	attrs: { id, xmlns: 'w:p', type: 'get', to: 's.whatsapp.net' },
	content: [{ tag: 'ping', attrs: {} }]
});`;

test('a query in flight when the server closes the socket is rejected, not orphaned', async () => {
	const { code, stdout, stderr } = await runScenario(`
${HELPERS}
// 600s: a waiter that nobody rejects can only surface here as a timeout
const h = await startHarness({ config: { defaultQueryTimeoutMs: 600000 } });
const p = settle(pending(h, 'in-flight'));
await tick(50);
// the ordering where the raw ws 'close' event reaches socket.js first
h.sock.ws.socket.close();
console.log('outcome=' + await p);
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /outcome=REJECTED 428 Connection Closed/);
});

test('a query in flight when end() is called by hand is rejected, not orphaned', async () => {
	const { code, stdout, stderr } = await runScenario(`
${HELPERS}
const h = await startHarness({ config: { defaultQueryTimeoutMs: 600000 } });
const p = settle(pending(h, 'in-flight'));
await tick(50);
const t0 = Date.now();
// the ordering where end() wins: it strips the listeners the waiter needs
await h.sock.end(new Error('bye'));
console.log('outcome=' + await p);
console.log('elapsed=' + (Date.now() - t0));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	// old: the waiter sat out its 600s timer and resolved undefined
	assert.match(stdout, /outcome=REJECTED 428 Connection Closed/);
	const elapsed = Number(stdout.match(/elapsed=(\d+)/)[1]);
	assert.ok(elapsed < 4000, `end() did not reject the waiter promptly: ${elapsed}ms`);
});

test('logout() does not leave an in-flight query unresolved either', async () => {
	const { code, stdout, stderr } = await runScenario(`
${HELPERS}
const h = await startHarness({ config: { defaultQueryTimeoutMs: 600000 } });
const p = settle(pending(h, 'in-flight'));
await tick(50);
await h.sock.logout('Intentional Logout');
console.log('outcome=' + await p);
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /outcome=REJECTED 428 Connection Closed/);
});

test('end() rejects every pending waiter, not only the first', async () => {
	const { code, stdout, stderr } = await runScenario(`
${HELPERS}
const h = await startHarness({ config: { defaultQueryTimeoutMs: 600000 } });
const one = settle(pending(h, 'w-1'));
const two = settle(pending(h, 'w-2'));
await tick(50);
await h.sock.end(new Error('bye'));
console.log('one=' + await one);
console.log('two=' + await two);
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /one=REJECTED 428 Connection Closed/);
	assert.match(stdout, /two=REJECTED 428 Connection Closed/);
});

test('a waiter rejected by end() leaves no timer behind it', async () => {
	const { code, stdout, stderr } = await runScenario(`
${HELPERS}
let outcome = 'PENDING';
// the reporter only records; nothing awaits it, so the timer census below is
// not perturbed by a settle() window
const h = await startHarness({ config: { defaultQueryTimeoutMs: 600000 } });
pending(h, 'in-flight').then(
	v => { outcome = 'RESOLVED ' + JSON.stringify(v); },
	e => { outcome = 'REJECTED ' + (e?.output?.statusCode) + ' ' + (e?.message); }
);
await tick(50);
const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
await h.sock.end(new Error('bye'));
const after = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
console.log('timersBefore=' + before);
console.log('timersAfter=' + after);
console.log('outcome=' + outcome);
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	const after = Number(stdout.match(/timersAfter=(\d+)/)[1]);
	const before = Number(stdout.match(/timersBefore=(\d+)/)[1]);
	// the waiter holds exactly one 600s promiseTimeout timer; end() has to cancel it
	assert.ok(after < before, `end() left the orphaned waiter's timer alive: ${after} >= ${before}`);
	assert.match(stdout, /outcome=REJECTED 428 Connection Closed/);
});

test('a query that was already answered is unaffected by end()', async () => {
	const { code, stdout, stderr } = await runScenario(`
${HELPERS}
const h = await startHarness({ config: { defaultQueryTimeoutMs: 300 } });
const p = settle(pending(h, 'in-flight'));
await tick(30);
h.sock.ws.emit('TAG:in-flight', { tag: 'iq', attrs: { type: 'result', id: 'in-flight' } });
console.log('before=' + await p);
await h.sock.end(new Error('bye'));
console.log('survived');
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /before=RESOLVED \{"tag":"iq"/);
	assert.match(stdout, /survived/);
});
