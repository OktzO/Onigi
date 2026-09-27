import test from 'node:test';
import assert from 'node:assert/strict';
import { handleIdentityChange } from '../lib/Utils/identity-change-handler.js';
import { jidEncode } from '../lib/WABinary/index.js';

/*
 * handleIdentityChange() wrote the debounce before the two early returns it
 * should have come after:
 *
 *     if (ctx.debounceCache.get(from)) { return { action: 'debounced' }; }
 *     ctx.debounceCache.set(from, true);          // <- here
 *     const isOfflineNotification = !isStringNullOrEmpty(node.attrs.offline);
 *     const hasExistingSession = await ctx.validateSession(from);
 *     if (!hasExistingSession.exists) { return { action: 'skipped_no_session' }; }
 *     if (isOfflineNotification) { return { action: 'skipped_offline' }; }
 *
 * Both returns are no-ops by design -- there is no session to refresh -- and
 * the caller does nothing else with the outcome, so writing the debounce on the
 * way out buys nothing and costs the next real notification its window. The
 * scenario the audit names: a queued offline notification arrives, is skipped
 * as 'skipped_offline', and the live notification that follows 100ms later is
 * dropped as 'debounced' -- so assertSessions never runs and a changed
 * identity is never picked up.
 *
 * The contract: the debounce is written only when the handler is actually going
 * to do the work.
 */
const FROM = jidEncode('99999', 's.whatsapp.net');

const node = (attrs = {}) => ({
	tag: 'notification',
	attrs: { from: FROM, id: 'N1', type: 'identity', ...attrs },
	content: [{ tag: 'identity', attrs: {} }]
});

const ctx = (over = {}) => {
	const cache = new Map();
	const calls = [];
	return {
		calls,
		cache,
		meId: '11111:1@s.whatsapp.net',
		meLid: '11111:1@lid',
		logger: { info: () => { }, debug: () => { }, warn: (...a) => calls.push(['warn', ...a]) },
		debounceCache: {
			get: k => cache.get(k),
			set: (k, v) => { cache.set(k, v); calls.push(['set', k]); },
			del: k => cache.delete(k)
		},
		validateSession: async () => ({ exists: true }),
		onBeforeSessionRefresh: () => { },
		assertSessions: async (...args) => { calls.push(['assert', ...args]); },
		...over
	};
};

test('an offline notification does not consume the next live notification', async () => {
	const c = ctx();
	const offline = await handleIdentityChange(node({ offline: '1' }), c);
	assert.equal(offline.action, 'skipped_offline');
	// the live notification that follows is the one that must run
	const live = await handleIdentityChange(node(), c);
	assert.equal(live.action, 'session_refreshed',
		`the live notification was ${live.action}; the offline one ate its debounce window`);
	assert.deepEqual(c.calls.filter(x => x[0] === 'assert'), [['assert', [FROM], true]]);
});

test('a notification with no existing session does not consume the next one', async () => {
	const c = ctx({ validateSession: async () => ({ exists: false }) });
	const first = await handleIdentityChange(node(), c);
	assert.equal(first.action, 'skipped_no_session');
	const second = await handleIdentityChange(node(), c);
	assert.equal(second.action, 'skipped_no_session', 'still no session, still a no-op');
	assert.equal(c.cache.has(FROM), false, 'a no-op must leave the debounce untouched');

	// and once there IS a session, it runs
	c.validateSession = async () => ({ exists: true });
	const third = await handleIdentityChange(node(), c);
	assert.equal(third.action, 'session_refreshed');
});

test('a real refresh still arms the debounce and drops the duplicate', async () => {
	const c = ctx();
	const first = await handleIdentityChange(node(), c);
	assert.equal(first.action, 'session_refreshed');
	assert.equal(c.cache.get(FROM), true, 'work done -> the debounce is armed');
	const second = await handleIdentityChange(node(), c);
	assert.equal(second.action, 'debounced');
	assert.deepEqual(c.calls.filter(x => x[0] === 'assert'), [['assert', [FROM], true]]);
});

test('an offline notification after a real refresh is still debounced', async () => {
	const c = ctx();
	await handleIdentityChange(node(), c);
	const offline = await handleIdentityChange(node({ offline: '1' }), c);
	assert.equal(offline.action, 'debounced');
});

test('the paths that return before the debounce never armed it', async () => {
	const noIdentity = await handleIdentityChange({
		tag: 'notification',
		attrs: { from: FROM, id: 'N2' },
		content: []
	}, ctx());
	assert.equal(noIdentity.action, 'no_identity_node');

	const noFrom = await handleIdentityChange({
		tag: 'notification',
		attrs: { id: 'N3' },
		content: [{ tag: 'identity', attrs: {} }]
	}, ctx());
	assert.equal(noFrom.action, 'invalid_notification');

	const self = await handleIdentityChange(node(), ctx({ meId: FROM }));
	assert.equal(self.action, 'skipped_self_primary');

	const companion = await handleIdentityChange({
		tag: 'notification',
		attrs: { from: jidEncode('99999', 's.whatsapp.net', 2), id: 'N4', type: 'identity' },
		content: [{ tag: 'identity', attrs: {} }]
	}, ctx());
	assert.equal(companion.action, 'skipped_companion_device');
});
