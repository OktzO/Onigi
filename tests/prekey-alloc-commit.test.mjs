import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';
import { getNextPreKeys } from '../lib/Utils/signal.js';

/*
 * firstUnuploadedPreKeyId used to be advanced at *generation* time, conflated
 * with nextPreKeyId in a single `update`. Two coupled consequences:
 *
 * (a) a permanent upload failure orphaned every generated key: the counter had
 *     already skipped past them, so the next upload never retried them and the
 *     account slowly drained its server-side pre-keys;
 * (b) `available = nextPreKeyId - firstUnuploadedPreKeyId` was structurally 0
 *     (both counters set together on every attempt), so a top-up minted a full
 *     new batch instead of only the shortfall.
 *
 * The contract: allocation advances nextPreKeyId immediately; commitment
 * advances firstUnuploadedPreKeyId only once the server has accepted the
 * upload. A failed upload therefore leaves firstUnuploadedPreKeyId put, and a
 * top-up mints exactly count - available new keys.
 */

const PRE_KEY_CREDS = `({
	noiseKey: { private: Buffer.alloc(32), public: Buffer.alloc(32, 1) },
	signedIdentityKey: { private: Buffer.alloc(32, 2), public: Buffer.alloc(32, 3) },
	signedPreKey: { keyId: 1, keyPair: { private: Buffer.alloc(32, 5), public: Buffer.alloc(32, 4) }, signature: Buffer.alloc(64) },
	advSecretKey: 'adv-secret',
	accountSyncCounter: 0,
	counter: 0,
	nextPreKeyId: 1,
	firstUnuploadedPreKeyId: 0,
	registrationId: 1234,
	me: { id: '12345:1@s.whatsapp.net', lid: '12345:1@lid', name: 'probe' },
	registered: true,
	pairingCode: 'ABCDEFGH'
})`;

const KEY_STORE = `(() => {
	const map = new Map();
	return {
		get: async (type, ids) => {
			const v = map.get(type);
			if (ids === undefined) { return v; }
			const out = {};
			for (const id of ids) { if (v && v[id] !== undefined) { out[id] = v[id]; } }
			return out;
		},
		set: async d => { for (const [k, v] of Object.entries(d)) { map.set(k, v); } },
		del: async k => { map.delete(k); },
		bind: async fn => fn({ get: this.get, set: this.set, del: this.del })
	};
})()`;

test('a failed upload leaves firstUnuploadedPreKeyId unchanged', async () => {
	const { code, stdout, stderr } = await runScenario(`
const report = p => p.then(v => 'RESOLVED', e => 'REJECTED');
const creds = ${PRE_KEY_CREDS};
const keys = ${KEY_STORE};
const h = await startHarness({ config: { defaultQueryTimeoutMs: 200, auth: { creds, keys } } });
const res = await report(h.sock.uploadPreKeys(20));
console.log('outcome=' + res);
console.log('nextPreKeyId=' + creds.nextPreKeyId);
console.log('firstUnuploadedPreKeyId=' + creds.firstUnuploadedPreKeyId);
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	// allocation is applied at generation time even though the upload failed
	assert.match(stdout, /nextPreKeyId=20/);
	// commitment must not happen on failure: the same keys are retried
	assert.match(stdout, /firstUnuploadedPreKeyId=0/);
});

test('a top-up with available keys mints only the shortfall', async () => {
	const creds = { nextPreKeyId: 21, firstUnuploadedPreKeyId: 11 };
	const store = new Map();
	const keys = {
		get: async (type, ids) => {
			const v = store.get(type);
			if (ids === undefined) { return v; }
			const out = {};
			for (const id of ids) { if (v && v[id] !== undefined) { out[id] = v[id]; } }
			return out;
		},
		set: async (d) => { for (const [k, v] of Object.entries(d)) { store.set(k, v); } },
		del: async () => { },
	};
	const result = await getNextPreKeys({ creds, keys }, 20);
	const minted = result.newPreKeys ? Object.keys(result.newPreKeys).length : -1;
	assert.equal(minted, 10, 'count - available = 20 - (21 - 11) = 10 new keys');
	assert.deepEqual(Object.keys(result.allocUpdate ?? {}), ['nextPreKeyId']);
	assert.deepEqual(Object.keys(result.commitUpdate ?? {}), ['firstUnuploadedPreKeyId']);
});
