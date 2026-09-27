/*
 * Shared fixture for the message send/retry pipeline tests.
 *
 * The retry and group-send code lives in closure-private functions inside
 * messages-send.js / messages-recv.js, so the only faithful way to exercise it
 * is through a real socket: a local ws server, real stanzas in, real stanzas
 * out. The `ev-socket-harness` helper boots exactly that, so this module adds
 * the observability those tests need, plus `runSocketScenario`.
 *
 * Every scenario runs in a child `node` process, for two reasons:
 *   - a booted socket leaves handles that keep the parent's event loop alive
 *     (the base harness alone does; that is why the earlier agent's crash tests
 *     already run in children), and
 *   - a child is the only place an unhandled rejection can be observed as a
 *     non-zero exit code.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import NodeCache from '@cacheable/node-cache';
import { proto } from '../WAProto/index.js';
import { KEY_BUNDLE_TYPE } from '../lib/Defaults/index.js';
import { noopLogger, startHarness, tick } from './helpers/ev-socket-harness.mjs';

export { noopLogger, startHarness, tick };

const execFileAsync = promisify(execFile);
const HARNESS_URL = new URL(import.meta.url).href;

export const ME_PN = '111111:1@s.whatsapp.net';
export const ME_LID = '999999:1@lid';
export const PEER_PN = '628111:1@s.whatsapp.net';
export const PEER_LID = '777777:1@lid';
export const GROUP_JID = '120363111111111111@g.us';
/** user-level (device 0 implied) jids, the shape a real group participant list has */
export const ME_GROUP_JID = '111111@s.whatsapp.net';
export const PEER_GROUP_JID = '628111@s.whatsapp.net';
export const PEER_LID_GROUP_JID = '777777@lid';

export const makeCreds = () => ({
	noiseKey: { private: Buffer.alloc(32), public: Buffer.alloc(32, 1) },
	signedIdentityKey: { private: Buffer.alloc(32, 2), public: Buffer.alloc(32, 3) },
	signedPreKey: { keyId: 1, public: Buffer.alloc(32, 4), private: Buffer.alloc(32, 5) },
	advSecretKey: 'adv-secret',
	accountSyncCounter: 0,
	counter: 0,
	me: { id: ME_PN, lid: ME_LID, name: 'probe' },
	registered: true,
	pairingCode: 'ABCDEFGH',
	preKeys: { 1: Buffer.alloc(32, 6) },
	nextPreKeyId: 2,
	firstUnuploadedPreKeyId: 1,
	accountSyncIndex: 0
});

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export const makeKeyStore = () => {
	const map = new Map();
	const sessionWrites = [];
	return {
		map,
		sessionWrites,
		get: async (type, ids) => {
			const v = map.get(type);
			if (ids === undefined) return clone(v);
			return ids.map(id => (Array.isArray(v) ? clone(v[id]) : clone(v?.[id])));
		},
		set: async d => {
			for (const [k, v] of Object.entries(d)) {
				if (k === 'session') sessionWrites.push(v);
				map.set(k, v);
			}
		},
		del: async k => { map.delete(k); },
		bind: async fn => fn(this),
		transaction: async fn => fn(this)
	};
};

export const makeLogger = () => {
	const logs = [];
	const entryText = entry => entry.slice(1).map(a => {
		try { return JSON.stringify(a); } catch { return String(a); }
	}).join(' ');
	const logger = {
		// `trace` is what makes sendNode log every stanza it puts on the wire
		// ({ xml, msg: 'xml send' }), so the assertions read real stanzas.
		level: 'trace',
		trace: (...a) => logs.push(['trace', ...a]),
		debug: (...a) => logs.push(['debug', ...a]),
		info: (...a) => logs.push(['info', ...a]),
		warn: (...a) => logs.push(['warn', ...a]),
		error: (...a) => logs.push(['error', ...a]),
		child() { return this; },
		logs,
		texts: () => logs.map(entryText),
		find: (level, needle) => logs.filter(l => (!level || l[0] === level) && entryText(l).includes(needle)),
		sentXml: () => logs.filter(l => l[0] === 'trace' && l[1]?.msg === 'xml send').map(l => l[1].xml)
	};
	return logger;
};

