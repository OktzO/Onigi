import assert from 'node:assert/strict';
import test from 'node:test';
import { runScenario } from './helpers/ev-socket-harness.mjs';
import { addTransactionCapability } from '../lib/Utils/auth-utils.js';

const silentLogger = () => {
	const rec = () => { };
	return {
		level: 'silent',
		trace: rec, debug: rec, info: rec, warn: rec, error: rec,
		child() { return this; }
	};
};

/*
 * addTransactionCapability() creates one AsyncLocalStorage per socket and never
 * disposes it. On Node < 24 an enabled AsyncLocalStorage stamps its resource
 * symbol onto every async resource created afterwards, process-wide, so every
 * reconnect leaves one more set of stamps alive for as long as any resource
 * from that socket's life survives. Upstream measured 1.9 GB of a 2.1 GB heap
 * after 25 h at ~250 sockets (issue #2806); a bot that reconnects on every
 * 401/515/network blip accumulates one per reconnect.
 *
 * The contract: the transaction capability exposes disposeTransactionStorage()
 * and the socket-end teardown calls it. The ALS instance is private to
 * addTransactionCapability, so the spy sits on the prototype and records which
 * instance was disposed; re-disposing through the keys proves the instance
 * end() reached is the one the socket's keys own.
 */
test('end() disables the per-socket transaction AsyncLocalStorage', async () => {
	const { code, stdout, stderr } = await runScenario(`
import { AsyncLocalStorage } from 'node:async_hooks';
const realDisable = AsyncLocalStorage.prototype.disable;
const disabled = [];
AsyncLocalStorage.prototype.disable = function (...args) {
	disabled.push(this);
	return realDisable.apply(this, args);
};
const h = await startHarness();
await tick(50);
const keys = h.sock.authState.keys;
console.log('hasDispose=' + typeof keys.disposeTransactionStorage);
console.log('before=' + disabled.length);
await h.sock.end(new Error('bye'));
console.log('after=' + disabled.length);
const disposedByEnd = disabled[0];
// the teardown runs on the store mutex, so the caller has to await it
await keys.disposeTransactionStorage?.();
console.log('sameInstance=' + (disabled.length === 2 && disabled[1] === disposedByEnd));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /hasDispose=function/, 'the transaction capability must expose disposeTransactionStorage');
	assert.match(stdout, /before=0/, 'a live socket must not have disposed its storage');
	assert.match(stdout, /after=1/, 'end() must disable the transaction storage exactly once');
	assert.match(stdout, /sameInstance=true/, 'end() disposed the storage the socket keys own');
});

/*
 * The instance is not the only thing that matters: end() must not tear the
 * storage down while a transaction is still running on it. end() never awaits
 * signal work, and a transaction is routinely open at that point — relayMessage
 * holds authState.keys.transaction across assertSessions, getUSyncDevices (a
 * round trip), patchMessageBeforeSending and sendNode, and every nested
 * parsedKeys.transaction() runs inside it.
 *
 * AsyncLocalStorage.disable() clears the store for the running context, so
 * disabling mid-transaction breaks the transaction twice over:
 *
 *   1. the transaction's own keys.get/keys.set fall out of the transactional
 *      path — reads hit the disk instead of the staged cache and writes go
 *      straight to state.set, where commitWithRetry(ctx.mutations) later
 *      overwrites them. That is the lost-update family, and it is silent.
 *   2. a nested transaction() no longer sees the context, so it is taken for a
 *      new one and queues on txMutex.runExclusive — a mutex the outer
 *      transaction still holds and, being store-global, never releases again.
 *      The in-flight sendMessage never settles.
 *
 * The scenario runs a real transaction across end(), with a nested transaction
 * and two staged writes inside it — one from before end() asked for disposal and
 * one from after, because the lost update is only real when something is left to
 * clobber — and reports each step. Every wait is bounded by its own race, so a
 * hang surfaces as an 'HUNG' marker and a failed assertion instead of a skipped
 * or timed-out test.
 */
test('end() does not dispose the transaction storage out from under a running transaction', async () => {
	const { code, stdout, stderr } = await runScenario(`
import { AsyncLocalStorage } from 'node:async_hooks';
const realDisable = AsyncLocalStorage.prototype.disable;
let disabled = 0;
AsyncLocalStorage.prototype.disable = function (...args) {
	disabled++;
	return realDisable.apply(this, args);
};
const bounded = (p, ms = 5000) => Promise.race([p, tick(ms).then(() => 'HUNG')]);
const h = await startHarness();
await tick(50);
const keys = h.sock.authState.keys;
await keys.set({ session: { id: 'initial' } });
let innerRan = false;
const outer = keys.transaction(async () => {
	// staged before end() asks for disposal: this lands in ctx.mutations and is
	// replayed by the single commitWithRetry at the end of the transaction
	await keys.set({ session: { staged: 'staged' } });
	// by now end() has asked for disposal: the flag is set synchronously, the
	// disable itself is waiting on this transaction's mutex
	await tick(150);
	// and this one lands after it, into a store whose dispose has not landed yet,
	// so it joins the same ctx.mutations and the commit replays both keys. Were
	// the disable ever to land mid-transaction this write would bypass the staged
	// cache and go straight to state.set, and the commit's state.set would then
	// replace the whole 'session' type on top of it - the lost update this test
	// exists for.
	await keys.set({ session: { after: 'after' } });
	// nested, and on a store whose dispose may already have landed
	await bounded(keys.transaction(async () => {
		await keys.set({ nested: { id: 'nested-B' } });
		innerRan = true;
	}));
	console.log('innerRan=' + innerRan);
	return 'outer-done';
});
const outerSettled = outer.then(v => 'result:' + v, e => 'error:' + (e && e.message));
const endSettled = h.sock.end(new Error('bye')).then(() => 'end-done', e => 'end-error:' + (e && e.message));
console.log('outer=' + await bounded(outerSettled));
console.log('end=' + await bounded(endSettled));
console.log('disabledCount=' + disabled);
// no ambient context here, so this reads the store the transaction committed to.
// Both keys have to be here: the commit is a single state.set, so a mid-transaction
// disable would have let the post-end() write through to the store directly and
// then had that same state.set wipe it on the way out.
const finalValue = await keys.get('session', ['staged', 'after']);
console.log('final=' + JSON.stringify(finalValue));
// a transaction that starts after the dispose must not queue behind the teardown
console.log('late=' + await bounded(keys.transaction(async () => {
	await keys.set({ session: { id: 'late' } });
	return 'late-done';
})));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /outer=result:outer-done/, 'the transaction open across end() must settle, not hang');
	assert.match(stdout, /end=end-done/, 'end() must not be wedged by the teardown it started');
	assert.match(stdout, /innerRan=true/, 'a nested transaction inside the one across end() must still complete');
	assert.match(stdout, /final=\["staged","after"\]/, 'both staged writes - the one from before end() and the one from after it - must be replayed by the commit');
	assert.match(stdout, /late=late-done/, 'a transaction started after the dispose must complete instead of queueing');
	assert.match(stdout, /disabledCount=1/, 'end() must still disable the storage exactly once');
});

