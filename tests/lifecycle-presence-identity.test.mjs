import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * sendPresenceUpdate() picked the own-identity attribute off a jid it had just
 * decoded, with no guards:
 *
 *     const me = authState.creds.me;                    // undefined before pairing
 *     ...
 *     if (!me.name) { ... }                             // TypeError when me is undefined
 *     ...
 *     const { server } = jidDecode(toJid);
 *     const isLid = server === 'lid';                   // excludes @hosted.lid
 *     await sendNode({ tag: 'chatstate', attrs: { from: isLid ? me.lid : me.id, to: toJid }, ... });
 *
 * Three separate failures, all in the one function that announces this
 * connection to the rest of the account:
 *
 *  - creds.me is undefined until the device pairs, so the very first presence
 *    update a fresh device sends is a TypeError rather than a warning;
 *  - `server === 'lid'` is false for a @hosted.lid recipient, so a chatstate to
 *    a hosted-LID peer is sent from the PN identity. Every other identity check
 *    in this file is `isLidUser(jid) || isHostedLidUser(jid)` (:287, :561, :649);
 *  - me.lid is unset until CB:success carries a lid, so `from: me.lid` is
 *    undefined, binaryNodeToString drops undefined attrs, the encoder omits the
 *    attribute, and the server discards the stanza.
 *
 * The trace log is the observation point: sendNode() logs
 * binaryNodeToString(frame) at logger.level === 'trace', and that function
 * filters undefined attrs -- so the stanza as the encoder will see it is exactly
 * what the log shows.
 *
 * Each scenario runs in a child: a real socket against a local ws server leaves
 * the server handle and a timer behind, so an in-process file never exits.
 */
const BUILDER = `import { WebSocketServer } from 'ws';
import { DEFAULT_CONNECTION_CONFIG } from '/home/user/noddjs/Onigi/lib/Defaults/index.js';
import { makeChatsSocket } from '/home/user/noddjs/Onigi/lib/Socket/chats.js';

const credsWith = me => ({
	noiseKey: { private: Buffer.alloc(32), public: Buffer.alloc(32, 1) },
	signedIdentityKey: { private: Buffer.alloc(32, 2), public: Buffer.alloc(32, 3) },
	signedPreKey: { keyId: 1, keyPair: { private: Buffer.alloc(32, 5), public: Buffer.alloc(32, 4) }, signature: Buffer.alloc(64) },
	advSecretKey: 'adv-secret',
	accountSyncCounter: 0,
	counter: 0,
	me,
	registered: !!me,
	pairingCode: 'ABCDEFGH'
});
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

const chatstateFor = async (me, to) => {
	const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await new Promise(res => wss.once('listening', res));
	const logger = noopLogger();
	logger.level = 'trace';
	const sock = makeChatsSocket({
		...DEFAULT_CONNECTION_CONFIG,
		waWebSocketUrl: 'ws://127.0.0.1:' + wss.address().port + '/ws/chat',
		logger,
		connectTimeoutMs: 600000,
		defaultQueryTimeoutMs: 600000,
		auth: { creds: credsWith(me), keys },
		makeSignalRepository: signalRepo,
		fireInitQueries: false
	});
	await new Promise(res => {
		if (sock.ws.isOpen) { return res(); }
		sock.ws.once('open', res);
	});
	await tick(50);
	logger.logs.length = 0;
	const outcome = await sock.sendPresenceUpdate('composing', to).then(
		() => 'resolved',
		e => 'rejected ' + e?.name
	);
	const sent = logger.logs
		.filter(l => l[1]?.msg === 'xml send')
		.map(l => String(l[1]?.xml))
		.filter(x => x.includes('<chatstate') || x.includes('<presence'));
	await sock.end(new Error('test teardown'));
	await new Promise(res => wss.close(res));
	return { outcome, sent };
};
const ME = { id: '11111:1@s.whatsapp.net', lid: '11111:1@lid', name: 'probe' };`;

const withMe = (meLiteral, to) => `
${BUILDER}
const { outcome, sent } = await chatstateFor(${meLiteral}, '${to}');
console.log('outcome=' + outcome);
console.log('sent=' + JSON.stringify(sent));
process.exit(0);
`;

