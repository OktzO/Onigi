import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const oktzSignal = require('oktz-signal');
const { native, SessionBuilder, SessionCipher, ProtocolAddress, PreKeyWhisperMessage } = oktzSignal;
const { makeLibSignalRepository } = await import('../lib/Signal/libsignal.js');

// A pkmsg is authenticated only by the MAC over its inner WhisperMessage. The
// `identityKey` in the wrapper is NOT covered by that MAC, so nothing read out of
// it may be persisted until the MAC has verified.

const JID = '15551@s.whatsapp.net';
const ADDR = '15551.0';
const SPK_ID = 5;
const OPK_ID = 7;
const SPARE_OPK_ID = 8;

const with05 = (b32) => Buffer.concat([Buffer.from([0x05]), b32]);
const makeIdentity = (priv) => ({ privKey: priv, pubKey: with05(native.curveGenerateKeypair(priv)[0]) });

// Mirrors makeCacheableSignalKeyStore: `transaction` is a per-key mutex, NOT a
// rollback. A write committed before the MAC fails stays committed.
function makeKeyStore() {
  const data = new Map();
  const chains = new Map();
  return {
    get: async (type, ids) => {
      const bucket = data.get(type) || new Map();
      const out = {};
      for (const id of ids) if (bucket.has(id)) out[id] = bucket.get(id);
      return out;
    },
    set: async (patch) => {
      for (const [type, entries] of Object.entries(patch)) {
        let bucket = data.get(type);
        if (!bucket) data.set(type, bucket = new Map());
        for (const [id, value] of Object.entries(entries)) {
          if (value === null) bucket.delete(id);
          else bucket.set(id, value);
        }
      }
    },
    transaction: (exec, key) => {
      const prev = chains.get(key) || Promise.resolve();
      const next = prev.then(exec, exec);
      chains.set(key, next.then(() => {}, () => {}));
      return next;
    },
    bucket: (type) => data.get(type) || new Map()
  };
}

const silentLogger = new Proxy({}, { get: () => () => {} });

// "Us": the device whose repository we drive. Owns two OPKs, one SPK, one identity.
async function makeLocalDevice() {
  const identityPriv = Buffer.alloc(32, 0x22);
  const identityPub = with05(native.curveGenerateKeypair(identityPriv)[0]);
  const spkPriv = Buffer.alloc(32, 0x33);
  const spkPub = with05(native.curveGenerateKeypair(spkPriv)[0]);
  const opk7 = Buffer.alloc(32, 0x44), opk8 = Buffer.alloc(32, 0x66);
  const opk7Pub = with05(native.curveGenerateKeypair(opk7)[0]);
  const opk8Pub = with05(native.curveGenerateKeypair(opk8)[0]);

  const keys = makeKeyStore();
  await keys.set({
    'pre-key': {
      [OPK_ID]: { private: opk7, public: opk7Pub },
      [SPARE_OPK_ID]: { private: opk8, public: opk8Pub }
    }
  });
  const creds = {
    registrationId: 222,
    signedIdentityKey: { private: identityPriv, public: native.curveGenerateKeypair(identityPriv)[0] },
    signedPreKey: { keyPair: { private: spkPriv, public: spkPub } }
  };
  const repo = makeLibSignalRepository({ creds, keys }, silentLogger, async () => null);

  // A remote peer answers a pendingPreKey with a fresh ephemeral, so each bundle
  // here produces a pkmsg under a brand-new baseKey.
  const bundleFor = (opkId) => ({
    identityKey: identityPub,
    signedPreKey: { keyId: SPK_ID, publicKey: spkPub, signature: native.curveSign(identityPriv, spkPub, null) },
    preKey: { keyId: opkId, publicKey: opkId === OPK_ID ? opk7Pub : opk8Pub },
    registrationId: 222
  });

  return { keys, repo, bundleFor };
}

