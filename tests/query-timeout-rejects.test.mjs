import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * waitForMessage() used to swallow its own timeout:
 *
 *   catch (error) {
 *       if (error instanceof Boom && error.output?.statusCode === DisconnectReason.timedOut) {
 *           logger?.warn?.({ msgId }, 'timed out waiting for message');
 *           return undefined;
 *       }
 *       throw error;
 *   }
 *
 * so every query the server never answered RESOLVED with undefined (audit:
 * `{"state":"RESOLVED","v":"undefined"} after 1202ms`). A caller cannot tell "the
 * server answered" from "the server said nothing for 60s":
 *
 *  - uploadPreKeys logs 'uploaded pre-keys successfully' and its retry ladder
 *    (socket.js:391) never runs;
 *  - getAvailablePreKeysOnServer does +countChild.attrs.value on the undefined
 *    result and dies with a TypeError, not a timeout;
 *  - digestKeyBundle concludes the digest is missing and re-uploads;
 *  - the keepalive ping's rejection handler never fires, so a dead connection
 *    pings forever.
 *
 * The contract: a query that is not answered in time rejects with the timeout
 * Boom, and the callers that can tolerate a mute server say so themselves.
 *
 * Every scenario runs in a child (the harness leaves the ws server handle and
 * two timers behind, so an in-process file never exits) and prints the outcome
 * as key=value for the parent to assert on.
 */

/** the harness creds fixture is not pre-key shaped: xmppSignedPreKey wants { keyId, keyPair, signature } */
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
			for (const id of ids) { out[id] = v?.[id]; }
			return out;
		},
		set: async d => { for (const [k, v] of Object.entries(d)) { map.set(k, v); } },
		del: async k => { map.delete(k); },
		bind: async fn => fn({ get: this.get, set: this.set, del: this.del })
	};
})()`;

/** reports RESOLVED/REJECTED for a promise, plus the statusCode when it rejected */
const REPORT = `const report = p => p.then(
	v => 'RESOLVED ' + JSON.stringify(v),
	e => 'REJECTED ' + (e?.output?.statusCode) + ' ' + (e?.message)
);`;

test('a query the server never answers rejects instead of resolving undefined', async () => {
	const { code, stdout, stderr } = await runScenario(`
${REPORT}
const h = await startHarness({ config: { defaultQueryTimeoutMs: 300 } });
const res = await report(h.sock.query({
	tag: 'iq',
	attrs: { id: 'mute-1', xmlns: 'w:p', type: 'get', to: 's.whatsapp.net' },
	content: [{ tag: 'ping', attrs: {} }]
}));
console.log('outcome=' + res);
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /outcome=REJECTED 408 Timed Out/);
});

test('waitForMessage itself rejects on timeout rather than resolving undefined', async () => {
	const { code, stdout, stderr } = await runScenario(`
${REPORT}
const h = await startHarness({ config: { defaultQueryTimeoutMs: 300 } });
console.log('outcome=' + await report(h.sock.waitForMessage('never-sent', 300)));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /outcome=REJECTED 408 Timed Out/);
});

test('a query the server DOES answer still resolves with the node', async () => {
	const { code, stdout, stderr } = await runScenario(`
${REPORT}
const h = await startHarness({ config: { defaultQueryTimeoutMs: 300 } });
const pending = h.sock.query({
	tag: 'iq',
	attrs: { id: 'answered-1', xmlns: 'w:p', type: 'get', to: 's.whatsapp.net' },
	content: [{ tag: 'ping', attrs: {} }]
});
await tick(30);
h.sock.ws.emit('TAG:answered-1', { tag: 'iq', attrs: { type: 'result', id: 'answered-1' } });
console.log('outcome=' + await report(pending));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /outcome=RESOLVED \{"tag":"iq","attrs":\{"type":"result","id":"answered-1"\}\}/);
});

test('the pre-key count failure is reported as the timeout, not a TypeError on undefined', async () => {
	const { code, stdout, stderr } = await runScenario(`
const h = await startHarness({ config: { defaultQueryTimeoutMs: 200 } });
// getAvailablePreKeysOnServer is module-private; uploadPreKeysToServerIfRequired is
// its only caller and swallows, so the reported error is read off the logger
await h.sock.uploadPreKeysToServerIfRequired();
const entry = h.logger.logs.find(l => l.slice(1).some(a => a === 'Failed to check/upload pre-keys during initialization'));
const err = entry?.slice(1).find(a => a && typeof a === 'object' && a.error)?.error;
console.log('status=' + (err?.output?.statusCode));
console.log('message=' + (err?.message));
console.log('name=' + (err?.name));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	// old shape: TypeError "Cannot read properties of undefined (reading 'attrs')"
	// at socket.js:362, from +countChild.attrs.value on the undefined result
	assert.match(stdout, /status=408/);
	assert.match(stdout, /message=Timed Out/);
	assert.doesNotMatch(stdout, /name=TypeError/);
});

test('uploadPreKeys rejects and its retry ladder runs instead of logging success', async () => {
	const { code, stdout, stderr } = await runScenario(`
${REPORT}
const auth = { creds: ${PRE_KEY_CREDS}, keys: ${KEY_STORE} };
const h = await startHarness({ config: { defaultQueryTimeoutMs: 150, auth } });
console.log('outcome=' + await report(h.sock.uploadPreKeys(5)));
const flat = h.logger.logs.map(l => l.map(String).join(' '));
console.log('successLog=' + flat.filter(l => l.includes('uploaded pre-keys successfully')).length);
console.log('attempts=' + flat.filter(l => l.includes('uploading pre-keys')).length);
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /outcome=REJECTED 408 Timed Out/);
	assert.match(stdout, /successLog=0/, 'a mute server must never be reported as a successful upload');
	// retryCount 0..3 -- the ladder is what the undefined resolve disabled
	assert.match(stdout, /attempts=4/);
}, { timeout: 60000 });

test('digestKeyBundle reports the timeout instead of a missing digest node', async () => {
	const { code, stdout, stderr } = await runScenario(`
${REPORT}
const auth = { creds: ${PRE_KEY_CREDS}, keys: ${KEY_STORE} };
const h = await startHarness({ config: { defaultQueryTimeoutMs: 200, auth } });
// old shape: the query resolved undefined, so it concluded the digest was missing,
// re-uploaded, and threw a plain Error
console.log('outcome=' + await report(h.sock.digestKeyBundle()));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /outcome=REJECTED 408 Timed Out/);
	assert.doesNotMatch(stdout, /returned no digest node/);
});

test('the CB:success init sequence times out without leaking an unhandled rejection', async () => {
	const { code, stdout, stderr } = await runScenario(`
const unhandled = [];
process.on('unhandledRejection', r => unhandled.push(r?.message || String(r)));
const h = await startHarness({ config: { defaultQueryTimeoutMs: 200 } });
// every query in the init path now rejects; all four call sites
// (uploadPreKeysToServerIfRequired, sendPassiveIq, digestKeyBundle,
// sendUnifiedSession) have to own their rejection
h.sock.ws.emit('CB:success', { tag: 'success', attrs: { t: '1700000000' } });
await tick(1500);
console.log('unhandled=' + JSON.stringify(unhandled));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /unhandled=\[\]/, 'CB:success left a rejection unowned');
});
