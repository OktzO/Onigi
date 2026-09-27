import test from 'node:test';
import assert from 'node:assert/strict';
import { runSocketScenario } from './messaging-retry-harness.mjs';

/*
 * 9.9f — assertSessions bucketed jids into LID and PN and dropped
 * everything else on the floor.
 *
 *     const wireJids = [
 *         ...jidsRequiringFetch.filter(jid => !!isLidUser(jid) || !!isHostedLidUser(jid)),
 *         ...((await signalRepository.lidMapping.getLIDsForPNs(
 *              jidsRequiringFetch.filter(jid => !!isPnUser(jid) || !!isHostedPnUser(jid)))) || []).map(a => a.lid)
 *     ];
 *
 * A group (@g.us) or newsletter (@newsletter) jid matches neither filter, so it
 * vanished: the function still returned didFetchNewSession = true, and the IQ
 * it sent carried an empty <key/>. The caller believed a session had been
 * fetched, nothing was, and the encryptMessage that followed threw much later
 * with an unrelated-looking error. assertSessions is exported on the socket, so
 * a consumer calling it with a group jid got the same silence.
 */

const one = async body => {
	const r = await runSocketScenario(`const logger = T.makeLogger();
const s = await bootSocket({ logger });
const keyIqs = () => s.sentXml().filter(x => x.includes("xmlns='encrypt'"));
${body}`);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
};

test('9.9f a group jid is rejected instead of silently dropped', () => one(`
let outcome = 'resolved';
try { await s.sock.assertSessions([T.GROUP_JID], true); } catch (e) { outcome = e.message; }
console.log('outcome = ' + outcome);
assert.match(outcome, new RegExp(T.GROUP_JID), 'the error must name the jid that cannot be fetched');
assert.deepEqual(keyIqs(), [], 'no session query may be sent for an unsupported jid');
`));

test('9.9f a newsletter jid is rejected too', () => one(`
await assert.rejects(
	() => s.sock.assertSessions(['1234567890@newsletter'], true),
	/newsletter/
);
assert.deepEqual(keyIqs(), []);
`));

test('9.9f a mixed list fails on the unsupported jid rather than dropping it', () => one(`
await assert.rejects(
	() => s.sock.assertSessions([T.PEER_PN, T.GROUP_JID], true),
	err => String(err.message).includes(T.GROUP_JID)
);
`));

test('9.9f a user jid is still fetched, and says so', () => one(`
const didFetch = await s.sock.assertSessions([T.PEER_PN], true);
assert.equal(didFetch, true, 'a real fetch must still report true');
const iqs = keyIqs();
assert.equal(iqs.length, 1, 'exactly one session query, got ' + iqs.length);
assert.ok(iqs[0].includes('628111'), 'the query must carry the jid that was asked for: ' + iqs[0]);
`));

test('9.9f a PN with no LID mapping is asked for by its own jid', () => one(`
// getLIDsForPNs returns nothing for an unmapped PN, which used to leave
// wireJids empty: an empty <key/> went out and the session was never fetched.
await s.sock.assertSessions([T.PEER_PN], true);
const iqs = keyIqs();
assert.equal(iqs.length, 1);
assert.ok(iqs[0].includes("<user jid='" + T.PEER_PN), 'the PN itself must be queried, not dropped: ' + iqs[0]);
`));

test('9.9f a PN with a LID mapping is still asked for by LID', () => one(`
const mapped = await bootSocket({ logger, lidMappings: { '628111:1@s.whatsapp.net': '777777:1@lid' } });
await mapped.sock.assertSessions([T.PEER_PN], true);
const iqs = mapped.sentXml().filter(x => x.includes("xmlns='encrypt'"));
assert.equal(iqs.length, 1);
assert.ok(iqs[0].includes("<user jid='" + T.PEER_LID), 'the mapped LID must win, as before: ' + iqs[0]);
assert.ok(!iqs[0].includes("<user jid='" + T.PEER_PN), 'and the PN must not be sent twice');
`));

test('9.9f a jid that already has a session is still a no-op', () => one(`
const didFetch = await s.sock.assertSessions([T.PEER_PN], false);
assert.equal(didFetch, false, 'nothing to fetch, so nothing fetched');
assert.deepEqual(keyIqs(), [], 'no query for a jid that already has a session');
`));
