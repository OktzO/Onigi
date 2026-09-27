import test from 'node:test';
import assert from 'node:assert/strict';
import { runSocketScenario } from './messaging-retry-harness.mjs';

/*
 * 8.5 — a partial fan-out used to report success.
 *
 * createParticipantNodes encrypts one node per recipient device and
 * catches per recipient:
 *
 *     catch (err) {
 *         logger.error({ jid, err }, 'Failed to encrypt for recipient');
 *         return null;
 *     }
 *
 * Only `nodes.length === 0` threw. With five devices and one stale
 * session, four encrypted nodes were sent, the stanza went out,
 * relayMessage resolved and sendMessage returned a key -- so the app
 * marked the message sent while one device never received it.
 *
 * There is no recovery path for that, and that is the deciding argument:
 * a device that never got a ciphertext cannot send a retry receipt, so
 * the peer-retry machinery can never notice. Partial delivery here is
 * silent, permanent loss, not a transient that heals itself.
 */

const PEER = '628111@s.whatsapp.net';
const STALE = '628111:2@s.whatsapp.net';
const DEVICES = {
	'111111': [{ user: '111111', server: 's.whatsapp.net', device: 0 }],
	'628111': [
		{ user: '628111', server: 's.whatsapp.net', device: 0 },
		{ user: '628111', server: 's.whatsapp.net', device: 1 },
		{ user: '628111', server: 's.whatsapp.net', device: 2 },
		{ user: '628111', server: 's.whatsapp.net', device: 3 },
		{ user: '628111', server: 's.whatsapp.net', device: 4 }
	]
};

const one = async (signalOverrides, body) => {
	const prelude = `const logger = T.makeLogger();
const s = await bootSocket({
	logger,
	signalOverrides: ${JSON.stringify(signalOverrides)},
	config: { userDevicesCache: T.makeDeviceCache(${JSON.stringify(DEVICES)}) }
});
const stanzas = () => s.sentXml().filter(x => x.includes("<message id='"));
`;
	const r = await runSocketScenario(prelude + body);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
};

test('8.5 one stale session out of five devices does not report the send as successful', () => one(
	{ encryptFailJids: [STALE] },
	`
const sent = await s.sock.sendMessage(T.PEER_GROUP_JID, { text: 'hello' }).then(() => 'resolved', e => 'rejected: ' + e.message);
console.log('sendMessage = ' + sent);
assert.match(sent, /^rejected/, 'a send that skipped a device must not resolve');
`
));

test('8.5 the failure names the device that was skipped', () => one(
	{ encryptFailJids: [STALE] },
	`
try { await s.sock.sendMessage(T.PEER_GROUP_JID, { text: 'hello' }); assert.fail('expected a rejection'); }
catch (err) {
	const text = String(err.message) + ' ' + JSON.stringify(err.data ?? {});
	console.log('error = ' + text);
	assert.match(text, /628111:2@s\.whatsapp\.net/, 'the caller must be able to see which device was skipped');
}
`
));

test('8.5 the stanza is not put on the wire when a device was skipped', () => one(
	{ encryptFailJids: [STALE] },
	`
try { await s.sock.sendMessage(T.PEER_GROUP_JID, { text: 'hello' }); } catch { }
assert.deepEqual(stanzas(), [], 'a partially encrypted fan-out must not reach the wire');
`
));

test('8.5 every device reachable still sends', () => one({}, `
const sent = await s.sock.sendMessage(T.PEER_GROUP_JID, { text: 'hello' });
assert.ok(sent && sent.key, 'a healthy send must still return a key');
assert.equal(stanzas().length, 1, 'a healthy send puts exactly one stanza on the wire');
assert.equal(s.signal.encryptCalls.length, 6, 'all six devices (mine plus five of theirs) must be encrypted for');
`));

test('8.5 a total encryption failure still reports All encryptions failed', () => one(
	{ encryptMessage: 'no session' },
	`
try { await s.sock.sendMessage(T.PEER_GROUP_JID, { text: 'hello' }); assert.fail('expected a rejection'); }
catch (err) {
	assert.match(err.message, /All encryptions failed/, 'the pre-existing all-failed behaviour must not change');
}
`
));

test('8.5 a partial sender-key distribution fails the group send', () => one(
	{ encryptFailJids: [STALE] },
	`
const s2 = await bootSocket({
	logger,
	signalOverrides: { encryptFailJids: ['628111:2@s.whatsapp.net'] },
	config: {
		cachedGroupMetadata: async () => T.groupMetadata(),
		userDevicesCache: T.makeDeviceCache({
			'111111': [{ user: '111111', server: 's.whatsapp.net', device: 0 }],
			'628111': [
				{ user: '628111', server: 's.whatsapp.net', device: 0 },
				{ user: '628111', server: 's.whatsapp.net', device: 2 }
			],
			'777777': [{ user: '777777', server: 'lid', device: 0 }]
		})
	}
});
let outcome = 'resolved';
try { await s2.sock.sendMessage(T.GROUP_JID, { text: 'hello group' }); } catch (e) { outcome = 'rejected: ' + e.message; }
console.log('group send = ' + outcome);
assert.match(outcome, /^rejected/, 'a device left without the sender key can never decrypt the group, so the send must not report success');
`
));

void PEER;
