import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// E2EE roundtrip test — the audit's #1 test-coverage gap: the Signal engine
// (oktz-signal) was swapped in wholesale but had zero roundtrip coverage.
// This exercises the real wrapper used by lib/Signal/libsignal.js:
// SessionBuilder.initOutgoing → encrypt → decryptPreKeyWhisperMessage → reply.

const oktzSignal = require('oktz-signal');
const { native, SessionBuilder, SessionCipher, ProtocolAddress } = oktzSignal;

const identityOf = (priv) =>
  Buffer.concat([Buffer.from([0x05]), native.curveGenerateKeypair(priv)[0]]);

function makeStorage(identity, regId, spkPair, preKeys = new Map()) {
  let session = null;
  return {
    getOurIdentity: async () => identity,
    getOurRegistrationId: async () => regId,
    loadSignedPreKey: async () => spkPair,
    loadPreKey: async (id) => preKeys.get(id) || null,
    removePreKey: async (id) => { preKeys.delete(id); },
    loadSession: async () => session,
    storeSession: async (id, s) => { session = s; },
  };
}

async function makePair() {
  const alicePriv = Buffer.alloc(32, 0x11);
  const bobPriv = Buffer.alloc(32, 0x22);
  const spkPriv = Buffer.alloc(32, 0x33), spkPub = native.curveGenerateKeypair(spkPriv)[0];
  const spkSig = native.curveSign(bobPriv, Buffer.concat([Buffer.from([0x05]), spkPub]), null);
  const opkPriv = Buffer.alloc(32, 0x44), opkPub = native.curveGenerateKeypair(opkPriv)[0];

  const aliceStorage = makeStorage({ privKey: alicePriv, pubKey: identityOf(alicePriv) }, 111, null);
  const bobStorage = makeStorage({ privKey: bobPriv, pubKey: identityOf(bobPriv) }, 222,
    { privKey: spkPriv, pubKey: Buffer.concat([Buffer.from([0x05]), spkPub]) },
    new Map([[7, { privKey: opkPriv, pubKey: Buffer.concat([Buffer.from([0x05]), opkPub]) }]]));

  const aliceAddr = new ProtocolAddress('bob-device', 1);
  const bobAddr = new ProtocolAddress('alice-device', 1);

  await new SessionBuilder(aliceStorage, aliceAddr).initOutgoing({
    identityKey: identityOf(bobPriv),
    signedPreKey: { keyId: 5, publicKey: Buffer.concat([Buffer.from([0x05]), spkPub]), signature: spkSig },
    preKey: { keyId: 7, publicKey: Buffer.concat([Buffer.from([0x05]), opkPub]) },
    registrationId: 42,
  });

  return {
    ca: new SessionCipher(aliceStorage, aliceAddr),
    cb: new SessionCipher(bobStorage, bobAddr),
    bobStorage,
  };
}

test('E2EE roundtrip: first message is PKMsg (type 3) and decrypts', async () => {
  const { ca, cb } = await makePair();
  const e = await ca.encrypt(Buffer.from('hello bob'));
  assert.equal(e.type, 3, 'first message must be type 3 (PKMsg)');
  assert.equal(e.body[0], 0x33, 'version byte 0x33');
  const plain = await cb.decryptPreKeyWhisperMessage(e.body);
  assert.equal(plain.toString(), 'hello bob');
});

test('E2EE roundtrip: after reply, sender downgrades to type 1 (plain WhisperMessage)', async () => {
  const { ca, cb } = await makePair();
  await cb.decryptPreKeyWhisperMessage((await ca.encrypt(Buffer.from('q1'))).body);
  const reply = await cb.encrypt(Buffer.from('reply'));
  assert.equal(reply.type, 1, 'recipient reply must be type 1');
  const back = await ca.decryptWhisperMessage(reply.body);
  assert.equal(back.toString(), 'reply');
  const next = await ca.encrypt(Buffer.from('steady'));
  assert.equal(next.type, 1, 'sender drops pendingPreKey after receiving a reply');
  assert.equal((await cb.decryptWhisperMessage(next.body)).toString(), 'steady');
});

test('E2EE roundtrip: out-of-order delivery decrypts via skipped-message keys', async () => {
  const { ca, cb } = await makePair();
  const msgs = [];
  for (let i = 1; i <= 3; i++) msgs.push(await ca.encrypt(Buffer.from('m' + i)));
  // receive in reverse: #3, #2, #1
  for (let i = 2; i >= 0; i--) {
    const d = msgs[i].type === 3
      ? await cb.decryptPreKeyWhisperMessage(msgs[i].body)
      : await cb.decryptWhisperMessage(msgs[i].body);
    assert.equal(d.toString(), 'm' + (i + 1));
  }
});

test('E2EE: one-time prekey is consumed after initIncoming', async () => {
  const { ca, cb, bobStorage } = await makePair();
  await cb.decryptPreKeyWhisperMessage((await ca.encrypt(Buffer.from('x'))).body);
  // OPK id 7 was removed by removePreKey — must no longer be loadable.
  const leftover = await bobStorage.loadPreKey(7);
  assert.ok(!leftover, 'OPK 7 must be removed after successful initIncoming');
});

test('E2EE: large message (100KB) roundtrips through PKMsg path', async () => {
  const { ca, cb } = await makePair();
  const big = Buffer.alloc(100 * 1024, 0x61);
  const e = await ca.encrypt(big);
  const out = await cb.decryptPreKeyWhisperMessage(e.body);
  assert.deepEqual(out, big);
});
