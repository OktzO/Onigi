import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { proto } from '../../WAProto/index.js';
import { DEFAULT_CONNECTION_CONFIG } from '../../lib/Defaults/index.js';
import makeWASocket from '../../lib/Socket/index.js';

const execFileAsync = promisify(execFile);

export const noopLogger = () => {
	const levels = { logs: [] };
	const rec = level => (...args) => levels.logs.push([level, ...args]);
	return Object.assign(levels, {
		level: 'silent',
		trace: rec('trace'),
		debug: rec('debug'),
		info: rec('info'),
		warn: rec('warn'),
		error: rec('error'),
		child() { return this; }
	});
};

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
		set: async d => {
			for (const [k, v] of Object.entries(d)) {
				map.set(k, v);
			}
		},
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

/**
 * Boots a real makeWASocket against a local ws server that accepts the
 * connection and then stays silent, so no noise handshake is needed. Inbound
 * stanzas are injected with sock.ws.emit('CB:...', node) which is exactly what
 * onMessageReceived does after decryption.
 */
export const startHarness = async (over = {}) => {
	const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await new Promise(res => wss.once('listening', res));
	const port = wss.address().port;
	const logger = over.logger || noopLogger();
	const sock = makeWASocket({
		...DEFAULT_CONNECTION_CONFIG,
		waWebSocketUrl: `ws://127.0.0.1:${port}/ws/chat`,
		logger,
		connectTimeoutMs: 600000,
		defaultQueryTimeoutMs: 600000,
		auth: { creds: credsFixture(), keys: keyStore() },
		makeSignalRepository: signalRepoStub,
		fireInitQueries: false,
		...over.config
	});
	await new Promise(res => {
		if (sock.ws.isOpen) { return res(); }
		sock.ws.once('open', res);
	});
	const send = async (event, node) => { sock.ws.emit(event, node); await tick(20); };
	const close = async () => {
		try { await sock.end(new Error('harness teardown')); } catch { }
		await new Promise(res => wss.close(res));
	};
	return { sock, logger, send, close, wss };
};

export const tick = (ms = 0) => new Promise(res => setTimeout(res, ms));

const PLAINTEXT_STANZA = id => ({
	tag: 'message',
	attrs: { id, from: '99999:1@s.whatsapp.net', t: '1700000000' },
	content: [{
		tag: 'plaintext',
		attrs: {},
		content: proto.Message.encode(proto.Message.fromObject({ conversation: 'hello' })).finish()
	}]
});
export { PLAINTEXT_STANZA };

/**
 * Runs `body` in a child node process with the harness in scope and reports the
 * raw exit outcome. The unhandled-rejection class of bug is a process-level
 * event, so the only faithful assertion is the child's exit code — an in-process
 * test would have to install its own unhandledRejection listener, which
 * suppresses the very default (throw) we need to observe.
 */
export const runScenario = async body => {
	const prelude = 'import { startHarness, noopLogger, tick, PLAINTEXT_STANZA } from '
		+ JSON.stringify(new URL(import.meta.url).href) + ';\n'
		+ 'import { proto } from '
		+ JSON.stringify(new URL('../../WAProto/index.js', import.meta.url).href) + ';\n';
	const opts = { timeout: 120000, maxBuffer: 32 * 1024 * 1024 };
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, ['--input-type=module', '-e', prelude + body], opts);
		return { code: 0, stdout, stderr };
	}
	catch (err) {
		return { code: err.code ?? err.signal ?? 'error', stdout: err.stdout || '', stderr: err.stderr || String(err) };
	}
};