export const makeSignalRepo = (over = {}) => {
	const encryptCalls = [];
	const decryptCalls = [];
	const base = {
		lidMapping: {
			storeLIDPNMappings: async () => { },
			getPNForLID: async () => null,
			getLIDForPN: async () => null,
			getLIDsForPNs: async () => []
		},
		migrateSession: async () => { },
		decryptMessage: async () => { throw new Error('MAC verification failed'); },
		decryptGroupMessage: async () => { throw new Error('MAC verification failed'); },
		encryptMessage: async ({ jid }) => {
			encryptCalls.push(jid);
			return { type: 'msg', ciphertext: Buffer.from('ciphertext') };
		},
		encryptGroupMessage: async () => ({ ciphertext: Buffer.from('skmsg'), senderKeyDistributionMessage: Buffer.from('skdm') }),
		processSenderKeyDistributionMessage: async () => { },
		getSenderKeyDistributionMessage: async () => Buffer.from('skdm'),
		hasSenderKey: async () => false,
		jidToSignalProtocolAddress: jid => `${jid}.0`,
		validateSession: async () => ({ exists: true }),
		getSessionInfo: async () => ({ registrationId: 1, baseKey: Buffer.alloc(32, 7) }),
		injectE2ESession: async () => { },
		close: () => { },
		encryptCalls,
		decryptCalls
	};
	const repo = { ...base, ...over };
	// JSON.stringify drops functions, and the scenario body is passed as source
	// text -- so a failing signal method is requested by naming its error.
	for (const key of Object.keys(over)) {
		if (typeof over[key] === 'string') {
			const message = over[key];
			repo[key] = async () => { throw new Error(message); };
		}
	}
	const innerDecrypt = repo.decryptMessage;
	repo.decryptMessage = async args => { decryptCalls.push({ jid: args.jid, type: args.type }); return innerDecrypt(args); };
	return repo;
};

/** Device cache that answers getUSyncDevices without a usync query. */
export const makeNodeCache = options => new NodeCache(options);
export const makeDeviceCache = usersToDevices => ({
	// exposed so a scenario can model a device joining between two sends
	devices: usersToDevices,
	async mget(users) { return Object.fromEntries(users.map(u => [u, usersToDevices[u]])); },
	async mset() { },
	async get(u) { return usersToDevices[u]; },
	async set() { },
	close() { }
});

