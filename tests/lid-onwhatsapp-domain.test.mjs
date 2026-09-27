import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * onWhatsApp does two things it cannot be allowed to do:
 *
 *  1. lose the caller's domain. It queries usync by phone number and then
 *     returns `id` from the *server's* answer, so
 *     onWhatsApp('111222333444@lid') answers
 *     [{ jid: '62812345678@s.whatsapp.net', exists: true }]
 *     — the caller passed a LID and gets a PN back, so
 *     `result[0].jid === myLid` is false and any caller that keys a cache or
 *     compares against its own input silently mismatches.
 *
 *  2. be unable to say "unknown". A LID whose PN is not in the mapping is
 *     `continue`d, and a row whose contact answer is falsy is filtered out by
 *     `filter(a => !!a.contact)`. Both cases produce the same observable as
 *     "this number is not on WhatsApp", so a caller cannot tell a number that
 *     does not exist from one we were unable to ask about — which is the whole
 *     point of the check.
 *
 * The contract pinned below: one entry per input jid, in input order, jid
 * echoed back as the caller spelled it, and exists = true | false | null where
 * null means "could not be determined".
 *
 * The harness lets a usync query be answered in-process: waitForMessage()
 * resolves on `ws.on('TAG:<msgId>')`, so capturing the tag the query registers
 * and emitting that event with a result node drives the real executeUSyncQuery
 * path with no noise handshake. (sendNode still writes an unencrypted frame to
 * the local ws server, which ignores it.)
 *
 * That driving code runs through runScenario, like every other harness test in
 * this repo: startHarness's WebSocketServer keeps a listening socket plus a
 * timer alive after close(), so an in-process harness never lets the test
 * runner's child exit and the suite stops. The child prints RESULT=<json> and
 * exits explicitly.
 */

const KNOWN_LID = '111222333444@lid';
const KNOWN_PN = '62812345678@s.whatsapp.net';
const UNMAPPED_LID = '555666777888@lid';
const UNMAPPED_PN = '62899999999@s.whatsapp.net';

const WABINARY = new URL('../lib/WABinary/index.js', import.meta.url).href;

const userRow = (jid, contactType) => ({
    tag: 'user',
    attrs: { jid },
    content: [{ tag: 'contact', attrs: contactType ? { type: contactType } : {} }]
});

const scenario = (inputs, rows) => `
const { jidNormalizedUser } = await import(${JSON.stringify(WABINARY)});
const userRow = (jid, contactType) => ({
    tag: 'user',
    attrs: { jid },
    content: [{ tag: 'contact', attrs: contactType ? { type: contactType } : {} }]
});
const usyncResult = rows => ({
    tag: 'iq',
    attrs: { type: 'result' },
    content: [{ tag: 'usync', attrs: {}, content: [{ tag: 'list', attrs: {}, content: rows }] }]
});
const signalRepo = () => new Proxy({
    lidMapping: {
        getPNForLID: async lid => (jidNormalizedUser(lid) === ${JSON.stringify(KNOWN_LID)} ? ${JSON.stringify(KNOWN_PN)} : null),
        getLIDForPN: async () => null,
        getLIDsForPNs: async () => null,
        getPNsForLIDs: async () => null,
        storeLIDPNMappings: async () => { }
    },
    close: () => { }
}, {
    get: (target, prop) => (prop in target ? target[prop] : async () => undefined)
});
const { sock, close } = await startHarness({ config: { makeSignalRepository: signalRepo } });
try {
    // null when onWhatsApp answers without asking the server anything (every
    // input was skipped), which is one of the states under test
    const tag = new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), 500);
        const origOn = sock.ws.on.bind(sock.ws);
        sock.ws.on = (event, ...rest) => {
            if (typeof event === 'string' && event.startsWith('TAG:')) {
                clearTimeout(timer);
                resolve(event.slice(4));
            }
            return origOn(event, ...rest);
        };
    });
    const pending = sock.onWhatsApp(...${JSON.stringify(inputs)});
    const msgId = await tag;
    if (msgId) {
        sock.ws.emit('TAG:' + msgId, usyncResult(${JSON.stringify(rows)}));
    }
    console.log('RESULT=' + JSON.stringify((await pending) ?? null));
}
finally {
    await close();
}
process.exit(0);
`;

const onWhatsAppWith = async (inputs, rows) => {
    const { code, stdout, stderr } = await runScenario(scenario(inputs, rows));
    assert.equal(code, 0, `the onWhatsApp scenario failed: ${stderr}`);
    const line = stdout.split('\n').find(l => l.startsWith('RESULT='));
    assert.ok(line, `the scenario printed no result: ${stdout}`);
    return JSON.parse(line.slice('RESULT='.length));
};

test('the returned jid is the one the caller passed, not the server answer', { timeout: 20000 }, async () => {
    const result = await onWhatsAppWith([KNOWN_LID], [userRow(KNOWN_PN, 'in')]);
    assert.deepEqual(result, [{ jid: KNOWN_LID, exists: true }]);
});

test('a PN input keeps its own domain too', { timeout: 20000 }, async () => {
    const result = await onWhatsAppWith([KNOWN_PN], [userRow(KNOWN_PN, 'in')]);
    assert.deepEqual(result, [{ jid: KNOWN_PN, exists: true }]);
});

test('a user the server says is not a contact is reported, not dropped', { timeout: 20000 }, async () => {
    const result = await onWhatsAppWith([UNMAPPED_PN], [userRow(UNMAPPED_PN)]);
    assert.deepEqual(result, [{ jid: UNMAPPED_PN, exists: false }]);
});

test('a LID with no PN mapping is reported as unknown, not as absent', { timeout: 20000 }, async () => {
    const result = await onWhatsAppWith([UNMAPPED_LID], []);
    assert.deepEqual(result, [{ jid: UNMAPPED_LID, exists: null }]);
});

test('mixed inputs come back in order, one entry each', { timeout: 20000 }, async () => {
    const result = await onWhatsAppWith(
        [KNOWN_LID, UNMAPPED_PN, UNMAPPED_LID],
        [userRow(KNOWN_PN, 'in'), userRow(UNMAPPED_PN)]
    );
    assert.deepEqual(result, [
        { jid: KNOWN_LID, exists: true },
        { jid: UNMAPPED_PN, exists: false },
        { jid: UNMAPPED_LID, exists: null }
    ]);
});
