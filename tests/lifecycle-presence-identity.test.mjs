import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONNECTION_CONFIG } from '../lib/Defaults/index.js';
import { makeChatsSocket } from '../lib/Socket/chats.js';
import { isHostedLidUser, isLidUser } from '../lib/WABinary/index.js';
import { noopLogger } from './helpers/ev-socket-harness.mjs';

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
 */
const credsWith = (me) => ({
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

const chatsAnswering = async (me) => {
	const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await new Promise(res => wss.once('listening', res));
	const logger = noopLogger();
	logger.level = 'trace';
	const sock = makeChatsSocket({
		...DEFAULT_CONNECTION_CONFIG,
		waWebSocketUrl: `ws://127.0.0.1:${wss.address().port}/ws/chat`,
		logger,
		connectTimeoutMs: 600000,
		defaultQueryTimeoutMs: 600000,
		auth: { creds: credsWith(me), keys: keyStore() },
		makeSignalRepository: signalRepoStub,
		fireInitQueries: false
	});
	await new Promise(res => {
		if (sock.ws.isOpen) { return res(); }
		sock.ws.once('open', res);
	});
	await new Promise(res => setTimeout(res, 50));
	const sent = () => logger.logs
		.filter(l => l[1]?.msg === 'xml send')
		.map(l => String(l[1]?.xml))
		.filter(xml => xml.includes('<chatstate') || xml.includes('<presence'));
	const clear = () => { logger.logs.length = 0; };
	return {
		sock,
		sent,
		clear,
		close: async () => {
			try { await sock.end(new Error('test teardown')); } catch { }
			await new Promise(res => wss.close(res));
		}
	};
};

const ME = { id: '11111:1@s.whatsapp.net', lid: '11111:1@lid', name: 'probe' };

test('a chatstate to a @lid peer is sent from the LID identity', async () => {
	const h = await chatsAnswering(ME);
	try {
		h.clear();
		await h.sock.sendPresenceUpdate('composing', '99999:1@lid');
		assert.equal(h.sent().length, 1, 'no chatstate reached the wire');
		assert.match(h.sent()[0], /from='11111:1@lid'/);
	}
	finally {
		await h.close();
	}
});

test('a chatstate to a @hosted.lid peer is sent from the LID identity too', async () => {
	const h = await chatsAnswering(ME);
	try {
		assert.ok(isHostedLidUser('99999:1@hosted.lid'), 'fixture assumption');
		assert.ok(!isLidUser('99999:1@hosted.lid'), 'fixture assumption');
		h.clear();
		await h.sock.sendPresenceUpdate('composing', '99999:1@hosted.lid');
		assert.equal(h.sent().length, 1, 'no chatstate reached the wire');
		// old: server === 'lid' is false here, so this went out from the PN
		assert.match(h.sent()[0], /from='11111:1@lid'/);
	}
	finally {
		await h.close();
	}
});

test('a chatstate to a PN peer is sent from the PN identity', async () => {
	const h = await chatsAnswering(ME);
	try {
		h.clear();
		await h.sock.sendPresenceUpdate('composing', '99999:1@s.whatsapp.net');
		assert.match(h.sent()[0], /from='11111:1@s\.whatsapp\.net'/);
	}
	finally {
		await h.close();
	}
});

test('a chatstate sent before the server gave us a lid still carries a from', async () => {
	const h = await chatsAnswering({ id: '11111:1@s.whatsapp.net', name: 'probe' });
	try {
		h.clear();
		await h.sock.sendPresenceUpdate('composing', '99999:1@lid');
		assert.equal(h.sent().length, 1, 'no chatstate reached the wire');
		// old: from: me.lid === undefined, which the trace filter and the encoder
		// both drop, leaving a chatstate with no from at all
		assert.match(h.sent()[0], /from='11111:1@s\.whatsapp\.net'/);
	}
	finally {
		await h.close();
	}
});

test('an available presence before pairing is a warning, not a TypeError', async () => {
	const h = await chatsAnswering(undefined);
	try {
		h.clear();
		let outcome = 'resolved';
		await h.sock.sendPresenceUpdate('available').then(
			() => { outcome = 'resolved'; },
			e => { outcome = 'rejected ' + e?.name; }
		);
		assert.equal(outcome, 'resolved', 'creds.me is undefined until the device pairs');
		assert.equal(h.sent().filter(x => x.includes('<presence')).length, 0,
			'a presence with no name must not be sent');
	}
	finally {
		await h.close();
	}
});

test('a composing presence before pairing is a warning, not a TypeError', async () => {
	const h = await chatsAnswering(undefined);
	try {
		h.clear();
		let outcome = 'resolved';
		await h.sock.sendPresenceUpdate('composing', '99999:1@s.whatsapp.net').then(
			() => { outcome = 'resolved'; },
			e => { outcome = 'rejected ' + e?.name; }
		);
		assert.equal(outcome, 'resolved', 'creds.me is undefined until the device pairs');
		assert.equal(h.sent().filter(x => x.includes('<chatstate')).length, 0,
			'a chatstate with no own identity must not be sent');
	}
	finally {
		await h.close();
	}
});
