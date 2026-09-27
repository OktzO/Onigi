import { LRUCache } from 'lru-cache';
/** Number of sent messages to cache in memory for handling retry receipts */
const RECENT_MESSAGES_SIZE = 512;
const MESSAGE_KEY_SEPARATOR = '\u0000';
/** Timeout for session recreation - 1 hour */
const RECREATE_SESSION_TIMEOUT = 60 * 60 * 1000; // 1 hour in milliseconds
const PHONE_REQUEST_DELAY = 3000;
// Retry reason codes matching WhatsApp Web's Signal error codes.
export var RetryReason;
(function (RetryReason) {
    RetryReason[RetryReason["UnknownError"] = 0] = "UnknownError";
    RetryReason[RetryReason["SignalErrorNoSession"] = 1] = "SignalErrorNoSession";
    RetryReason[RetryReason["SignalErrorInvalidKey"] = 2] = "SignalErrorInvalidKey";
    RetryReason[RetryReason["SignalErrorInvalidKeyId"] = 3] = "SignalErrorInvalidKeyId";
    /** MAC verification failed - most common cause of decryption failures */
    RetryReason[RetryReason["SignalErrorInvalidMessage"] = 4] = "SignalErrorInvalidMessage";
    RetryReason[RetryReason["SignalErrorInvalidSignature"] = 5] = "SignalErrorInvalidSignature";
    RetryReason[RetryReason["SignalErrorFutureMessage"] = 6] = "SignalErrorFutureMessage";
    /** Explicit MAC failure - session is definitely out of sync */
    RetryReason[RetryReason["SignalErrorBadMac"] = 7] = "SignalErrorBadMac";
    RetryReason[RetryReason["SignalErrorInvalidSession"] = 8] = "SignalErrorInvalidSession";
    RetryReason[RetryReason["SignalErrorInvalidMsgKey"] = 9] = "SignalErrorInvalidMsgKey";
    RetryReason[RetryReason["BadBroadcastEphemeralSetting"] = 10] = "BadBroadcastEphemeralSetting";
    RetryReason[RetryReason["UnknownCompanionNoPrekey"] = 11] = "UnknownCompanionNoPrekey";
    RetryReason[RetryReason["AdvFailure"] = 12] = "AdvFailure";
    RetryReason[RetryReason["StatusRevokeDelay"] = 13] = "StatusRevokeDelay";
})(RetryReason || (RetryReason = {}));
/** Error codes that indicate a MAC failure and require immediate session recreation */
const MAC_ERROR_CODES = new Set([RetryReason.SignalErrorInvalidMessage, RetryReason.SignalErrorBadMac]);
/**
 * The Signal layer reports failures as message strings (oktz-signal's native
 * errors are plain strings), so a retry reason has to be recovered from the
 * text. Ordered most-specific first; anything unrecognised is an UnknownError,
 * which is also what the wire used to carry unconditionally.
 */
