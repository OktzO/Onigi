import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_JID, runSocketScenario } from './messaging-retry-harness.mjs';

/*
 * 8.6e — the debounced device-list write.
 *
 * getUSyncDevices batches device lists into `pendingDeviceLists` and
 * flushes them 5s later in one keys.set, so a process that dies inside
 * that window loses the write. It is a persistence gap, not message
 * loss: the next usync re-derives the list, and lib/Signal/libsignal.js
 * only reads 'device-list' to answer getSessionInfo for prekeys.
 *
 * registerSocketEndHandler already flushes on shutdown, so this file
 * pins that behaviour against regression and records the window that is
 * left (a hard kill inside the debounce).
 */

const PRELUDE = `
const logger = T.makeLogger();
const keys = T.makeKeyStore();
const s = await bootSocket({
	logger,
	keys,
	usyncUsers: [{ jid: '628111@s.whatsapp.net', devices: [0, 2] }],
	config: { cachedGroupMetadata: async () => T.groupMetadata() }
});
// no device cache configured -> the real NodeCache is used and misses,
// so a usync query runs and queues a device-list write
const deviceList = () => keys.map.get('device-list') || {};
`;

const one = async body => {
	const r = await runSocketScenario(PRELUDE + body);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
};

test('8.6e a usync queues the device list rather than writing it immediately', () => one(`
await s.sock.sendMessage(T.GROUP_JID, { text: 'one' });
await s.waitForLog('queued user device lists for storage');
assert.deepEqual(deviceList(), {}, 'the write is debounced, not immediate');
`));

test('8.6e ending the socket inside the debounce window flushes the device list', () => one(`
await s.sock.sendMessage(T.GROUP_JID, { text: 'one' });
await s.waitForLog('queued user device lists for storage');
assert.deepEqual(deviceList(), {}, 'precondition: nothing persisted yet');
await s.sock.end(new Error('test teardown'));
for (let i = 0; i < 60 && Object.keys(deviceList()).length === 0; i++) await tick(20);
console.log('device-list after end() = ' + JSON.stringify(deviceList()));
assert.deepEqual(
	deviceList()['628111'],
	['0', '2'],
	'a shutdown inside the 5s debounce must still persist the queued device list'
);
`));

test('8.6e the debounce batches, so a burst of sends is one write', () => one(`
await s.sock.sendMessage(T.GROUP_JID, { text: 'one' });
await s.sock.sendMessage(T.GROUP_JID, { text: 'two' });
await s.sock.sendMessage(T.GROUP_JID, { text: 'three' });
await s.waitForLog('queued user device lists for storage');
const sets = [];
const realSet = keys.set;
keys.set = async data => { sets.push(Object.keys(data)); return realSet.call(keys, data); };
await s.sock.end(new Error('test teardown'));
for (let i = 0; i < 60 && Object.keys(deviceList()).length === 0; i++) await tick(20);
assert.deepEqual(deviceList()['628111'], ['0', '2']);
assert.deepEqual(sets, [['device-list']], 'a burst must collapse into a single device-list write, got ' + JSON.stringify(sets));
`));
