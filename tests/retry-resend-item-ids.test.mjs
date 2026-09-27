import test from 'node:test';
import assert from 'node:assert/strict';
import { runSocketScenario } from './messaging-retry-harness.mjs';

/*
 * 1985d92 removed the per-<item>-id check and charge from the resend loop, on the
 * grounds that handleReceipt had "already applied" the budget. It had applied it
 * to exactly one id:
 *
 *     const ids = [attrs.id];
 *     if (Array.isArray(content)) {
 *         const items = getBinaryNodeChildren(content[0], 'item');
 *         ids.push(...items.map(i => i.attrs.id));     // :1206-1210
 *     }
 *     ...
 *     if (ids[0] && key.participant && (await willSendMessageAgain(ids[0], key.participant))) {
 *         await updateSendMessageAgainCount(ids[0], key.participant);   // :1242-1245
 *
 * ids[0] is the receipt's OWN attrs.id. The messages that actually go back on
 * the wire come from the <item> list, and their ids were charged by nothing --
 * measured, after one multi-item receipt: counters P0=1, P1..P4=undefined. The
 * peer's own maxMsgRetryCount check does not close the gap either; this side is
 * what caps it.
 *
 * Combined with 8.2 (markRetrySuccess no longer evicts the cached message, so a
 * served resend leaves the message available), a peer can rotate attrs.id and
 * have the same cached message re-sent for ever. Before 1985d92 the 8.2
 * cache-eviction bug self-limited this to one resend, so a bounded budget was
 * traded for an unbounded one -- and both commits carry passing tests, because
 * tests/retry-resend-budget.test.mjs only ever emits single-id receipts, which
 * is the one shape the cap still bounds.
 *
 * Measured against a real socket, enableRecentMessageCache, maxMsgRetryCount 5:
 *
 *   20 receipts, attrs.id rotating, each asking for <item id='M0'/>  -> 20 resends
 *   10 items x 8 receipts                                             -> 110 resends
 *   control, receipt asks for attrs.id itself                        -> 5 (correct)
 *
 * One receipt's <item> list is peer controlled too, so its length is bounded
 * here: unbounded ids means unbounded cache/getMessage lookups and an unbounded
 * fanout out of a single stanza.
 */

const CACHED = { config: { enableRecentMessageCache: true } };
/** The bound put on one receipt's <item> list, mirrored from messages-recv.js. */
const MAX_RETRY_ITEM_IDS = 20;

/** Child-side helpers: a scenario body only has T, bootSocket, tick and assert. */
const PRELUDE = `
const rotatingReceipt = (rid, itemIds) => ({
	tag: 'receipt',
	attrs: { id: rid, from: T.PEER_PN, participant: T.PEER_PN, t: '1700000000', type: 'retry' },
	content: [
		{ tag: 'list', attrs: {}, content: itemIds.map(id => ({ tag: 'item', attrs: { id } })) },
		{ tag: 'retry', attrs: { count: '1', id: rid, t: '1700000000', v: '1', error: '0' } },
		...T.keyBundle()
	]
});
const stanzasFor = id => s.sentXml().filter(x => x.includes("<message id='" + id + "'")).length;
`;

const one = async (over, body) => {
	const r = await runSocketScenario(`const s = await bootSocket(${JSON.stringify(over)});\n${PRELUDE}\n${body}`);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
};

test('a peer rotating attrs.id cannot re-send the same cached message for ever', () => one(CACHED, `
s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, 'M0', { conversation: 'the one true message' });
let resends = 0;
for (let i = 0; i < 20; i++) {
	const before = s.signal.encryptCalls.length;
	s.sock.ws.emit('CB:receipt', rotatingReceipt('ROT-' + i, ['M0']));
	await tick(400);
	if (s.signal.encryptCalls.length > before) resends++;
}
console.log('RESENDS=' + resends);
assert.equal(resends, 5, 'the budget is maxMsgRetryCount (5) per message, whatever the receipt calls itself: got ' + resends);
assert.equal(await s.counter('M0', T.PEER_PN), 5, 'the <item> id is the id that is charged, not the receipt attrs.id');
assert.ok(s.sock.messageRetryManager.getRecentMessage(T.PEER_PN, 'M0'), 'a served resend leaves the message cached for the peer to ask again');
`));