test('a chatstate to a @lid peer is sent from the LID identity', async () => {
	const { code, stdout, stderr } = await runScenario(withMe('ME', '99999:1@lid'));
	assert.equal(code, 0, stderr);
	assert.match(stdout, /sent=\["<chatstate from='11111:1@lid'/);
});

test('a chatstate to a @hosted.lid peer is sent from the LID identity too', async () => {
	const { code, stdout, stderr } = await runScenario(`
${BUILDER}
const { isHostedLidUser, isLidUser } = await import('/home/user/noddjs/Onigi/lib/WABinary/index.js');
console.log('hostedIsLid=' + isHostedLidUser('99999:1@hosted.lid'));
console.log('hostedIsNotLid=' + !isLidUser('99999:1@hosted.lid'));
const { outcome, sent } = await chatstateFor(ME, '99999:1@hosted.lid');
console.log('outcome=' + outcome);
console.log('sent=' + JSON.stringify(sent));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /hostedIsLid=true/, 'fixture assumption');
	assert.match(stdout, /hostedIsNotLid=true/, 'fixture assumption');
	// old: server === 'lid' is false here, so this went out from the PN
	assert.match(stdout, /sent=\["<chatstate from='11111:1@lid'/);
});

test('a chatstate to a PN peer is sent from the PN identity', async () => {
	const { code, stdout, stderr } = await runScenario(withMe('ME', '99999:1@s.whatsapp.net'));
	assert.equal(code, 0, stderr);
	assert.match(stdout, /sent=\["<chatstate from='11111:1@s\.whatsapp\.net'/);
});

test('a chatstate sent before the server gave us a lid still carries a from', async () => {
	const { code, stdout, stderr } = await runScenario(
		withMe("{ id: '11111:1@s.whatsapp.net', name: 'probe' }", '99999:1@lid')
	);
	assert.equal(code, 0, stderr);
	// old: from: me.lid === undefined, which the trace filter and the encoder
	// both drop, leaving a chatstate with no from at all
	assert.match(stdout, /sent=\["<chatstate from='11111:1@s\.whatsapp\.net'/);
});

test('an available presence before pairing is a warning, not a TypeError', async () => {
	const { code, stdout, stderr } = await runScenario(`
${BUILDER}
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(res => wss.once('listening', res));
const logger = noopLogger();
logger.level = 'trace';
const sock = makeChatsSocket({
	...DEFAULT_CONNECTION_CONFIG,
	waWebSocketUrl: 'ws://127.0.0.1:' + wss.address().port + '/ws/chat',
	logger,
	connectTimeoutMs: 600000,
	defaultQueryTimeoutMs: 600000,
	auth: { creds: credsWith(undefined), keys },
	makeSignalRepository: signalRepo,
	fireInitQueries: false
});
await new Promise(res => {
	if (sock.ws.isOpen) { return res(); }
	sock.ws.once('open', res);
});
await tick(50);
logger.logs.length = 0;
const outcome = await sock.sendPresenceUpdate('available').then(() => 'resolved', e => 'rejected ' + e?.name);
const sent = logger.logs.filter(l => l[1]?.msg === 'xml send').map(l => String(l[1]?.xml));
console.log('outcome=' + outcome);
console.log('sent=' + JSON.stringify(sent));
await sock.end(new Error('test teardown'));
await new Promise(res => wss.close(res));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /outcome=resolved/, 'creds.me is undefined until the device pairs');
	assert.match(stdout, /sent=\[\]/, 'a presence with no name must not be sent');
});

test('a composing presence before pairing is a warning, not a TypeError', async () => {
	const { code, stdout, stderr } = await runScenario(`
${BUILDER}
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(res => wss.once('listening', res));
const logger = noopLogger();
logger.level = 'trace';
const sock = makeChatsSocket({
	...DEFAULT_CONNECTION_CONFIG,
	waWebSocketUrl: 'ws://127.0.0.1:' + wss.address().port + '/ws/chat',
	logger,
	connectTimeoutMs: 600000,
	defaultQueryTimeoutMs: 600000,
	auth: { creds: credsWith(undefined), keys },
	makeSignalRepository: signalRepo,
	fireInitQueries: false
});
await new Promise(res => {
	if (sock.ws.isOpen) { return res(); }
	sock.ws.once('open', res);
});
await tick(50);
logger.logs.length = 0;
const outcome = await sock.sendPresenceUpdate('composing', '99999:1@s.whatsapp.net').then(() => 'resolved', e => 'rejected ' + e?.name);
const sent = logger.logs.filter(l => l[1]?.msg === 'xml send').map(l => String(l[1]?.xml));
console.log('outcome=' + outcome);
console.log('sent=' + JSON.stringify(sent));
await sock.end(new Error('test teardown'));
await new Promise(res => wss.close(res));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /outcome=resolved/, 'creds.me is undefined until the device pairs');
	assert.doesNotMatch(stdout, /<chatstate/, 'a chatstate with no own identity must not be sent');
});
