import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeEventBuffer } from '../lib/Utils/event-buffer.js';

import { sleep } from './helpers/ev-flush-harness.mjs';

/*
 * The 'error' channel is public API (lib/Types/Events.d.ts declares
 * BaileysEventErrorListener and on('error', ...) as a listener), and
 * reportError() re-emits on the *same channel that produced the failure*. Every
 * listener is registered through attach(), whose catch/rejection handler routes
 * the failure straight back into reportError -- so a listener on 'error' that
 * fails is re-reported into 'error', which fails again, for ever.
 *
 *   - an ASYNC error listener that throws livelocks: each rejection re-enters
 *     reportError on the microtask queue, so the event loop never reaches a
 *     timer, an I/O completion or a signal handler again. 100% CPU, nothing
 *     logged, no way out. Measured before the fix: 100000 invocations of the
 *     error listener in 100ms from ONE rejected ordinary handler.
 *   - a SYNC error listener that throws recurses synchronously instead, until
 *     the stack runs out (measured depth 1676).
 *
 * Every other test in event-buffer-handler-errors.test.mjs uses a *synchronous*
 * error listener and a well behaved one at that, which is why this was
 * invisible: the trap needs an error listener that fails.
 *
 * Both instances are child processes. The livelock starves the event loop, so
 * an in-process test could only ever hang the runner, and an in-process
 * unhandledRejection listener would suppress the very default under test.
 */

const execFileAsync = promisify(execFile);
const bufferUrl = new URL('../lib/Utils/event-buffer.js', import.meta.url).href;

/**
 * One rejected ordinary handler, one failing error listener, then a timer that
 * can only be reached if the loop is bounded. Prints the invocation count so a
 * bound can be asserted rather than merely "the process eventually died".
 */
const runChild = async listenerBody => {
	const script = `
import { makeEventBuffer } from ${JSON.stringify(bufferUrl)};
const logged = [];
const logger = { debug() {}, trace() {}, warn() {}, error: (...a) => logged.push(a[0]?.err?.message) };
const ev = makeEventBuffer(logger);
let calls = 0;
ev.on('error', ${listenerBody});
ev.on('messages.upsert', async () => { throw new Error('one rejected handler'); });
ev.emit('messages.upsert', { messages: [], type: 'notify' });
await new Promise(resolve => setTimeout(resolve, 300));
console.log('calls=' + calls);
console.log('logged=' + JSON.stringify(logged));
console.log('survived');
process.exit(0);
`;
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { timeout: 30000 });
		return { code: 0, stdout, stderr };
	}
	catch (err) {
		return { code: err.code ?? err.signal ?? 'error', stdout: err.stdout || '', stderr: err.stderr || String(err) };
	}
};

test('an async error listener that rejects cannot livelock the process', async () => {
	const { code, stdout, stderr } = await runChild(`async () => { calls += 1; throw new Error('reject ' + calls); }`);
	assert.equal(code, 0, `the process hung or died: code=${code}\n${stderr}`);
	assert.match(stdout, /survived/, `the event loop was starved by the failure loop: ${stderr}`);
	assert.match(stdout, /calls=1\b/, `one rejected handler must reach the error listener once, not for ever: ${stdout}`);
});

test('a sync error listener that throws cannot recurse without bound', async () => {
	const { code, stdout, stderr } = await runChild(`() => { calls += 1; throw new Error('sync throw ' + calls); }`);
	assert.equal(code, 0, `the process hung or died: code=${code}\n${stderr}`);
	assert.doesNotMatch(stderr, /Maximum call stack size exceeded/, 'a throwing error listener must not recurse into the stack limit');
	assert.match(stdout, /calls=1\b/, `one rejected handler must reach the error listener once, not for ever: ${stdout}`);
});

test('a failing error listener is reported, not silently dropped', async () => {
	const logged = [];
	const eb = makeEventBuffer({ debug() {}, trace() {}, warn() {}, error: (...a) => logged.push(a) });
	eb.on('error', () => { throw new Error('error listener boom'); });
	eb.on('messages.upsert', async () => { throw new Error('handler boom'); });
	eb.emit('messages.upsert', { messages: [], type: 'notify' });
	await sleep(50);
	eb.destroy();
	assert.equal(logged.length, 1, `the failing error listener must be reported exactly once, got ${logged.length}`);
	assert.equal(logged[0][0].err.message, 'error listener boom');
});

test('a well behaved error listener still sees the original failure', async () => {
	const seen = [];
	const eb = makeEventBuffer({ debug() {}, trace() {}, warn() {}, error() {} });
	eb.on('error', (err, events) => seen.push([err.message, events]));
	eb.on('messages.upsert', async () => { throw new Error('handler boom'); });
	eb.emit('messages.upsert', { messages: [], type: 'notify' });
	await sleep(50);
	eb.destroy();
	assert.deepEqual(seen, [['handler boom', ['messages.upsert']]], 'the error channel is still the reporting path for every other event');
});
