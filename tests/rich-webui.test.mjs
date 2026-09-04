import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proto } from '../WAProto/index.js';
import {
    buildWebuiMessage,
    generateWebuiMessageId,
    WEBUI_PRIMITIVE_TYPENAME,
    DEFAULT_BOT_JID,
    DEFAULT_FORWARD_ORIGIN
} from '../lib/Utils/rich-webui.js';

const SAMPLE_HTML = '<!DOCTYPE html><html><head><style>body{color:#fff}</style></head><body><h1>Tes</h1><script>console.log("ok")</script></body></html>';

test('buildWebuiMessage: struktur dasar + default Meta AI', () => {
    const msg = buildWebuiMessage({ html: SAMPLE_HTML, title: 'Kartu Tes' });
    const rich = msg.botForwardedMessage.message.richResponseMessage;
    assert.equal(rich.messageType, 'AI_RICH_RESPONSE_TYPE_STANDARD');
    assert.equal(rich.submessages.length, 1);
    assert.equal(rich.submessages[0].messageType, 'AI_RICH_RESPONSE_TEXT');
    assert.equal(rich.submessages[0].messageText, 'Kartu Tes');
    assert.equal(rich.contextInfo.forwardedAiBotMessageInfo.botJid, DEFAULT_BOT_JID);
    assert.equal(rich.contextInfo.forwardOrigin, DEFAULT_FORWARD_ORIGIN);
    assert.equal(msg.messageContextInfo.deviceListMetadataVersion, 2);
    assert.ok(msg.messageContextInfo.botMetadata.botResponseId);
});

test('buildWebuiMessage: identitas bisa di-override', () => {
    const msg = buildWebuiMessage({
        html: SAMPLE_HTML,
        title: 'Custom',
        botJid: '12345@bot',
        forwardOrigin: 'CUSTOM_ORIGIN',
        responseId: 'fixed-uuid-1234'
    });
    const rich = msg.botForwardedMessage.message.richResponseMessage;
    assert.equal(rich.contextInfo.forwardedAiBotMessageInfo.botJid, '12345@bot');
    assert.equal(rich.contextInfo.forwardOrigin, 'CUSTOM_ORIGIN');
    assert.equal(msg.messageContextInfo.botMetadata.botResponseId, 'fixed-uuid-1234');
});

test('buildWebuiMessage: unifiedResponse berisi primitive HTML dengan payload utuh', () => {
    const msg = buildWebuiMessage({ html: SAMPLE_HTML, title: 'Tes' });
    const dataB64 = msg.botForwardedMessage.message.richResponseMessage.unifiedResponse.data;
    const unified = JSON.parse(Buffer.from(dataB64, 'base64').toString('utf-8'));
    const primitive = unified.sections[0].view_model.primitive;
    assert.equal(primitive.__typename, WEBUI_PRIMITIVE_TYPENAME);
    assert.equal(primitive.payload, SAMPLE_HTML);
    assert.deepEqual(primitive.trusted_sources, []);
    assert.equal(unified.sections[0].view_model.__typename, 'GenAISingleLayoutViewModel');
});

test('buildWebuiMessage: tolak html kosong/non-string', () => {
    assert.throws(() => buildWebuiMessage({}), TypeError);
    assert.throws(() => buildWebuiMessage({ html: '' }), TypeError);
    assert.throws(() => buildWebuiMessage({ html: 123 }), TypeError);
});

test('proto roundtrip: botForwardedMessage selamat encode/decode', () => {
    const msg = buildWebuiMessage({ html: SAMPLE_HTML, title: 'Roundtrip' });
    const encoded = proto.Message.encode(proto.Message.fromObject(msg)).finish();
    const decoded = proto.Message.decode(encoded);
    const rich = decoded.botForwardedMessage?.message?.richResponseMessage;
    assert.ok(rich, 'richResponseMessage hilang setelah decode');
    assert.equal(rich.submessages[0].messageText, 'Roundtrip');
    // Catatan: protobufjs fromObject men-decode string base64 untuk field bytes,
    // jadi di wire `data` berisi JSON mentah (bukan teks base64).
    const dataBuf = Buffer.from(rich.unifiedResponse.data);
    const unified = JSON.parse(dataBuf.toString('utf-8'));
    assert.equal(unified.sections[0].view_model.primitive.payload, SAMPLE_HTML);
    assert.equal(unified.sections[0].view_model.primitive.__typename, WEBUI_PRIMITIVE_TYPENAME);
});

test('generateWebuiMessageId: format WA (3EB0 + 36 hex uppercase)', () => {
    const id = generateWebuiMessageId();
    assert.match(id, /^3EB0[0-9A-F]{36}$/);
});
