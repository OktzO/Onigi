import test from 'node:test';
import assert from 'node:assert/strict';
import { deflate } from 'node:zlib';
import { promisify } from 'node:util';
import NodeCache from '@cacheable/node-cache';
import processMessage from '../lib/Utils/process-message.js';
import { aesEncryptGCM, hmacSign } from '../lib/Utils/crypto.js';
import { runScenario } from './helpers/ev-socket-harness.mjs';
import { proto } from '../WAProto/index.js';

const deflatePromise = promisify(deflate);

/*
 * Issue #2822 ("Meta-AI self-chat messages keep getting redelivered").
 *
 * A retry-receipt loop or a duplicated stanza made `processMessage` run the
 * whole dispatch again for a message it had already handled: a second
 * `messages.upsert`, a second receipt, a second history append. Nothing in
 * the pipeline was idempotent, so the duplicate was indistinguishable from a
 * genuinely new message downstream.
 *
 * The fix is an opt-in `processedMessageCache` in the ctx: keyed on the
 * message identity (`key.id` + a short hash of a cheap body signature), the
 * second delivery of the *same* stanza returns before any emit.
 *
 * Every assertion below counts EMITTED `ev` events, never internal call
 * counts, so the test observes the contract a consumer of the socket sees.
 */

const ME = '62812345678:1@s.whatsapp.net';
const CHAT = '62899999999@s.whatsapp.net';

const silentLogger = () => ({
    level: 'silent',
    trace() { },
    debug() { },
    info() { },
    warn() { },
    error() { }
});

/** minimal ctx — everything processMessage touches, nothing it doesn't */
const ctxFor = (emitted, extra = {}) => ({
    shouldProcessHistoryMsg: false,
    placeholderResendCache: {
        get: async () => undefined,
        del: async () => undefined
    },
    ev: { on: () => { }, off: () => { }, emit: (event, data) => { emitted.push({ event, data }); } },
    creds: { me: { id: ME }, accountSettings: {} },
    signalRepository: {
        lidMapping: {
            getLIDForPN: async () => undefined,
            getPNForLID: async () => undefined,
            storeLIDPNMappings: async () => undefined
        },
        migrateSession: async () => undefined
    },
    keyStore: {
        get: async () => ({}),
        set: async () => { },
        transaction: async fn => fn()
    },
    logger: silentLogger(),
    options: {},
    getMessage: async () => undefined,
    ...extra
});

/**
 * The only stanza that makes `processMessage` itself emit `messages.upsert`:
 * a PDO (peer data operation) response carrying a placeholder resend — the
 * phone answering a retry we asked for, which is exactly the stanza that
 * comes back twice when a retry receipt loops.
 */
const placeholderResendStanza = (stanzaId, text) => {
    const webMessageInfo = proto.WebMessageInfo.encode({
        key: { id: 'ORIG-1', fromMe: true, remoteJid: CHAT },
        message: { conversation: text ?? 'hello' },
        messageTimestamp: 1700000000
    }).finish();
    return {
        key: { id: stanzaId, fromMe: true, remoteJid: CHAT },
        message: {
            protocolMessage: {
                type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE,
                peerDataOperationRequestResponseMessage: {
                    stanzaId: stanzaId,
                    peerDataOperationResult: [
                        { placeholderMessageResendResponse: { webMessageInfoBytes: webMessageInfo } }
                    ]
                }
            }
        }
    };
};

/** a plain receipt: someone read one of our messages */
const receiptStanza = (stanzaId) => ({
    key: { id: stanzaId, fromMe: false, remoteJid: CHAT, participant: CHAT },
    message: {
        reactionMessage: {
            key: { id: 'ORIG-2', fromMe: true, remoteJid: CHAT },
            text: 'read',
            groupingKey: 'ORIG-2',
            senderTimestampMs: 1700000000000
        }
    }
});

/**
 * Build the encrypted body of an event response, using the same derivation
 * decryptEventResponse inverts (lib/Utils/process-message.js). Lets the test
 * feed a response that really decrypts, so "the retry worked" is observable as
 * a decrypted eventResponse rather than as an absence of log lines.
 */
const encryptEventResponse = (messageSecret, creationKey) => {
    // participant-less creation key in a PN chat, and a responder in that same
    // chat — both resolve to CHAT through getKeyAuthor
    const eventMsgId = creationKey.id;
    const jid = creationKey.remoteJid;
    const iv = Buffer.alloc(12, 3);
    const key0 = hmacSign(messageSecret, new Uint8Array(32), 'sha256');
    const key = hmacSign(Buffer.concat([
        Buffer.from(eventMsgId),
        Buffer.from(jid),
        Buffer.from(jid),
        Buffer.from('Event Response'),
        new Uint8Array([1])
    ]), key0, 'sha256');
    const plaintext = proto.Message.EventResponseMessage.encode(proto.Message.EventResponseMessage.fromObject({
        response: proto.Message.EventResponseMessage.EventResponseType.GOING,
        timestampMs: 1700000000000
    })).finish();
    return {
        encIv: iv,
        encPayload: aesEncryptGCM(plaintext, key, iv, Buffer.from(`${eventMsgId}\u0000${jid}`))
    };
};

