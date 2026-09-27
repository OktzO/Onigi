import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBinaryNode } from '../lib/WABinary/encode.js';
import { decodeBinaryNode } from '../lib/WABinary/decode.js';
import { encodeBinaryNodeRust } from '../lib/WABinary/rust-adapter.js';
import { encodeNode } from 'whatsapp-rust-bridge';

const jsOf = (node) => { try { return { bytes: encodeBinaryNode(structuredClone(node)) }; } catch (e) { return { err: e }; } };
const rsOf = (node) => { try { return { bytes: Buffer.from(encodeNode(structuredClone(node))) }; } catch (e) { return { err: e }; } };
const rustAdapterOf = (node) => { try { return { bytes: encodeBinaryNodeRust(structuredClone(node)) }; } catch (e) { return { err: e }; } };

test('an empty-string attribute is not dropped by the adapter', async () => {
    const node = { tag: 'x', attrs: { a: '' } };
    // what the native encoder does on its own
    const native = rsOf(node);
    assert.notEqual(Buffer.compare(native.bytes, jsOf(node).bytes), 0, 'precondition: native and JS encoders disagree here');

    const got = rustAdapterOf(node);
    assert.ok(got.bytes, 'the adapter must return a frame');
    assert.equal(Buffer.compare(got.bytes, jsOf(node).bytes), 0, 'adapter must match the JS encoder byte for byte');
    assert.deepEqual((await decodeBinaryNode(got.bytes)).attrs, { a: '' });
});

test('a non-string attribute is rejected by the adapter exactly as by the JS encoder', () => {
    for (const value of [12345, 1.5, true, Buffer.from('z'), { b: 1 }, ['z'], Infinity, NaN]) {
        const js = jsOf({ tag: 'x', attrs: { a: value } });
        assert.ok(js.err, 'precondition: the JS encoder rejects this value');
        const got = rustAdapterOf({ tag: 'x', attrs: { a: value } });
        assert.ok(got.err, `adapter must reject ${String(value)}, not return bytes`);
        assert.equal(got.err.message, js.err.message);
    }
});

test('a non-string attribute on a nested node is rejected by the adapter', () => {
    const node = { tag: 'a', attrs: {}, content: [{ tag: 'b', attrs: {}, content: [{ tag: 'c', attrs: { a: 1 } }] }] };
    const got = rustAdapterOf(node);
    assert.ok(got.err, 'adapter must reject a non-string attribute nested in content');
    assert.equal(got.err.message, jsOf(node).err.message);
});

test('a node missing attrs, or with null content items, is encoded by the JS encoder', () => {
    for (const node of [{ tag: 'x' }, { tag: 'x', attrs: {}, content: [null, { tag: 'y', attrs: {} }] }]) {
        const got = rustAdapterOf(node);
        assert.ok(got.bytes, 'adapter must return a frame');
        assert.equal(Buffer.compare(got.bytes, jsOf(node).bytes), 0);
    }
});

test('the adapter still matches the JS encoder on the shapes both handle natively', () => {
    const nodes = [
        { tag: 'x', attrs: { a: 'abc' } },
        { tag: 'x', attrs: { name: 'text', subject: 'text' } },
        { tag: 'x', attrs: { to: '1234@s.whatsapp.net' } },
        { tag: 'x', attrs: { t: '1700000000' } },
        { tag: 'x', attrs: { h: 'DEADBEEF' } },
        { tag: 'x', attrs: { a: 'z'.repeat(300) } },
        { tag: 'x', attrs: {}, content: 'hi' },
        { tag: 'x', attrs: {}, content: Buffer.from([1, 2, 3]) },
        { tag: 'x', attrs: {}, content: [{ tag: 'y', attrs: { a: 'b' } }] },
        { tag: 'a', attrs: {}, content: [{ tag: 'b', attrs: {}, content: [{ tag: 'c', attrs: { x: 'y' }, content: 'z' }] }] }
    ];
    for (const node of nodes) {
        const got = rustAdapterOf(node);
        assert.equal(Buffer.compare(got.bytes, jsOf(node).bytes), 0, `adapter mismatch for ${JSON.stringify(node)}`);
    }
});

test('a recurring native failure keeps reporting instead of warning once per process', async () => {
    // {content: 5} is a shape the native encoder cannot take, so every call
    // throws natively, falls back to JS, and JS throws the real error. 250
    // calls must surface more than the first warning, or a permanently broken
    // native encoder stays invisible for the life of the process.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const script = `
        const { encodeBinaryNodeRust } = await import('${new URL('../lib/WABinary/rust-adapter.js', import.meta.url).href}');
        for (let i = 0; i < 250; i++) {
            try { encodeBinaryNodeRust({ tag: 'x', attrs: {}, content: 5 }); } catch { }
        }
    `.trim();
    const { stderr } = await run(process.execPath, ['--input-type=module', '-e', script], {
        cwd: new URL('../', import.meta.url).pathname,
        env: { ...process.env, ONIGI_RUST_WABINARY: '1' }
    });
    const warnings = stderr.split('\n').filter(l => l.includes('[rust-adapter]'));
    assert.ok(warnings.length > 1, `expected repeated warnings, got ${warnings.length}: ${stderr}`);
    assert.match(warnings[warnings.length - 1], /occurrence \d+/);
});
