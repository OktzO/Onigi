import test from 'node:test';
import assert from 'node:assert/strict';
import { runSocketScenario } from './messaging-retry-harness.mjs';

/*
 * 8.6a — the retry reason code never reached shouldRecreateSession.
 *
 * MessageRetryManager.shouldRecreateSession(jid, hasSession, errorCode)
 * has an immediate-recreation branch for MAC errors (codes 4 and 7) and
 * otherwise falls through to an hourly backoff that sets its history on
 * the first retry and then returns recreate:false for an hour. Both call
 * sites passed two arguments, so errorCode was always undefined and
 * parseRetryErrorCode / isMacError had no call sites at all. The retry
 * receipt this library *sends* hardcoded error:'0'.
 *
 * The consequence: an inbound MAC failure, the one case where the peer's
 * session is provably out of sync, took the hourly branch. The session
 * was rebuilt once and then left broken for an hour, while retries 2..5
 * went out over it at a fixed delay(250) until the cap dropped the
 * message.
 */

const MAC = 'MAC verification failed';

const one = async (over, body) => {
	const r = await runSocketScenario(`const logger = T.makeLogger();
const keys = T.makeKeyStore();
const s = await bootSocket({ logger, keys, ...${JSON.stringify(over)} });
const receipts = () => s.sentXml().filter(x => x.includes("type='retry'"));
${body}`);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
};

test('8.6a an inbound MAC failure is reported as retry reason 7, not 0', () => one(
	{ config: { enableRecentMessageCache: true } },
	`
s.sock.ws.emit('CB:message', T.undecryptableStanza(T.PEER_PN, 'M1'));
await s.waitForXml("type='retry'");
const attrs = receipts().map(x => /error='(\\d+)'/.exec(x)?.[1]);
console.log('outgoing retry error attrs = ' + JSON.stringify(attrs));
assert.ok(attrs.length > 0, 'a retry receipt must have been sent');
assert.deepEqual([...new Set(attrs)], ['7'], 'a MAC failure is SignalErrorBadMac (7), not 0');
`
));

test('8.6a a MAC failure keeps recreating the session on every retry', () => one(
	{ config: { enableRecentMessageCache: true } },
	`
for (let i = 0; i < 3; i++) {
	s.sock.ws.emit('CB:message', T.undecryptableStanza(T.PEER_PN, 'M1'));
	await tick(500);
}
console.log('session resets = ' + keys.sessionWrites.length);
assert.equal(
	keys.sessionWrites.length,
	2,
	'retry 2 and retry 3 must both rebuild a session that failed a MAC check, got ' + keys.sessionWrites.length
);
`
));

test('8.6a a peer retry reporting a MAC error keeps recreating our session', () => one(
	{ config: { enableRecentMessageCache: true }, signalOverrides: { distinctSessionBaseKeys: true } },
	`
s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, 'M2', { conversation: 'resend me' });
for (const count of [1, 2, 3]) {
	s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: 'M2', participant: T.PEER_PN, count, error: '7', bundle: false }));
	await tick(600);
}
console.log('session resets = ' + keys.sessionWrites.length);
assert.equal(
	keys.sessionWrites.length,
	2,
	'the 2nd and 3rd peer retry for a MAC error must both rebuild the session, got ' + keys.sessionWrites.length
);
`
));

test('8.6a a peer retry with no error code still uses the hourly backoff', () => one(
	{ config: { enableRecentMessageCache: true }, signalOverrides: { distinctSessionBaseKeys: true } },
	`
s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, 'M3', { conversation: 'resend me' });
for (const count of [1, 2, 3]) {
	s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: 'M3', participant: T.PEER_PN, count, error: '0', bundle: false }));
	await tick(600);
}
console.log('session resets = ' + keys.sessionWrites.length);
assert.equal(
	keys.sessionWrites.length,
	1,
	'without a MAC error the hourly backoff must still allow exactly one rebuild, got ' + keys.sessionWrites.length
);
`
));

test('8.6a the MAC branch is taken regardless of how recently the session was rebuilt', () => one(
	{ config: { enableRecentMessageCache: true }, signalOverrides: { distinctSessionBaseKeys: true } },
	`
s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, 'M4', { conversation: 'resend me' });
s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: 'M4', participant: T.PEER_PN, count: 1, error: '0', bundle: false }));
await tick(500);
// prime the hourly history the way an unrelated earlier retry would
s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: 'M4', participant: T.PEER_PN, count: 2, error: '0', bundle: false }));
await tick(600);
const primed = keys.sessionWrites.length;
s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: 'M4', participant: T.PEER_PN, count: 3, error: '7', bundle: false }));
await tick(600);
console.log('session resets: after priming = ' + primed + ', after the MAC retry = ' + keys.sessionWrites.length);
assert.ok(primed >= 1, 'precondition: the hourly branch fired at least once');
assert.equal(keys.sessionWrites.length, primed + 1, 'a MAC error must bypass the hourly backoff');
`
));

test('8.6a parseRetryErrorCode and isMacError are wired to call sites', async () => {
	const { MessageRetryManager, RetryReason } = await import('../lib/Utils/message-retry-manager.js');
	const m = new MessageRetryManager({ debug() { }, warn() { } }, 5);
	assert.equal(m.parseRetryErrorCode('7'), RetryReason.SignalErrorBadMac);
	assert.equal(m.parseRetryErrorCode('0'), RetryReason.UnknownError);
	assert.equal(m.isMacError(RetryReason.SignalErrorBadMac), true);
	assert.equal(m.isMacError(RetryReason.SignalErrorNoSession), false);
	assert.equal(m.shouldRecreateSession('a@s.whatsapp.net', true, RetryReason.SignalErrorBadMac).recreate, true);
	assert.equal(m.shouldRecreateSession('a@s.whatsapp.net', true, RetryReason.SignalErrorNoSession).recreate, false);
});
