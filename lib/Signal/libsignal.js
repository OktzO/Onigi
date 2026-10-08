// ProtocolAddress is pure JS with no native dependency (oktz-signal ships it as
// a dependency-free src/ module), so it stays a static import. That is what keeps
// `jidToSignalProtocolAddress` synchronous, and therefore the public repository
// shape unchanged; the engine below is the only thing that has to be lazy.
// @ts-ignore
import { ProtocolAddress } from 'oktz-signal/src/protocol-address.js';
import { LRUCache } from 'lru-cache';
import { generateSignalPubKey } from '../Utils/index.js';
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser, jidDecode, transferDevice, WAJIDDomains } from '../WABinary/index.js';
import { SenderKeyName } from './Group/sender-key-name.js';
import { SenderKeyRecord } from './Group/sender-key-record.js';
import { GroupCipher, GroupSessionBuilder, SenderKeyDistributionMessage } from './Group/index.js';
import { LIDMappingStore } from './lid-mapping.js';
/**
 * Thrown when the Signal engine cannot be loaded at all. Not exported: callers
 * classify on `code`, exactly as lib/Utils/crypto.js classifies curve-native's
 * XEdDsaUnavailableError -- duck-typed, because the module can be loaded more
 * than once in one process and `instanceof` would then be a lie.
 */
class SignalEngineUnavailableError extends Error {
    constructor(cause) {
        super(`E2EE is unavailable on ${process.platform}-${process.arch}: no native prebuild loaded. `
            + `oktz-signal publishes only signal-linux-{arm64,x64}-{gnu,musl}, so its loader threw on import. `
            + `Install a matching @oktz-signal/signal-${process.platform}-${process.arch} build, or run on linux-x64 or linux-arm64.`,
        { cause });
        this.name = 'SignalEngineUnavailableError';
        this.code = 'ONIGI_SIGNAL_ENGINE_UNSUPPORTED';
    }
}
/**
 * The engine is loaded on first use, never at import.
 *
 * oktz-signal's optionalDependencies cover only linux-{arm64,x64}-{gnu,musl};
 * its loader throws `Cannot find native binding` everywhere else. A top-level
 * `import * as libsignal from 'oktz-signal'` is evaluated while the module graph
 * is built, so that throw took down lib/index.js itself and made the library
 * unimportable on darwin, win32 and android-arm64 -- for code paths that never
 * touch E2EE. Lazy loading moves the failure to the first E2EE operation, where
 * it can be reported as the typed, platform-naming error above.
 *
 * The promise is cached, and a rejected one is cached too: a platform with no
 * prebuild must not re-enter the loader once per message.
 */
let enginePromise;
const engine = () => (enginePromise ??= import('oktz-signal').catch((cause) => { // @ts-ignore
    throw new SignalEngineUnavailableError(cause);
}));
/**
 * Extract identity key from PreKeyWhisperMessage for identity change detection.
 * `preKeyWhisperMessage` comes from the already-resolved engine: decoding needs
 * the native protobuf parser, and the catch below would otherwise report a
 * missing engine as a missing identity key.
 */
