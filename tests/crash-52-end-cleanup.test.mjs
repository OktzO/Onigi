import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * A user connection.update listener that throws is absorbed by the event buffer
 * (ef782df), so the throw that escapes end() has to come from the buffer's own
 * failure report. config.logger is a user supplied option, and a logger whose
 * error() throws is reachable without any library bug.
 *
 * The break these tests name: dropping the guard around the closing
 * ev.emit('connection.update') in end() lets that throw skip
 * ev.removeAllListeners('connection.update') / ev.destroy() (socket.js), leaking
 * the 30s flush timer, the history cache and every listener.
 */
const SCENARIO = `
const logger = noopLogger();
logger.error = () => { throw new Error('logger.error is broken'); };
const h = await startHarness({ logger });
h.sock.ev.on('connection.update', u => {
	if (u.connection === 'close') { throw new Error('user handler boom'); }
});
await h.sock.end(new Error('bye'));
console.log('isBuffering=' + h.sock.ev.isBuffering());
console.log('survived');
`;

test('end() still tears the event buffer down when the close notification fails', async () => {
	const { code, stdout, stderr } = await runScenario(SCENARIO + '\nprocess.exit(0);\n');
	assert.equal(code, 0, `end() let the failure escape: ${stderr}`);
	assert.match(stdout, /survived/);
	// ev.destroy() sets isBuffering false and clears the pending flush timers
	assert.match(stdout, /isBuffering=false/);
});

test('end() strips the connection.update listeners even when the close notification fails', async () => {
	const { code, stdout, stderr } = await runScenario(SCENARIO + `
let afterEnd = 0;
h.sock.ev.on('connection.update', () => { afterEnd++; });
h.sock.ev.emit('connection.update', { connection: 'close' });
console.log('listenersAfterEnd=' + afterEnd);
process.exit(0);
`);
	assert.equal(code, 0, `end() let the failure escape: ${stderr}`);
	assert.match(stdout, /listenersAfterEnd=0/, 'ev.removeAllListeners must still have run');
});
