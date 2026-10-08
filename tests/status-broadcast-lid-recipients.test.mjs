import test from 'node:test';
import assert from 'node:assert/strict';
import { runSocketScenario } from './messaging-retry-harness.mjs';

/*
 * A status broadcast's recipients were enumerated straight from the caller's
 * `statusJidList`:
 *
 *     if (isStatus && statusJidList) { participantsList.push(...statusJidList); }
 *     const additionalDevices = await getUSyncDevices(participantsList, ...);
 *
 * `statusJidList` is a list of *contacts*, and on a migrated account the only
 * address that carries a Signal session is the LID -- assertSessions already
 * resolves PN to LID before it fetches, and the 1:1 destination path resolves
 * for the same reason (Task 14). `getUSyncDevices` does not resolve, so the PN
 * went on the wire as an address the server answers 479 for.
 *
 * The fix resolves each entry through the same resolveTcTokenJid the 1:1 path
 * uses, so the tests below pin the two halves: a mapped PN reaches the wire as
 * its LID, and an unmapped PN is left exactly as the caller passed it.
 */

const DEVICES = {
	'111111': [{ user: '111111', server: 's.whatsapp.net', device: 0 }],
	'628111': [{ user: '628111', server: 's.whatsapp.net', device: 0 }],
	'777777': [{ user: '777777', server: 'lid', device: 0 }],
	'555555': [{ user: '555555', server: 's.whatsapp.net', device: 0 }]
};

/** `mapped` are the PNs a migrated account has a LID for. */
const one = async (mapped, body) => {
	const prelude = `const logger = T.makeLogger();
const signal = T.makeSignalRepo();
const LIDS = ${JSON.stringify(mapped)};
signal.lidMapping.getLIDForPN = async pn => LIDS[pn] ?? null;
const s = await bootSocket({
	logger,
	signal,
	config: { userDevicesCache: T.makeDeviceCache(${JSON.stringify(DEVICES)}) }
});
const toJids = () => [...(s.sentXml().find(x => x.includes('status@broadcast')) ?? '').matchAll(/<to jid='([^']+)'/g)].map(m => m[1]);
const encryptJids = () => s.signal.encryptCalls;
`;
	const r = await runSocketScenario(prelude + body);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
};

const UNMAPPED_PN = '555555:1@s.whatsapp.net';

test('a status recipient with a LID mapping is encrypted and addressed as its LID', async () => {
	await one(
		{ '628111:1@s.whatsapp.net': '777777:1@lid' },
		`
await s.sock.sendMessage('status@broadcast', { text: 'hi' }, { statusJidList: [T.PEER_PN] });
console.log('to = ' + JSON.stringify(toJids()));
console.log('encrypted = ' + JSON.stringify(encryptJids()));
assert.ok(
	toJids().some(j => j.startsWith('777777') && j.endsWith('@lid')),
	'the stanza must carry a <to> in the LID identity space, got ' + JSON.stringify(toJids())
);
assert.equal(
	toJids().filter(j => j.startsWith('628111')).length, 0,
	'no recipient device may still be addressed by the caller\\'s PN: ' + JSON.stringify(toJids())
);
`
	);
});

test('a status recipient with no LID mapping keeps the jid the caller passed', async () => {
	await one(
		{},
		`
await s.sock.sendMessage('status@broadcast', { text: 'hi' }, { statusJidList: ['${UNMAPPED_PN}'] });
console.log('to = ' + JSON.stringify(toJids()));
assert.ok(
	toJids().some(j => j.startsWith('555555') && j.endsWith('@s.whatsapp.net')),
	'an unmapped PN must stay a PN, got ' + JSON.stringify(toJids())
);
`
	);
});