// A remote peer with its own identity and a fresh SessionBuilder.
async function sendPkmsg(bundle, identitySeed) {
  const identityPriv = Buffer.alloc(32, identitySeed);
  const peer = makeIdentity(identityPriv);
  const addr = new ProtocolAddress('15551', 0);
  let session = null;
  const storage = {
    getOurIdentity: async () => peer,
    getOurRegistrationId: async () => identitySeed,
    loadSignedPreKey: async () => ({ privKey: Buffer.alloc(32, 0x77), pubKey: with05(Buffer.alloc(32, 0x78)) }),
    loadPreKey: async () => null,
    removePreKey: async () => {},
    loadSession: async () => session,
    storeSession: async (id, s) => { session = s; }
  };
  await new SessionBuilder(storage, addr).initOutgoing(bundle);
  const { body } = await new SessionCipher(storage, addr).encrypt(Buffer.from('hello'));
  return { ciphertext: Buffer.from(body), identityKey: peer.pubKey };
}

// The inner serialized WhisperMessage is `33 | 0a 21 | ratchetKey(33) | counter |
// previousCounter | ciphertext | mac`. The ratchetKey derives the MAC key, so
// flipping a ratchetKey byte fails authentication as a MAC check while leaving
// the pkmsg framing, the advertised baseKey and the identityKey untouched.
// Offset 4 is the first byte of the 0x05-prefixed ratchet key.
const RATCHET_KEY_BYTE = 4;

