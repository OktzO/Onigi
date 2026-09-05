import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdditionalNode } from '../lib/WABinary/generic-utils.js';

test('getAdditionalNode: node biz utk buttons/list/interactive (pola ob9)', () => {
    for (const type of ['buttons', 'list', 'interactive']) {
        const nodes = getAdditionalNode(type);
        assert.equal(nodes.length, 1);
        const biz = nodes[0];
        assert.equal(biz.tag, 'biz');
        assert.equal(biz.attrs.actual_actors, '2');
        assert.equal(biz.attrs.host_storage, '2');
        assert.ok(Number.isFinite(Number(biz.attrs.privacy_mode_ts)));
        // struktur children: engagement + interactive > native_flow
        const tags = biz.content.map((c) => c.tag);
        assert.deepEqual(tags, ['engagement', 'interactive']);
        assert.equal(biz.content[0].attrs.customer_service_state, 'open');
        const interactive = biz.content[1];
        assert.equal(interactive.attrs.type, 'native_flow');
        const flow = interactive.content[0];
        assert.equal(flow.tag, 'native_flow');
        assert.equal(flow.attrs.v, '9');
        assert.ok(['mixed'].includes(flow.attrs.name));
    }
});

test('getAdditionalNode: flow khusus (cta_catalog dkk) punya nama sendiri', () => {
    const biz = getAdditionalNode('cta_catalog')[0];
    const flow = biz.content[1].content[0];
    assert.equal(flow.attrs.name, 'cta_catalog');
    assert.equal(getAdditionalNode('mpm')[0].content[1].content[0].attrs.name, 'mpm');
});

test('getAdditionalNode: order response pakai native_flow_name', () => {
    const biz = getAdditionalNode('review_and_pay')[0];
    assert.equal(biz.tag, 'biz');
    assert.equal(biz.attrs.native_flow_name, 'order_details');
    assert.equal(biz.attrs.actual_actors, undefined);
    assert.deepEqual(biz.content, []);
});

test('getAdditionalNode: tipe tak dikenal tetap kembalikan biz dasar', () => {
    const biz = getAdditionalNode('bogus_type')[0];
    assert.equal(biz.tag, 'biz');
    assert.equal(biz.attrs.actual_actors, '2');
    assert.deepEqual(biz.content, []);
});

test('relayMessage: blok auto-inject biz ada di jalur kirim (source check)', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../lib/Socket/messages-send.js', import.meta.url), 'utf8');
    // injection harus ada setelah push additionalNodes, sebelum sendNode
    const pushIdx = src.indexOf('stanza.content.push(...additionalNodes)');
    const injectIdx = src.indexOf('const buttonType = getButtonType(message)');
    const bizCheckIdx = src.indexOf("node.tag === 'biz'");
    const sendIdx = src.indexOf('await sendNode(stanza)', injectIdx);
    assert.ok(pushIdx > 0, 'push additionalNodes ada');
    assert.ok(injectIdx > pushIdx, 'injection setelah additionalNodes');
    assert.ok(bizCheckIdx > injectIdx, 'cek duplikat biz node ada');
    assert.ok(sendIdx > injectIdx, 'injection sebelum sendNode');
    // getButtonType harus mengenali buttons/list/interactive
    assert.ok(src.includes("msg.listMessage ? 'list' : 'buttons'"));
    assert.ok(src.includes("'interactive'"), 'fallback interactive');
    // import getAdditionalNode harus ada
    assert.ok(src.includes('getAdditionalNode'), 'import getAdditionalNode');
});
