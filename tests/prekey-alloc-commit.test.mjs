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

test('an interleaved commit cannot move firstUnuploadedPreKeyId backwards', async () => {
	/*
	 * The interleave the reviewer reproduced, against a real socket:
	 *   consumer B (sendRetryRequest, count 1) allocates and keeps its snapshot
	 *   consumer A (uploadPreKeys, count 20) allocates and commits 21
	 *   consumer B applies its own snapshot-derived commit, 2
	 * Both commitUpdate values were computed by Math.max against the *same* stale
	 * creds, so neither could see the other's write: the handler's unconditional
	 * Object.assign then lowered the live counter 21 -> 2. `available` inflated
	 * with it, so every later top-up minted too few keys.
	 */
	const { code, stdout, stderr } = await runScenario(`
const { getNextPreKeys } = await import(${JSON.stringify(new URL('../lib/Utils/signal.js', import.meta.url).href)});
const creds = ${PRE_KEY_CREDS};
const keys = ${KEY_STORE};
const h = await startHarness({ config: { defaultQueryTimeoutMs: 200, auth: { creds, keys } } });
// B allocates first and holds the snapshot; nothing is applied yet
const bAlloc = await getNextPreKeys({ creds: { ...creds }, keys }, 1);
// A allocates and commits against the live creds
const aAlloc = await getNextPreKeys({ creds, keys }, 20);
h.sock.ev.emit('creds.update', aAlloc.allocUpdate);
h.sock.ev.emit('creds.update', aAlloc.commitUpdate);
console.log('afterA=' + creds.nextPreKeyId + ',' + creds.firstUnuploadedPreKeyId);
// B now applies the update it computed from the older snapshot
h.sock.ev.emit('creds.update', bAlloc.commitUpdate);
console.log('afterB=' + creds.nextPreKeyId + ',' + creds.firstUnuploadedPreKeyId);
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	// A allocates 20 over an empty store: nextPreKeyId 1 -> 20, commit 20
	assert.match(stdout, /afterA=20,20/);
	// B's commit was computed as 1, from a snapshot taken before A's write
	assert.match(stdout, /afterB=20,20/, 'the stale commit lowered a monotonic counter');
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
