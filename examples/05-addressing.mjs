/*
 * examples/05-addressing.mjs — JIDs across the PN, LID and hosted domains.
 *
 * Run: node examples/05-addressing.mjs
 *
 * WhatsApp addresses the same person two ways: by phone number
 * (`...@s.whatsapp.net`, "PN") and by an opaque identifier (`...@lid`). Device
 * 99 lives in a third domain, `hosted`. This example is a factual tour of what
 * the JID helpers in lib/WABinary/jid-utils.js actually do, because getting
 * this wrong is the most common way to break a session.
 *
 * Every assertion below is a property of the shipped code. Nothing here claims
 * the addressing is *complete* — see the note at the end.
 */

import assert from 'node:assert/strict';
import {
	areJidsSameUser,
	getServerFromDomainType,
	isHostedLidUser,
	isHostedPnUser,
	isJidGroup,
	isLidUser,
	isPnUser,
	jidDecode,
	jidEncode,
	jidNormalizedUser,
	transferDevice,
	WAJIDDomains
} from '../lib/index.js';

const main = () => {
	// --- the four domains -----------------------------------------------------------

	const CASES = [
		['15551234567@s.whatsapp.net', { user: '15551234567', device: undefined, domainType: WAJIDDomains.WHATSAPP }],
		['15551234567:2@s.whatsapp.net', { user: '15551234567', device: 2, domainType: WAJIDDomains.WHATSAPP }],
		['999888777666:99@hosted', { user: '999888777666', device: 99, domainType: WAJIDDomains.HOSTED }],
		['888777666555@lid', { user: '888777666555', device: undefined, domainType: WAJIDDomains.LID }],
		['888777666555:3@lid', { user: '888777666555', device: 3, domainType: WAJIDDomains.LID }],
		['777666555444:99@hosted.lid', { user: '777666555444', device: 99, domainType: WAJIDDomains.HOSTED_LID }]
	];
	console.log('jid                                    user           device  domain');
	for (const [jid, expected] of CASES) {
		const got = jidDecode(jid);
		assert.equal(got.user, expected.user, jid);
		assert.equal(got.device, expected.device, jid);
		assert.equal(got.domainType, expected.domainType, jid);
		console.log(
			`${jid.padEnd(38)} ${String(got.user).padEnd(14)} ${String(got.device ?? '-').padEnd(7)} ${WAJIDDomains[got.domainType]}`
		);
	}
	console.log(`\nall ${CASES.length} shapes decode as above; jidDecode returns undefined for a string with no '@'`);
	assert.equal(jidDecode('not-a-jid'), undefined);

	// --- the predicates -------------------------------------------------------------

	assert.equal(isPnUser('15551234567@s.whatsapp.net'), true);
	assert.equal(isLidUser('888777666555@lid'), true);
	assert.equal(isHostedPnUser('999888777666:99@hosted'), true);
	assert.equal(isHostedLidUser('777666555444:99@hosted.lid'), true);
	assert.equal(isJidGroup('120363000000000000@g.us'), true);
	assert.equal(isPnUser('888777666555@lid'), false, '@lid is not a phone-number jid');
	assert.equal(isLidUser('15551234567@s.whatsapp.net'), false, '@s.whatsapp.net is not a lid');
	console.log('the isXUser predicates are domain tests, not a PN/LID equivalence');

	// --- normalisation --------------------------------------------------------------

	// c.us is the legacy spelling; the modern one is s.whatsapp.net.
	assert.equal(jidNormalizedUser('15551234567@c.us'), '15551234567@s.whatsapp.net');
	// the device is dropped, the domain is kept
	assert.equal(jidNormalizedUser('15551234567:4@s.whatsapp.net'), '15551234567@s.whatsapp.net');
	assert.equal(jidNormalizedUser('888777666555@lid'), '888777666555@lid');
	// a jid naming no user normalises to undefined, never to ''
	assert.equal(jidNormalizedUser('@lid'), undefined);
	assert.equal(jidNormalizedUser('nonsense'), undefined);
	console.log("\njidNormalizedUser('15551234567@c.us')  ->", jidNormalizedUser('15551234567@c.us'));
	console.log("jidNormalizedUser('15551234567:4@s.whatsapp.net') ->", jidNormalizedUser('15551234567:4@s.whatsapp.net'));
	console.log("jidNormalizedUser('nonsense')          ->", String(jidNormalizedUser('nonsense')));

	// --- same user, two domains ------------------------------------------------------

	// The predicate compares the *user* part, so the same person compares equal
	// however they are addressed. This is what the LID-aware call sites rely on.
	assert.equal(areJidsSameUser('15551234567@s.whatsapp.net', '15551234567:2@s.whatsapp.net'), true);
	assert.equal(areJidsSameUser('15551234567@s.whatsapp.net', '888777666555@lid'), false,
		'different user parts are different people, whatever the domain');
	// a group is never a user, whatever its user part reads
	assert.equal(areJidsSameUser('120363000000000000@g.us', '120363000000000000@s.whatsapp.net'), false);
	assert.equal(areJidsSameUser('status@broadcast', 'status@s.whatsapp.net'), false);
	// an empty side is never "the same user"
	assert.equal(areJidsSameUser('15551234567@s.whatsapp.net', '@lid'), false);
	console.log('\nareJidsSameUser compares user parts and refuses any operand that is not a user');

	// --- device transfer, PN -> LID --------------------------------------------------

	// migrateSession (lib/Signal/libsignal.js:271) moves a session from a PN
	// address to the LID address. transferDevice is the primitive: keep the
	// device, take the target's user and server.
	assert.equal(
		transferDevice('15551234567:2@s.whatsapp.net', '888777666555@lid'),
		'888777666555:2@lid'
	);
	assert.equal(
		transferDevice('15551234567:2@s.whatsapp.net', '888777666555:99@hosted.lid'),
		'888777666555:2@hosted.lid'
	);
	// device 0 is implicit and is not written back
	assert.equal(transferDevice('15551234567@s.whatsapp.net', '888777666555@lid'), '888777666555@lid');
	console.log("\ntransferDevice('15551234567:2@s.whatsapp.net', '888777666555@lid') ->",
		transferDevice('15551234567:2@s.whatsapp.net', '888777666555@lid'));

	// --- round trip -----------------------------------------------------------------

	for (const [jid] of CASES) {
		assert.equal(jidEncode(jidDecode(jid).user, jidDecode(jid).server, jidDecode(jid).device), jid,
			`${jid} must survive encode(decode())`);
	}
	console.log(`all ${CASES.length} jids survive jidEncode(jidDecode(x))`);

	// --- domain type <-> server -----------------------------------------------------

	assert.equal(getServerFromDomainType('lid', WAJIDDomains.WHATSAPP), 'lid', 'WHATSAPP keeps the input server');
	assert.equal(getServerFromDomainType('whatever', WAJIDDomains.LID), 'lid');
	assert.equal(getServerFromDomainType('whatever', WAJIDDomains.HOSTED), 'hosted');
	assert.equal(getServerFromDomainType('whatever', WAJIDDomains.HOSTED_LID), 'hosted.lid');
	console.log('getServerFromDomainType maps the numeric domain to its server name');
};

main();
console.log(`
ok — the JID helpers, as implemented.

What this does NOT establish: that addressing is complete end to end. LID
resolution needs a live usync round trip, and this library answers a few of
those questions honestly rather than guessing:

  - onWhatsApp() answers one entry per input, echoing the caller's own jid, with
    exists = true | false | null. null means "could not be determined" — a LID
    with no known phone-number mapping, or a row the server did not answer. It
    does not fabricate a number for a LID it could not resolve.
  - A missing engine or an unanswered query is never reported as "no session"
    or "does not exist".

Whether Meta's servers answer consistently in every case is not something this
repository can test, and is not claimed anywhere in these docs.`);
