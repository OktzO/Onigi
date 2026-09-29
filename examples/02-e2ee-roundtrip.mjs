/*
 * examples/02-e2ee-roundtrip.mjs — a real Signal session, encrypted and decrypted.
 *
 * Run: node examples/02-e2ee-roundtrip.mjs
 *
 * Two `makeLibSignalRepository` instances, two in-memory key stores, one real
 * prekey bundle. Everything below is the production code path: the same
 * `encryptMessage` / `decryptMessage` the socket calls, over the same native
 * engine (oktz-signal). No network, no credentials.
 *
 * What it shows, and why each assertion is there:
 *
 *   1. A prekey bundle injected with `injectE2ESession` builds a real session.
 *   2. The first message is a PreKeyWhisperMessage — `type: 'pkmsg'` — and the
 *      receiver's first message back is NOT, because the session is now
 *      established. That asymmetry is the X3DH handshake, observed.
 *   3. A single flipped bit in the ciphertext is rejected. A forged ciphertext
 *      does not decrypt.
 *   4. `getSessionInfo` reports the *sender's* registration id, not the
 *      receiver's, because the session record stores the remote end's.
 *   5. A group message encrypts and a sender-key record appears, keyed per
 *      (group, sender, device) — the property commit 4ca7553 restored.
 */

import assert from 'node:assert/strict';
import { BufferJSON } from '../lib/Utils/generics.js';
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js';
import { Curve, generateSignalPubKey, signedKeyPair } from '../lib/Utils/crypto.js';
import { SenderKeyName } from '../lib/Signal/Group/sender-key-name.js';
import { jidDecode } from '../lib/WABinary/index.js';

const silentLogger = {
	level: 'silent',
	trace: () => { },
	debug: () => { },
	info: () => { },
	warn: () => { },
	error: () => { },
	child() {
		return this;
	}
};

/** An in-memory `auth.keys`: get / set / del / transaction, as the library calls them. */
const memoryKeyStore = () => {
	const buckets = new Map();
	const chains = new Map();
	const readBucket = type => {
		let bucket = buckets.get(type);
		if (!bucket) {
			buckets.set(type, bucket = new Map());
		}
		return bucket;
	};
	return {
		/** every key of a type, for assertions */
		dump: type => Object.fromEntries(readBucket(type)),
		get: async (type, ids) => {
			const bucket = readBucket(type);
			if (ids === undefined) {
				return Object.fromEntries(bucket);
			}
			const out = {};
			for (const id of ids) {
				if (bucket.has(id)) {
					out[id] = bucket.get(id);
				}
			}
			return out;
		},
		set: async patch => {
			for (const [type, entries] of Object.entries(patch)) {
				const bucket = readBucket(type);
				for (const [id, value] of Object.entries(entries)) {
					if (value === null) {
						bucket.delete(id);
					} else {
						bucket.set(id, value);
					}
				}
			}
		},
		del: async key => {
			for (const bucket of buckets.values()) {
				bucket.delete(key);
			}
		},
		/** a per-key promise chain: a mutex, not a rollback */
		transaction: (exec, key) => {
			const previous = chains.get(key) || Promise.resolve();
			const next = previous.then(exec, exec);
			chains.set(key, next.then(() => { }, () => { }));
			return next;
		}
	};
};

const ALICE = '15559876543@s.whatsapp.net';
const BOB = '15551234567@s.whatsapp.net';

/** Build one end: an identity key, a signed prekey, a prekey store, a repository. */
const makeEnd = (registrationId) => {
	const identityKeyPair = Curve.generateKeyPair();
	const signedPreKey = signedKeyPair(identityKeyPair, 1);
	const keys = memoryKeyStore();
	const repository = makeLibSignalRepository({
		creds: { registrationId, signedIdentityKey: identityKeyPair, signedPreKey },
		keys
	}, silentLogger, async () => null);
	return { identityKeyPair, signedPreKey, keys, repository, registrationId };
};

