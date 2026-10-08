import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, tick } from './helpers/ev-socket-harness.mjs';

/*
 * Two independent defects on the media path, both rooted in the same place:
 * refreshMediaConn() talks to the socket twice, and neither read of it was safe.
 *
 * (a) While readyState is CONNECTING, ws.isOpen is false, so query() threw
 *     Boom('Connection Closed') before the first byte went out -- and a fresh
 *     connection that has not opened yet has no 'close' event and no reconnect
 *     to recover from it (issue #2821). The media fetch has to wait for 'open'
 *     like every other handshake-aware step.
 *
 * (b) `const media = await mediaConn` re-awaited whatever promise was cached,
 *     including one that had already REJECTED. mediaConn was assigned the
 *     fetching IIFE, so a single transient media_conn failure (a dropped
 *     socket, an error iq) left a rejected promise in the slot forever: every
 *     later upload rethrew it and media stayed dead for the rest of the socket's
 *     life, with no way to retry short of reconnecting.
 *
 * Both scenarios run in a child process (the harness leaves the ws server handle
 * and timers behind) and print the outcome as key=value for the parent.
 */
const lib = rel => JSON.stringify(new URL(rel, import.meta.url).href);

/** reports RESOLVED/REJECTED for a promise, plus the statusCode when it rejected */
const REPORT = `const report = p => p.then(
	v => 'RESOLVED ' + (v?.hosts?.[0]?.hostname ?? JSON.stringify(v)),
	e => 'REJECTED ' + (e?.output?.statusCode) + ' ' + (e?.message)
);`;

/** a media_conn iq result, as the server answers the w:m set */
const MEDIA_CONN_RESULT = `const mediaConnResult = id => ({
	tag: 'iq',
	attrs: { type: 'result', id, from: 's.whatsapp.net' },
	content: [{
		tag: 'media_conn',
		attrs: { ttl: '604800', auth: 'AUTH-TOKEN' },
		content: [{ tag: 'host', attrs: { hostname: 'mmg.whatsapp.net', maxContentLengthBytes: '15728640' } }]
	}]
});`;

/**
 * Boots makeWASocket against a server that holds the HTTP upgrade back for
 * `delayMs`. The client's socket is therefore still CONNECTING right after the
 * socket is built -- a fresh connection, nothing to reconnect from.
 */
const DELAYED_BOOT = `import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import makeWASocket from ${lib('../lib/Socket/index.js')};
import { DEFAULT_CONNECTION_CONFIG } from ${lib('../lib/Defaults/index.js')};

const creds = () => ({
	noiseKey: { private: Buffer.alloc(32), public: Buffer.alloc(32, 1) },
	signedIdentityKey: { private: Buffer.alloc(32, 2), public: Buffer.alloc(32, 3) },
	signedPreKey: { keyId: 1, public: Buffer.alloc(32, 4), private: Buffer.alloc(32, 5) },
	advSecretKey: 'adv-secret',
	accountSyncCounter: 0,
	counter: 0,
	me: { id: '12345:1@s.whatsapp.net', lid: '12345:1@lid', name: 'probe' },
	registered: true,
	pairingCode: 'ABCDEFGH'
});

const keyStore = () => {
	const map = new Map();
	return {
		get: async (type, ids) => {
			const v = map.get(type);
			if (ids === undefined) { return v; }
			return ids.map(id => (Array.isArray(v) ? v[id] : v?.[id]));
		},
		set: async d => { for (const [k, v] of Object.entries(d)) { map.set(k, v); } },
		del: async k => { map.delete(k); },
		bind: async fn => fn({ get: this.get, set: this.set, del: this.del })
	};
};

const signalRepoStub = () => new Proxy({
	lidMapping: {
		storeLIDPNMappings: async () => { },
		getPNForLID: async () => null,
		getLIDForPN: async () => null
	},
	migrateSession: async () => { },
	decryptMessage: async () => { throw new Error('not used'); },
	encryptMessage: async () => { throw new Error('not used'); },
	close: () => { }
}, {
	get: (target, prop) => (prop in target ? target[prop] : async () => undefined)
});

const quietLogger = () => {
	const rec = level => () => { };
	return { level: 'silent', trace: rec(), debug: rec(), info: rec(), warn: rec(), error: rec(), child() { return this; } };
};

const startDelayedSocket = async delayMs => {
	const wss = new WebSocketServer({ noServer: true });
	const server = http.createServer();
	server.on('upgrade', (req, socket, head) => {
		setTimeout(() => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)), delayMs);
	});
	await new Promise(res => server.listen(0, '127.0.0.1', res));
	let conns = 0;
	wss.on('connection', () => { conns++; });
	const sock = makeWASocket({
		...DEFAULT_CONNECTION_CONFIG,
		waWebSocketUrl: 'ws://127.0.0.1:' + server.address().port + '/ws/chat',
		logger: quietLogger(),
		connectTimeoutMs: 600000,
		defaultQueryTimeoutMs: 600000,
		auth: { creds: creds(), keys: keyStore() },
		makeSignalRepository: signalRepoStub,
		fireInitQueries: false
	});
	// the raw socket the client will keep; a reconnect would replace it
	const raw = sock.ws.socket;
	return { sock, raw, conns: () => conns };
};

/** records the query tags waitForMessage parks on, so a scenario can answer them */
const captureTags = ws => {
	const tags = [];
	const origOn = ws.on.bind(ws);
	ws.on = (event, fn) => {
		if (String(event).startsWith('TAG:')) { tags.push(String(event)); }
		return origOn(event, fn);
	};
	return tags;
};

const settled = async (read, ms = 5000) => {
	const end = Date.now() + ms;
	while (read() === 'pending' && Date.now() < end) { await tick(20); }
	return read();
};`;

