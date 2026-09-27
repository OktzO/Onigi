import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * logout() ended with:
 *
 *     void end(new Boom(msg || 'Intentional Logout', { statusCode: DisconnectReason.loggedOut }));
 *
 * so logout() resolved while the socket, the keepalive interval and the event
 * buffer were all still live: end() is async, and everything it does past the
 * close notification -- the teardown, the buffered flush, the buffer destroy --
 * happens after the await that logout() has already returned from. A caller that
 * does `await sock.logout()` and then tears down its own state, or reconnects,
 * is racing the teardown it asked for.
 *
 * The contract: by the time logout() resolves, the connection is closed and
 * announced.
 */
test('logout() has finished the teardown by the time it resolves', async () => {
	const { code, stdout, stderr } = await runScenario(`
const h = await startHarness();
const seen = [];
h.sock.ev.on('connection.update', u => { seen.push(u.connection || 'update'); });
await tick(50);
seen.length = 0;
await h.sock.logout('Intentional Logout');
// no tick: whatever the close notification needs, logout() must have waited for it
console.log('seenAtResolve=' + JSON.stringify(seen));
console.log('isClosed=' + h.sock.ws.isClosed);
console.log('isBuffering=' + h.sock.ev.isBuffering());
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	// old: seenAtResolve=[] -- end() had not reached the emit yet
	assert.match(stdout, /seenAtResolve=\[[^\]]*"close"/,
		`logout() resolved before the close notification was delivered: ${stdout}`);
	assert.match(stdout, /isClosed=true/);
	assert.match(stdout, /isBuffering=false/);
});

test('logout() is still fire-and-forget safe: a teardown error does not reject it', async () => {
	const { code, stdout, stderr } = await runScenario(`
const h = await startHarness();
await tick(50);
let rejection = 'none';
await h.sock.logout('Intentional Logout').then(
	() => { rejection = 'resolved'; },
	e => { rejection = 'rejected ' + (e?.output?.statusCode); }
);
console.log('outcome=' + rejection);
console.log('isClosed=' + h.sock.ws.isClosed);
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	// end() already swallows its own failures (crash-52); logout() must not turn
	// that into a rejection its callers now have to handle
	assert.match(stdout, /outcome=resolved/);
	assert.match(stdout, /isClosed=true/);
});
