import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeEventBuffer } from '../lib/Utils/event-buffer.js';

import { makeProbe, sleep, upsert } from './helpers/ev-flush-harness.mjs';

/*
 * reportError's fallback -- logger.error at the end of the reporter -- was the
 * one call on that path that was not wrapped:
 *
 *     try { ev.emit('error', err, events); return; }
 *     catch (emitErr) { err = emitErr; }
 *     logger.error({ err }, ...);              // :50, unguarded
 *
 * reportError is reached from onDeferredFlush, and onDeferredFlush runs from the
 * three setTimeout callbacks that drive the buffer (:56, :219, :239). A timer
 * callback has no caller to throw to and no promise to reject, so a throwing
 * logger there is an uncaughtException and the host process dies.
 *
 * config.logger is a user supplied option, and the flush logs before it emits
 * anything, so this needs no user handler and no user event: a logger whose
 * debug() throws reaches the reporter, and if its error() throws as well -- a
 * broken/misconfigured sink, the classic case -- the report is what kills the
 * process that the guard was written to save. 519eb1c/6890b55 routed the failure
 * onto the error channel and stopped there.
 *
 * Child process + exit code for the timer paths: an in-process
 * uncaughtException listener would suppress the very default under test.
 */

const execFileAsync = promisify(execFile);
const bufferUrl = new URL('../lib/Utils/event-buffer.js', import.meta.url).href;

const runChild = async (loggerBody, body) => {
	const script = `
import { makeEventBuffer } from ${JSON.stringify(bufferUrl)};
const logger = ${loggerBody};
const ev = makeEventBuffer(logger);
${body}
await new Promise(resolve => setTimeout(resolve, 400));
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

const assertSurvived = ({ code, stdout, stderr }, what) => {
	assert.equal(code, 0, `${what} let the report escape as an uncaught exception: ${stderr}`);
	assert.match(stdout, /survived/, `${what} killed the process: ${stderr}`);
};

// The maximally hostile logger for the *deferred flush* path: flush()'s debug
// throws, and so do trace() (last line of flush), warn() (the 30s auto-flush
// callback) and error() (the reporter's fallback). debug() is left alone for
// every other call shape on purpose -- buffer()'s own
// logger.debug('Event buffer activated') is reached from a function the user
// awaited, so a logger that throws there is a different defect than this one.
const HOSTILE = `{
	debug: (a) => { if (a && typeof a === 'object' && 'bufferCount' in a) throw new Error('debug sink is gone'); },
	trace() { throw new Error('trace sink is gone'); },
	info() {},
	warn() { throw new Error('warn sink is gone'); },
	error() { throw new Error('error sink is gone'); }
}`;

// Same logger with a working trace()/warn(), to isolate the reporter's own
// fallback as the escaping call.
const ERROR_SINK_ONLY = `{
	debug: (a) => { if (a && typeof a === 'object' && 'bufferCount' in a) throw new Error('debug sink is gone'); },
	trace() {},
	info() {},
	warn() {},
	error() { throw new Error('error sink is gone'); }
}`;

test('a throwing error() sink cannot kill the process from the debounced flush', async () => {
	const r = await runChild(ERROR_SINK_ONLY, `
await ev.createBufferedFunction(async () => 'a')();
ev.emit('messages.upsert', { messages: [{ key: { remoteJid: '1@s', id: 'a', fromMe: false } }], type: 'notify' });
await new Promise(r2 => setTimeout(r2, 300));
`);
	assertSurvived(r, 'the debounced flush');
});

test('a throwing error() sink cannot kill the process from the single-buffer flush', async () => {
	const r = await runChild(ERROR_SINK_ONLY, `
await ev.createBufferedFunction(async () => 'a')();
ev.createBufferedFunction(() => new Promise(r2 => setTimeout(r2, 400)).then(() => 'b'))();
ev.emit('messages.upsert', { messages: [{ key: { remoteJid: '1@s', id: 'a', fromMe: false } }], type: 'notify' });
`);
	assertSurvived(r, 'the single-buffer flush');
});

test('a logger whose every deferred-flush sink throws cannot kill the process', async () => {
	const r = await runChild(HOSTILE, `
await ev.createBufferedFunction(async () => 'a')();
ev.emit('messages.upsert', { messages: [{ key: { remoteJid: '1@s', id: 'a', fromMe: false } }], type: 'notify' });
await new Promise(r2 => setTimeout(r2, 300));
`);
	assertSurvived(r, 'a logger with no working sink on the deferred path');
});

test('a throwing warn() in the 30s auto-flush is reported, not thrown', async t => {
	// The 30s callback is onDeferredFlush(() => { if (isBuffering) { logger.warn(...);
	// return flush(); } }), so the warn is inside the guard -- but only the guard:
	// with logger.error also throwing, the *report* was the thing that escaped.
	const logger = {
		debug: (a) => { if (a && typeof a === 'object' && 'bufferCount' in a) throw new Error('debug sink is gone'); },
		warn() { throw new Error('warn sink is gone'); },
		trace() { throw new Error('trace sink is gone'); },
		error() { throw new Error('error sink is gone'); }
	};
	const ev = makeEventBuffer(logger);
	t.mock.timers.enable({ apis: ['setTimeout'] });
	ev.buffer();
	ev.emit('messages.upsert', upsert('a'));
	assert.doesNotThrow(() => t.mock.timers.tick(30000), 'a broken warn() in the auto-flush must not escape the timer');
	assert.equal(ev.isBuffering(), true, 'a failed flush must leave the batch recoverable');
	t.mock.timers.reset();
});

test('a throwing error() sink does not turn a handler failure into a library failure', async () => {
	const ev = makeEventBuffer({ debug() {}, trace() {}, warn() {}, error() { throw new Error('error sink is gone'); } });
	ev.on('messages.upsert', () => { throw new Error('handler boom'); });
	ev.buffer();
	// The user handler failed, and the library is the caller's frame here: a
	// broken logger must not make emit() throw at the caller.
	assert.doesNotThrow(() => {
		ev.emit('messages.upsert', upsert('a'));
		ev.flush();
	});
	await sleep(20);
	ev.destroy();
});

test('a failed flush is still reported on the error channel when the logger also throws', async () => {
	const seen = [];
	const probe = makeProbe({ logger: { debug() { }, trace() { }, warn() { }, error() { throw new Error('error sink is gone'); } } });
	probe.ev.removeAllListeners('error');
	probe.ev.on('error', (err, events) => seen.push(err.message));
	probe.ev.on('messages.upsert', () => { throw new Error('handler boom'); });
	probe.ev.buffer();
	probe.ev.emit('messages.upsert', upsert('a'));
	probe.ev.flush();
	await sleep(20);
	assert.deepEqual(seen, ['handler boom'], 'the error channel is the reporting path and a throwing logger must not divert it');
	probe.ev.destroy();
});
