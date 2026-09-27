import test from 'node:test';
import assert from 'node:assert/strict';
import { runSocketScenario } from './messaging-retry-harness.mjs';

/*
 * 9.1 — the sender identity was taken from the *chat's* server, which is
 * never a LID for a group.
 *
 *     const isLidConv = jidDecode(jid)?.server === 'lid' && !!creds.me?.lid;
 *     const userJid = isLidConv ? creds.me.lid : creds.me.id;
 *
 * `jidDecode('<group>@g.us').server` is 'g.us', so a LID-addressed group
 * always got creds.me.id -- a PN -- as userJid, which flows into
 * generateWAMessageFromContent for two things:
 *
 *   * contextInfo.participant of a message we quote, and
 *   * the outgoing WebMessageInfo's own `participant` (messages.js:620).
 *
 * Meanwhile relayMessage stamps addressing_mode="lid" on the stanza and
 * derives the sender key from creds.me.lid (:560, :570), so the group is
 * addressed in LIDs while the participant stamped inside the encrypted
 * skmsg is a PN.
 *
 * The second defect is on messages.js:569, which inverts the rule commit
 * 9173c4e introduced: `quoted.key.participant || userJid` lets a *stored*
 * participant win over the addressing-consistent userJid. In a 1:1 LID
 * chat, quoting a message whose key.participant is your PN puts a PN
 * where the LID belongs.
 */

const one = async (addressingMode, body) => {
	const prelude = `const logger = T.makeLogger();
const s = await bootSocket({
	logger,
	config: {
		userDevicesCache: T.makeDeviceCache({
			'111111': [{ user: '111111', server: 's.whatsapp.net', device: 0 }],
			'628111': [{ user: '628111', server: 's.whatsapp.net', device: 0 }],
			'777777': [{ user: '777777', server: 'lid', device: 0 }]
		}),
		${addressingMode === null ? 'cachedGroupMetadata: async () => undefined' : `cachedGroupMetadata: async () => T.groupMetadata({ addressingMode: ${JSON.stringify(addressingMode)} })`}
	}
});
`;
	const r = await runSocketScenario(prelude + body);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
};

const DEVICES = 'userDevicesCache';

test('9.1 a LID-addressed group stamps our LID, not our PN, as the participant', () => one(
	'lid',
	`
const sent = await s.sock.sendMessage(T.GROUP_JID, { text: 'hi' });
console.log('participant = ' + sent.participant);
assert.equal(sent.participant, T.ME_LID, 'a lid-addressed group must stamp our lid');
`
));

test('9.1 the stanza is addressed in the same identity space', () => one(
	'lid',
	`
await s.sock.sendMessage(T.GROUP_JID, { text: 'hi' });
const stanza = s.sentXml().find(x => x.includes('addressing_mode'));
assert.match(stanza, /addressing_mode='lid'/, 'precondition: the stanza is lid-addressed');
assert.equal(T.ME_LID.startsWith(T.ME_PN.split('@')[0]), false, 'precondition: pn and lid are different users');
`
));

test('9.1 a PN-addressed group still stamps our PN', () => one(
	'pn',
	`
const sent = await s.sock.sendMessage(T.GROUP_JID, { text: 'hi' });
console.log('participant = ' + sent.participant);
assert.equal(sent.participant, T.ME_PN, 'a pn-addressed group must keep our pn');
`
));

test('9.1 quoting our own group message does not stamp a PN into a LID group', () => one(
	'lid',
	`
const quoted = { key: { remoteJid: T.GROUP_JID, fromMe: true, id: 'QUOTED1', participant: T.ME_PN }, message: { conversation: 'mine' } };
const sent = await s.sock.sendMessage(T.GROUP_JID, { text: 'hi' }, { quoted });
const ctx = sent.message.extendedTextMessage.contextInfo;
console.log('contextInfo.participant = ' + ctx.participant);
assert.equal(ctx.participant, T.jidNormalizedUser(T.ME_LID), 'the quoted-from-me participant must be the chat\\'s own identity');
`
));

test('9.1 quoting our own 1:1 LID message does not keep the stored PN', () => one(
	null,
	`
// key.participant is copied verbatim off the stanza by decode-wa-message.js,
// so in a lid chat it can be our pn; the addressing-consistent identity is userJid.
const quoted = { key: { remoteJid: T.PEER_LID, fromMe: true, id: 'QUOTED2', participant: T.ME_PN }, message: { conversation: 'mine' } };
const sent = await s.sock.sendMessage(T.PEER_LID, { text: 'hi' }, { quoted });
const ctx = sent.message.extendedTextMessage.contextInfo;
console.log('contextInfo.participant = ' + ctx.participant);
assert.equal(ctx.participant, T.jidNormalizedUser(T.ME_LID), 'userJid must win over a stored pn participant');
`
));

test('9.1 a 1:1 PN chat still stamps the PN', () => one(
	null,
	`
const sent = await s.sock.sendMessage(T.PEER_PN, { text: 'hi' });
assert.ok(!sent.participant, 'a 1:1 pn chat has no participant on the outgoing message, got ' + sent.participant);
`
));

void DEVICES;
