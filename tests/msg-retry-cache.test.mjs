import test from 'node:test';
import assert from 'node:assert/strict';
import { runSocketScenario } from './messaging-retry-harness.mjs';
import { decryptMessageNode } from '../lib/Utils/decode-wa-message.js';

/*
 * The message-retry counter: four coupled defects.
 *
 *  (a) `sendRetryRequest` and `updateSendMessageAgainCount` each did
 *      get -> +1 -> set from a different lock chain, and handleReceipt did the
 *      check and the charge as two separate awaits, so two retries racing on
 *      one message both read the same value and one charge was lost.
 *  (b) the key was `${id}:${participant}` in five places, so a stanza with no
 *      participant -- every 1:1 message -- was filed under the literal string
 *      "<id>:undefined" instead of under its own id.
 *  (c) `(await get(key)) || 0` turns "the cache has no entry" into "nothing
 *      has been charged yet". For the library's own NodeCache that is exactly
 *      right; for a caller-supplied msgRetryCounterCache -- documented as "map
 *      to store the retry counts for failed messages; used to determine
 *      whether to retry a message or not" (lib/Types/Socket.d.ts) -- it hands
 *      out a retry the caller never permitted (issue #2802).
 *  (d) the branch that stamps a CIPHERTEXT stub because the stanza carried
 *      nothing to decrypt logged nothing, so the message that most needs a
 *      reason had none.
 */

const one = async (over, body) => {
	const r = await runSocketScenario(`const s = await bootSocket(${JSON.stringify(over)});\n${body}`);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
};

test('two retries racing on one message both charge the budget', () => one(
	{ config: { enableRecentMessageCache: true } },
	`
const PEER_DEV = '628111:2@s.whatsapp.net';
// Two receipts for the same message from two different remote jids: they take
// two different receiptMutex keys, so both reach the one counter at once.
s.sock.messageRetryManager.addRecentMessage('628111@s.whatsapp.net', 'Z', { conversation: 'x' });
s.sock.messageRetryManager.addRecentMessage('628111:9@s.whatsapp.net', 'Z', { conversation: 'x' });
s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: 'Z', participant: PEER_DEV, from: '628111@s.whatsapp.net', count: 1 }));
s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: 'Z', participant: PEER_DEV, from: '628111:9@s.whatsapp.net', count: 1 }));
await tick(1500);
const charged = await s.counter('Z', PEER_DEV);
console.log('CHARGED=' + charged);
assert.equal(charged, 2, 'two concurrent charges on one key must both land, got ' + charged);
`
));

test('a stanza with no participant is filed under its own id', async () => {
	const r = await runSocketScenario(`
/*
 * A counter store, not a veto: it answers 0 for a message it has no entry for,
 * and that 0 is what the library charges against. (The cache that answers
 * undefined instead is the caller withholding permission -- the test below.)
 */
const store = { charged: [], get: async () => 0, set: async (k, v) => { store.charged.push([k, v]); }, del: async () => { } };
const s = await bootSocket({ config: { msgRetryCounterCache: store, retryRequestDelayMs: 0 } });
s.sock.ws.emit('CB:message', T.undecryptableStanza(T.PEER_PN, 'PL-A'));
await tick(400);
s.sock.ws.emit('CB:message', T.undecryptableStanza(T.PEER_PN, 'PL-B'));
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
	if (store.charged.length >= 2) break;
	await tick(100);
}
console.log('CHARGED-KEYS=' + JSON.stringify(store.charged));
const keys = store.charged.map(([k]) => k).sort();
assert.deepEqual(keys, ['PL-A', 'PL-B'], 'two participant-less messages must get two entries of their own: ' + JSON.stringify(keys));
for (const k of keys) {
	assert.equal(
		store.charged.find(([key]) => key === k)[1], 1,
		k + ' owns its own count of 1, it did not ride on the other message'
	);
}
assert.equal(
	keys.filter(k => k.includes('undefined')).length, 0,
	'the string "undefined" must never become part of a cache key'
);
s.stop();
`);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
});

test('a caller-supplied counter decides what a miss means', async () => {
	const r = await runSocketScenario(`
/*
 * The caller's cache is the authority on whether a retry is permitted: an
 * unseen key is its answer, not a licence. The internal NodeCache is the
 * library's own bookkeeping and misses on first use, so the same miss there
 * still has to buy the first retry -- that direction is what the counterpart
 * below pins, and nothing else in the suite would catch it.
 */
const callerOwned = { get: async () => undefined, set: async () => { }, del: async () => { } };
const silent = await bootSocket({ config: { msgRetryCounterCache: callerOwned, retryRequestDelayMs: 0 } });
silent.sock.ws.emit('CB:message', T.undecryptableStanza(T.PEER_PN, 'OWN-A'));
// the placeholder resend the retry path makes first takes ~2s, so wait for the
// outcome rather than for the log line that only says the path was entered
const deadline = Date.now() + 12000;
while (Date.now() < deadline) {
	if (silent.sentXml().some(x => x.includes("type='retry'"))) break;
	if (silent.logger.find(undefined, 'reached retry limit').length) break;
	await tick(50);
}
const askedOfCaller = silent.sentXml().filter(x => x.includes("type='retry'")).length;
console.log('asked-with-caller-owned-cache=' + askedOfCaller);
assert.equal(askedOfCaller, 0, 'a counter the caller left without an entry for this message must not be turned into a permitted retry');
assert.ok(silent.logger.find(undefined, 'reached retry limit').length >= 1, 'and it must be reported as exhausted rather than silently rewritten to zero');
silent.stop();

const internal = await bootSocket({ config: { msgRetryCounterCache: undefined, retryRequestDelayMs: 0 } });
internal.sock.ws.emit('CB:message', T.undecryptableStanza(T.PEER_PN, 'OWN-B'));
const askedOfInternal = await internal.waitForXml("type='retry'", 15000);
console.log('asked-with-internal-cache=' + askedOfInternal.length);
assert.equal(askedOfInternal.length, 1, 'the library-owned counter must read a miss as "nothing charged yet": the first retry request is the entire point of this path');
internal.stop();
`);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
});

test('a stanza with nothing to decrypt is logged, not just stamped', async () => {
	const entries = [];
	const rec = level => (...a) => entries.push([level, ...a]);
	const logger = {
		level: 'debug',
		trace: rec('trace'), debug: rec('debug'), info: rec('info'),
		warn: rec('warn'), error: rec('error'),
		child() { return this; }
	};
	// nothing decryptable: no <enc>, no <plaintext>, and not a view_once
	const stanza = {
		tag: 'message',
		attrs: { id: 'ABSENT-1', from: '628111:1@s.whatsapp.net', t: '1700000000' },
		content: [{ tag: 'rate-limit', attrs: {} }]
	};
	const decoded = decryptMessageNode(stanza, '111111:1@s.whatsapp.net', '999999:1@lid', {}, logger);
	await decoded.decrypt();
	const { fullMessage } = decoded;
	const text = entries
		.map(e => e.slice(1).map(a => { try { return JSON.stringify(a); } catch { return String(a); } }).join(' '))
		.join('\n');
	console.log(text);
	assert.deepEqual(fullMessage.messageStubParameters, ['Message absent from node'], 'precondition: this is the branch under test');
	assert.ok(
		entries.some(e => JSON.stringify(e).includes('ABSENT-1')),
		'the branch that stamps a CIPHERTEXT stub for an absent message logged nothing, so the stub appears with no reason: ' + text
	);
});