test('every id in one receipt gets its own budget', () => one(CACHED, `
const ids = Array.from({ length: 10 }, (_, i) => 'N' + i);
for (const id of ids) s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, id, { conversation: id });
let total = 0;
const perReceipt = [];
for (let count = 1; count <= 8; count++) {
	const before = s.signal.encryptCalls.length;
	s.sock.ws.emit('CB:receipt', rotatingReceipt('RCPT-' + count, ids));
	await tick(1200);
	const d = s.signal.encryptCalls.length - before;
	total += d;
	perReceipt.push(d);
}
console.log('PER_RECEIPT=' + perReceipt.join(','));
console.log('TOTAL=' + total);
for (const id of ids) {
	assert.equal(await s.counter(id, T.PEER_PN), 5, id + ' must be charged its own budget of 5, got ' + await s.counter(id, T.PEER_PN));
	assert.equal(stanzasFor(id), 5, id + ' must go back on the wire at most 5 times, got ' + stanzasFor(id));
}
assert.equal(perReceipt.slice(5).every(d => d === 0), true, 'receipts past the budget must put nothing on the wire: ' + perReceipt.join(','));
`));

test('one receipt cannot ask for an unbounded list', () => one(CACHED, `
const ids = Array.from({ length: 200 }, (_, i) => 'B' + i);
for (const id of ids) s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, id, { conversation: id });
s.sock.ws.emit('CB:receipt', rotatingReceipt('BULK', ids));
await tick(4000);
const answered = new Set(s.sentXml().map(x => (/<message id='([^']+)'/.exec(x) || [])[1]).filter(Boolean));
console.log('ANSWERED=' + answered.size);
assert.ok(answered.size <= ${MAX_RETRY_ITEM_IDS}, 'one receipt may be answered for at most ${MAX_RETRY_ITEM_IDS} messages, got ' + answered.size);
// ids = ['BULK', ...200 item ids] and the bound covers the whole list, so 20 ids
// are considered; the receipt's own id is not in the cache, leaving 19 answers.
assert.equal(answered.size, ${MAX_RETRY_ITEM_IDS - 1}, 'the bound is on the id list, attrs.id included');
`));

test('a receipt cannot spend one id budget twice in a single receipt', () => one(CACHED, `
s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, 'D0', { conversation: 'x' });
const before = s.signal.encryptCalls.length;
s.sock.ws.emit('CB:receipt', rotatingReceipt('D0', ['D0', 'D0', 'D0', 'D0', 'D0', 'D0', 'D0', 'D0', 'D0', 'D0']));
await tick(1200);
console.log('RELAYS=' + (s.signal.encryptCalls.length - before));
console.log('STANZAS=' + stanzasFor('D0'));
console.log('COUNTER=' + await s.counter('D0', T.PEER_PN));
assert.equal(stanzasFor('D0'), 1, 'one receipt asking ten times for the same id gets it once, not ten stanzas');
assert.equal(await s.counter('D0', T.PEER_PN), 1, 'the id must be charged once per receipt, not once per occurrence');
`));

test('a single-id receipt is still bounded exactly as before', () => one(CACHED, `
// the control 1985d92 did not break: a receipt with no <list> asks for attrs.id
s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, 'M0', { conversation: 'x' });
let resends = 0;
for (let i = 0; i < 20; i++) {
	const before = s.signal.encryptCalls.length;
	s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: 'M0', participant: T.PEER_PN, count: i + 1 }));
	await tick(400);
	if (s.signal.encryptCalls.length > before) resends++;
}
console.log('RESENDS=' + resends);
assert.equal(resends, 5, 'maxMsgRetryCount: 5 must buy 5 resends, got ' + resends);
assert.equal(await s.counter('M0', T.PEER_PN), 5);
`));

test('a receipt that asks only for unknown ids puts nothing on the wire', () => one(CACHED, `
let resends = 0;
for (let i = 0; i < 6; i++) {
	const before = s.signal.encryptCalls.length;
	s.sock.ws.emit('CB:receipt', rotatingReceipt('MISS-' + i, ['NOPE-' + i]));
	await tick(400);
	if (s.signal.encryptCalls.length > before) resends++;
}
console.log('RESENDS=' + resends);
assert.equal(resends, 0, 'an unservable id must not reach the wire');
`));
