import assert from 'node:assert/strict';
import test from 'node:test';
import { runScenario } from './helpers/ev-socket-harness.mjs';

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
keys.disposeTransactionStorage?.();
console.log('sameInstance=' + (disabled.length === 2 && disabled[1] === disposedByEnd));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /hasDispose=function/, 'the transaction capability must expose disposeTransactionStorage');
	assert.match(stdout, /before=0/, 'a live socket must not have disposed its storage');
	assert.match(stdout, /after=1/, 'end() must disable the transaction storage exactly once');
	assert.match(stdout, /sameInstance=true/, 'end() disposed the storage the socket keys own');
});
