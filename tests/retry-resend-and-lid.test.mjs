import test from 'node:test';
import assert from 'node:assert/strict';
import { runSocketScenario } from './messaging-retry-harness.mjs';

/*
 * Three defects on the 1:1 send path, all measured against a real socket.
 *
 * (a) A retry resend was encrypted twice. `relayMessage` pushed the retry
 *     participant into `devices` (:548) AND encrypted it again in the
 *     `isRetryResend` block (:754), so one resend carried two mutually
 *     exclusive shapes for the same device -- a bare <enc count=...> plus a
 *     <participants> fan-out holding a second ciphertext for the same jid --
 *     which the server answers 479. Independently: the double ratchet advanced
 *     two steps for one message, so the peer can decrypt only one of them.
 *     Captured before the fix, one resend produced this stanza:
 *
 *       <message id='R1' to='628111:2@s.whatsapp.net' device_fanout='false'>
 *           <enc v='2' type='msg' count='1'>        <-- retry encrypt
 *           <participants><to jid='628111:2@s.whatsapp.net'><enc .../>  <-- fan-out
 *
 * (b) relayMessage sent to the caller's @s.whatsapp.net jid even when a LID
 *     mapping existed, so a migrated account's send was addressed wrongly.
 *
 * (c) resolveTcTokenJid / resolveIssuanceJid awaited the LID store unguarded,
 *     so a throwing store killed the whole stanza over a token lookup.
 *
 * The retry scenarios run in a child process through messaging-retry-harness.mjs
 * (the retry path is closure-private, so a real socket is the only faithful
 * harness) and read real stanzas back off the wire log.
 */

const CACHED = { config: { enableRecentMessageCache: true } };
/** a peer *device* asking for the resend, so the participant path is taken */
const RETRY_DEVICE = '628111:2@s.whatsapp.net';

/** Child-side helpers: a scenario body only has T, bootSocket, tick and assert. */
const PRELUDE = `
const stanzasFor = id => s.sentXml().filter(x => x.includes("<message id='" + id + "'"));
const nodes = (xml, tag) => (xml.match(new RegExp('<' + tag + '[ />]', 'g')) || []).length;
`;

const one = async (over, body, boot) => {
	const r = await runSocketScenario(`${boot ?? `const s = await bootSocket(${JSON.stringify(over)});`}\n${PRELUDE}\n${body}`);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
};

test('a 1:1 retry resend encrypts the target exactly once', () => one(CACHED, `
s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, 'R1', { conversation: 'resend me' });
s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: 'R1', from: T.PEER_PN, participant: ${JSON.stringify(RETRY_DEVICE)}, count: 1 }));
await s.waitForXml("<message id='R1'");
const stanzas = stanzasFor('R1');
assert.equal(stanzas.length, 1, 'one receipt must answer with one stanza, got ' + stanzas.length);
const xml = stanzas[0];
console.log('STANZA=' + xml);
assert.equal(nodes(xml, 'enc'), 1, 'the target must carry exactly one ciphertext, got ' + nodes(xml, 'enc') + ': ' + xml);
assert.equal(nodes(xml, 'participants'), 0, 'a retry resend must not also emit a device fan-out: ' + xml);
assert.equal(nodes(xml, 'to'), 0, 'nor a <to> node for the same device: ' + xml);
assert.match(xml, new RegExp("to='" + ${JSON.stringify(RETRY_DEVICE).replaceAll('.', '\\.')} + "'"), 'it stays addressed to the device that asked: ' + xml);
assert.match(xml, /count='1'/, 'and the one ciphertext is the retry one, which carries count= for the peer to dedupe: ' + xml);
assert.equal(
	s.signal.encryptCalls.filter(j => j === ${JSON.stringify(RETRY_DEVICE)}).length,
	1,
	'the target must be encrypted once, not once per path: ' + JSON.stringify(s.signal.encryptCalls)
);
`));

test('a retry resend advances the sending chain once, not twice', () => one(
	{ config: { enableRecentMessageCache: true }, signalOverrides: { distinctSessionBaseKeys: true } },
	`
s.sock.messageRetryManager.addRecentMessage(T.PEER_PN, 'R2', { conversation: 'resend me' });
for (const count of [1, 2, 3]) {
	s.sock.ws.emit('CB:receipt', T.retryReceipt({ id: 'R2', from: T.PEER_PN, participant: ${JSON.stringify(RETRY_DEVICE)}, count }));
	await tick(600);
}
const stanzas = stanzasFor('R2');
console.log('ENCRYPT_CALLS=' + JSON.stringify(s.signal.encryptCalls));
console.log('STANZAS=' + stanzas.length);
assert.equal(stanzas.length, 3, 'three receipts within the budget get three resends');
for (const xml of stanzas) {
	assert.equal(nodes(xml, 'enc'), 1, 'every resend carries one ciphertext: ' + xml);
}
assert.deepEqual(
	s.signal.encryptCalls,
	[${JSON.stringify(RETRY_DEVICE)}, ${JSON.stringify(RETRY_DEVICE)}, ${JSON.stringify(RETRY_DEVICE)}],
	'each resend must advance the chain exactly once -- two encrypts per message leave the peer unable to decrypt the second'
);
`));

test('send resolves a PN to its LID before sending', () => one(
	{},
	`
const sent = await s.sock.sendMessage(T.PEER_PN, { text: 'hello' });
const stanzas = stanzasFor(sent.key.id);
assert.equal(stanzas.length, 1, 'one message, one stanza');
const xml = stanzas[0];
console.log('STANZA=' + xml);
assert.match(xml, /to='777777:1@lid'/, 'a mapped PN must be addressed by its LID: ' + xml);
assert.doesNotMatch(xml, /to='628111/, 'the @s.whatsapp.net jid must not go on the wire when a LID is mapped: ' + xml);
`,
	`
// the store knows this PN; bootSocket binds getLIDForPN when the socket is
// built, so the mapping has to be in place before the boot.
const signal = T.makeSignalRepo();
signal.lidMapping.getLIDForPN = async pn => (pn === T.PEER_PN ? T.PEER_LID : null);
const s = await bootSocket({ signal });
`
));

test('a throwing LID store does not break the send', () => one(
	{},
	`
const sent = await s.sock.sendMessage(T.PEER_PN, { text: 'hello' });
const stanzas = stanzasFor(sent.key.id);
assert.equal(stanzas.length, 1, 'a LID-lookup failure must degrade, not kill the stanza');
console.log('STANZA=' + stanzas[0]);
assert.match(stanzas[0], /to='628111:1@s\\.whatsapp\\.net'/, 'falling back to the PN it was given');
`,
	`
const signal = T.makeSignalRepo();
signal.lidMapping.getLIDForPN = async () => { throw new Error('lid store offline'); };
const s = await bootSocket({ signal });
`
).then(r => {
	assert.match(
		r.stderr + r.log.join('\n'),
		/lid store offline/,
		'the degradation has to be reported, not swallowed silently'
	);
	return r;
}));
