import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * parseNewsletterCreateResponse() dereferenced the response all the way down
 * with no guards at all:
 *
 *     name: thread.name.text,
 *     description: thread.description.text,
 *     picture: { id: thread.picture.id, directPath: thread.picture.direct_path },
 *     mute_state: viewer.mute
 *
 * A partial answer -- a newsletter with no description, or one whose viewer
 * metadata came back without `mute`, or a picture the server truncated -- throws
 * a TypeError out of newsletterCreate(). The caller gets an exception with no
 * statusCode and no reference to the response that produced it, and the
 * newsletter it just created is left in an unknown state from the caller's side.
 *
 * The contract: absence is read optionally where absence is normal, and a
 * response that cannot be read at all is a Boom with a statusCode.
 *
 * Each scenario runs in a child: a real socket against a local ws server leaves
 * the server handle and a timer behind, so an in-process file never exits.
 */
const BUILDER = `import { WebSocketServer } from 'ws';
import { DEFAULT_CONNECTION_CONFIG } from '/home/user/noddjs/Onigi/lib/Defaults/index.js';
import { makeNewsletterSocket } from '/home/user/noddjs/Onigi/lib/Socket/newsletter.js';

const creds = {
	noiseKey: { private: Buffer.alloc(32), public: Buffer.alloc(32, 1) },
	signedIdentityKey: { private: Buffer.alloc(32, 2), public: Buffer.alloc(32, 3) },
	signedPreKey: { keyId: 1, keyPair: { private: Buffer.alloc(32, 5), public: Buffer.alloc(32, 4) }, signature: Buffer.alloc(64) },
	advSecretKey: 'adv-secret',
	accountSyncCounter: 0,
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

/** boots a newsletter socket whose every w:mex query is answered with payload */
const createAnswering = async payload => {
	const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await new Promise(res => wss.once('listening', res));
	const sock = makeNewsletterSocket({
		...DEFAULT_CONNECTION_CONFIG,
		waWebSocketUrl: 'ws://127.0.0.1:' + wss.address().port + '/ws/chat',
		logger: noopLogger(),
		connectTimeoutMs: 600000,
		defaultQueryTimeoutMs: 600000,
		auth: { creds, keys },
		makeSignalRepository: signalRepo,
		fireInitQueries: false
	});
	await new Promise(res => {
		if (sock.ws.isOpen) { return res(); }
		sock.ws.once('open', res);
	});
	const origOn = sock.ws.on.bind(sock.ws);
	sock.ws.on = (event, ...rest) => {
		const registered = origOn(event, ...rest);
		if (typeof event === 'string' && event.startsWith('TAG:')) {
			// answer on the next turn: the emitter has to have the waiter attached first
			const id = event.slice(4);
			setTimeout(() => sock.ws.emit(event, {
				tag: 'iq',
				attrs: { type: 'result', id },
				content: [{ tag: 'result', attrs: {}, content: Buffer.from(JSON.stringify(payload), 'utf-8') }]
			}), 0);
		}
		return registered;
	};
	return {
		sock,
		done: async () => {
			try { await sock.end(new Error('test teardown')); } catch { }
			await new Promise(res => wss.close(res));
		}
	};
};
`;

const FULL = {
	data: {
		xwa2_newsletter_create: {
			id: '1234567890@newsletter',
			thread_metadata: {
				name: { text: 'Onigi' },
				creation_time: '1700000000',
				description: { text: 'a newsletter' },
				invite: 'INV',
				subscribers_count: '7',
				verification: 'VERIFIED',
				picture: { id: 'PIC', direct_path: '/p' }
			},
			viewer_metadata: { mute: 'off' }
		}
	}
};

/** runs newsletterCreate() against FULL as the body mutates it, and reports */
const scenario = (body) => `
${BUILDER}
const payload = (() => { const p = ${JSON.stringify(FULL)}; ${body}; return p; })();
const h = await createAnswering(payload);
const res = await h.sock.newsletterCreate('Onigi', 'a newsletter').then(
	r => 'OK ' + JSON.stringify(r),
	e => 'ERR ' + (e?.isBoom ? 'Boom' : (e?.name ?? 'none')) + ' ' + (e?.output?.statusCode ?? '-') + ' ' + e?.message
);
console.log('result=' + res);
await h.done();
process.exit(0);
`;

test('a complete newsletter create response still parses', async () => {
	const { code, stdout, stderr } = await runScenario(scenario(''));
	assert.equal(code, 0, stderr);
	assert.match(stdout, /"id":"1234567890@newsletter"/);
	assert.match(stdout, /"name":"Onigi"/);
	assert.match(stdout, /"description":"a newsletter"/);
	assert.match(stdout, /"id":"PIC"/);
	assert.match(stdout, /"mute_state":"off"/);
});

test('a response with no description parses instead of throwing', async () => {
	const { code, stdout, stderr } = await runScenario(scenario(
		'delete p.data.xwa2_newsletter_create.thread_metadata.description'
	));
	assert.equal(code, 0, stderr);
	assert.match(stdout, /result=OK /, 'a newsletter created with a null description is legitimate');
	assert.doesNotMatch(stdout, /description/, 'the absent description must not be invented');
});

test('a response with no viewer metadata parses instead of throwing', async () => {
	const { code, stdout, stderr } = await runScenario(scenario(
		'delete p.data.xwa2_newsletter_create.viewer_metadata'
	));
	assert.equal(code, 0, stderr);
	assert.match(stdout, /result=OK /);
	assert.doesNotMatch(stdout, /mute_state/);
});

test('a response with no picture parses instead of throwing', async () => {
	const { code, stdout, stderr } = await runScenario(scenario(
		'delete p.data.xwa2_newsletter_create.thread_metadata.picture'
	));
	assert.equal(code, 0, stderr);
	assert.match(stdout, /result=OK /);
	assert.doesNotMatch(stdout, /directPath/);
});

test('a response with no name is a Boom, not a TypeError', async () => {
	const { code, stdout, stderr } = await runScenario(scenario(
		'delete p.data.xwa2_newsletter_create.thread_metadata.name'
	));
	assert.equal(code, 0, stderr);
	// old: TypeError 'Cannot read properties of undefined (reading text)'
	assert.match(stdout, /result=ERR Boom 400 /);
	assert.doesNotMatch(stdout, /TypeError/);
});

test('a response with no thread_metadata at all is a Boom, not a TypeError', async () => {
	const { code, stdout, stderr } = await runScenario(scenario(
		'p.data.xwa2_newsletter_create = { id: "123@newsletter" }'
	));
	assert.equal(code, 0, stderr);
	// old: TypeError 'Cannot read properties of undefined (reading name)'
	assert.match(stdout, /result=ERR Boom 400 /);
	assert.doesNotMatch(stdout, /TypeError/);
});
