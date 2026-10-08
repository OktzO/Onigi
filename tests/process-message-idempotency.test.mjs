import test from 'node:test';
import assert from 'node:assert/strict';
import NodeCache from '@cacheable/node-cache';
import processMessage from '../lib/Utils/process-message.js';
import { proto } from '../WAProto/index.js';

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
    // be decrypted; it must NOT be marked as processed, or the redelivery that
    // arrives once the creation message is stored would be swallowed and the
    // response lost forever. Observable through the warn it logs each time.
    const deferredLogs = [];
    const deferredEmitted = [];
    const deferredCtx = ctxFor(deferredEmitted, {
        processedMessageCache: new NodeCache({ stdTTL: 600, useClones: false }),
        logger: {
            ...silentLogger(),
            warn: (...a) => { deferredLogs.push(JSON.stringify(a)); }
        }
    });
    const undecryptable = () => ({
        key: { id: 'EVENT-1', fromMe: false, remoteJid: CHAT, participant: CHAT },
        message: {
            encEventResponseMessage: {
                eventCreationMessageKey: { id: 'CREATION-1', fromMe: true, remoteJid: CHAT }
            }
        }
    });
    await processMessage(undecryptable(), deferredCtx);
    await processMessage(undecryptable(), deferredCtx);
    assert.equal(
        deferredLogs.filter(l => l.includes('event creation message not found')).length, 2,
        'an undecryptable message must stay unmarked so its redelivery retries'
    );
});