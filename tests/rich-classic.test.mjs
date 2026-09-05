import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeUserJid,
    buildButtonsMessage,
    buildListMessage,
} from '../lib/Utils/rich-classic.js';

test('normalizeUserJid: string, sock, user object, undefined', () => {
    assert.equal(normalizeUserJid('6285143885645@s.whatsapp.net'), '6285143885645@s.whatsapp.net');
    assert.equal(normalizeUserJid({ user: { id: '123@s.whatsapp.net' } }), '123@s.whatsapp.net');
    assert.equal(normalizeUserJid({ id: '456@s.whatsapp.net' }), '456@s.whatsapp.net');
    assert.equal(normalizeUserJid(undefined), undefined);
    assert.equal(normalizeUserJid({ user: { jid: 'legacy' } }), undefined, 'sock.user.jid (legacy) harus undefined');
});

test('buildButtonsMessage: struktur buttonsMessage klasik', () => {
    const content = buildButtonsMessage({
        text: 'Halo',
        footer: 'pilih tombol',
        buttons: [
            { buttonId: '.owner', buttonText: '🧀 Owner' },
            { buttonId: '.allmenu', buttonText: '💐 Allmenu' },
        ],
        locationMessage: { jpegThumbnail: Buffer.alloc(8), name: 'Bot', address: 'v10' },
    });
    assert.ok(content.buttonsMessage);
    assert.equal(content.buttonsMessage.buttons.length, 2);
    assert.equal(content.buttonsMessage.headerType, 6);
    assert.equal(content.buttonsMessage.buttons[0].type, 1);
    assert.equal(content.buttonsMessage.buttons[0].buttonText.displayText, '🧀 Owner');
    assert.equal(content.buttonsMessage.contentText, 'Halo');
    assert.equal(content.buttonsMessage.footerText, 'pilih tombol');
    assert.ok(content.buttonsMessage.locationMessage);
});

test('buildButtonsMessage: tanpa locationMessage -> headerType 1', () => {
    const content = buildButtonsMessage({
        text: 'tes',
        buttons: [{ buttonId: 'a', buttonText: 'A' }],
    });
    assert.equal(content.buttonsMessage.headerType, 1);
    assert.equal(content.buttonsMessage.locationMessage, undefined);
});

test('buildButtonsMessage: validasi input', () => {
    assert.throws(() => buildButtonsMessage({ buttons: [{ buttonId: 'a', buttonText: 'A' }] }), /text/);
    assert.throws(() => buildButtonsMessage({ text: 'x', buttons: [] }), /1 tombol/);
    assert.throws(() => buildButtonsMessage({
        text: 'x',
        buttons: [1, 2, 3, 4].map((i) => ({ buttonId: `b${i}`, buttonText: `B${i}` })),
    }), /3 tombol/);
});

test('buildListMessage: struktur listMessage klasik', () => {
    const content = buildListMessage({
        title: '🍃 Menu',
        description: 'pilih kategori',
        buttonText: 'Pilih Disini',
        sections: [
            {
                title: 'Kategori',
                rows: [
                    { title: 'main', description: '19 command', rowId: '.menucat main' },
                    { title: 'sticker', rowId: '.menucat sticker' },
                ],
            },
        ],
    });
    assert.ok(content.listMessage);
    assert.equal(content.listMessage.listType, 2);
    assert.equal(content.listMessage.sections[0].rows.length, 2);
    assert.equal(content.listMessage.sections[0].rows[1].description, '');
    assert.equal(content.listMessage.sections[0].rows[0].rowId, '.menucat main');
});

test('buildListMessage: validasi input', () => {
    assert.throws(() => buildListMessage({ buttonText: 'x', sections: [{ title: 's', rows: [] }] }), /title/);
    assert.throws(() => buildListMessage({ title: 'x', sections: [{ title: 's', rows: [] }] }), /buttonText/);
    assert.throws(() => buildListMessage({ title: 'x', buttonText: 'y', sections: [] }), /section/);
});

test('integrasi: content klasik lolos generateWAMessageFromContent', async () => {
    const { generateWAMessageFromContent } = await import('../lib/Utils/messages.js');
    const jid = '120363000000@g.us';
    const userJid = '6285143885645@s.whatsapp.net';

    const btn = await generateWAMessageFromContent(jid, buildButtonsMessage({
        text: 'tes tombol',
        buttons: [{ buttonId: '.owner', buttonText: 'Owner' }],
    }), { userJid });
    assert.ok(btn.message.buttonsMessage);
    assert.equal(btn.participant, userJid, 'participant grup harus terisi dari userJid');

    const list = await generateWAMessageFromContent(jid, buildListMessage({
        title: 'Menu',
        buttonText: 'Pilih',
        sections: [{ title: 'S', rows: [{ title: 'a', rowId: 'a' }] }],
    }), { userJid });
    assert.ok(list.message.listMessage);
});
