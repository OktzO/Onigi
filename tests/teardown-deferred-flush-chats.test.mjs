import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * The history-sync state machine ends two of its branches with:
 *
 *     if (!willSyncHistory) {
 *         syncState = SyncState.Online;
 *         setTimeout(() => ev.flush(), 0);          // chats.js:1084
 *         return;
 *     }
 *     if (authState.creds.accountSyncCounter > 0) {
 *         syncState = SyncState.Online;
 *         setTimeout(() => ev.flush(), 0);          // chats.js:1093
 *         return;
 *     }
 *
 * A bare flush() inside a timer callback. Nothing in a timer has a caller to
 * throw to and no promise to reject, so a throw there is an uncaught exception
 * and the host process dies -- the same class 519eb1c fixed inside
 * event-buffer.js, in the three places that own the buffer. It just did not
 * reach the two places that only ask the buffer to flush.
 *
 * flush() logs logger.debug({ bufferCount }) before it emits anything, so a
 * config.logger -- a user supplied option -- whose debug() throws reaches both
 * sites with no library bug and no user handler, which is the same trigger
 * crash-53 uses on the synchronous path. Any other throw reachable from flush()
 * (consolidateEvents, an emit) dies the same way.
 *
 * The contract: a failing deferred flush is reported, not thrown.
 */
const BUILDER = `import { WebSocketServer } from 'ws';
import { DEFAULT_CONNECTION_CONFIG } from '/home/user/noddjs/Onigi/lib/Defaults/index.js';
import { makeChatsSocket } from '/home/user/noddjs/Onigi/lib/Socket/chats.js';

const creds = {
	noiseKey: { private: Buffer.alloc(32), public: Buffer.alloc(32, 1) },
	signedIdentityKey: { private: Buffer.alloc(32, 2), public: Buffer.alloc(32, 3) },
	signedPreKey: { keyId: 1, keyPair: { private: Buffer.alloc(32, 5), public: Buffer.alloc(32, 4) }, signature: Buffer.alloc(64) },
	advSecretKey: 'adv-secret',
	accountSyncCounter: 1,
	counter: 0,
	me: { id: '12345:1@s.whatsapp.net', lid: '12345:1@lid', name: 'probe' },
	registered: true,
	pairingCode: 'ABCDEFGH'
};
const map = new Map();
const keys = {
	get: async (t, ids) => { const v = map.get(t); if (ids === undefined) { return v; } const o = {}; for (const i of ids) { o[i] = v?.[i]; } return o; },
	set: async d => { for (const [k, v] of Object.entries(d)) { map.set(k, v); } },
	del: async k => { map.delete(k); },
	bind: async fn => fn({ get: this.get, set: this.set, del: this.del })
};
const signalRepo = () => new Proxy({
	lidMapping: { storeLIDPNMappings: async () => { }, getPNForLID: async () => null, getLIDForPN: async () => null },
	close: () => { }
}, { get: (t, p) => (p in t ? t[p] : async () => undefined) });

const boot = async (over = {}, breakDebug = true) => {
	const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await new Promise(res => wss.once('listening', res));
	const logger = noopLogger();
	// flush() logs logger.debug({ bufferCount }, 'Flushing event buffer') as its
	// first statement, so this reaches the deferred flush and nothing else
	const realDebug = logger.debug;
	logger.debug = (...args) => {
		if (breakDebug && args[0] && typeof args[0] === 'object' && 'bufferCount' in args[0]) {
			throw new Error('logger.debug is broken');
		}
		return realDebug(...args);
	};
	const sock = makeChatsSocket({
		...DEFAULT_CONNECTION_CONFIG,
		waWebSocketUrl: 'ws://127.0.0.1:' + wss.address().port + '/ws/chat',
		logger,
		connectTimeoutMs: 600000,
		defaultQueryTimeoutMs: 600000,
		auth: { creds, keys },
		makeSignalRepository: signalRepo,
		fireInitQueries: false,
		...over
	});
	await new Promise(res => {
		if (sock.ws.isOpen) { return res(); }
		sock.ws.once('open', res);
	});
	await tick(50);
	return { sock, logger, wss };
};`;

test('the deferred flush when history sync is disabled cannot kill the process', async () => {
	const { code, stdout, stderr } = await runScenario(`
${BUILDER}
const h = await boot({ shouldSyncHistoryMessage: () => false });
h.sock.ev.emit('connection.update', { receivedPendingNotifications: true });
await tick(300);
console.log('survived');
process.exit(0);
`);
	// the uncaught-exception class of bug: only the child's exit code is faithful
	assert.equal(code, 0, `the deferred flush escaped: ${stderr}`);
	assert.match(stdout, /survived/);
});

test('the deferred flush on a reconnection cannot kill the process', async () => {
	const { code, stdout, stderr } = await runScenario(`
${BUILDER}
// accountSyncCounter > 0 in the fixture, and history sync is enabled, so this
// takes the second branch
const h = await boot();
h.sock.ev.emit('connection.update', { receivedPendingNotifications: true });
await tick(300);
console.log('survived');
process.exit(0);
`);
	assert.equal(code, 0, `the deferred flush escaped: ${stderr}`);
	assert.match(stdout, /survived/);
});

test('a failing deferred flush is reported on the error channel', async () => {
	const { code, stdout, stderr } = await runScenario(`
${BUILDER}
const h = await boot({ shouldSyncHistoryMessage: () => false });
const errs = [];
h.sock.ev.on('error', err => errs.push(String(err?.message)));
h.sock.ev.emit('connection.update', { receivedPendingNotifications: true });
await tick(300);
console.log('reported=' + JSON.stringify(errs));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /reported=\["logger\.debug is broken/);
});

test('with no error listener a failing deferred flush is logged, not thrown', async () => {
	const { code, stdout, stderr } = await runScenario(`
${BUILDER}
const h = await boot({ shouldSyncHistoryMessage: () => false });
// the same logger whose debug() throws, but logger.error() is what a failing
// handler reports through
const reported = [];
h.logger.error = (...args) => { reported.push(String(args[1])); };
h.sock.ev.emit('connection.update', { receivedPendingNotifications: true });
await tick(300);
console.log('reported=' + JSON.stringify(reported));
console.log('survived');
process.exit(0);
`);
	assert.equal(code, 0, `the deferred flush escaped: ${stderr}`);
	assert.match(stdout, /survived/);
	assert.match(stdout, /reported=\["/);
});

test('a deferred flush that succeeds still releases the batch', async () => {
	const { code, stdout, stderr } = await runScenario(`${BUILDER}
// breakDebug off: this is the path the guard must not change
const h = await boot({ shouldSyncHistoryMessage: () => false }, false);
const flushed = [];
h.sock.ev.on('messages.upsert', e => flushed.push(e.messages.length));
// the state machine buffers and schedules the flush on the next macrotask, so
// the burst has to be emitted before that
h.sock.ev.emit('connection.update', { receivedPendingNotifications: true });
h.sock.ev.emit('messages.upsert', {
	messages: [{ key: { id: 'MSG1', remoteJid: '99999:1@s.whatsapp.net', fromMe: false }, messageTimestamp: 1 }],
	type: 'notify'
});
await tick(300);
console.log('flushed=' + JSON.stringify(flushed));
console.log('isBuffering=' + h.sock.ev.isBuffering());
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /flushed=\[1\]/, 'the deferred flush must still release the batch');
	assert.match(stdout, /isBuffering=false/);
});
