import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageRetryManager } from '../lib/Utils/message-retry-manager.js';

/*
 * 8.6c — the retry-counter cap is a fix, but it was silent.
 *
 * retryCounters is bounded at 5_000 entries with a 15-minute TTL, so a
 * burst larger than that evicts live counters: an evicted message's
 * retry budget restarts from zero. That is the intended trade (bounded
 * memory over an exact cap) and it is not a leak -- the audit confirmed
 * messageKeyIndex is correctly pruned by the recent-messages LRU's
 * dispose, 512/512. What was missing is any signal that it happened, so
 * a device that suddenly gets a full fresh budget looked like a
 * mystery.
 */

const collect = () => {
	const logs = [];
	const logger = { debug: (...a) => logs.push(['debug', ...a]), warn: (...a) => logs.push(['warn', ...a]), info: () => { }, error: () => { } };
	return { logs, logger };
};

test('8.6c evicting a retry counter under load is reported at debug level', () => {
	const { logs, logger } = collect();
	const m = new MessageRetryManager(logger, 5);
	// 5_000 is the cap; the 5_001st insert must evict the least-recently-used
	// counter rather than grow without bound.
	for (let i = 0; i < 5_000; i++) m.incrementRetryCount(`msg-${i}`);
	assert.equal(logs.length, 0, 'filling the cache is not an eviction');
	m.incrementRetryCount('msg-overflow');
	const evictions = logs.filter(l => l[0] === 'debug' && JSON.stringify(l).includes('msg-0"'));
	assert.equal(evictions.length, 1, 'the evicted counter must be named in the log');
	assert.match(JSON.stringify(evictions[0]), /retr/i, 'the message must say what kind of entry was dropped');
	assert.match(JSON.stringify(evictions[0]), /max/, 'the message must name the cap that dropped it');
});

test('8.6c updating a counter in place is not reported as an eviction', () => {
	const { logs, logger } = collect();
	const m = new MessageRetryManager(logger, 5);
	m.incrementRetryCount('msg-1');
	m.incrementRetryCount('msg-1');
	m.incrementRetryCount('msg-1');
	assert.deepEqual(logs, [], 'lru-cache fires dispose with reason "set" on a replacement; that is not an eviction');
	assert.equal(m.getRetryCount('msg-1'), 3);
});

test('8.6c the counters really are bounded', () => {
	const { logger } = collect();
	const m = new MessageRetryManager(logger, 5);
	for (let i = 0; i < 6_000; i++) m.incrementRetryCount(`msg-${i}`);
	assert.equal(m.retryCounters.size, 5_000, 'the cap must hold');
	// the oldest entries went, so their budgets restart -- which is the trade
	// this cap makes, and the reason the eviction has to be observable
	assert.equal(m.getRetryCount('msg-0'), 0);
	assert.equal(m.getRetryCount('msg-5999'), 1);
});

test('8.6c the recent-message index is not leaked by its own LRU', () => {
	const { logger } = collect();
	const m = new MessageRetryManager(logger, 5);
	for (let i = 0; i < 600; i++) m.addRecentMessage('x@s.whatsapp.net', `msg-${i}`, { conversation: 'hi' });
	assert.equal(m.recentMessagesMap.size, 512, 'the message cache is capped');
	assert.equal(m.messageKeyIndex.size, 512, 'every eviction must prune the id index too');
});
