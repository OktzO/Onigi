import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * messages-recv.js guards every other sendMessageAck with .catch() (receipt,
 * notification, message, call). The ignored-JID early return in processNode was
 * the one bare `await`. sendNode throws Boom('Connection Closed') when the
 * socket is not open, so a stanza that lands just as the server goes away
 * rejects out of processNode, out of the bare
 * ws.on('CB:message', async node => { await processNode(...) }) and becomes an
 * unhandled rejection.
 *
 * sock.ws.socket = null is the state WebSocketClient.close() itself leaves
 * behind (isClosed === true), i.e. the socket died between the read and the
 * deferred stanza.
 */
const SCENARIO = `
const h = await startHarness({ config: { shouldIgnoreJid: () => true } });
h.sock.ws.socket = null;
h.sock.ws.emit('CB:message', { tag: 'message', attrs: { id: 'MSG1', from: '99999:1@s.whatsapp.net' }, content: [] });
await tick(400);
console.log('survived');
`;

test('an ack that fails on the ignored-JID path does not kill the process', async () => {
	const { code, stderr } = await runScenario(SCENARIO + '\nprocess.exit(0);\n');
	assert.equal(code, 0, `processNode let the ack rejection escape: ${stderr}`);
});

test('a failed ack on the ignored-JID path is logged, not swallowed', async () => {
	const { code, stdout, stderr } = await runScenario(`
const h = await startHarness({ config: { shouldIgnoreJid: () => true } });
const acks = [];
h.logger.error = (...args) => { acks.push(args); };
h.sock.ws.socket = null;
h.sock.ws.emit('CB:message', { tag: 'message', attrs: { id: 'MSG1', from: '99999:1@s.whatsapp.net' }, content: [] });
await tick(400);
console.log('acked=' + acks.length);
console.log('ctx=' + (acks[0]?.[1] ?? 'none'));
process.exit(0);
`);
	assert.equal(code, 0, `processNode let the ack rejection escape: ${stderr}`);
	assert.match(stdout, /acked=1/, 'the ack failure must reach logger.error');
	assert.match(stdout, /ctx=.*ack/);
});

/*
 * Pre-login notification ack: a notification (e.g. companion_reg_refresh)
 * arrives before creds.update sets authState.creds.me. The old
 * `authState.creds.me.id` in sendMessageAck threw a TypeError, the .catch
 * logged 'failed to ack notification', and no ack stanza was ever sent.
 * Observable: no 'sent ack' debug entry and no TypeError error entry.
 */
test('a pre-login notification is acked without touching creds.me', async () => {
	const { code, stdout, stderr } = await runScenario(`
const myCreds = {
	noiseKey: { private: Buffer.alloc(32), public: Buffer.alloc(32, 1) },
	signedIdentityKey: { private: Buffer.alloc(32, 2), public: Buffer.alloc(32, 3) },
	signedPreKey: { keyId: 1, public: Buffer.alloc(32, 4), private: Buffer.alloc(32, 5) },
	advSecretKey: 'adv-secret', accountSyncCounter: 0, counter: 0,
	me: undefined, registered: true, pairingCode: 'ABCDEFGH'
};
const myKeys = {
	get: async () => undefined,
	set: async () => {},
	del: async () => {},
	bind: async fn => fn({ get: async () => undefined, set: async () => {}, del: async () => {} })
};
const h = await startHarness({ config: { auth: { creds: myCreds, keys: myKeys } } });
h.sock.ws.emit('CB:notification', { tag: 'notification', attrs: { id: 'N1', from: '12345:1@s.whatsapp.net', type: 'companion_reg_refresh' }, content: [] });
await tick(400);
const errs = h.logger.logs.filter(l => l[0] === 'error');
const typeErr = errs.filter(l => String(l[1] && (l[1].ackErr || l[1].error || l[1].err || '')).includes('TypeError')).length;
const sentAck = h.logger.logs.filter(l => l[2] === 'sent ack').length;
console.log('errs=' + errs.length);
console.log('typeErr=' + typeErr);
console.log('sentAck=' + sentAck);
process.exit(0);
`);
	assert.equal(code, 0, `child died: ${stderr}`);
	assert.match(stdout, /typeErr=0/, `TypeError surfaced: ${stderr}`);
	assert.match(stdout, /errs=0/, `an error was logged: ${stdout}`);
	assert.match(stdout, /sentAck=1/, 'the ack path must complete');
});