test('a media_conn fetch during CONNECTING waits for open instead of throwing', async () => {
	const { code, stdout, stderr } = await runScenario(`
${DELAYED_BOOT}
${MEDIA_CONN_RESULT}
${REPORT}
const { sock, raw, conns } = await startDelayedSocket(600);
const tags = captureTags(sock.ws);
let sends = 0;
const rawSend = raw.send.bind(raw);
raw.send = (data, cb) => { sends++; return rawSend(data, cb); };
let outcome = 'pending';
sock.refreshMediaConn().then(
	v => { outcome = 'RESOLVED ' + (v?.hosts?.[0]?.hostname ?? JSON.stringify(v)); },
	e => { outcome = 'REJECTED ' + (e?.output?.statusCode) + ' ' + (e?.message); }
);
console.log('readyState=' + sock.ws.socket.readyState);
console.log('isOpen=' + sock.ws.isOpen);
await tick(150);
console.log('duringConnecting=' + outcome);
console.log('sendsDuringConnecting=' + sends);
await new Promise(res => sock.ws.once('open', res));
console.log('atOpen=' + outcome);
await tick(50);
console.log('sendsAfterOpen=' + sends);
const tag = tags[tags.length - 1];
console.log('waiterRegistered=' + (tag ? 'yes' : 'no'));
if (tag) { sock.ws.emit(tag, mediaConnResult(tag.slice(4))); }
console.log('afterOpen=' + await settled(() => outcome));
console.log('sameSocket=' + (sock.ws.socket === raw));
console.log('isOpenAfter=' + sock.ws.isOpen);
console.log('serverConns=' + conns());
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	// the fetch was issued while readyState was CONNECTING (0)
	assert.match(stdout, /readyState=0/);
	assert.match(stdout, /isOpen=false/);
	// the old shape: query() threw before the first byte, so this is a rejection
	assert.match(stdout, /duringConnecting=pending/, 'the fetch must wait for open, not throw');
	assert.match(stdout, /sendsDuringConnecting=0/, 'nothing may go out while the socket is CONNECTING');
	assert.match(stdout, /atOpen=pending/, 'the fetch must still be waiting right after open');
	assert.match(stdout, /sendsAfterOpen=[1-9]/, 'the media_conn query never reached the wire');
	assert.match(stdout, /waiterRegistered=yes/);
	assert.match(stdout, /afterOpen=RESOLVED mmg\.whatsapp\.net/);
	// no reconnect was needed: same socket, still open, one server-side connection
	assert.match(stdout, /sameSocket=true/);
	assert.match(stdout, /isOpenAfter=true/);
	assert.match(stdout, /serverConns=1/);
});

test('one failed media_conn query does not disable media for the socket', async () => {
	const { code, stdout, stderr } = await runScenario(`
${REPORT}
${MEDIA_CONN_RESULT}
const h = await startHarness();
const sock = h.sock;
const tags = [];
const origOn = sock.ws.on.bind(sock.ws);
sock.ws.on = (event, fn) => {
	if (String(event).startsWith('TAG:')) { tags.push(String(event)); }
	return origOn(event, fn);
};
// the first fetch dies on the wire -- a dropped connection, an error iq -- and
// leaves the socket perfectly usable, which is the whole point of the bug
const rawSend = sock.ws.socket.send.bind(sock.ws.socket);
sock.ws.socket.send = (_data, cb) => { setTimeout(() => cb(new Error('transient send failure')), 0); };
console.log('first=' + await report(sock.refreshMediaConn()));
sock.ws.socket.send = rawSend;
console.log('socketStillOpen=' + sock.ws.isOpen);
// the next upload goes out on the same socket; the report is attached up front
// so a rejected fetch is this scenario's finding, not an unhandled rejection
const second = report(sock.refreshMediaConn());
await tick(30);
const tag = tags[tags.length - 1];
if (tag) { sock.ws.emit(tag, mediaConnResult(tag.slice(4))); }
console.log('second=' + await second);
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	// the first attempt's error still belongs to the caller that made it
	assert.match(stdout, /first=REJECTED undefined transient send failure/);
	assert.match(stdout, /socketStillOpen=true/);
	// old shape: the cached rejection is rethrown here, forever
	assert.match(stdout, /second=RESOLVED mmg\.whatsapp\.net/);
});