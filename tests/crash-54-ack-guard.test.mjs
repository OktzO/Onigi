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
