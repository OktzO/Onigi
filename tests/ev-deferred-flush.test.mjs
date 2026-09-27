import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEventBuffer } from '../lib/Utils/event-buffer.js';
import { flushBoomLogger, makeProbe, runChild, sleep, upsert } from './helpers/ev-flush-harness.mjs';

/*
 * attach() owns the rejected handler promise, so a failing handler is reported
 * on the synchronous path. The flush itself, though, is driven from three
 * setTimeout callbacks (event-buffer.js:93, :191, :207) that sit outside every
 * try/catch. A throw there has no promise to reject and no caller to catch it:
 * it is an uncaught exception in a timer callback and the host process dies.
 *
 * The trigger is config.logger again -- flush() calls logger.debug({ bufferCount })
 * before it emits anything, so a logger whose debug() throws reaches the deferred
 * flush with no user handler and no user event involved.
 *
 * Child process + exit code, for the same reason as tests/crash-53-*.mjs: an
 * in-process uncaughtException listener would suppress the very default under
 * test. The 30s auto-flush is covered in-process with mock timers, where
 * routing to the error channel is the observable contract.
 */

const assertSurvivedAndReported = ({ code, stdout, stderr }, what) => {
	assert.equal(code, 0, `${what} let the flush failure escape as an uncaught exception: ${stderr}`);
	assert.match(stdout, /survived/, `${what} killed the process: ${stderr}`);
	assert.match(stdout, /seen=\["logger\.debug is broken\|messages\.upsert"\]/, `${what} did not route the failure to the error channel`);
	assert.match(stdout, /released=\["a"\]/, `${what} stranded the buffered events`);
};

test('the 100ms debounced flush in createBufferedFunction cannot kill the process', async () => {
	// work() settles, bufferCount drops to 0, and the finally block arms
	// flushPendingTimeout -- the only timer that flushes in this shape.
	const { code, stdout, stderr } = await runChild(`
await ev.createBufferedFunction(async () => 'a')();
ev.emit('messages.upsert', upsert('a'));
await sleep(400);
ev.flush();
`);
	assertSurvivedAndReported({ code, stdout, stderr }, 'the debounced flush');
});

test('the 100ms single-buffer flush in createBufferedFunction cannot kill the process', async () => {
	// a second, still-pending buffer holds bufferCount at 1 when the first
	// timer fires, so that timer's own flush() is the one that throws
	const { code, stdout, stderr } = await runChild(`
await ev.createBufferedFunction(async () => 'a')();
const pending = ev.createBufferedFunction(() => sleep(400).then(() => 'b'));
pending();
ev.emit('messages.upsert', upsert('a'));
await sleep(600);
`);
	assertSurvivedAndReported({ code, stdout, stderr }, 'the single-buffer flush');
});

test('a failed 30s auto-flush is routed, not thrown, and strands nothing', async t => {
	const probe = makeProbe();
	t.mock.timers.enable({ apis: ['setTimeout'] });
	probe.ev.buffer();
	probe.ev.emit('messages.upsert', upsert('a'));
	t.mock.timers.tick(30000);
	assert.deepEqual(probe.seen, ['logger.debug is broken|messages.upsert'], 'the auto-flush failure must be routed, not thrown');
	// the batch is still buffered: isBuffering is only cleared by a flush that ran
	assert.equal(probe.ev.isBuffering(), true, 'a failed flush must leave the batch recoverable');
	assert.equal(probe.ev.flush(), true);
	assert.deepEqual(probe.released, ['a'], 'the events the failed flush could not release must not be lost');
	// a swallowed failure must not leave the re-armed 30s timer running forever
	t.mock.timers.tick(30000);
	assert.deepEqual(probe.seen, ['logger.debug is broken|messages.upsert'], 'the re-armed auto-flush must be cleared by the flush that followed it');
});

test('with no error listener a failed deferred flush is logged, not thrown', async () => {
	const logged = [];
	const logger = flushBoomLogger(msg => logged.push(msg));
	const eb = makeEventBuffer(logger);
	await eb.createBufferedFunction(async () => 'a')();
	eb.emit('messages.upsert', upsert('a'));
	await sleep(300);
	assert.deepEqual(logged, ['logger.debug is broken'], 'default behaviour is to log the failure');
	eb.destroy();
});

test('a buffer that flushes cleanly is unaffected by the guard', async () => {
	const quiet = { debug() { }, trace() { }, warn() { }, error() { } };
	const probe = makeProbe({ logger: quiet });
	await probe.ev.createBufferedFunction(async () => 'a')();
	probe.ev.emit('messages.upsert', upsert('a'));
	await sleep(300);
	assert.deepEqual(probe.seen, [], 'a flush that does not throw must not report anything');
	assert.deepEqual(probe.released, ['a'], 'the batch still flushes normally');
	probe.ev.destroy();
});