const u32 = n => Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const u24 = n => Buffer.from([(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

/** A well-formed <registration> + <keys> bundle, as a real retry receipt carries. */
export const keyBundle = () => [
	{ tag: 'registration', attrs: {}, content: u32(4242) },
	{
		tag: 'keys',
		attrs: {},
		content: [
			{ tag: 'type', attrs: {}, content: Buffer.from(KEY_BUNDLE_TYPE) },
			{ tag: 'identity', attrs: {}, content: Buffer.alloc(32, 3) },
			{ tag: 'key', attrs: {}, content: [{ tag: 'id', attrs: {}, content: u24(7) }, { tag: 'value', attrs: {}, content: Buffer.alloc(32, 4) }] },
			{
				tag: 'skey',
				attrs: {},
				content: [
					{ tag: 'id', attrs: {}, content: u24(1) },
					{ tag: 'value', attrs: {}, content: Buffer.alloc(32, 5) },
					{ tag: 'signature', attrs: {}, content: Buffer.alloc(64, 9) }
				]
			}
		]
	}
];

/** An inbound stanza whose ciphertext the signal stub refuses to decrypt. */
export const undecryptableStanza = (jid, id) => ({
	tag: 'message',
	attrs: { id, from: jid, t: '1700000000' },
	content: [{ tag: 'enc', attrs: { v: '2', type: 'msg' }, content: Buffer.from('garbage-ciphertext') }]
});

/** An inbound stanza that decrypts trivially — normal, healthy traffic. */
export const plaintextStanza = (jid, id, text = 'hello') => ({
	tag: 'message',
	attrs: { id, from: jid, t: '1700000000' },
	content: [{
		tag: 'plaintext',
		attrs: {},
		content: proto.Message.encode(proto.Message.fromObject({ conversation: text })).finish()
	}]
});

/** A peer's retry receipt for a message we sent. */
export const retryReceipt = ({ id, participant, count, error = '0', bundle = true, from }) => ({
	tag: 'receipt',
	attrs: { id, from: from || participant, participant, t: '1700000000', type: 'retry' },
	content: [
		{ tag: 'retry', attrs: { count: String(count), id, t: '1700000000', v: '1', error } },
		...(bundle ? keyBundle() : [])
	]
});

export const groupMetadata = (over = {}) => ({
	id: GROUP_JID,
	addressingMode: 'lid',
	subject: 'test group',
	size: 3,
	owner: ME_PN,
	participants: [
		{ id: ME_GROUP_JID, admin: null },
		{ id: PEER_GROUP_JID, admin: null },
		{ id: PEER_LID_GROUP_JID, admin: null }
	],
	ephemeralDuration: 0,
	...over
});

export const bootSocket = async (over = {}) => {
	const logger = over.logger || makeLogger();
	const keys = over.keys || makeKeyStore();
	const signal = over.signal || makeSignalRepo(over.signalOverrides);
	const msgRetryCounterCache = new NodeCache({ maxKeys: 10_000, stdTTL: 600_000, useClones: false });
	const config = {
		auth: { creds: makeCreds(), keys },
		makeSignalRepository: () => signal,
		msgRetryCounterCache,
		...over.config
	};
	const h = await startHarness({ logger, config });

	// Answer every <iq> the code under test sends, so nothing waits out the
	// harness's 10-minute query timeout. A usync gets a device list back, which
	// is what drives the device-list persistence path.
	const usyncUsers = over.usyncUsers;
	const answered = new Set();
	const pump = setInterval(() => {
		for (const xml of logger.sentXml()) {
			const id = /<iq [^>]*id='([^']+)'/.exec(xml)?.[1];
			if (!id || answered.has(id)) continue;
			answered.add(id);
			const isUsync = xml.includes("xmlns='usync'");
			const result = { tag: 'iq', attrs: { id, type: 'result', xmlns: 'encrypt' } };
			if (isUsync && usyncUsers?.length) {
				result.content = [{
					tag: 'usync',
					attrs: { context: 'message', mode: 'query', sid: '0', last: 'true', index: '0' },
					content: [{
						tag: 'list',
						attrs: {},
						content: usyncUsers.map(({ jid, devices }) => ({
							tag: 'user',
							attrs: { jid },
							content: [{
								tag: 'devices',
								attrs: {},
								content: [{
									tag: 'device-list',
									attrs: {},
									content: devices.map((d, i) => ({ tag: 'device', attrs: { id: String(d), 'key-index': String(i + 1) } }))
								}]
							}]
						}))
					}]
				}];
			}
			h.sock.ws.emit(`TAG:${id}`, result);
		}
	}, 15);

	return {
		h,
		sock: h.sock,
		logger,
		keys,
		signal,
		msgRetryCounterCache,
		counter: (id, participant) => msgRetryCounterCache.get(`${id}:${participant}`),
		/** Every stanza the library has put on the wire so far, as XML strings. */
		sentXml: () => logger.sentXml(),
		waitForLog: async (needle, ms = 4000) => {
			const deadline = Date.now() + ms;
			for (;;) {
				const hit = logger.find(undefined, needle);
				if (hit.length) return hit;
				if (Date.now() > deadline) return [];
				await tick(15);
			}
		},
		waitForXml: async (needle, ms = 4000) => {
			const deadline = Date.now() + ms;
			for (;;) {
				const hit = logger.sentXml().filter(x => x.includes(needle));
				if (hit.length) return hit;
				if (Date.now() > deadline) return [];
				await tick(15);
			}
		},
		stop: () => clearInterval(pump)
	};
};

/**
 * Runs `body` in a child node process with the whole fixture in scope as `T`
 * plus `assert`. The child's exit code carries the assertion, so a crashing or
 * unhandled-rejectioning scenario is a non-zero exit like any other failure.
 */
export const runSocketScenario = async body => {
	const prelude = `import * as T from ${JSON.stringify(HARNESS_URL)};\n`
		+ "import assert from 'node:assert/strict';\n"
		+ 'const { bootSocket, tick } = T;\n';
	const script = `${prelude}
const scenario = async () => {
${body}
};
let payload = { ok: true };
try {
	await scenario();
}
catch (err) {
	payload = { ok: false, message: (err && err.message) || String(err), stack: err && err.stack };
}
process.stdout.write('__RESULT__' + JSON.stringify(payload) + '\\n', () => {
	process.exit(payload.ok ? 0 : 1);
});
`;
	let stdout = '';
	let stderr = '';
	let code = 0;
	try {
		const out = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
		stdout = out.stdout; stderr = out.stderr;
	}
	catch (err) {
		stdout = err.stdout || ''; stderr = err.stderr || '';
		code = err.code ?? err.signal ?? 'error';
	}
	const line = stdout.split('\n').find(l => l.startsWith('__RESULT__'));
	const result = line ? JSON.parse(line.slice('__RESULT__'.length)) : { ok: false, message: 'scenario produced no result' };
	return { code, result, stdout, stderr, log: stdout.split('\n').filter(l => l && !l.startsWith('__RESULT__')) };
};
