import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONNECTION_CONFIG } from '../lib/Defaults/index.js';
import { makeNewsletterSocket } from '../lib/Socket/newsletter.js';
import { noopLogger } from './helpers/ev-socket-harness.mjs';

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
 * statusCode and no indication of what the server actually said, and the
 * newsletter it just created is left in an unknown state from the caller's side.
 *
 * The contract: a partial response is a bad response, reported as a Boom with a
 * statusCode, not a TypeError.
 */
const credsFixture = () => ({
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
}, { get: (target, prop) => (prop in target ? target[prop] : async () => undefined) });

/** builds a newsletter socket wired to answer every w:mex query with `payload` */
export const newsletterAnswering = async (payload) => {
	const wss = new (await import('ws')).WebSocketServer({ host: '127.0.0.1', port: 0 });
	await new Promise(res => wss.once('listening', res));
	const sock = makeNewsletterSocket({
		...DEFAULT_CONNECTION_CONFIG,
		waWebSocketUrl: `ws://127.0.0.1:${wss.address().port}/ws/chat`,
		logger: noopLogger(),
		connectTimeoutMs: 600000,
		defaultQueryTimeoutMs: 600000,
		auth: { creds: credsFixture(), keys: keyStore() },
		makeSignalRepository: signalRepoStub,
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
				content: [{
					tag: 'result',
					attrs: {},
					content: Buffer.from(JSON.stringify(payload), 'utf-8')
				}]
			}), 0);
		}
		return registered;
	};
	return {
		sock,
		close: async () => {
			try { await sock.end(new Error('test teardown')); } catch { }
			await new Promise(res => wss.close(res));
		}
	};
};

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

test('a complete newsletter create response still parses', async () => {
	const h = await newsletterAnswering(FULL);
	try {
		const res = await h.sock.newsletterCreate('Onigi', 'a newsletter');
		assert.equal(res.id, '1234567890@newsletter');
		assert.equal(res.name, 'Onigi');
		assert.equal(res.description, 'a newsletter');
		assert.equal(res.picture.id, 'PIC');
		assert.equal(res.mute_state, 'off');
	}
	finally {
		await h.close();
	}
});

test('a response with no description parses instead of throwing', async () => {
	const payload = structuredClone(FULL);
	delete payload.data.xwa2_newsletter_create.thread_metadata.description;
	const h = await newsletterAnswering(payload);
	try {
		const res = await h.sock.newsletterCreate('Onigi');
		assert.equal(res.id, '1234567890@newsletter');
		assert.equal(res.name, 'Onigi');
		assert.equal(res.description, undefined);
	}
	finally {
		await h.close();
	}
});

test('a response with no viewer metadata parses instead of throwing', async () => {
	const payload = structuredClone(FULL);
	delete payload.data.xwa2_newsletter_create.viewer_metadata;
	const h = await newsletterAnswering(payload);
	try {
		const res = await h.sock.newsletterCreate('Onigi', 'a newsletter');
		assert.equal(res.mute_state, undefined);
	}
	finally {
		await h.close();
	}
});

test('a response with no picture parses instead of throwing', async () => {
	const payload = structuredClone(FULL);
	delete payload.data.xwa2_newsletter_create.thread_metadata.picture;
	const h = await newsletterAnswering(payload);
	try {
		const res = await h.sock.newsletterCreate('Onigi', 'a newsletter');
		assert.deepEqual(res.picture, { id: undefined, directPath: undefined });
	}
	finally {
		await h.close();
	}
});

test('a response with no name is a Boom, not a TypeError', async () => {
	const payload = structuredClone(FULL);
	delete payload.data.xwa2_newsletter_create.thread_metadata.name;
	const h = await newsletterAnswering(payload);
	try {
		const err = await h.sock.newsletterCreate('Onigi', 'a newsletter').then(() => null, e => e);
		assert.ok(err, 'a nameless newsletter must not parse');
		assert.notEqual(err.name, 'TypeError', `got a TypeError: ${err.message}`);
		assert.equal(err.isBoom, true, `not a Boom: ${err.name} ${err.message}`);
		assert.equal(err.output.statusCode, 400);
	}
	finally {
		await h.close();
	}
});

test('a response with no thread_metadata at all is a Boom, not a TypeError', async () => {
	const payload = { data: { xwa2_newsletter_create: { id: '123@newsletter' } } };
	const h = await newsletterAnswering(payload);
	try {
		const err = await h.sock.newsletterCreate('Onigi', 'a newsletter').then(() => null, e => e);
		assert.ok(err);
		assert.equal(err.isBoom, true, `not a Boom: ${err.name} ${err.message}`);
	}
	finally {
		await h.close();
	}
});
