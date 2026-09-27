import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * uploadPreKeys() was:
 *
 *     let uploadTimeoutTimer;
 *     uploadPreKeysPromise = Promise.race([
 *         uploadLogic(0),
 *         new Promise((_, reject) => {
 *             uploadTimeoutTimer = setTimeout(() => reject(new Boom('Pre-key upload timeout', { statusCode: 408 })), UPLOAD_TIMEOUT);
 *         })
 *     ]).finally(() => clearTimeout(uploadTimeoutTimer));
 *     try { await uploadPreKeysPromise; }
 *     finally { uploadPreKeysPromise = null; }
 *
 * The race covers uploadLogic, and uploadLogic's first act is a key-store
 * transaction. So the 30s budget can expire while the transaction is still
 * committing, and the finally releases the dedupe guard while the abandoned
 * uploadLogic(0) is still going. A caller arriving after that point finds a
 * null guard, starts a second uploadLogic, and blocks on the same tx mutex.
 *
 * The audit's numbers: call#1 REJECTED 408 @30684ms, call#2 REJECTED 408
 * @61685ms, two commits, two upload frames. Both callers were told the upload
 * failed; the server received the keys twice.
 *
 * Same root cause for the other face: a <count> stanza answered twice (two
 * uploadPreKeysToServerIfRequired calls) issues two <count> queries, and
 * nothing but the dedupe guard stops the second from starting a second
 * uploadLogic once the guard has been released early.
 *
 * The contract: the dedupe guard is held until the work settles, and the 30s
 * budget covers the network upload rather than the key-store commit.
 *
 * UPLOAD_TIMEOUT is 30s, so the guard has to still be held 31s in -- this test
 * takes 40s of wall clock and cannot be shortened without a config seam for the
 * timeout, which would be new public API for the sake of a test.
 */
const prelude = (gateFirst) => `const gateFirst = ${gateFirst};
const creds = {
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
};

// the first transaction's commit is held past UPLOAD_TIMEOUT when gateFirst,
// which is the audit's "its key-store transaction is still committing" state
let release = () => { };
const gate = gateFirst ? new Promise(res => { release = res; }) : Promise.resolve();
let commitStarts = 0;
let commits = 0;
const map = new Map();
const keys = {
	get: async (type, ids) => {
		const v = map.get(type);
		if (ids === undefined) { return v; }
		const out = {};
		for (const id of ids) { out[id] = v?.[id]; }
		return out;
	},
	set: async d => {
		commitStarts++;
		if (commitStarts === 1) { await gate; }
		for (const [k, v] of Object.entries(d)) { map.set(k, v); }
		commits++;
	},
	del: async k => { map.delete(k); },
	bind: async fn => fn({ get: this.get, set: this.set, del: this.del })
};

const h = await startHarness({
	config: { defaultQueryTimeoutMs: 600000, auth: { creds, keys } }
});
const batches = [];
h.sock.ev.on('creds.update', u => { if (u && u.nextPreKeyId) { batches.push(u.nextPreKeyId); } });
const state = tag => {
	const r = calls.map(c => c.state).join(',');
	console.log(tag + ' t=' + Math.round((Date.now() - t0) / 1000) + 's batches=' + batches.length
		+ ' commits=' + commits + '/' + commitStarts + ' calls=' + r);
};
const calls = [
	{ state: 'PENDING' },
	{ state: 'PENDING' }
];
const track = (i, p) => p.then(
	v => { calls[i].state = 'RESOLVED'; },
	e => { calls[i].state = 'REJECTED ' + (e?.output?.statusCode); }
);
const t0 = Date.now();`;

test('the dedupe guard survives the upload timeout while the store is still committing', async () => {
	const { code, stdout, stderr } = await runScenario(`
${prelude(true)}
track(0, h.sock.uploadPreKeys(5));
await tick(500);
state('afterFirstCall');
// the budget expires here; the transaction has not committed yet
await tick(30500);
state('atTimeoutPlusOne');
// and a second caller arrives
track(1, h.sock.uploadPreKeys(5));
await tick(500);
state('afterSecondCall');
// now let the commit through
release();
await tick(4000);
state('afterCommit');
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	// the upload timeout must not reject while the key-store commit is in flight:
	// the caller would be told the upload failed while the keys were being written
	assert.match(stdout, /atTimeoutPlusOne t=3\ds batches=1 commits=0\/1 calls=PENDING,PENDING/,
		`the 30s budget raced the store transaction:\n${stdout}`);
	// the guard must still be held: one batch generated, one commit
	assert.match(stdout, /afterCommit t=\d+s batches=1 commits=1\/1 calls=PENDING,PENDING/,
		`a second uploadLogic ran while the first was in flight:\n${stdout}`);
	assert.doesNotMatch(stdout, /batches=2/, `two pre-key batches were generated:\n${stdout}`);
	assert.doesNotMatch(stdout, /commits=\d\/2/, `a second commit ran:\n${stdout}`);
}, { timeout: 90000 });

/*
 * Not a RED: this one is green before and after on purpose. It pins the other
 * side of the contract, so "hold the guard until the work settles" cannot be
 * satisfied by latching it forever. The upload is answered here rather than
 * timing out, so a settled upload means one batch and one commit.
 */
test('a caller that arrives after the upload has settled starts a fresh run', async () => {
	const { code, stdout, stderr } = await runScenario(`
${prelude(false)}
// answer whatever the upload asks, so the run settles instead of timing out
const tags = [];
const origOn = h.sock.ws.on.bind(h.sock.ws);
h.sock.ws.on = (event, ...rest) => {
	if (typeof event === 'string' && event.startsWith('TAG:')) { tags.push(event.slice(4)); }
	return origOn(event, ...rest);
};
const loop = (async () => {
	for (let i = 0; i < 400; i++) {
		const tag = tags.shift();
		if (tag) { h.sock.ws.emit('TAG:' + tag, { tag: 'iq', attrs: { type: 'result', id: tag } }); }
		await tick(25);
	}
})();
track(0, h.sock.uploadPreKeys(5));
await tick(800);
state('firstSettled');
track(1, h.sock.uploadPreKeys(5));
await tick(400);
state('secondRunning');
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	// the guard is a dedupe, not a permanent latch: once the work is done the
	// next caller must be able to upload again
	assert.match(stdout, /firstSettled t=\d+s batches=1 commits=1\/1 calls=RESOLVED/);
	assert.match(stdout, /secondRunning t=\d+s batches=2 commits=2\/2 calls=RESOLVED,RESOLVED/);
}, { timeout: 90000 });
