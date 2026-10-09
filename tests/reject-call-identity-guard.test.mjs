import test from 'node:test';
import assert from 'node:assert/strict';
import { runSocketScenario } from './messaging-retry-harness.mjs';

/*
 * rejectCall builds a <call> stanza whose `from` is our own identity. With no
 * identity that stanza is malformed, so the operation is skipped rather than
 * optional-chained into `from: undefined` -- a stanza nobody can be the author
 * of is worse than no stanza. The two other unguarded sites are deliberately
 * left alone; see the report.
 */

const one = async (over, body) => {
	const r = await runSocketScenario(`const s = await bootSocket(${JSON.stringify(over)});\n${body}`);
	assert.equal(r.code, 0, `${r.result?.message}\n${r.log.join('\n')}\n${r.stderr}`);
	return r;
};

test('a reject with no identity is skipped, not sent as from=undefined', () => one(
	{ config: { retryRequestDelayMs: 0 } },
	`
delete s.sock.authState.creds.me;
await s.sock.rejectCall('CALL-1', '628111@s.whatsapp.net');
await tick(300);
console.log('XMLS=' + JSON.stringify(s.sentXml()) + ' DBG=' + s.logger.find('debug', 'skipping call reject').length);
assert.equal(s.sentXml().filter(x => x.startsWith('<call')).length, 0, 'a <call> with from=undefined is malformed and must not go out');
assert.ok(s.logger.find('debug', 'skipping call reject').length >= 1, 'the skip is reported, not silent');
s.stop();
`
));

test('with an identity the reject still goes out', () => one(
	{ config: { retryRequestDelayMs: 0 } },
	`
// not awaited: rejectCall goes out through query(), which waits for a peer
// response this harness never sends. The stanza is on the wire by now.
s.sock.rejectCall('CALL-1', '628111@s.whatsapp.net').catch(() => { });
await tick(600);
const calls = s.sentXml().filter(x => x.startsWith('<call'));
console.log('CALLS=' + JSON.stringify(calls));
assert.equal(calls.length, 1, 'the guard must not cost the normal path its stanza');
assert.ok(calls[0].includes("from='" + T.ME_PN + "'"), 'the stanza carries our own identity: ' + calls[0]);
s.stop();
`
));