// Locate the length-delimited field holding the inner WhisperMessage. Re-encoding
// is not an option: oktz-signal ships a decode-only protobuf type, so the byte is
// patched in place (the field length is unchanged, so no re-framing is needed).
function findInnerMessageRange(pb) {
  let i = 0;
  let range = null;
  while (i < pb.length) {
    let key = 0, shift = 0, b;
    do { b = pb[i++]; key |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    const wire = key & 7;
    if (wire === 2) {
      let len = 0;
      shift = 0;
      do { b = pb[i++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
      range = { start: i, len };
      i += len;
    } else if (wire === 0) {
      do { b = pb[i++]; } while (b & 0x80);
    } else {
      break;
    }
  }
  return range;
}

function tamperMac(ciphertext) {
  const out = Buffer.from(ciphertext);
  const pb = out.subarray(1);
  const proto = PreKeyWhisperMessage.decode(pb);
  const range = findInnerMessageRange(pb);
  assert.ok(range, 'pkmsg must carry a length-delimited inner message');
  assert.equal(range.len, proto.message.length, 'inner message must be the trailing bytes field');
  out[1 + range.start + RATCHET_KEY_BYTE] ^= 0x01;
  return out;
}

const openBaseKeys = (record) => Object.values(JSON.parse(record)._sessions || {})
  .filter((e) => e?.indexInfo && e.indexInfo.closed === -1)
  .map((e) => e.indexInfo.baseKey);

const storedSession = (keys) => keys.bucket('session').get(ADDR) || null;
const storedIdentity = (keys) => keys.bucket('identity-key').get(ADDR) || null;

test('unauthenticated pkmsg does not destroy the session or poison the identity key', async () => {
  const { keys, repo, bundleFor } = await makeLocalDevice();

  // Healthy established session from the real peer (identity seed 0x11).
  const good = await sendPkmsg(bundleFor(OPK_ID), 0x11);
  const plain = await repo.decryptMessage({ jid: JID, type: 'pkmsg', ciphertext: good.ciphertext });
  assert.equal(plain.toString(), 'hello');

  const healthyRecord = storedSession(keys);
  const healthyIdentity = Buffer.from(storedIdentity(keys));
  const [healthyBaseKey] = openBaseKeys(healthyRecord);
  assert.ok(healthyBaseKey, 'precondition: an open session is established');
  assert.equal(healthyIdentity.length, 33, 'precondition: peer identity key stored');

  // Fresh baseKey, 33 attacker-chosen identity bytes, MAC verification fails. The
  // message is rejected, so none of it may reach disk.
  const forged = await sendPkmsg(bundleFor(SPARE_OPK_ID), 0x99);
  const tampered = tamperMac(forged.ciphertext);

  await assert.rejects(
    repo.decryptMessage({ jid: JID, type: 'pkmsg', ciphertext: tampered }),
    /MAC verification failed/i
  );

  assert.ok(storedSession(keys), 'a rejected pkmsg must not delete the established session');
  assert.deepEqual(
    openBaseKeys(storedSession(keys)),
    [healthyBaseKey],
    'the original open session must survive a rejected pkmsg'
  );
  assert.deepEqual(
    Buffer.from(storedIdentity(keys)),
    healthyIdentity,
    'the identity key must only move on an authenticated pkmsg'
  );
});

test('rejected pkmsg leaves the session usable for the real peer', async () => {
  const { keys, repo, bundleFor } = await makeLocalDevice();
  const good = await sendPkmsg(bundleFor(OPK_ID), 0x11);
  await repo.decryptMessage({ jid: JID, type: 'pkmsg', ciphertext: good.ciphertext });

  const forged = await sendPkmsg(bundleFor(SPARE_OPK_ID), 0x99);
  await assert.rejects(
    repo.decryptMessage({ jid: JID, type: 'pkmsg', ciphertext: tamperMac(forged.ciphertext) }),
    /MAC verification failed/i
  );

  assert.ok(storedSession(keys), 'session must not be deleted by a rejected pkmsg');
  const info = await repo.getSessionInfo(JID);
  assert.ok(info, 'session info must still resolve after a rejected pkmsg');
});

test('authenticated pkmsg from a re-keyed peer still re-establishes the session', async () => {
  const { keys, repo, bundleFor } = await makeLocalDevice();
  const first = await sendPkmsg(bundleFor(OPK_ID), 0x11);
  await repo.decryptMessage({ jid: JID, type: 'pkmsg', ciphertext: first.ciphertext });

  // Legitimate re-key: valid MAC, new identity key.
  const rekeyed = await sendPkmsg(bundleFor(SPARE_OPK_ID), 0x55);
  const plain = await repo.decryptMessage({ jid: JID, type: 'pkmsg', ciphertext: rekeyed.ciphertext });
  assert.equal(plain.toString(), 'hello');

  assert.deepEqual(
    Buffer.from(storedIdentity(keys)),
    rekeyed.identityKey,
    'an authenticated identity change must be adopted'
  );
  assert.ok(openBaseKeys(storedSession(keys)).length > 0, 'a usable session must remain after re-key');
});

test('pkmsg naming a consumed one-time prekey does not touch stored state', async () => {
  const { keys, repo, bundleFor } = await makeLocalDevice();
  const first = await sendPkmsg(bundleFor(OPK_ID), 0x11);
  await repo.decryptMessage({ jid: JID, type: 'pkmsg', ciphertext: first.ciphertext });
  const healthyRecord = storedSession(keys);
  const healthyIdentity = Buffer.from(storedIdentity(keys));

  // Same peer re-initialises with the OPK we already burned: loadPreKey returns
  // null, the session is built without DH4, and nothing may be persisted.
  const replay = await sendPkmsg(bundleFor(OPK_ID), 0x11);
  await assert.rejects(repo.decryptMessage({ jid: JID, type: 'pkmsg', ciphertext: replay.ciphertext }));

  assert.equal(storedSession(keys), healthyRecord, 'session record must be byte-identical');
  assert.deepEqual(Buffer.from(storedIdentity(keys)), healthyIdentity, 'identity key must be unchanged');
});

test('identity key is not poisoned by a pkmsg whose prekey we do not hold', async () => {
  const { keys, repo, bundleFor } = await makeLocalDevice();
  const good = await sendPkmsg(bundleFor(OPK_ID), 0x11);
  await repo.decryptMessage({ jid: JID, type: 'pkmsg', ciphertext: good.ciphertext });
  const healthyIdentity = Buffer.from(storedIdentity(keys));

  // Unknown prekey id: rejected during initIncoming, before any MAC check.
  const forged = await sendPkmsg({ ...bundleFor(SPARE_OPK_ID), preKey: { keyId: 99, publicKey: bundleFor(SPARE_OPK_ID).preKey.publicKey } }, 0x99);
  await assert.rejects(repo.decryptMessage({ jid: JID, type: 'pkmsg', ciphertext: forged.ciphertext }), /Missing prekey 99/);

  assert.deepEqual(
    Buffer.from(storedIdentity(keys)),
    healthyIdentity,
    'an unresolvable pkmsg must not move the TOFU identity pointer'
  );
});
