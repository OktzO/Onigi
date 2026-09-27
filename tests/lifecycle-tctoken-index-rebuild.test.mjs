import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMergedTcTokenIndexWrite, readTcTokenIndex, TC_TOKEN_INDEX_KEY } from '../lib/Utils/tc-token-utils.js';

/*
 * readTcTokenIndex() conflated two states that mean opposite things:
 *
 *     const entry = data[TC_TOKEN_INDEX_KEY];
 *     if (!entry?.token?.length) return [];        // absent  -> []
 *     ...
 *     if (!Array.isArray(parsed)) return [];       // garbage  -> []
 *     return parsed.filter(...);                   // empty    -> []
 *
 * "there is no usable index, rebuild it" and "the index says there is nothing
 * to prune" are the same value, so a caller cannot tell them apart. The
 * consequence is that cross-session pruning silently becomes a no-op: nothing
 * is ever pruned, and nothing ever says why.
 *
 * The contract: absent, empty, unparseable or non-array all mean "no index" and
 * are reported as undefined, so the caller can rebuild instead of concluding
 * there was nothing to do. A present index with entries is still returned.
 */
const keys = (stored) => ({
	get: async (type, ids) => {
		const v = stored?.[type];
		const out = {};
		for (const id of ids || []) {
			out[id] = v?.[id];
		}
		return out;
	}
});

const withIndex = (value) => keys({ tctoken: { [TC_TOKEN_INDEX_KEY]: { token: Buffer.from(JSON.stringify(value)) } } });

test('an absent index is reported as no index, not as empty', async () => {
	assert.equal(await readTcTokenIndex(keys({})), undefined);
	assert.equal(await readTcTokenIndex(keys()), undefined);
});

test('a stored empty index is reported as no index', async () => {
	assert.equal(await readTcTokenIndex(withIndex([])), undefined);
});

test('a token with no bytes is reported as no index', async () => {
	assert.equal(await readTcTokenIndex(keys({ tctoken: { [TC_TOKEN_INDEX_KEY]: { token: Buffer.alloc(0) } } })), undefined);
	assert.equal(await readTcTokenIndex(keys({ tctoken: { [TC_TOKEN_INDEX_KEY]: {} } })), undefined);
});

test('an unparseable or non-array token is reported as no index', async () => {
	assert.equal(await readTcTokenIndex(withIndex('nonsense')), undefined);
	assert.equal(await readTcTokenIndex(withIndex({ a: 1 })), undefined);
});

test('a real index comes back with the sentinel filtered out', async () => {
	assert.deepEqual(
		await readTcTokenIndex(withIndex(['a@s.whatsapp.net', TC_TOKEN_INDEX_KEY, '', 'b@s.whatsapp.net', 7])),
		['a@s.whatsapp.net', 'b@s.whatsapp.net']
	);
});

test('buildMergedTcTokenIndexWrite starts a fresh index when there is none', async () => {
	// new Set(undefined) throws, which is what a caller would hit on the very
	// first tctoken issued after a restart
	const write = await buildMergedTcTokenIndexWrite(keys({}), ['a@s.whatsapp.net']);
	const parsed = JSON.parse(Buffer.from(write[TC_TOKEN_INDEX_KEY].token).toString());
	assert.deepEqual(parsed, ['a@s.whatsapp.net']);
});

test('buildMergedTcTokenIndexWrite unions onto an existing index', async () => {
	const write = await buildMergedTcTokenIndexWrite(withIndex(['a@s.whatsapp.net']), ['b@s.whatsapp.net']);
	const parsed = JSON.parse(Buffer.from(write[TC_TOKEN_INDEX_KEY].token).toString());
	assert.deepEqual(parsed.sort(), ['a@s.whatsapp.net', 'b@s.whatsapp.net']);
});
