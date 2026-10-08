import assert from 'node:assert/strict';
import test from 'node:test';
import { addTransactionCapability } from '../lib/Utils/auth-utils.js';

const noopLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

const tick = ms => new Promise(res => setTimeout(res, ms));

test('transactions with different keys against the same store do not interleave', async () => {
	const state = {
		get: async () => ({}),
		set: async () => {}
	};
	const keys = addTransactionCapability(state, noopLogger, { maxCommitRetries: 1, delayBetweenTriesMs: 1 });
	const order = [];
	let release;
	const gate = new Promise(res => { release = res; });
	const t1 = keys.transaction(async () => {
		order.push('A-start');
		await gate;
		order.push('A-end');
	}, 'key-a');
	await tick(20);
	const t2 = keys.transaction(async () => {
		order.push('B-start');
		order.push('B-end');
	}, 'key-b');
	await tick(30);
	release();
	await Promise.all([t1, t2]);
	assert.deepEqual(order, ['A-start', 'A-end', 'B-start', 'B-end']);
});