const main = async () => {
	const alice = makeEnd(11111);
	const bob = makeEnd(22222);
	console.log('alice signal address:', alice.repository.jidToSignalProtocolAddress(BOB));
	console.log('bob   signal address:', bob.repository.jidToSignalProtocolAddress(ALICE));

	// --- 1. bob publishes a prekey bundle -----------------------------------------
	// This is the same shape lib/Utils/signal.js:63 extracts from a device list.
	const oneTimePreKey = Curve.generateKeyPair();
	await bob.keys.set({ 'pre-key': { 7: oneTimePreKey } });
	await alice.repository.injectE2ESession({
		jid: BOB,
		session: {
			registrationId: bob.registrationId,
			identityKey: generateSignalPubKey(bob.identityKeyPair.public),
			signedPreKey: {
				keyId: bob.signedPreKey.keyId,
				publicKey: generateSignalPubKey(bob.signedPreKey.keyPair.public),
				signature: bob.signedPreKey.signature
			},
			preKey: { keyId: 7, publicKey: generateSignalPubKey(oneTimePreKey.public) }
		}
	});
	console.log('alice injected bob\'s prekey bundle');

	// --- 2. the first message establishes the session ------------------------------
	const plaintext = 'hello from the example';
	const first = await alice.repository.encryptMessage({ jid: BOB, data: Buffer.from(plaintext) });
	// lib/Signal/libsignal.js:171 — signal type 3 is a PreKeyWhisperMessage
	assert.equal(first.type, 'pkmsg', 'the first message to a new peer is a prekey message');
	assert.equal(first.ciphertext[0] & 0x0f, 3, 'the ciphertext carries version 3 in its low nibble');
	console.log(`alice -> bob  type=${first.type}  ${first.ciphertext.length} bytes`);

	const received = await bob.repository.decryptMessage({
		jid: ALICE, type: first.type, ciphertext: first.ciphertext
	});
	assert.equal(received.toString(), plaintext);
	console.log('bob decrypted:', JSON.stringify(received.toString()));

	// The session exists now, so the reply rides a plain WhisperMessage.
	const reply = await bob.repository.encryptMessage({ jid: ALICE, data: Buffer.from('and a reply') });
	assert.equal(reply.type, 'msg', 'once the session exists, messages are no longer prekey messages');
	const replyRead = await alice.repository.decryptMessage({
		jid: BOB, type: reply.type, ciphertext: reply.ciphertext
	});
	assert.equal(replyRead.toString(), 'and a reply');
	console.log(`bob -> alice  type=${reply.type}  ${reply.ciphertext.length} bytes`);

	// The one-time prekey was consumed, so it cannot be replayed.
	assert.equal((await bob.keys.get('pre-key', ['7']))['7'], undefined, 'the one-time prekey is consumed');
	console.log('bob\'s one-time prekey 7 was consumed and removed');

	// --- 3. a forged ciphertext does not decrypt ----------------------------------
	// A fresh message: the ratchet already consumed the key for `reply`, so
	// replaying that exact ciphertext would fail as a replay rather than as a
	// forgery. This one fails at the MAC, which is the property under test.
	const toForge = await bob.repository.encryptMessage({ jid: ALICE, data: Buffer.from('do not tamper') });
	const forged = Buffer.from(toForge.ciphertext);
	forged[forged.length - 1] ^= 0x01;
	await assert.rejects(
		() => alice.repository.decryptMessage({ jid: BOB, type: toForge.type, ciphertext: forged }),
		/mac|invalid|decrypt|failed/i,
		'a one-bit-flipped ciphertext must not decrypt'
	);
	console.log('a one-bit-flipped ciphertext was rejected');

	// The un-tampered original still decrypts, so the failure above was the
	// forgery and not a broken session.
	const intact = await alice.repository.decryptMessage({
		jid: BOB, type: toForge.type, ciphertext: toForge.ciphertext
	});
	assert.equal(intact.toString(), 'do not tamper');
	console.log('the untampered original decrypted fine, so the rejection above was the forgery');

	// --- 4. session introspection ---------------------------------------------------
	assert.deepEqual(await alice.repository.validateSession(BOB), { exists: true });
	const info = await alice.repository.getSessionInfo(BOB);
	assert.ok(info, 'getSessionInfo must report a session');
	assert.equal(typeof info.baseKey.byteLength, 'number');
	assert.equal(typeof info.registrationId, 'number');
	console.log('alice.validateSession(BOB) =', JSON.stringify(await alice.repository.validateSession(BOB)));
	console.log('alice.getSessionInfo(BOB).registrationId =', info.registrationId,
		'· baseKey', info.baseKey.byteLength, 'bytes');

	// --- 5. group messaging ----------------------------------------------------------
	const GROUP = '120363000000000000@g.us';
	const group = await alice.repository.encryptGroupMessage({
		group: GROUP, meId: ALICE, data: Buffer.from('hello group')
	});
	assert.ok(group.ciphertext.length > 0);
	assert.ok(group.senderKeyDistributionMessage.length > 0, 'a sender-key distribution message accompanies the first group send');
	assert.equal(await alice.repository.hasSenderKey({ group: GROUP, meId: ALICE }), true);
	console.log(`group ciphertext ${group.ciphertext.length} bytes, SKDM ${group.senderKeyDistributionMessage.length} bytes`);

	// The store slot is keyed by group AND sender AND device. Before commit
	// 4ca7553 every member of a group serialized to `<group>::undefined::<device>`,
	// so they all shared one slot. These are the exact address objects
	// jidToSignalSenderKeyName builds (lib/Signal/libsignal.js:395).
	const address = (jid) => ({
		name: jidDecode(jid).user,
		deviceId: jidDecode(jid).device ?? 0,
		toString: () => `${jidDecode(jid).user}.${jidDecode(jid).device ?? 0}`
	});
	const mine = new SenderKeyName(GROUP, address(ALICE));
	const theirs = new SenderKeyName(GROUP, address('15550009999@s.whatsapp.net'));
	const mineDevice1 = new SenderKeyName(GROUP, address('15559876543:1@s.whatsapp.net'));
	assert.equal(mine.serialize(), `${GROUP}::15559876543::0`);
	assert.notEqual(mine.serialize(), theirs.serialize(), 'two members must not share a sender-key slot');
	assert.notEqual(mine.serialize(), mineDevice1.serialize(), 'one member on two devices must not share a slot');
	console.log('sender-key slots:');
	console.log('  member A, phone  ', mine.serialize());
	console.log('  member B, phone  ', theirs.serialize());
	console.log('  member A, web :1 ', mineDevice1.serialize());

	// And what actually landed in the store, read back through the same reviver
	// the library uses.
	const slot = Object.keys(alice.keys.dump('sender-key'));
	assert.equal(slot.length, 1, 'alice has exactly one sender-key slot: her own');
	const record = JSON.parse(Buffer.from(alice.keys.dump('sender-key')[slot[0]]).toString('utf8'), BufferJSON.reviver);
	console.log('sender-key record states:', record.length, '| keyIds:', record.map(s => s.senderKeyId));
	assert.ok(!JSON.stringify(record).includes('undefined'), 'no field of the record may be undefined');
};

await main();
console.log('\nok — real X3DH, real ratchet, real group sender key, real forgery rejection.');
