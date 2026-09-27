import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeEventBuffer } from '../lib/Utils/event-buffer.js';

const execFileAsync = promisify(execFile);
const noopLogger = { debug() {}, trace() {}, warn() {}, error() {} };
const msg = (id, jid) => ({
	key: { remoteJid: jid, id, fromMe: false },
	messageTimestamp: 1,
	message: { conversation: id }
});
const upsert = (id) => ({ messages: [msg(id, '1@s')], type: 'notify' });
const tick = () => new Promise(resolve => setImmediate(resolve));

const captureUnhandled = (t, sink) => {
	const listener = (err) => sink.push(err);
	process.on('unhandledRejection', listener);
	t.after(() => process.off('unhandledRejection', listener));
	return sink;
};

test('rejected async process handler reaches the error event, not unhandledRejection', async t => {
	const unhandled = captureUnhandled(t, []);
	const eb = makeEventBuffer(noopLogger);
	const seen = [];
	eb.on('error', (err, events) => seen.push([err.message, events]));
	eb.process(async () => { throw new Error('db.save failed'); });
	eb.emit('messages.upsert', upsert('a'));
	await tick();
	assert.deepEqual(unhandled, [], 'handler rejection must not surface as an unhandledRejection');
	assert.deepEqual(seen, [['db.save failed', ['messages.upsert']]]);
});

test('rejected async on() handler reaches the error event, not unhandledRejection', async t => {
	const unhandled = captureUnhandled(t, []);
	const eb = makeEventBuffer(noopLogger);
	const seen = [];
	eb.on('error', (err, events) => seen.push([err.message, events]));
	eb.on('messages.upsert', async () => { throw new Error('consumer boom'); });
	eb.emit('messages.upsert', upsert('a'));
	await tick();
	assert.deepEqual(unhandled, [], 'handler rejection must not surface as an unhandledRejection');
	assert.deepEqual(seen, [['consumer boom', ['messages.upsert']]]);
});

test('synchronous handler throw does not escape emit() or flush()', async t => {
	const unhandled = captureUnhandled(t, []);
	const eb = makeEventBuffer(noopLogger);
	const seen = [];
	eb.on('error', (err, events) => seen.push([err.message, events]));
	eb.on('messages.upsert', () => { throw new Error('sync handler boom'); });
	eb.buffer();
	assert.doesNotThrow(() => {
		eb.emit('messages.upsert', upsert('a'));
		eb.flush();
	}, 'sync throw must not escape the buffer');
	assert.deepEqual(unhandled, []);
	assert.deepEqual(seen, [['sync handler boom', ['messages.upsert']]]);
});

test('synchronous process handler throw does not escape flush()', async t => {
	const unhandled = captureUnhandled(t, []);
	const eb = makeEventBuffer(noopLogger);
	const seen = [];
	eb.on('error', (err, events) => seen.push([err.message, events]));
	eb.process(() => { throw new Error('sync process boom'); });
	eb.buffer();
	eb.emit('messages.upsert', upsert('a'));
	assert.doesNotThrow(() => eb.flush());
	assert.deepEqual(unhandled, []);
	assert.deepEqual(seen, [['sync process boom', ['messages.upsert']]]);
});

test('handler failure with no error listener logs instead of throwing', async t => {
	captureUnhandled(t, []);
	const logged = [];
	const eb = makeEventBuffer({ ...noopLogger, error: (...args) => logged.push(args) });
	eb.process(async () => { throw new Error('db.save failed'); });
	eb.buffer();
	assert.doesNotThrow(() => {
		eb.emit('messages.upsert', upsert('a'));
		eb.flush();
	});
	await tick();
	assert.equal(logged.length, 1, 'default behaviour is to log the failure');
	assert.equal(logged[0][0].err.message, 'db.save failed');
});

test('a failing async process handler does not kill the host process', async () => {
	const moduleUrl = new URL('../lib/Utils/event-buffer.js', import.meta.url).href;
	const script = `
import { makeEventBuffer } from ${JSON.stringify(moduleUrl)};
const logger = {
	debug() {}, trace() {}, warn() {},
	error: (...args) => process.stderr.write('LOGGED ' + args.map(String).join(' ') + '\\n')
};
const ev = makeEventBuffer(logger);
ev.process(async () => { throw new Error('db.save failed'); });
ev.emit('messages.upsert', {
	messages: [{ key: { remoteJid: '1@s', id: 'a', fromMe: false } }], type: 'notify'
});
await new Promise(resolve => setTimeout(resolve, 100));
console.log('survived');
`;
	let stdout = '';
	let stderr = '';
	let code = 0;
	try {
		const res = await execFileAsync(process.execPath, ['--input-type=module', '-e', script]);
		stdout = res.stdout;
		stderr = res.stderr;
	}
	catch (err) {
		code = err.code;
		stderr = err.stderr;
	}
	assert.equal(code, 0, `host process died: ${stderr}`);
	assert.match(stdout, /survived/);
	assert.match(stderr, /LOGGED .*messages\.upsert/, 'default behaviour is to log');
});
