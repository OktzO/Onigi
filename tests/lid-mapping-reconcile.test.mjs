import assert from 'node:assert/strict';
import test from 'node:test';
import { runSocketScenario } from './messaging-retry-harness.mjs';

/*
 * handleMessage only stored a new LID mapping when there was *no* mapping at
 * all (lib/Socket/messages-recv.js):
 *
 *     if (!(await signalRepository.lidMapping.getPNForLID(alt))) {
 *         await signalRepository.lidMapping.storeLIDPNMappings([{ lid: alt, pn: primaryJid }]);
 *         await signalRepository.migrateSession(primaryJid, alt);
 *     }
 *
 * The guard asks "do I know this LID?" but the caller needs "do I know that
 * this LID belongs to *this* PN?". A LID already recorded against a different
 * PN -- a previous owner, a recycled LID, a contact mid-migration -- answered
 * "yes" and was skipped forever: storeLIDPNMappings and migrateSession never
 * ran, the signal session stayed filed under the wrong address, and every
 * message from the real owner came back "Bad MAC" / "No session found to
 * decrypt message" (issues #2234, #2321, #2506). Upstream develop "H8 fix".
 *
 * The same block is a bare check-then-store across two awaits with no lock, so
 * two inbound messages from the same participant both read the pre-store value
 * and both migrate the same session.
 */

const PEER_PN = '628111:1@s.whatsapp.net';
/** the LID this PN announced first */
const LID_1 = '777777:1@lid';
/** the LID it announces now, still recorded against somebody else */
const LID_2 = '888888:1@lid';
/** whoever LID_2 is wrongly recorded against */
const STALE_PN = '555555:1@s.whatsapp.net';
/** a device-less LID: no device part at all, which is what most announcements carry */
const LID_3 = '999999@lid';
/** what getPNForLID hands back for LID_3 when the store holds the right pn *user*: the store
 *  only ever keeps user<->user (lib/Signal/lid-mapping.js:30) and getPNForLID then splices the
 *  *LID's* device onto that user (lid-mapping.js:229) -- with no LID device, no device comes back */
const PN_NO_DEVICE = '628111@s.whatsapp.net';

const one = async body => {
	const prelude = `const logger = T.makeLogger();
const PN = ${JSON.stringify(PEER_PN)};
const LID_1 = ${JSON.stringify(LID_1)};
const LID_2 = ${JSON.stringify(LID_2)};
const LID_3 = ${JSON.stringify(LID_3)};
const PN_NO_DEVICE = ${JSON.stringify(PN_NO_DEVICE)};
const STALE_PN = ${JSON.stringify(STALE_PN)};
/** a PN-addressed 1:1 stanza that announces lid as the sender's alt address */
const announce = (id, lid) => {
	const node = T.plaintextStanza(PN, id, 'hello');
	node.attrs.addressing_mode = 'pn';
	node.attrs.peer_recipient_lid = lid;
	return node;
};
/** a signal repository whose lid-mapping is a plain map, so a scenario can see exactly what the site did */
const lidSignal = (initial) => {
	const map = new Map(initial);
	const stored = [];
	const migrated = [];
	const signal = T.makeSignalRepo();
	// the awaits are the point: a real store round-trips to disk, so the
	// compare and the store are two separate suspensions
	signal.lidMapping.getPNForLID = async lid => { await tick(5); return map.get(lid) ?? null; };
	signal.lidMapping.storeLIDPNMappings = async pairs => {
		stored.push(...pairs);
		await tick(5);
		for (const p of pairs) map.set(p.lid, p.pn);
	};
	signal.migrateSession = async (pn, lid) => { migrated.push([pn, lid]); await tick(5); };
	return { signal, stored, migrated, pnFor: lid => map.get(lid) ?? null };
};
`;
	const r = await runSocketScenario(prelude + body);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
};

test('a stale LID mapping is reconciled, not skipped', () => one(`
const { signal, stored, migrated, pnFor } = lidSignal([[LID_1, PN], [LID_2, STALE_PN]]);
assert.equal(pnFor(LID_2), STALE_PN, 'precondition: LID_2 is recorded against the wrong PN');

const s = await bootSocket({ logger, signal });
s.sock.ws.emit('CB:message', announce('M1', LID_2));
assert.equal((await s.waitForXml("<receipt id='M1'")).length, 1, 'precondition: the message was handled');

assert.equal(pnFor(LID_2), PN, 'the announcing PN must now own LID_2, or its messages stay undecryptable');
assert.deepEqual(stored, [{ lid: LID_2, pn: PN }], 'the stale pair is overwritten');
assert.deepEqual(migrated, [[PN, LID_2]], 'and the signal session is migrated to the reconciled pair');
`));

test('two concurrent announcements of the same participant map and migrate once', () => one(`
const { signal, stored, migrated, pnFor } = lidSignal([]);
const s = await bootSocket({ logger, signal });

// emitted back to back, so both reach the compare before either has stored
s.sock.ws.emit('CB:message', announce('C1', LID_2));
s.sock.ws.emit('CB:message', announce('C2', LID_2));
assert.equal((await s.waitForXml("<receipt id='C1'")).length, 1, 'precondition: the first message was handled');
assert.equal((await s.waitForXml("<receipt id='C2'")).length, 1, 'precondition: the second message was handled');

assert.equal(pnFor(LID_2), PN);
assert.deepEqual(stored, [{ lid: LID_2, pn: PN }], 'the pair is stored once, not once per inbound message');
assert.deepEqual(migrated, [[PN, LID_2]], 'the session is migrated once, not once per inbound message');
`));

/*
 * The mirror of the first test: a mapping that already names this pn user must be left
 * alone. This is the branch a `!==` compare cannot get right, because the operand it is
 * handed is not the stored value. getPNForLID never returns what the store holds -- the
 * store only keeps user<->user (lid-mapping.js:30) -- it fabricates a jid by splicing the
 * *LID's* device onto that stored pn user (lid-mapping.js:229). A device-less LID therefore
 * comes back device-less, while `from` carries a device, so `existingPn !== primaryJid` is
 * true for a perfectly good mapping. Nothing was corrupted (the store dedupes at
 * lid-mapping.js:61-68 and migrateSession short-circuits through migratedSessionCache at
 * libsignal.js:290), but every inbound message re-entered the lock and redid the work.
 * Comparing the users is the comparison the caller actually means.
 */
test('a matching LID mapping is left alone, even when the devices differ', () => one(`
const { signal, stored, migrated, pnFor } = lidSignal([[LID_3, PN_NO_DEVICE]]);
assert.equal(pnFor(LID_3), PN_NO_DEVICE, 'precondition: LID_3 is recorded against this same pn user');

const s = await bootSocket({ logger, signal });
s.sock.ws.emit('CB:message', announce('M2', LID_3));
assert.equal((await s.waitForXml("<receipt id='M2'")).length, 1, 'precondition: the message was handled');

assert.deepEqual(stored, [], 'the mapping already names the same pn user, so nothing is rewritten');
assert.deepEqual(migrated, [], 'and the session is not re-migrated on every inbound message');
`));