import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { encodeBinaryNode } from '../lib/WABinary/encode.js';
import { decodeBinaryNode } from '../lib/WABinary/decode.js';
import { encodeBinaryNodeRust, decodeBinaryNodeRust } from '../lib/WABinary/rust-adapter.js';

const fixtureNodes = [
    { tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'get', id: '3EB0ABC123' }, content: [{ tag: 'query', attrs: { xmlns: 'w' } }] },
    { tag: 'message', attrs: { to: '1234@s.whatsapp.net', id: 'X', t: '1234' }, content: Buffer.from('hello world binary') },
    { tag: 'body', attrs: {}, content: 'plain string text' },
    { tag: 'receipt', attrs: { id: 'ABC', t: '1234' }, content: undefined },
    {
        tag: 'chat',
        attrs: { jid: '6281234567890:5@lid', from: 'user@server' },
        content: [
            { tag: 'a', attrs: { k: 'v' }, content: 'str' },
            { tag: 'b', attrs: {}, content: Buffer.from([1, 2, 3, 255, 0, 128]) },
            { tag: 'c', attrs: {}, content: [{ tag: 'd', attrs: { deep: 'node' } }] },
            { tag: 'e', attrs: {}, content: '6281234567890' },
            { tag: 'f', attrs: {}, content: 'DEADBEEF' },
            { tag: 'g', attrs: {}, content: '123-456.789' },
            { tag: 'h', attrs: {}, content: '1234@s.whatsapp.net' }
        ]
    },
    { tag: 'binary', attrs: {}, content: Buffer.alloc(300, 9) },
    { tag: 'nested', attrs: {}, content: [{ tag: 'l1', attrs: {}, content: [{ tag: 'l2', attrs: {}, content: [{ tag: 'l3', attrs: { x: 'y' }, content: Buffer.from('deep bin') }] }] }] }
];

const normalize = (obj) => JSON.parse(JSON.stringify(obj, (_k, v) => (Buffer.isBuffer(v) || v instanceof Uint8Array)
    ? Buffer.from(v.data ?? v).toString('hex')
    : v));

test('rust encode byte-identical to JS encode', () => {
    for (const node of fixtureNodes) {
        const jsBytes = encodeBinaryNode(node);
        const rustBytes = encodeBinaryNodeRust(node);
        assert.equal(Buffer.compare(jsBytes, rustBytes), 0, `encode mismatch for <${node.tag}>`);
    }
});

test('rust decode deep-equal to JS decode (raw bytes)', async () => {
    for (const node of fixtureNodes) {
        const frame = encodeBinaryNode(node);
        const jsDecoded = await decodeBinaryNode(frame);
        const rustDecoded = await decodeBinaryNodeRust(frame);
        assert.deepEqual(normalize(rustDecoded), normalize(jsDecoded), `decode mismatch for <${node.tag}>`);
    }
});

test('rust decode handles compressed frames', async () => {
    for (const node of fixtureNodes) {
        const payload = encodeBinaryNode(node).slice(1);
        const frame = Buffer.concat([Buffer.from([2]), deflateSync(payload)]);
        const jsDecoded = await decodeBinaryNode(frame);
        const rustDecoded = await decodeBinaryNodeRust(frame);
        assert.deepEqual(normalize(rustDecoded), normalize(jsDecoded), `compressed decode mismatch for <${node.tag}>`);
    }
});

test('rust decode returns plain objects (no wasm pointers leaked)', async () => {
    const node = fixtureNodes[4];
    const decoded = await decodeBinaryNodeRust(encodeBinaryNode(node));
    assert.equal(typeof decoded.tag, 'string');
    assert.equal(typeof decoded.free, 'undefined', 'root must not be a wasm wrapper');
    for (const child of decoded.content) {
        assert.equal(typeof child.free, 'undefined', 'children must not be wasm wrappers');
    }
});

test('WRB decode path (ONIGI_RUST_WABINARY_DECODE=1) matches JS decode', async () => {
    // runs the adapter in a child process with WRB decode forced on
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const node = fixtureNodes[4];
    const frame = encodeBinaryNode(node).toString('hex');
    const script = `
        const { decodeBinaryNodeRust } = await import('${new URL('../lib/WABinary/rust-adapter.js', import.meta.url).href}');
        const d = await decodeBinaryNodeRust(Buffer.from(process.argv[1], 'hex'));
        console.log(JSON.stringify(d, (k, v) => Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v.data ?? v).toString('hex') : v));
    `.trim();
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script, frame], {
        cwd: new URL('../', import.meta.url).pathname,
        env: { ...process.env, ONIGI_RUST_WABINARY: '1', ONIGI_RUST_WABINARY_DECODE: '1' }
    });
    const jsDecoded = await decodeBinaryNode(Buffer.from(frame, 'hex'));
    const normalize = (obj) => JSON.parse(JSON.stringify(obj, (_k, v) => (Buffer.isBuffer(v) || v instanceof Uint8Array)
        ? Buffer.from(v.data ?? v).toString('hex')
        : v));
    assert.deepEqual(normalize(JSON.parse(stdout)), normalize(jsDecoded));
});

test('adapter falls back to JS on WRB failure', async () => {
    // malformed frame must fall back and then throw like the JS decoder
    await assert.rejects(decodeBinaryNodeRust(Buffer.from([0, 0xfa, 0x99, 0x99])));
});

test('JS path when ONIGI_RUST_WABINARY=0', async () => {
    // exercised via env in CI; here just verify the JS fallback path produces same output
    const node = fixtureNodes[0];
    const frame = encodeBinaryNode(node);
    assert.deepEqual(normalize(await decodeBinaryNodeRust(frame)), normalize(await decodeBinaryNode(frame)));
});
