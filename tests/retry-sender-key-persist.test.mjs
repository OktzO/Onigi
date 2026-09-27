import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCacheableSignalKeyStore } from '../lib/Utils/auth-utils.js';
import { GROUP_JID, runSocketScenario } from './messaging-retry-harness.mjs';

/*
 * 8.3 — the sender-key distribution side of the group send.
 *
 * relayMessage marks every device that has not been sent a
 * senderKeyDistributionMessage in the `sender-key-memory` map for the
 * group, and persists that map *before* it writes the stanza. The stanza
 * goes out ~260 lines later, after device-identity, reporting-token and
 * tctoken work, so a transport failure at sendNode left the map already
 * claiming the sender key had been distributed.
 *
 * The map is the *only* record of that: the next group send reads it,
 * sees hasKey === true, and adds nothing to senderKeyRecipients, so no
 * SKDM is sent at all. Those devices never obtain the sender key, so
 * every later group message is undecryptable for them, with nothing on
 * the wire and nothing in the log to say so. Only the peer's own retry
 * receipt, which nulls the map, heals it.
 *
 * Measured with makeCacheableSignalKeyStore -- the first-party store
 * wrapper this package exports, whose NodeCache runs useClones: false --
 * a failed group send left "628111:5@s.whatsapp.net": true in the store
 * and the next, healthy send distributed to 0 devices.
 */

const PRELUDE = `
const persisted = new Map();
const store = {
	get: async (type, ids) => Object.fromEntries(ids.map(id => [id, persisted.get(type + '/' + id)])),
	set: async data => { for (const t in data) for (const id in data[t]) persisted.set(t + '/' + id, data[t][id]); },
	del: async () => { }
};
const keys = makeCacheableSignalKeyStore(store, logger, T.makeNodeCache({ maxKeys: 100, stdTTL: 600000, useClones: false, deleteOnExpire: true }));
const devices = {
	'111111': [{ user: '111111', server: 's.whatsapp.net', device: 0 }],
	'628111': [{ user: '628111', server: 's.whatsapp.net', device: 0 }],
	'777777': [{ user: '777777', server: 'lid', device: 0 }]
};
const devCache = T.makeDeviceCache(devices);
const s = await bootSocket({
	logger,
	keys,
	config: { cachedGroupMetadata: async () => T.groupMetadata(), userDevicesCache: devCache }
});
const rawSend = s.sock.ws.socket.send.bind(s.sock.ws.socket);
const healWire = () => { s.sock.ws.socket.send = rawSend; };
const breakWire = () => { s.sock.ws.socket.send = (_d, cb) => cb(new Error('Connection Closed')); };
const memory = () => persisted.get('sender-key-memory/' + T.GROUP_JID) || {};
const send = async text => {
	s.signal.encryptCalls.length = 0;
	await s.sock.sendMessage(T.GROUP_JID, { text });
	return s.signal.encryptCalls.slice();
};
`;

const one = async body => {
	const r = await runSocketScenario(
		`const { makeCacheableSignalKeyStore } = await import(${JSON.stringify(new URL('../lib/Utils/auth-utils.js', import.meta.url).href)});\n`
		+ `const logger = T.makeLogger();\n${PRELUDE}\n${body}`
	);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
};

test('8.3 a group send that never reached the wire does not record the sender key', () => one(`
await send('one');
devices['628111'].push({ user: '628111', server: 's.whatsapp.net', device: 5 });
breakWire();
try { await s.sock.sendMessage(T.GROUP_JID, { text: 'two' }); } catch { }
console.log('memory after the failed send = ' + JSON.stringify(memory()));
assert.equal(
	memory()['628111:5@s.whatsapp.net'],
	undefined,
	'the sender key was recorded for a device whose stanza never left the process'
);
`));

test('8.3 the next group send re-distributes the sender key a failed send missed', () => one(`
await send('one');
devices['628111'].push({ user: '628111', server: 's.whatsapp.net', device: 5 });
breakWire();
try { await s.sock.sendMessage(T.GROUP_JID, { text: 'two' }); } catch { }
healWire();
const healed = await send('three');
console.log('skdm recipients on the next send = ' + JSON.stringify(healed));
assert.deepEqual(
	healed,
	['628111:5@s.whatsapp.net'],
	'the device the failed send skipped must be given the sender key on the next send'
);
`));

test('8.3 a clean group send does record the sender key', () => one(`
const first = await send('one');
healWire();
assert.equal(first.length, 3, 'the first group send distributes to every device');
assert.equal(memory()['628111@s.whatsapp.net'], true, 'a delivered sender key must be remembered');
`));

test('8.3 a second clean group send distributes to nobody new', () => one(`
await send('one');
const second = await send('two');
assert.deepEqual(second, [], 'a device that already has the sender key must not be re-sent it');
`));

test('8.3 a store that clones on read is not poisoned by a failed send', () => one(`
const cloning = T.makeKeyStore();
const s2 = await bootSocket({
	logger,
	keys: cloning,
	config: { cachedGroupMetadata: async () => T.groupMetadata(), userDevicesCache: devCache }
});
devices['628111'].push({ user: '628111', server: 's.whatsapp.net', device: 5 });
s2.sock.ws.socket.send = (_d, cb) => cb(new Error('Connection Closed'));
try { await s2.sock.sendMessage(T.GROUP_JID, { text: 'two' }); } catch { }
assert.equal(
	cloning.map.get('sender-key-memory'),
	undefined,
	'a failed send must not leave a sender-key-memory write behind'
);
`));