/*
 * Both of the above are re-entrancy hazards, and end() is public: keys, end and
 * logout are all on the socket type (lib/Socket/socket.d.ts). A consumer that
 * closes its socket from inside its own transaction — the shape every
 * "flush the pending work, then tear down" wrapper produces — asks the store
 * mutex for a lock the calling frame is already holding, so end() awaits a
 * teardown that can never be granted: not a slow close, a permanent hang, with
 * no timer and no socket event to break it. Nothing inside the library does
 * this today, which is exactly why it needs a test rather than an argument.
 *
 * end() is awaited through a race so the hang shows up as an 'HUNG' marker on
 * the console and a failed assertion, not as a stalled test run.
 */
test('end() called from inside a transaction settles instead of re-entering the store mutex', async () => {
	const { code, stdout, stderr } = await runScenario(`
const bounded = (p, ms = 5000) => Promise.race([p, tick(ms).then(() => 'HUNG')]);
const h = await startHarness();
await tick(50);
const keys = h.sock.authState.keys;
const outcome = await bounded(keys.transaction(async () => {
	await keys.set({ session: { id: 'staged' } });
	await h.sock.end(new Error('bye'));
	return 'end-inside-transaction-done';
}));
console.log('outcome=' + outcome);
// the transaction still commits what it staged, and the store is left readable
console.log('value=' + JSON.stringify(await keys.get('session', ['id'])));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /outcome=end-inside-transaction-done/, 'end() from inside a transaction must settle, not hang on the store mutex');
	assert.match(stdout, /value=\["staged"\]/, 'the transaction that closed the socket must still commit what it staged');
});

/*
 * The store mutex is the whole deadlock: it is store-global, so a transaction
 * that cannot be recognised as nested queues behind a holder that is waiting on
 * it. That window is narrow in production (it needs a nested call to arrive
 * after the disable lands) but it is exactly the window end() opens, so it is
 * pinned directly here: a transaction holds the mutex, disposal is requested,
 * and only then does a second transaction ask to start.
 */
test('a transaction asked to start while disposal is pending bypasses the store mutex', async () => {
	const state = { get: async () => ({}), set: async () => { }, clear: async () => { } };
	const keys = addTransactionCapability(state, silentLogger(), { maxCommitRetries: 1, delayBetweenTriesMs: 1 });
	let releaseHolder;
	const held = keys.transaction(() => new Promise(res => { releaseHolder = res; }));
	await new Promise(res => setImmediate(res));
	// request only — awaiting it here would deadlock against the holder, which is the
	// trap this fix has to keep avoiding
	const disposal = keys.disposeTransactionStorage();
	let lateRan = false;
	const late = keys.transaction(async () => { lateRan = true; });
	const outcome = await Promise.race([late.then(() => 'ran'), new Promise(res => setTimeout(() => res('HUNG'), 1500))]);
	assert.equal(outcome, 'ran', 'a transaction must not queue on a store mutex an in-flight transaction still owns');
	assert.equal(lateRan, true);
	releaseHolder('held-done');
	assert.equal(await held, 'held-done');
	await disposal;
});
