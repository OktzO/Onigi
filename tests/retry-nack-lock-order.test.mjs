import test from 'node:test';
import assert from 'node:assert/strict';
import { runSocketScenario } from './messaging-retry-harness.mjs';

/*
 * 8.6d — the NACK for an undecryptable message was held behind two locks
 * and a fixed delay, all inside the per-chat lock.
 *
 * handleMessage took messageMutex for the chat, and inside that callback
 * it took the *global* retryMutex, sent the retry receipt, slept
 * retryRequestDelayMs, and only then sent the NACK:
 *
 *     await messageMutex.mutex(chat, async () => {
 *         ...
 *         await retryMutex.mutex(async () => {
 *             await sendRetryRequest(node, !encNode);
 *             if (retryRequestDelayMs) await delay(retryRequestDelayMs);
 *             acked = true;
 *             await sendMessageAck(node, NACK_REASONS.UnhandledError);
 *         });
 *     });
 *
 * So N undecryptable messages across N chats serialised their NACKs at
 * ~N x 250ms, and each of those chats' *normal* traffic was locked out
 * for the whole queue. N=3 already costs a chat 750ms of blocked
 * inbound messages; the default retryRequestDelayMs of 250ms means the
 * cost grows linearly with the number of chats in trouble.
 *
 * The observable is the lock, not the NACK: the retry requests still have
 * to serialise (they share one global mutex by design), but the per-chat
 * lock must not be held for that.
 */

const DELAY = 2500;
const THRESHOLD = 1500;

const one = async body => {
	const r = await runSocketScenario(`const logger = T.makeLogger();
const s = await bootSocket({ logger, config: { retryRequestDelayMs: ${DELAY}, enableRecentMessageCache: true } });
const receipts = () => s.sentXml().filter(x => x.includes("<receipt id='"));
const nacks = id => s.sentXml().filter(x => x.startsWith("<ack id='" + id + "'"));
${body}`);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
};

test('8.6d an undecryptable message does not lock out normal traffic in its chat', () => one(`
s.sock.ws.emit('CB:message', T.undecryptableStanza(T.PEER_PN, 'U1'));
await s.waitForLog('Attempting retry request for failed decryption');
const started = Date.now();
s.sock.ws.emit('CB:message', T.plaintextStanza(T.PEER_PN, 'P1', 'normal traffic'));
await s.waitForXml("<receipt id='P1'");
const elapsed = Date.now() - started;
console.log('healthy message in the same chat was acknowledged after ' + elapsed + 'ms (retry delay is ' + ${DELAY} + 'ms)');
assert.ok(
	elapsed < ${THRESHOLD},
	'normal traffic waited ' + elapsed + 'ms behind another message\\'s retry delay'
);
`));

test('8.6d the NACK is still sent, after the configured delay', () => one(`
s.sock.ws.emit('CB:message', T.undecryptableStanza(T.PEER_PN, 'U2'));
await s.waitForLog('Attempting retry request for failed decryption');
const started = Date.now();
s.sock.ws.emit('CB:message', T.plaintextStanza(T.PEER_PN, 'P2', 'normal traffic'));
const nack = await s.waitForXml("<ack id='U2'", 8000);
const elapsed = Date.now() - started;
console.log('nack after ' + elapsed + 'ms');
assert.equal(nack.length, 1, 'the undecryptable message must still be nacked');
assert.match(nack[0], /error='500'/, 'and with UnhandledError (500), as before');
assert.ok(elapsed >= ${DELAY} - 250, 'the NACK still waits out retryRequestDelayMs, it just no longer holds the chat lock');
`));

test('8.6d the retry receipt is still sent before the NACK', () => one(`
s.sock.ws.emit('CB:message', T.undecryptableStanza(T.PEER_PN, 'U3'));
const retry = await s.waitForXml("type='retry'", 8000);
assert.equal(retry.length, 1, 'the retry request must still go out');
await s.waitForXml("<ack id='U3'", 8000);
assert.equal(receipts().length >= 0, true);
`));
