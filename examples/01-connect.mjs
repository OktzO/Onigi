/*
 * examples/01-connect.mjs — connect to a local server and watch the handshake.
 *
 * Run: node examples/01-connect.mjs
 *
 * No credentials, no network, no ffmpeg. It boots a real `makeWASocket` against
 * the local server in examples/helpers/local-wa-server.mjs, which implements
 * the same Noise XX handshake the real one does, and it asserts on what the
 * client actually wrote.
 *
 * The interesting result is the *failure*: the client refuses the server's
 * certificate chain. That is correct. WA_CERT_DETAILS.PUBLIC_KEY
 * (lib/Defaults/index.js:28) is WhatsApp's real long-term key, its private half
 * is not in this repository, and lib/Utils/noise-handler.js:183 checks the
 * chain against it. A refusal here is the certificate check working, which is
 * the check commit 42d416d made real.
 */

import assert from 'node:assert/strict';
import makeWASocket, { DEFAULT_CONNECTION_CONFIG, jidDecode, proto } from '../lib/index.js';
import { NOISE_WA_HEADER } from '../lib/Defaults/index.js';
import { startLocalWaServer } from './helpers/local-wa-server.mjs';

/**
 * A pino-shaped logger at level 'silent'.
 *
 * It cannot be a bare Proxy: the library calls `logger.child({ class })` and
 * then reads `.level` on the result, so the child has to be a real object.
 */
const silentLogger = () => {
	const logger = {
		level: 'silent',
		trace: () => { },
		debug: () => { },
		info: () => { },
		warn: () => { },
		error: () => { },
		child: () => logger
	};
	return logger;
};

/** A key store with no state: this example never gets far enough to need one. */
const emptyKeyStore = () => ({ get: async () => ({}), set: async () => { }, del: async () => { } });

/** Creds shaped like a real registered session; the values are irrelevant here. */
const fixtureCreds = () => ({
	noiseKey: { private: Buffer.alloc(32, 1), public: Buffer.alloc(32, 2) },
	signedIdentityKey: { private: Buffer.alloc(32, 3), public: Buffer.alloc(32, 4) },
	signedPreKey: { keyId: 1, public: Buffer.alloc(32, 5), private: Buffer.alloc(32, 6) },
	advSecretKey: Buffer.alloc(32, 7).toString('base64'),
	accountSyncCounter: 0,
	counter: 0,
	me: { id: '15550001111:1@s.whatsapp.net', lid: '9998887776:1@lid', name: 'local' },
	registered: true,
	pairingCode: 'ABCDEFGH'
});

const main = async () => {
	const server = await startLocalWaServer();
	console.log('local server listening on', server.url);

	const sock = makeWASocket({
		...DEFAULT_CONNECTION_CONFIG,
		waWebSocketUrl: server.url,
		logger: silentLogger(),
		auth: { creds: fixtureCreds(), keys: emptyKeyStore() },
		// fireInitQueries runs a burst of queries on open; this example only
		// wants the handshake
		fireInitQueries: false,
		connectTimeoutMs: 5000,
		defaultQueryTimeoutMs: 5000,
		keepAliveIntervalMs: 120000
	});

	// `sock.user` is `creds.me` -- there is no `sock.user.jid` in this library
	console.log('sock.user.id  =', sock.user.id);
	console.log('sock.user.lid =', sock.user.lid);
	console.log('jidDecode(sock.user.id).user =', jidDecode(sock.user.id).user);

	// The client tears the socket down on a handshake failure and reports why.
	// `sock.ev` is a BaileysEventEmitter: on / off / removeAllListeners / emit.
	// It has no `once`, so a one-shot listener is built from `on` + `off`.
	const closed = new Promise(resolve => {
		const onUpdate = u => {
			if (u.connection !== 'close') {
				return;
			}
			sock.ev.off('connection.update', onUpdate);
			resolve(u.lastDisconnect);
		};
		sock.ev.on('connection.update', onUpdate);
	});

	const disconnect = await Promise.race([
		closed,
		new Promise(resolve => setTimeout(() => resolve(null), 10_000))
	]);

	// --- what the client actually put on the wire --------------------------------

	assert.equal(server.frames.length, 1, 'the client should write exactly one frame before failing');
	const first = server.frames[0];

	// The first write is prefixed with the Noise header (NOISE_WA_HEADER), then a
	// 3-byte big-endian length, then the clientHello (lib/Utils/noise-handler.js:194).
	assert.deepEqual([...first.subarray(0, 4)], [...NOISE_WA_HEADER], 'first write must open with NOISE_WA_HEADER');
	const size = (first[4] << 16) | (first[5] << 8) | first[6];
	assert.equal(first.length, 7 + size, 'the 3-byte length must cover exactly the rest of the frame');

	// The clientHello is a real protobuf with a real 32-byte X25519 ephemeral.
	assert.ok(server.clientHello, 'the local server must have decoded a clientHello');
	const ephemeral = server.clientHello.clientHello?.ephemeral;
	assert.equal(ephemeral?.length, 32, 'clientHello.ephemeral must be a 32-byte X25519 public key');

	// And it round-trips through the protobuf implementation the library uses.
	const reencoded = proto.HandshakeMessage.encode(
		proto.HandshakeMessage.fromObject({ clientHello: { ephemeral } })
	).finish();
	assert.deepEqual(
		[...reencoded],
		[...first.subarray(7)],
		'the decoded clientHello must re-encode to the exact bytes on the wire'
	);
	console.log(`clientHello: ${size} bytes, ephemeral ${ephemeral.length} bytes, re-encodes identically`);

	// --- and why it stopped --------------------------------------------------------

	assert.ok(disconnect, 'the socket should have closed');
	const { error } = disconnect;
	assert.equal(error.output?.statusCode, 400, 'the client rejects the certificate with a 400');
	// noise-handler.js:183 — the intermediate is signed by a key the client does
	// not know, so the chain is refused. If this ever starts passing, the check
	// has been weakened and this example fails.
	assert.match(error.message, /noise intermediate certificate signature invalid/);
	console.log('client refused the server certificate:', JSON.stringify(error.message));

	await server.close();
	console.log('\nok — the handshake ran, the key schedule matched, and the certificate check refused us.');
	console.log('   Nothing was faked to get here: those are the real bytes and the real rejection.');
};

await main();