/**
 * A history-sync stanza that needs no network to be processed: the chunk rides
 * inline, deflated, so downloadAndProcessHistorySyncNotification takes the
 * local decode path instead of downloading it.
 */
const historySyncStanza = async stanzaId => {
    const chunk = proto.HistorySync.encode(proto.HistorySync.fromObject({
        syncType: proto.HistorySync.HistorySyncType.RECENT,
        progress: 100,
        conversations: [{
            id: CHAT,
            messages: [{
                message: {
                    key: { id: 'HISTMSG-1', fromMe: false, remoteJid: CHAT },
                    message: { conversation: 'from history' },
                    messageTimestamp: 1700000000
                }
            }]
        }]
    })).finish();
    return {
        // fromMe: the self-only protocol types are dropped from a non-self origin
        key: { id: stanzaId, fromMe: true, remoteJid: ME },
        message: {
            protocolMessage: {
                type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
                historySyncNotification: {
                    syncType: proto.HistorySync.HistorySyncType.RECENT,
                    chunkOrder: 1,
                    initialHistBootstrapInlinePayload: await deflatePromise(chunk)
                }
            }
        }
    };
};

const deliverTwice = async (build, ctxExtra = {}) => {
    const emitted = [];
    const ctx = ctxFor(emitted, ctxExtra);
    // the same stanza, byte-for-byte: exactly what a redelivery looks like
    await processMessage(build('STANZA-1'), ctx);
    await processMessage(build('STANZA-1'), ctx);
    return emitted.filter(e => e.event === 'messages.upsert');
};

test('a redelivered message is processed once', async () => {
    // --- the fix: a cache in the ctx dedupes the redelivery ---------------
    const processedMessageCache = new NodeCache({ stdTTL: 600, useClones: false });
    const upserts = await deliverTwice(placeholderResendStanza, { processedMessageCache });
    assert.equal(upserts.length, 1, 'the same stanza must yield exactly one messages.upsert');
    assert.equal(
        upserts[0].data.messages.length, 1,
        'the surviving upsert must still carry the message'
    );

    // --- receipts dedupe on the same key ---------------------------------
    const receiptEmitted = [];
    const receiptCtx = ctxFor(receiptEmitted, {
        processedMessageCache: new NodeCache({ stdTTL: 600, useClones: false })
    });
    await processMessage(receiptStanza('RECEIPT-1'), receiptCtx);
    await processMessage(receiptStanza('RECEIPT-1'), receiptCtx);
    assert.equal(
        receiptEmitted.filter(e => e.event === 'messages.reaction').length, 1,
        'a redelivered receipt must not be emitted twice'
    );

    // --- a different body under the same id is a different message -------
    // (this is why the cache key carries a body hash, not just the id)
    const differing = [];
    const differingCtx = ctxFor(differing, {
        processedMessageCache: new NodeCache({ stdTTL: 600, useClones: false })
    });
    await processMessage(placeholderResendStanza('STANZA-2', 'first'), differingCtx);
    await processMessage(placeholderResendStanza('STANZA-2', 'second'), differingCtx);
    assert.equal(
        differing.filter(e => e.event === 'messages.upsert').length, 2,
        'two different messages sharing an id must both be processed'
    );

    // --- optionality: no cache in ctx = today's behaviour, untouched -----
    const uncached = await deliverTwice(placeholderResendStanza);
    assert.equal(
        uncached.length, 2,
        'with no processedMessageCache the redelivery is processed as before'
    );

    // --- a message we could not act on yet stays retryable ---------------
    // An event response whose creation message is not in the store yet cannot
    // be decrypted. It must NOT be marked as processed, or the redelivery that
    // arrives once the creation message is stored would be swallowed and the
    // response lost forever.
    //
    // Asserted the way a consumer sees it, not by counting logs: the creation
    // message only becomes available for the second delivery, so the outcome
    // that matters is the `messages.update` carrying the decrypted response.
    const creationKey = { id: 'CREATION-1', fromMe: true, remoteJid: CHAT };
    const eventSecret = Buffer.alloc(32, 7);
    const encryptedResponse = encryptEventResponse(eventSecret, creationKey);
    let storeLookups = 0;
    const retryEmitted = [];
    const retryCtx = ctxFor(retryEmitted, {
        processedMessageCache: new NodeCache({ stdTTL: 600, useClones: false }),
        getMessage: async () => (++storeLookups === 1
            ? undefined
            : { messageContextInfo: { messageSecret: eventSecret } })
    });
    const eventResponseStanza = () => ({
        key: { id: 'EVENT-1', fromMe: false, remoteJid: CHAT, participant: CHAT },
        message: {
            encEventResponseMessage: {
                eventCreationMessageKey: creationKey,
                ...encryptedResponse
            }
        }
    });
    await processMessage(eventResponseStanza(), retryCtx);
    assert.equal(
        retryEmitted.filter(e => e.event === 'messages.update').length, 0,
        'with no creation message in the store there is nothing to update yet'
    );
    await processMessage(eventResponseStanza(), retryCtx);
    const updates = retryEmitted.filter(e => e.event === 'messages.update');
    assert.equal(
        updates.length, 1,
        'the redelivery must be retried and emit its update, not swallowed by the cache'
    );
    assert.equal(updates[0].data[0].key.id, 'CREATION-1');
    assert.equal(updates[0].data[0].update.eventResponses.length, 1);
    assert.equal(
        updates[0].data[0].update.eventResponses[0].response.response,
        proto.Message.EventResponseMessage.EventResponseType.GOING,
        'and the response must be the decrypted one, not a placeholder'
    );
    // now that it succeeded it is marked, so a third delivery adds nothing
    await processMessage(eventResponseStanza(), retryCtx);
    assert.equal(
        retryEmitted.filter(e => e.event === 'messages.update').length, 1,
        'a delivery after a successful retry must dedupe'
    );
});

