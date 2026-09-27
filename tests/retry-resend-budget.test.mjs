import test from 'node:test';
import assert from 'node:assert/strict';
import { runSocketScenario } from './messaging-retry-harness.mjs';

/*
 * 8.1 / 8.2 / 8.4 — the resend budget.
 *
 * One reproduction shows all three. A peer device asks for a resend five
 * times; the library must re-send five times. Measured against a real socket:
 *
 *   - the `${id}:${participant}` counter is charged TWICE per receipt, once by
 *     handleReceipt and again by sendMessagesAgain, so `maxMsgRetryCount: 5`
 *     cannot buy five resends (8.1);
 *   - markRetrySuccess() fires on a cache *hit*, ~80 lines before relayMessage
 *     runs, and evicts the cached message, so the very next receipt can no
 *     longer find it and the rest of the budget is spent on nothing (8.2);
 *   - and when it cannot find it, the library says so at `debug` level, which
 *     in the default configuration (no store, no recent-message cache, no
 *     getMessage) is the only signal the user gets (8.4).
 */

const MSG_ID = 'MSGID-RESEND-BUDGET';
const CACHED = { config: { enableRecentMessageCache: true } };
const one = async (over, body) => {
	const r = await runSocketScenario(`const s = await bootSocket(${JSON.stringify(over)});\n${body}`);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
};

test('8.1 one peer retry receipt charges the resend counter exactly once', () => one(CACHED, `
s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, ${JSON.stringify(MSG_ID)}, { conversation: 'resend me' });
s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: ${JSON.stringify(MSG_ID)}, participant: T.PEER_PN, count: 1 }));
await tick(400);
const charged = await s.counter(${JSON.stringify(MSG_ID)}, T.PEER_PN);
assert.equal(charged, 1, 'one receipt must buy exactly one resend, not two');
`));

test('8.1 maxMsgRetryCount receipts buy maxMsgRetryCount resends', () => one(CACHED, `
s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, ${JSON.stringify(MSG_ID)}, { conversation: 'resend me' });
let resends = 0;
for (let count = 1; count <= 5; count++) {
	const before = s.signal.encryptCalls.length;
	s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: ${JSON.stringify(MSG_ID)}, participant: T.PEER_PN, count }));
	await tick(400);
	if (s.signal.encryptCalls.length > before) resends++;
}
console.log('resends=' + resends);
assert.equal(resends, 5, 'maxMsgRetryCount: 5 must buy 5 resends, got ' + resends);
`));

test('8.2 a served resend leaves the message available for the next device', () => one(CACHED, `
s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, ${JSON.stringify(MSG_ID)}, { conversation: 'resend me' });
s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: ${JSON.stringify(MSG_ID)}, participant: T.PEER_PN, count: 1 }));
await tick(400);
const cached = s.sock.messageRetryManager.getRecentMessage(T.PEER_PN, ${JSON.stringify(MSG_ID)});
assert.ok(cached, 'one device asking for a resend must not consume the message for every other device');
assert.deepEqual(cached.message, { conversation: 'resend me' });
`));

test('8.2 markRetrySuccess runs only after the resend reached the wire', () => one({
	config: { enableRecentMessageCache: true },
	signalOverrides: { encryptMessage: 'no session' }
}, `
s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, ${JSON.stringify(MSG_ID)}, { conversation: 'resend me' });
s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: ${JSON.stringify(MSG_ID)}, participant: T.PEER_PN, count: 1 }));
await s.waitForLog('error in sending message again');
assert.ok(
	s.sock.messageRetryManager.getRecentMessage(T.PEER_PN, ${JSON.stringify(MSG_ID)}),
	'a resend that never reached the wire must leave the message cached for the peer to retry again'
);
assert.equal(
	s.sock.messageRetryManager.getRetryCount(${JSON.stringify(MSG_ID)}),
	0,
	'a resend that failed must not be recorded as a successful retry'
);
`));

test('8.2 two peer devices each get their resend from the same cached message', () => one(CACHED, `
s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, ${JSON.stringify(MSG_ID)}, { conversation: 'resend me' });
s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: ${JSON.stringify(MSG_ID)}, from: T.PEER_PN, participant: '628111:2@s.whatsapp.net', count: 1 }));
await tick(400);
const afterFirst = s.signal.encryptCalls.length;
s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: ${JSON.stringify(MSG_ID)}, from: T.PEER_PN, participant: '628111:3@s.whatsapp.net', count: 1 }));
await tick(400);
assert.ok(
	s.signal.encryptCalls.length > afterFirst,
	'a second device reporting a decryption failure must still be served the message'
);
`));

test('8.4 an unservable retry request is reported above debug level', () => one({}, `
s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: 'MSGID-NOT-CACHED', participant: T.PEER_PN, count: 1 }));
await s.waitForLog('but message not available');
const noisy = s.logger.find(undefined, 'but message not available');
assert.equal(noisy.length, 1, 'the failure must be reported once per unservable id, got ' + noisy.length);
assert.notEqual(noisy[0][0], 'debug', 'a dead-end resend path reported at debug level is invisible in production');
const text = s.logger.texts().find(t => t.includes('but message not available'));
assert.match(text, /enableRecentMessageCache|getMessage/, 'the message must name what to configure');
`));

test('8.4 an unservable retry request puts nothing on the wire', () => one({}, `
s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: 'MSGID-NOT-CACHED', participant: T.PEER_PN, count: 1 }));
await s.waitForLog('but message not available');
assert.deepEqual(s.signal.encryptCalls, [], 'nothing may be re-sent when the message is not available');
`));

test('8.1 a healthy resend sends exactly the requested message once', () => one(CACHED, `
s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, ${JSON.stringify(MSG_ID)}, { conversation: 'resend me' });
s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: ${JSON.stringify(MSG_ID)}, participant: T.PEER_PN, count: 1 }));
await s.waitForXml("<message id='" + ${JSON.stringify(MSG_ID)});
const stanzas = s.sentXml().filter(x => x.includes("<message id='" + ${JSON.stringify(MSG_ID)} + "'"));
assert.equal(stanzas.length, 1, 'a single receipt must not fan out twice: ' + stanzas.length);
`));