function extractIdentityFromPkmsg(ciphertext, preKeyWhisperMessage) {
    try {
        if (!ciphertext || ciphertext.length < 2) {
            return undefined;
        }
        // Version byte check (version 3)
        const version = ciphertext[0];
        if ((version & 0xf) !== 3) {
            return undefined;
        }
        // Parse protobuf (skip version byte)
        const preKeyProto = preKeyWhisperMessage.decode(ciphertext.slice(1));
        if (preKeyProto.identityKey?.length === 33) {
            return new Uint8Array(preKeyProto.identityKey);
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
export function makeLibSignalRepository(auth, logger, pnToLIDFunc) {
    const lidMapping = new LIDMappingStore(auth.keys, logger, pnToLIDFunc);
    const storage = signalStorage(auth, lidMapping);
    const parsedKeys = auth.keys;
    const migratedSessionCache = new LRUCache({
        max: 10_000,
        ttl: 12 * 60 * 60 * 1000, // 12 jam
        ttlAutopurge: true,
        updateAgeOnGet: true
    });
    const ensureSenderKeyAndCreateSkdm = async (group, meId) => {
        const senderName = jidToSignalSenderKeyName(group, meId);
        const senderNameStr = senderName.toString();
        const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
        if (!senderKey) {
            await storage.storeSenderKey(senderName, new SenderKeyRecord());
        }
        const skdm = await new GroupSessionBuilder(storage).create(senderName);
        return { senderName, skdm };
    };
    const repository = {
        decryptGroupMessage({ group, authorJid, msg }) {
            const senderName = jidToSignalSenderKeyName(group, authorJid);
            const cipher = new GroupCipher(storage, senderName);
            // Use transaction to ensure atomicity
            return parsedKeys.transaction(async () => {
                return cipher.decrypt(msg);
            });
        },
        async processSenderKeyDistributionMessage({ item, authorJid }) {
            const builder = new GroupSessionBuilder(storage);
            if (!item.groupId) {
                throw new Error('Group ID is required for sender key distribution message');
            }
            const senderName = jidToSignalSenderKeyName(item.groupId, authorJid);
            const senderMsg = new SenderKeyDistributionMessage(null, null, null, null, item.axolotlSenderKeyDistributionMessage);
            const senderNameStr = senderName.toString();
            return parsedKeys.transaction(async () => {
                const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
                if (!senderKey) {
                    await storage.storeSenderKey(senderName, new SenderKeyRecord());
                }
                await builder.process(senderName, senderMsg);
            });
        },
        async decryptMessage({ jid, type, ciphertext }) {
            // Resolved before anything is constructed or decoded: an absent engine
            // must not be reachable from the catch-all below and reported as a
            // missing identity key.
            const { SessionCipher, PreKeyWhisperMessage } = await engine();
            const addr = jidToSignalProtocolAddress(jid);
            const session = new SessionCipher(storage, addr);
            // A pkmsg wrapper's identityKey is not covered by the MAC that
            // ratchetDecryptPkmsg verifies, so it is only read here and persisted
            // once that MAC has passed. `transaction` is a mutex, not a rollback,
            // so a write committed before the check survives a later failure.
            const pendingIdentity = type === 'pkmsg' ? extractIdentityFromPkmsg(ciphertext, PreKeyWhisperMessage) : undefined;
            async function doDecrypt() {
                let result;
                switch (type) {
                    case 'pkmsg':
                        result = await session.decryptPreKeyWhisperMessage(ciphertext);
                        break;
                    case 'msg':
                        result = await session.decryptWhisperMessage(ciphertext);
                        break;
                }
                return result;
            }
            // If it's not a sync message, we need to ensure atomicity
            // For regular messages, we use a transaction to ensure atomicity
            return parsedKeys.transaction(async () => {
                const decrypted = await doDecrypt();
                if (pendingIdentity) {
                    const identityChanged = await storage.saveIdentity(addr.toString(), pendingIdentity);
                    if (identityChanged) {
                        logger.info({ jid, addr: addr.toString() }, 'identity key changed or new contact, session re-established');
                    }
                }
                return decrypted;
            });
        },
        async encryptMessage({ jid, data }) {
            const { SessionCipher } = await engine();
            const addr = jidToSignalProtocolAddress(jid);
            const cipher = new SessionCipher(storage, addr);
            // Use transaction to ensure atomicity
            return parsedKeys.transaction(async () => {
                const { type: sigType, body } = await cipher.encrypt(data);
                const type = sigType === 3 ? 'pkmsg' : 'msg';
                return { type, ciphertext: Buffer.from(body, 'binary') };
            });
        },
        async encryptGroupMessage({ group, meId, data }) {
            return parsedKeys.transaction(async () => {
                const { senderName, skdm } = await ensureSenderKeyAndCreateSkdm(group, meId);
                const ciphertext = await new GroupCipher(storage, senderName).encrypt(data);
                return { ciphertext, senderKeyDistributionMessage: skdm.serialize() };
            });
        },
        async getSenderKeyDistributionMessage({ group, meId }) {
            return parsedKeys.transaction(async () => {
                const { skdm } = await ensureSenderKeyAndCreateSkdm(group, meId);
                return skdm.serialize();
            });
        },
        async hasSenderKey({ group, meId }) {
            const senderName = jidToSignalSenderKeyName(group, meId).toString();
            const { [senderName]: key } = await auth.keys.get('sender-key', [senderName]);
            return !!key;
        },
        async getSessionInfo(jid) {
            const addr = jidToSignalProtocolAddress(jid).toString();
            const session = (await storage.loadSession(addr));
            if (!session) {
                return null;
            }
            // oktz-signal SessionRecord tidak mengekspos getOpenSession() seperti
            // libsignal; ambil info sesi terbuka dari JSON hasil serialize().
            // Struktur: { _sessions: { <key>: { indexInfo: { baseKey: <base64> }, registrationId: <number> } } }
            try {
                const parsed = JSON.parse(session.serialize());
                const sessions = parsed._sessions || {};
                const entries = Object.values(sessions);
                // Prefer entri yang belum ditutup (indexInfo.closed === -1) bila field tersedia
                const open = entries.find(e => e?.indexInfo && (e.indexInfo.closed === undefined || e.indexInfo.closed === -1)) || entries[0];
                const baseKeyRaw = open?.indexInfo?.baseKey;
                const registrationId = open?.registrationId;
                if (!baseKeyRaw || typeof registrationId !== 'number') {
                    return null;
                }
                const baseKey = typeof baseKeyRaw === 'string'
                    ? new Uint8Array(Buffer.from(baseKeyRaw, 'base64'))
                    : new Uint8Array(baseKeyRaw);
                return { baseKey, registrationId };
            }
            catch {
                return null;
            }
        },
        async injectE2ESession({ jid, session }) {
            const { SessionBuilder } = await engine();
            logger.trace({ jid }, 'injecting E2EE session');
            const cipher = new SessionBuilder(storage, jidToSignalProtocolAddress(jid));
            return parsedKeys.transaction(async () => {
                // libsignal runtime accepts an absent prekey (initOutgoing checks `device.preKey && ...`)
                // but the bundled .d.ts marks it required.
                await cipher.initOutgoing(session);
            });
        },
        jidToSignalProtocolAddress(jid) {
            return jidToSignalProtocolAddress(jid).toString();
        },
        // Optimized direct access to LID mapping store
        lidMapping,
        async validateSession(jid) {
            // Outside the catch: `exists: false` for a platform that has no engine
            // would be a fabricated answer, not a reported failure.
            await engine();
            try {
                const addr = jidToSignalProtocolAddress(jid);
                const session = await storage.loadSession(addr.toString());
                if (!session) {
                    return { exists: false, reason: 'no session' };
                }
                if (!session.haveOpenSession()) {
                    return { exists: false, reason: 'no open session' };
                }
                return { exists: true };
            }
            catch (error) {
                return { exists: false, reason: 'validation error' };
            }
        },
        async deleteSession(jids) {
            if (!jids.length)
                return;
            // Convert JIDs to signal addresses and prepare for bulk deletion
            const sessionUpdates = {};
            jids.forEach(jid => {
                const addr = jidToSignalProtocolAddress(jid);
                sessionUpdates[addr.toString()] = null;
            });
            // Single transaction for all deletions
            return parsedKeys.transaction(async () => {
                await auth.keys.set({ session: sessionUpdates });
            });
        },
        close() {
            migratedSessionCache.clear();
            lidMapping.close();
        },
        async migrateSession(fromJid, toJid) {
            // TODO: use usync to handle this entire mess
            if (!fromJid || (!isLidUser(toJid) && !isHostedLidUser(toJid)))
                return { migrated: 0, skipped: 0, total: 0 };
            // Only support PN to LID migration
            if (!isPnUser(fromJid) && !isHostedPnUser(fromJid)) {
                return { migrated: 0, skipped: 0, total: 1 };
            }
            const { user } = jidDecode(fromJid);
            logger.debug({ fromJid }, 'bulk device migration - loading all user devices');
            // Get user's device list from storage
            const { [user]: userDevices } = await parsedKeys.get('device-list', [user]);
            if (!userDevices) {
                return { migrated: 0, skipped: 0, total: 0 };
            }
            const { device: fromDevice } = jidDecode(fromJid);
            const fromDeviceStr = fromDevice?.toString() || '0';
            if (!userDevices.includes(fromDeviceStr)) {
                userDevices.push(fromDeviceStr);
            }
            // Filter out cached devices before database fetch
            const uncachedDevices = userDevices.filter(device => {
                const deviceKey = `${user}.${device}`;
                return !migratedSessionCache.has(deviceKey);
            });
            // Bulk check session existence only for uncached devices
            const deviceSessionKeys = uncachedDevices.map(device => `${user}.${device}`);
            const existingSessions = await parsedKeys.get('session', deviceSessionKeys);
            // Step 3: Convert existing sessions to JIDs (only migrate sessions that exist)
            const deviceJids = [];
            for (const [sessionKey, sessionData] of Object.entries(existingSessions)) {
                if (sessionData) {
                    // Session exists in storage
                    const deviceStr = sessionKey.split('.')[1];
                    if (!deviceStr)
                        continue;
                    const deviceNum = parseInt(deviceStr);
                    let jid = deviceNum === 0 ? `${user}@s.whatsapp.net` : `${user}:${deviceNum}@s.whatsapp.net`;
                    if (deviceNum === 99) {
                        jid = `${user}:99@hosted`;
                    }
                    deviceJids.push(jid);
                }
            }
            logger.debug({
                fromJid,
                totalDevices: userDevices.length,
                devicesWithSessions: deviceJids.length,
                devices: deviceJids
            }, 'bulk device migration complete - all user devices processed');
            // Resolved here, past the PN→LID guards above: a migration that was
            // never going to do work still answers with its no-op counts on a
            // platform with no engine, instead of failing.
            const { SessionRecord } = await engine();
            // Single transaction for all migrations
            return parsedKeys.transaction(async () => {
                const migrationOps = deviceJids.map(jid => {
                    const lidWithDevice = transferDevice(jid, toJid);
                    const fromDecoded = jidDecode(jid);
                    const toDecoded = jidDecode(lidWithDevice);
                    return {
                        fromJid: jid,
                        toJid: lidWithDevice,
                        pnUser: fromDecoded.user,
                        lidUser: toDecoded.user,
                        deviceId: fromDecoded.device || 0,
                        fromAddr: jidToSignalProtocolAddress(jid),
                        toAddr: jidToSignalProtocolAddress(lidWithDevice)
                    };
                });
                const totalOps = migrationOps.length;
                let migratedCount = 0;
                // Bulk fetch PN sessions - already exist (verified during device discovery)
                const pnAddrStrings = Array.from(new Set(migrationOps.map(op => op.fromAddr.toString())));
                const pnSessions = await parsedKeys.get('session', pnAddrStrings);
                // Prepare bulk session updates (PN → LID migration + deletion)
                const sessionUpdates = {};
                for (const op of migrationOps) {
                    const pnAddrStr = op.fromAddr.toString();
                    const lidAddrStr = op.toAddr.toString();
                    const pnSession = pnSessions[pnAddrStr];
                    if (pnSession) {
                        // Session exists (guaranteed from device discovery)
                        const fromSession = SessionRecord.deserialize(pnSession);
                        if (fromSession.haveOpenSession()) {
                            // Queue for bulk update: copy to LID, delete from PN
                            sessionUpdates[lidAddrStr] = fromSession.serialize();
                            sessionUpdates[pnAddrStr] = null;
                            migratedCount++;
                        }
                    }
                }
                // Single bulk session update for all migrations
                if (Object.keys(sessionUpdates).length > 0) {
                    await parsedKeys.set({ session: sessionUpdates });
                    logger.debug({ migratedSessions: migratedCount }, 'bulk session migration complete');
                    // Cache device-level migrations
                    for (const op of migrationOps) {
                        if (sessionUpdates[op.toAddr.toString()]) {
                            const deviceKey = `${op.pnUser}.${op.deviceId}`;
                            migratedSessionCache.set(deviceKey, true);
                        }
                    }
                }
                const skippedCount = totalOps - migratedCount;
                return { migrated: migratedCount, skipped: skippedCount, total: totalOps };
            });
        }
    };
    return repository;
}
const jidToSignalProtocolAddress = (jid) => {
    const decoded = jidDecode(jid);
    const { user, device, server, domainType } = decoded;
    if (!user) {
        throw new Error(`JID decoded but user is empty: "${jid}" -> user: "${user}", server: "${server}", device: ${device}`);
    }
    const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user;
    const finalDevice = device || 0;
    if (device === 99 && decoded.server !== 'hosted' && decoded.server !== 'hosted.lid') {
        throw new Error('Unexpected non-hosted device JID with device 99. This ID seems invalid. ID:' + jid);
    }
    return new ProtocolAddress(signalUser, finalDevice);
};
const jidToSignalSenderKeyName = (group, user) => {
    return new SenderKeyName(group, jidToSignalProtocolAddress(user));
};
// The store key the pre-rename SenderKeyName produced, rebuilt from the name
// object rather than by parsing its serialized form. Returns null for anything
// that is not a SenderKeyName, so a caller passing a different shape still
// takes the plain "not found" path instead of querying a bogus key.
const legacySenderKeyId = (senderKeyName) => {
    try {
        const sender = senderKeyName.getSender?.();
        if (!sender) return null;
        return `${senderKeyName.getGroupId()}::undefined::${sender.deviceId ?? 0}`;
    } catch {
        return null;
    }
};
/**
 * Prune archived sessions from a serialized SessionRecord JSON string.
 * Keeps the newest `keep` entries by indexInfo.created, always preserving
 * open sessions (closed === -1). Malformed input passes through untouched.
 */
function pruneSessionRecord(sessionJson, keep = 8) {
    // Cheap scalar gate: storeSession runs on nearly every message; a full
    // JSON parse+stringify per save measured ~0.12 ms. Multi-entry records
    // are the exception, so skip parsing unless entry count may exceed `keep`.
    if (sessionJson.split('"indexInfo"').length - 1 <= keep) {
        return sessionJson;
    }
    try {
        const record = JSON.parse(sessionJson);
        const entries = record?._sessions;
        if (!entries || typeof entries !== 'object' || Object.keys(entries).length <= keep) {
            return sessionJson;
        }
        const sorted = Object.entries(entries)
            .sort(([, a], [, b]) => (a?.indexInfo?.created ?? 0) - (b?.indexInfo?.created ?? 0));
        let toDrop = sorted.length - keep;
        const pruned = {};
        for (const [key, entry] of sorted) {
            if (toDrop > 0 && entry?.indexInfo?.closed !== -1) {
                toDrop--;
                continue;
            }
            pruned[key] = entry;
        }
        return JSON.stringify({ ...record, _sessions: pruned });
    }
    catch {
        return sessionJson;
    }
}
function signalStorage({ creds, keys }, lidMapping) {
    // Shared function to resolve PN signal address to LID if mapping exists
    const resolveLIDSignalAddress = async (id) => {
        if (id.includes('.')) {
            const [deviceId, device] = id.split('.');
            const [user, domainType_] = deviceId.split('_');
            const domainType = parseInt(domainType_ || '0');
            if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID)
                return id;
            const pnJid = `${user}${device !== '0' ? `:${device}` : ''}@${domainType === WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'}`;
            const lidForPN = await lidMapping.getLIDForPN(pnJid);
            if (lidForPN) {
                const lidAddr = jidToSignalProtocolAddress(lidForPN);
                return lidAddr.toString();
            }
        }
        return id;
    };
    return {
        loadSession: async (id) => {
            // Outside the try: returning null here would read as "no session
            // stored", which quietly disables E2EE instead of naming the platform.
            const { SessionRecord } = await engine();
            try {
                const wireJid = await resolveLIDSignalAddress(id);
                const { [wireJid]: sess } = await keys.get('session', [wireJid]);
                if (sess) {
                    return SessionRecord.deserialize(sess);
                }
            }
            catch (e) {
                return null;
            }
            return null;
        },
        storeSession: async (id, session) => {
            const wireJid = await resolveLIDSignalAddress(id);
            await keys.set({ session: { [wireJid]: pruneSessionRecord(session.serialize()) } });
        },
        isTrustedIdentity: () => {
            return true; // TOFU - Trust on First Use (same as WhatsApp Web)
        },
        loadIdentityKey: async (id) => {
            const wireJid = await resolveLIDSignalAddress(id);
            const { [wireJid]: key } = await keys.get('identity-key', [wireJid]);
            return key || undefined;
        },
        saveIdentity: async (id, identityKey) => {
            const wireJid = await resolveLIDSignalAddress(id);
            const { [wireJid]: existingKey } = await keys.get('identity-key', [wireJid]);
            const keysMatch = existingKey?.length === identityKey.length && existingKey.every((byte, i) => byte === identityKey[i]);
            if (existingKey && keysMatch) {
                return false;
            }
            // The session is deliberately left alone: this only runs after the
            // pkmsg MAC verified, and the engine has already stored a session
            // derived from that same message, so clearing it here would discard a
            // working session on every legitimate re-key.
            await keys.set({ 'identity-key': { [wireJid]: identityKey } });
            return true;
        },
        loadPreKey: async (id) => {
            const keyId = id.toString();
            const { [keyId]: key } = await keys.get('pre-key', [keyId]);
            if (key) {
                return {
                    privKey: Buffer.from(key.private),
                    pubKey: Buffer.from(key.public)
                };
            }
        },
        removePreKey: (id) => keys.set({ 'pre-key': { [id]: null } }),
        loadSignedPreKey: () => {
            const key = creds.signedPreKey;
            return {
                privKey: Buffer.from(key.keyPair.private),
                pubKey: Buffer.from(key.keyPair.public)
            };
        },
        loadSenderKey: async (senderKeyName) => {
            const keyId = senderKeyName.toString();
            const { [keyId]: key } = await keys.get('sender-key', [keyId]);
            if (key) {
                return SenderKeyRecord.deserialize(key);
            }
            // A miss is answered with an empty record rather than null, so
            // GroupCipher's own `if (!record)` guard cannot fire and the
            // failure surfaces one line later as "No session found to decrypt
            // message" — which names sessions when the sender key is what is
            // missing. That is how a rename here becomes an unexplained
            // group outage.
            //
            // The name did change. serialize() used to read `this.sender.id`,
            // which oktz-signal's ProtocolAddress does not define, so every
            // sender keyed as "<group>::undefined::<device>" and all members of
            // a group shared one slot. Keys written then are unreachable now.
            //
            // So on a miss, look once under the name the old format produced.
            // Read-only by design: storeSenderKey still writes the current name,
            // so a record recovered this way is re-saved correctly on the next
            // write and the legacy slot stops being consulted for that sender.
            const legacyId = legacySenderKeyId(senderKeyName);
            if (legacyId && legacyId !== keyId) {
                const { [legacyId]: legacyKey } = await keys.get('sender-key', [legacyId]);
                if (legacyKey) {
                    return SenderKeyRecord.deserialize(legacyKey);
                }
            }
            return new SenderKeyRecord();
        },
        storeSenderKey: async (senderKeyName, key) => {
            const keyId = senderKeyName.toString();
            const serialized = JSON.stringify(key.serialize());
            await keys.set({ 'sender-key': { [keyId]: Buffer.from(serialized, 'utf-8') } });
        },
        getOurRegistrationId: () => creds.registrationId,
        getOurIdentity: () => {
            const { signedIdentityKey } = creds;
            return {
                privKey: Buffer.from(signedIdentityKey.private),
                pubKey: Buffer.from(generateSignalPubKey(signedIdentityKey.public))
            };
        }
    };
}
//# sourceMappingURL=libsignal.js.map