test('a history-sync stanza deferred before the initial sync completes still lands on retry', async () => {
    // shouldProcessHistoryMsg:false means the initial sync has not finished, so
    // there is nowhere to put the chunk yet. Nothing was done, so the stanza
    // must NOT be marked -- otherwise the notification the server resends once
    // the sync does complete is mistaken for a redelivery of a handled message
    // and the whole chunk is silently dropped.
    const processedMessageCache = new NodeCache({ stdTTL: 600, useClones: false });
    const emitted = [];
    const stanza = await historySyncStanza('HIST-1');

    const deferring = ctxFor(emitted, { processedMessageCache, shouldProcessHistoryMsg: false });
    await processMessage(stanza, deferring);
    await processMessage(stanza, deferring);
    assert.equal(
        emitted.filter(e => e.event === 'messaging-history.set').length, 0,
        'no history is available while the initial sync is still pending'
    );

    // the retry, once the sync has completed: the chunk must actually arrive,
    // which is the part "nothing was logged" could never show
    const ready = ctxFor(emitted, { processedMessageCache, shouldProcessHistoryMsg: true });
    await processMessage(stanza, ready);
    const sets = emitted.filter(e => e.event === 'messaging-history.set');
    assert.equal(sets.length, 1, 'the retry must deliver the chunk exactly once');
    assert.equal(
        sets[0].data.messages.length, 1,
        'and deliver its messages, not just the event'
    );
    assert.equal(sets[0].data.messages[0].message.conversation, 'from history');

    // marked now, so the server resending it again is a redelivery
    await processMessage(stanza, ready);
    assert.equal(
        emitted.filter(e => e.event === 'messaging-history.set').length, 1,
        'a delivery after a successful history sync must dedupe'
    );
});

test('a redelivered ordinary message is upserted once through the real CB:message path', async () => {
    // processMessage's guard only covers what processMessage emits, and the
    // ordinary-message route emits `messages.upsert` from upsertMessage in
    // lib/Socket/chats.js -- before processMessage is ever reached. Driven
    // through the real handler here: a redelivered stanza is a second
    // ws.emit('CB:message', ...) of the same stanza, not a second call into
    // processMessage, which the previous test would not catch.
    //
    // The outbound sendReceipt in handleMessage (messages-recv.js, above the
    // upsertMessage call) still fires per redelivery; that guard belongs at a
    // call site in another file and is tracked as a follow-up.
    const { code, stdout, stderr } = await runScenario(`
const h = await startHarness();
await tick(50);
const delivered = [];
h.sock.ev.on('messages.upsert', e => delivered.push(e.messages.map(m => m.key.id).join(',')));
h.sock.ws.emit('CB:message', PLAINTEXT_STANZA('DUP-1'));
await tick(400);
h.sock.ws.emit('CB:message', PLAINTEXT_STANZA('DUP-1'));
await tick(400);
console.log('delivered=' + JSON.stringify(delivered));
await h.close();
process.exit(0);
`);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /delivered=\["DUP-1"\]/, 'a redelivered stanza must not reach the consumer twice');
});
