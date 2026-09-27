import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * Both of these ws.on('CB:...', async ...) handlers had no try/catch, so a
 * rejection inside them was an unhandled rejection. They are reachable with no
 * buggy user code at all:
 *   - await sendNode on a socket that died between the read and the deferred
 *     stanza emit -> Boom('Connection Closed') from socket.js
 *   - refNode.content.toString('utf-8') on a content-less <ref/>
 *
 * Reachable-without-a-handshake note: a local ws server cannot deliver a genuine
 * pair-device stanza without a real noise handshake, so both vectors are driven
 * by emitting the parsed stanza on a live socket, the same way onMessageReceived
 * does after decryption. sendNode-failure is reproduced with sock.ws.socket
 * nulled; the content-less <ref/> needs an open socket because genPairQR bails
 * on !ws.isOpen first. Neither vector needs any buggy user code.
 *
 * sock.ws.socket = null is the state WebSocketClient.close() itself leaves
 * behind (isClosed === true).
 */
const PAIR_STANZA = `{
	tag: 'iq',
	attrs: { id: 'QR1', type: 'set', to: 's.whatsapp.net', xmlns: 'md' },
	content: [{ tag: 'pair-device', attrs: {}, content: [{ tag: 'ref', attrs: {}, content: Buffer.from('AQID') }] }]
}`;

const PREVIEW_STANZA = `{ tag: 'ib', attrs: {} }`;

const scenarios = [
	{
		name: 'CB:iq,type:set,pair-device',
		guard: 'pair device',
		body: `h.sock.ws.emit('CB:iq,type:set,pair-device', ${PAIR_STANZA});`
	},
	{
		name: 'CB:ib,,offline_preview',
		guard: 'offline preview',
		body: `h.sock.ws.emit('CB:ib,,offline_preview', ${PREVIEW_STANZA});`
	}
];

for (const { name, guard, body } of scenarios) {
	test(`${name} does not kill the process when sendNode fails`, async () => {
		const { code, stderr } = await runScenario(`
const h = await startHarness();
h.sock.ws.socket = null;
${body}
await tick(400);
console.log('survived');
process.exit(0);
`);
		assert.equal(code, 0, `${name} let the rejection escape: ${stderr}`);
	});

	test(`${name} logs a failed sendNode and stays usable`, async () => {
		const { code, stdout, stderr } = await runScenario(`
const h = await startHarness();
const errs = [];
h.logger.error = (...args) => { errs.push(args); };
h.sock.ws.socket = null;
${body}
await tick(400);
console.log('logged=' + errs.filter(a => String(a[1]).includes('${guard}')).length);
console.log('loggedAny=' + errs.length);
console.log('survived');
process.exit(0);
`);
		assert.equal(code, 0, `${name} let the rejection escape: ${stderr}`);
		assert.match(stdout, new RegExp(`logged=1`), `the ${guard} failure must reach logger.error`);
		assert.match(stdout, /survived/);
	});
}

// second reachable vector for CB:iq,type:set,pair-device: genPairQR does
// refNode.content.toString('utf-8') on whatever <ref/> carried, and a
// content-less <ref/> gives undefined. Needs an open socket, since genPairQR
// bails on !ws.isOpen before touching the ref.
test('CB:iq,type:set,pair-device survives a content-less <ref/>', async () => {
	const { code, stdout, stderr } = await runScenario(`
const h = await startHarness();
const errs = [];
h.logger.error = (...args) => { errs.push(args); };
h.sock.ws.emit('CB:iq,type:set,pair-device', {
	tag: 'iq',
	attrs: { id: 'QR1', type: 'set', to: 's.whatsapp.net', xmlns: 'md' },
	content: [{ tag: 'pair-device', attrs: {}, content: [{ tag: 'ref', attrs: {} }] }]
});
await tick(400);
console.log('logged=' + errs.filter(a => String(a[1]).includes('pair device')).length);
console.log('survived');
process.exit(0);
`);
	assert.equal(code, 0, `the content-less <ref/> escaped: ${stderr}`);
	assert.match(stdout, /logged=1/);
	assert.match(stdout, /survived/);
});