const DECRYPT_ERROR_PATTERNS = [
    [/mac verification failed|mac validation|invalid signature|bad mac/i, RetryReason.SignalErrorBadMac],
    [/key used already|never filled/i, RetryReason.SignalErrorInvalidKeyId],
    [/no session|empty record/i, RetryReason.SignalErrorNoSession],
    [/untrusted identity/i, RetryReason.SignalErrorInvalidKey],
    [/invalid message/i, RetryReason.SignalErrorInvalidMessage]
];
export const classifyDecryptError = (error) => {
    if (error === undefined || error === null || error === '') {
        return undefined;
    }
    const text = typeof error === 'string' ? error : (error.message ?? String(error));
    for (const [pattern, code] of DECRYPT_ERROR_PATTERNS) {
        if (pattern.test(text)) {
            return code;
        }
    }
    return RetryReason.UnknownError;
};
export class MessageRetryManager {
    constructor(logger, maxMsgRetryCount) {
        this.logger = logger;
        this.recentMessagesMap = new LRUCache({
            max: RECENT_MESSAGES_SIZE,
            ttl: 5 * 60 * 1000,
            ttlAutopurge: true,
            dispose: (_value, key) => {
                const separatorIndex = key.lastIndexOf(MESSAGE_KEY_SEPARATOR);
                if (separatorIndex > -1) {
                    const messageId = key.slice(separatorIndex + MESSAGE_KEY_SEPARATOR.length);
                    this.messageKeyIndex.delete(messageId);
                }
            }
        });
        this.messageKeyIndex = new Map();
        this.sessionRecreateHistory = new LRUCache({
            max: 10_000,
            ttl: RECREATE_SESSION_TIMEOUT * 2,
            ttlAutopurge: true
        });
        this.retryCounters = new LRUCache({
            max: 5_000,
            ttl: 15 * 60 * 1000,
            ttlAutopurge: true,
            updateAgeOnGet: true,
            // An eviction resets that message's budget, so it has to be visible:
            // a peer that suddenly gets a full fresh allowance would otherwise be
            // a mystery. Only reason 'evict' counts -- lru-cache also fires
            // dispose with reason 'set' when a counter is incremented in place.
            dispose: (value, key, reason) => {
                if (reason === 'evict') {
                    this.logger.debug({ messageId: key, retryCount: value }, `retry counter evicted by the 5_000 entry max on retryCounters, its budget restarts from zero`);
                }
            }
        }); // 15 minutes TTL
        this.baseKeys = new LRUCache({
            max: 1024,
            ttl: 15 * 60 * 1000,
            ttlAutopurge: true
        });
        this.pendingPhoneRequests = {};
        this.maxMsgRetryCount = 5;
        this.statistics = {
            totalRetries: 0,
            successfulRetries: 0,
            failedRetries: 0,
            mediaRetries: 0,
            sessionRecreations: 0,
            phoneRequests: 0
        };
        this.maxMsgRetryCount = maxMsgRetryCount;
    }
    /**
     * Add a recent message to the cache for retry handling
     */
    addRecentMessage(to, id, message) {
        const key = { to, id };
        const keyStr = this.keyToString(key);
        // Add new message
        this.recentMessagesMap.set(keyStr, {
            message,
            timestamp: Date.now()
        });
        this.messageKeyIndex.set(id, keyStr);
        this.logger.debug(`Added message to retry cache: ${to}/${id}`);
    }
    /**
     * Get a recent message from the cache
     */
    getRecentMessage(to, id) {
        const key = { to, id };
        const keyStr = this.keyToString(key);
        return this.recentMessagesMap.get(keyStr);
    }
    /**
     * Check if a session should be recreated based on retry count, history, and error code.
     * MAC errors (codes 4 and 7) trigger immediate session recreation regardless of timeout.
     */
    shouldRecreateSession(jid, hasSession, errorCode) {
        // If we don't have a session, always recreate
        if (!hasSession) {
            this.sessionRecreateHistory.set(jid, Date.now());
            this.statistics.sessionRecreations++;
            return {
                reason: "we don't have a Signal session with them",
                recreate: true
            };
        }
        // IMMEDIATE recreation for MAC errors - session is definitely out of sync
        if (errorCode !== undefined && MAC_ERROR_CODES.has(errorCode)) {
            this.sessionRecreateHistory.set(jid, Date.now());
            this.statistics.sessionRecreations++;
            this.logger.warn({ jid, errorCode: RetryReason[errorCode] }, 'MAC error detected, forcing immediate session recreation');
            return {
                reason: `MAC error (code ${errorCode}: ${RetryReason[errorCode]}), immediate session recreation`,
                recreate: true
            };
        }
        const now = Date.now();
        const prevTime = this.sessionRecreateHistory.get(jid);
        // If no previous recreation or it's been more than an hour
        if (!prevTime || now - prevTime > RECREATE_SESSION_TIMEOUT) {
            this.sessionRecreateHistory.set(jid, now);
            this.statistics.sessionRecreations++;
            return {
                reason: 'retry count > 1 and over an hour since last recreation',
                recreate: true
            };
        }
        return { reason: '', recreate: false };
    }
    /**
     * Parse error code from retry receipt's retry node.
     * Returns undefined if no error code is present.
     */
    parseRetryErrorCode(errorAttr) {
        if (errorAttr === undefined || errorAttr === '') {
            return undefined;
        }
        const code = parseInt(errorAttr, 10);
        if (Number.isNaN(code)) {
            return undefined;
        }
        // Validate it's a known RetryReason
        if (code >= RetryReason.UnknownError && code <= RetryReason.StatusRevokeDelay) {
            return code;
        }
        return RetryReason.UnknownError;
    }
    /**
     * Check if an error code indicates a MAC failure
     */
    isMacError(errorCode) {
        return errorCode !== undefined && MAC_ERROR_CODES.has(errorCode);
    }
    /**
     * Increment retry counter for a message
     */
    incrementRetryCount(messageId) {
        this.retryCounters.set(messageId, (this.retryCounters.get(messageId) || 0) + 1);
        this.statistics.totalRetries++;
        return this.retryCounters.get(messageId);
    }
    /**
     * Get retry count for a message
     */
    getRetryCount(messageId) {
        return this.retryCounters.get(messageId) || 0;
    }
    /**
     * Check if message has exceeded maximum retry attempts
     */
    hasExceededMaxRetries(messageId) {
        return this.getRetryCount(messageId) >= this.maxMsgRetryCount;
    }
    /**
     * Mark retry as successful
     *
     * Clears the *inbound* bookkeeping only. The recent-message cache is the
     * *outbound* copy of the message and is shared by every device of a chat,
     * so dropping it here meant the first device to ask for a resend consumed
     * the message for all the others -- and the peer's remaining retries could
     * never be served at all. LRU + TTL already bound it.
     */
    markRetrySuccess(messageId) {
        this.statistics.successfulRetries++;
        // Clean up retry counter for successful message
        this.retryCounters.delete(messageId);
        this.cancelPendingPhoneRequest(messageId);
    }
    /**
     * Mark retry as failed
     *
     * Reached from the inbound cap (a message we could not decrypt the fifth
     * time). Like markRetrySuccess this must not evict recentMessagesMap: that
     * cache is what serves a later legitimate resend, in either direction.
     */
    markRetryFailed(messageId) {
        this.statistics.failedRetries++;
        this.retryCounters.delete(messageId);
        this.cancelPendingPhoneRequest(messageId);
    }
    /**
     * Schedule a phone request with delay
     */
    schedulePhoneRequest(messageId, callback, delay = PHONE_REQUEST_DELAY) {
        // Cancel any existing request for this message
        this.cancelPendingPhoneRequest(messageId);
        this.pendingPhoneRequests[messageId] = setTimeout(() => {
            delete this.pendingPhoneRequests[messageId];
            this.statistics.phoneRequests++;
            callback();
        }, delay);
        this.logger.debug(`Scheduled phone request for message ${messageId} with ${delay}ms delay`);
    }
    /**
     * Cancel pending phone request
     */
    cancelPendingPhoneRequest(messageId) {
        const timeout = this.pendingPhoneRequests[messageId];
        if (timeout) {
            clearTimeout(timeout);
            delete this.pendingPhoneRequests[messageId];
            this.logger.debug(`Cancelled pending phone request for message ${messageId}`);
        }
    }
    clear() {
        this.recentMessagesMap.clear();
        this.messageKeyIndex.clear();
        this.sessionRecreateHistory.clear();
        this.retryCounters.clear();
        this.baseKeys.clear();
        for (const messageId of Object.keys(this.pendingPhoneRequests)) {
            this.cancelPendingPhoneRequest(messageId);
        }
        this.statistics = {
            totalRetries: 0,
            successfulRetries: 0,
            failedRetries: 0,
            mediaRetries: 0,
            sessionRecreations: 0,
            phoneRequests: 0
        };
    }
    saveBaseKey(addr, msgId, baseKey) {
        this.baseKeys.set(`${addr}:${msgId}`, baseKey);
    }
    hasSameBaseKey(addr, msgId, baseKey) {
        const stored = this.baseKeys.get(`${addr}:${msgId}`);
        if (!stored || stored.length !== baseKey.length) {
            return false;
        }
        for (let i = 0; i < stored.length; i++) {
            if (stored[i] !== baseKey[i])
                return false;
        }
        return true;
    }
    deleteBaseKey(addr, msgId) {
        this.baseKeys.delete(`${addr}:${msgId}`);
    }
    keyToString(key) {
        return `${key.to}${MESSAGE_KEY_SEPARATOR}${key.id}`;
    }
    removeRecentMessage(messageId) {
        const keyStr = this.messageKeyIndex.get(messageId);
        if (!keyStr) {
            return;
        }
        this.recentMessagesMap.delete(keyStr);
        this.messageKeyIndex.delete(messageId);
    }
}
//# sourceMappingURL=message-retry-manager.js.map