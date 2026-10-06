import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * The creds.update listener announced a push name on every update whose name
 * differed from the one already stored in creds:
 *
 *     ev.on('creds.update', update => {
 *         const name = update.me?.name;            // undefined for a partial update
 *         if (creds.me?.name !== name) {           // 'probe' !== undefined -> true
 *             sendNode({ tag: 'presence', attrs: { name: name } });   // <presence />
 *         }
 *         Object.assign(creds, update);
 *     });
 *
 * `creds` is the *merged* state (`const { creds } = authState`, socket.js:296),
 * not the event payload, so `creds.me` survives every later update -- and
 * `creds.update` fires on ordinary key churn (pre-key upload, signed-pre-key
 * rotation), none of which carries a `me`. Each one sent a presence with no
 * attributes at all. A `<presence/>` with no `type` reads as "available", so
 * the account was announced online continuously and WhatsApp stopped pushing
 * notifications to the user's phone -- even with markOnlineOnConnect: false.
 *
 * The guard has to test the *event's* name. Testing the merged `creds.me` is
 * the trap: it still holds the old name on every partial update, so it would
 * stay true forever and change nothing. A `me` on its own is not enough either
 * -- validate-connection.js:192 emits `me: { id, name: bizName, lid }` where
 * `bizName` is undefined for a non-business pair-success stanza.
 *
 * sendNode() logs binaryNodeToString(frame) at logger.level === 'trace', and
 * that function filters undefined attrs -- so the stanza as the encoder will
 * see it is exactly what the log shows. Each scenario runs in a child: a real
 * socket against a local ws server leaves the server handle and a timer behind,
 * so an in-process file never exits.
 */
const PRELUDE = `
const logger = noopLogger();
logger.level = 'trace';
const { sock, close } = await startHarness({ logger });
await tick(50);
logger.logs.length = 0;
`;

const epilogue = `
console.log('sent=' + JSON.stringify(sent));
await close();
process.exit(0);
`;

const sentSoFar = `const sent = logger.logs
	.filter(l => l[1]?.msg === 'xml send')
	.map(l => String(l[1]?.xml))
	.filter(x => x.includes('<presence'));
`;

test('a partial creds.update without me sends no presence', async () => {
	// the creds already carry me.name = 'probe'; this is the shape of the
	// signed-pre-key rotation at socket.js:172, i.e. key churn with no me
	const { code, stdout, stderr } = await runScenario(`
${PRELUDE}
sock.ev.emit('creds.update', { signedPreKey: { keyId: 2, public: Buffer.alloc(32, 9), private: Buffer.alloc(32, 8) } });
await tick(50);
${sentSoFar}${epilogue}`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /sent=\[\]/, 'a nameless presence reads as "available" and suppresses phone pushes');
});

test('a creds.update that really changes me.name still announces the new push name', async () => {
	const { code, stdout, stderr } = await runScenario(`
${PRELUDE}
sock.ev.emit('creds.update', { me: { id: '12345:1@s.whatsapp.net', lid: '12345:1@lid', name: 'renamed' } });
await tick(50);
${sentSoFar}${epilogue}`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /sent=\["<presence name='renamed'\/>"\]/);
});
