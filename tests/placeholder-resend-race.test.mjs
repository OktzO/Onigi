import test from 'node:test';
import assert from 'node:assert/strict';
import { runSocketScenario } from './messaging-retry-harness.mjs';

/*
 * requestPlaceholderResend asks the phone to re-send a message we only have a
 * CIPHERTEXT stub for. Two defects made that ask fire more than once:
 *
 *  (a) the cache read, the decision and the cache write were three separate
 *      awaits, so two concurrent calls for one message both read a miss, both
 *      stored, and both went on to send a placeholderMessageResendRequest for
 *      the same message. Same shape Task 11 fixed for the retry counter.
 *  (b) the cache key is messageKey?.id, so a keyless messageKey filed itself
 *      under the literal key "undefined" and every such message shared one
 *      entry: the first arrival resolving the resend request for all of them.
 */

const one = async (over, body) => {
	const r = await runSocketScenario(`${helper}const s = await bootSocket(${JSON.stringify(over)});\n${body}`);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
};

const helper = "const resendRequests = s => s.sentXml().filter(x => x.includes(\"category='peer'\"));\n";

test('two concurrent resend requests for one message send one ask', () => one(
	{ config: { retryRequestDelayMs: 0 } },
	`
const key = { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'DUP-1' };
const [a, b] = await Promise.all([
	s.sock.requestPlaceholderResend(key),
	s.sock.requestPlaceholderResend(key)
]);
await tick(300);
const asks = resendRequests(s);
console.log('ASKS=' + asks.length + ' RESULTS=' + JSON.stringify([a, b]));
assert.equal(asks.length, 1, 'the peer must be asked once for one message, got ' + asks.length + ' asks');
assert.equal([a, b].filter(Boolean).length, 1, 'exactly one call did the work and the other declined: ' + JSON.stringify([a, b]));
assert.equal(typeof (a || b), 'string', 'the winner returns the PDO request id it sent');
s.stop();
`
));

test('a message key with no id is rejected, not filed under "undefined"', () => one(
	{ config: { retryRequestDelayMs: 0 } },
	`
const writes = [];
const store = {
	get: async () => undefined,
	set: async (k, v) => { writes.push(k); },
	del: async () => { }
};
const s2 = await bootSocket({ config: { retryRequestDelayMs: 0, placeholderResendCache: store } });
let thrown = null;
try {
	await s2.sock.requestPlaceholderResend({ remoteJid: '628111@s.whatsapp.net', fromMe: false });
}
catch (err) {
	thrown = err;
}
console.log('THROWN=' + (thrown && thrown.message) + ' ISBOOM=' + Boolean(thrown && thrown.isBoom) + ' WRITES=' + JSON.stringify(writes));
assert.ok(thrown, 'a keyless message cannot be resend-requested and must say so');
assert.ok(thrown.isBoom, 'the file reports its other precondition with a Boom, so this one is too: ' + String(thrown));
assert.equal(writes.length, 0, 'nothing may be written under a shared key: ' + JSON.stringify(writes));
assert.equal(writes.filter(k => String(k).includes('undefined')).length, 0, 'the string "undefined" must never become a cache key');
assert.equal(resendRequests(s2).length, 0, 'and no resend request goes out');
s2.stop();
s.stop();
`
));