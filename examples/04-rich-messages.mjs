/*
 * examples/04-rich-messages.mjs — buttons, lists and inline HTML, built offline.
 *
 * Run: node examples/04-rich-messages.mjs
 *
 * These builders are pure: they turn a description into the `message` object
 * that `relayMessage` would put on the wire. So they can be demonstrated, and
 * their output verified against the protobuf the library ships, without a
 * server.
 *
 * What is NOT demonstrated here: whether a given WhatsApp client renders a given
 * card. That is a property of Meta's clients, not of this library, and no test
 * in this repository can observe it. The README says so; this example does not
 * pretend otherwise.
 */

import assert from 'node:assert/strict';
import {
	buildButtonsMessage,
	buildListMessage,
	buildWebuiMessage,
	DEFAULT_BOT_JID,
	DEFAULT_FORWARD_ORIGIN,
	generateWebuiMessageId,
	normalizeUserJid,
	proto,
	WEBUI_MAX_PAYLOAD_BYTES,
	WEBUI_PRIMITIVE_TYPENAME
} from '../lib/index.js';

const main = () => {
	// --- normalizeUserJid ----------------------------------------------------------

	// `sock.user` is `creds.me` and has `.id`. There is no `sock.user.jid` in
	// this library; code that reads it gets undefined and stamps a null
	// participant onto group messages.
	assert.equal(normalizeUserJid('15551234567@s.whatsapp.net'), '15551234567@s.whatsapp.net');
	assert.equal(normalizeUserJid({ user: { id: '1:1@s.whatsapp.net' } }), '1:1@s.whatsapp.net');
	assert.equal(normalizeUserJid({ id: '2:2@s.whatsapp.net' }), '2:2@s.whatsapp.net');
	assert.equal(normalizeUserJid(undefined), undefined);
	console.log('normalizeUserJid accepts a jid, a sock, or a user object');

	// --- buttonsMessage -------------------------------------------------------------

	const buttons = buildButtonsMessage({
		text: 'Hello Brother — pick an option',
		footer: '© onigis',
		buttons: [
			{ buttonId: '.owner', buttonText: 'Owner' },
			{ buttonId: '.allmenu', buttonText: 'All menu' }
		]
	});
	assert.equal(buttons.buttonsMessage.buttons.length, 2);
	assert.equal(buttons.buttonsMessage.headerType, 1, 'headerType 1 = text only');
	assert.equal(buttons.buttonsMessage.buttons[0].buttonText.displayText, 'Owner');
	console.log('\nbuttonsMessage:', JSON.stringify(buttons));

	// The 1..3 button bound is enforced, not assumed.
	assert.throws(() => buildButtonsMessage({ text: 'x', buttons: [] }), /minimal 1/);
	assert.throws(() => buildButtonsMessage({
		text: 'x',
		buttons: [1, 2, 3, 4].map(n => ({ buttonId: `.${n}`, buttonText: String(n) }))
	}), /maksimal 3/);
	console.log('  the 1..3 button bound is enforced');

	// A location header switches headerType to 6.
	const withHeader = buildButtonsMessage({
		text: 'x', buttons: [{ buttonId: '.a', buttonText: 'A' }],
		locationMessage: { name: 'My Bot', address: 'onigis' }
	});
	assert.equal(withHeader.buttonsMessage.headerType, 6);
	console.log('  a locationMessage header switches headerType to 6');

	// --- listMessage ----------------------------------------------------------------

	const list = buildListMessage({
		title: 'Menu',
		description: 'Pick a category',
		buttonText: 'Open',
		sections: [{
			title: 'Categories',
			rows: [
				{ title: 'main', description: '19 commands', rowId: '.menucat main' },
				{ title: 'sticker', description: '42 commands', rowId: '.menucat sticker' }
			]
		}]
	});
	assert.equal(list.listMessage.sections[0].rows.length, 2);
	assert.equal(list.listMessage.sections[0].rows[1].rowId, '.menucat sticker');
	assert.equal(list.listMessage.listType, 2);
	assert.throws(() => buildListMessage({ title: 'x', buttonText: 'y', sections: [] }), /minimal 1 section/);
	console.log('\nlistMessage: 1 section, 2 rows, listType', list.listMessage.listType);

	// --- both encode to the protobuf this library ships -----------------------------

	for (const [label, content] of [['buttonsMessage', buttons], ['listMessage', list]]) {
		const message = { ...content, messageContextInfo: {} };
		const bytes = proto.Message.encode(proto.Message.fromObject(message)).finish();
		const decoded = proto.Message.decode(bytes);
		assert.ok(decoded[label], `${label} must survive a protobuf round trip`);
		console.log(`  ${label} encodes to ${bytes.length} bytes and decodes back`);
	}

	// --- buildWebuiMessage ----------------------------------------------------------

	const html = '<!DOCTYPE html><html><body><h2>Bot Menu</h2><button onclick="alert(1)">Press</button></body></html>';
	const webui = buildWebuiMessage({ html, title: 'Bot Menu' });
	const rich = webui.botForwardedMessage.message.richResponseMessage;

	assert.equal(rich.contextInfo.forwardedAiBotMessageInfo.botJid, DEFAULT_BOT_JID);
	assert.equal(rich.contextInfo.forwardOrigin, DEFAULT_FORWARD_ORIGIN);

	// The HTML is not a string on the wire: it is base64(JSON) under a primitive
	// typename that comes from WhatsApp Web's bundle. Only `data` is a protobuf
	// field of unifiedResponse — the response_id inside is the JSON's own.
	const decodedPayload = JSON.parse(Buffer.from(rich.unifiedResponse.data, 'base64').toString('utf8'));
	const primitive = decodedPayload.sections[0].view_model.primitive;
	assert.equal(primitive.__typename, WEBUI_PRIMITIVE_TYPENAME);
	assert.equal(primitive.payload, html);
	assert.equal(primitive.trusted_sources.length, 0);
	// The same uuid appears in the protobuf contextInfo and in the JSON payload,
	// which is what ties the rendered card to its bot response id.
	assert.equal(webui.messageContextInfo.botMetadata.botResponseId, decodedPayload.response_id);
	console.log(`\nWebUI: ${Buffer.byteLength(html)} bytes of HTML -> ${rich.unifiedResponse.data.length} bytes of base64 JSON`);
	console.log('  primitive typename :', WEBUI_PRIMITIVE_TYPENAME);
	console.log('  forwarded as       :', DEFAULT_BOT_JID, '/', DEFAULT_FORWARD_ORIGIN);
	console.log('  botResponseId      :', decodedPayload.response_id, '(matches contextInfo)');

	// The full nesting encodes, which is the part that would silently break.
	const webuiBytes = proto.Message.encode(proto.Message.fromObject({
		...webui, messageContextInfo: webui.messageContextInfo
	})).finish();
	assert.ok(webuiBytes.length > Buffer.byteLength(html), 'the encoded message must actually contain the payload');
	console.log(`  the whole nesting encodes to ${webuiBytes.length} bytes`);

	// Identity can be overridden.
	const custom = buildWebuiMessage({ html, botJid: '12345@bot', forwardOrigin: 'CUSTOM' });
	assert.equal(custom.botForwardedMessage.message.richResponseMessage.contextInfo.forwardedAiBotMessageInfo.botJid, '12345@bot');
	console.log('  botJid and forwardOrigin can be overridden');

	// The bounds are real.
	assert.throws(() => buildWebuiMessage({ html: '' }), TypeError);
	assert.equal(WEBUI_MAX_PAYLOAD_BYTES, 65536);
	const oversize = 'x'.repeat(WEBUI_MAX_PAYLOAD_BYTES + 1);
	const warned = buildWebuiMessage({ html: oversize });
	assert.ok(warned, 'an oversize payload warns, it does not throw');
	console.log(`  an empty html throws; a payload over ${WEBUI_MAX_PAYLOAD_BYTES} bytes warns and still builds`);

	// Message ids match the WhatsApp shape.
	const id = generateWebuiMessageId();
	assert.match(id, /^3EB0[0-9A-F]{36}$/);
	console.log('  generateWebuiMessageId ->', id, `(${id.length} chars)`);
};

main();
console.log('\nok — the builders produce what the protobuf accepts. Whether a client renders a card');
console.log('     is Meta\'s behaviour, not this library\'s, and is not claimed here.');
