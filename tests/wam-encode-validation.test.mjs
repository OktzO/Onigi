import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWAM } from '../lib/WAM/encode.js';
import { BinaryInfo } from '../lib/WAM/BinaryInfo.js';

const wam = (opts) => encodeWAM(new BinaryInfo(opts));
const DROPPED = { WamDroppedEvent: { globals: {}, props: {} } };
const caught = (fn) => { try { fn(); return null; } catch (e) { return e; } };
// field id 1 of WamDroppedEvent, flags 0x3d for the event record, weight -1 as 0xff
const head = (propFlags, propId, payload) => `57414d0501000000390611ff${propFlags}${propId.toString(16).padStart(2, '0')}${payload}`;

// --- (a) the boolean value type ---

test('a boolean is written as type 1 for false and type 2 for true', () => {
    // The size class is the high nibble of the field flags byte. WA Web's own
    // WABinary / WAWebWamLibProtocol produced 0x16 for the value 0 and 0x26 for
    // the value 1 — captured byte-for-byte in oxidezap/whatsapp-rust
    // plugins/wam-catalog/src/tests.rs, whose encoder asserts whole buffers
    // against those vectors. So false=1 and true=2, and `(value + 1) << 4` in
    // lib/WAM/encode.js:73 is right. Pinned here so nobody "fixes" it.
    const isFromWamsys = (v) => wam({ events: [{ WamDroppedEvent: { globals: {}, props: { isFromWamsys: v } } }] }).toString('hex');
    // 0x26 = CLASS(2) | LAST | FIELD, id 3 = isFromWamsys
    assert.equal(isFromWamsys(true), '57414d0501000000390611ff2603');
    // 0x16 = CLASS(1) | LAST | FIELD, id 3
    assert.equal(isFromWamsys(false), '57414d0501000000390611ff1603');
});

test('the numeric and string size classes match the WA Web vectors', () => {
    // WA Web: -1 -> 0x36+ff, 2 -> 0x36+02, 127 -> 0x36+7f, 128 -> 0x46+u16le,
    // 32768 -> 0x56+u32le, 2147483648 -> 0x76+f64 (never int64, class 6 unused)
    const int = (v) => wam({ events: [{ WamDroppedEvent: { globals: {}, props: { droppedEventCode: v } } }] }).toString('hex');
    assert.equal(int(-1), head('36', 1, 'ff'));
    assert.equal(int(2), head('36', 1, '02'));
    assert.equal(int(127), head('36', 1, '7f'));
    assert.equal(int(128), head('46', 1, '8000'));
    assert.equal(int(32768), head('56', 1, '00800000'));
    assert.equal(int(2147483648), head('76', 1, '000000000000e041'));

    // strings: class 8 for <256 bytes, class 9 for <65536, class 10 beyond
    const str = (s) => encodeWAM(new BinaryInfo({ events: [{ MetaVerifiedInteraction: { globals: {}, props: { businessOwnerJid: s } } }] })).toString('hex');
    assert.equal(str('a'), '57414d0501000000390613ff86010161');
    assert.equal(str('a'.repeat(255)), `57414d0501000000390613ff8601ff${'61'.repeat(255)}`);
    assert.equal(str('a'.repeat(256)), `57414d0501000000390613ff96010001${'61'.repeat(256)}`);
});

// --- (b) a bare string throw ---

test('an unsupported value type throws a real Error naming the field', () => {
    for (const value of [{}, undefined, Symbol('x'), () => 1]) {
        const err = caught(() => wam({ events: [{ WamDroppedEvent: { globals: {}, props: { droppedEventCode: value } } }] }));
        assert.ok(err instanceof Error, `expected an Error for ${String(value)}, got a ${typeof err === 'string' ? 'bare string' : typeof err}`);
        assert.match(err.message, /unsupported WAM value type/);
    }
});

// --- (c) an unknown global name ---

test('an unknown global name throws a real Error naming the global', () => {
    const err = caught(() => wam({ events: [{ WamDroppedEvent: { globals: { nope: 1 }, props: {} } }] }));
    assert.ok(err instanceof Error, `expected an Error, got ${err?.constructor?.name}`);
    assert.match(err.message, /unknown WAM global "nope"/);
    // a real global still encodes (0x80 = CLASS | global, id 17 = appVersion)
    assert.equal(wam({ events: [{ WamDroppedEvent: { globals: { appVersion: '2.3000' }, props: {} } }] }).toString('hex'), '57414d0501000000801106322e33303030' + '3d0611ff');
});

// --- (d) a malformed event entry ---

test('a malformed event entry throws a real Error naming the shape', () => {
    for (const entry of [{}, { Unknown: {} }, null, 'WamDroppedEvent', 42]) {
        const err = caught(() => wam({ events: [entry] }));
        assert.ok(err instanceof Error, `expected an Error for ${JSON.stringify(entry)}, got ${err?.constructor?.name}: ${err?.message}`);
        assert.match(err.message, /WAM event/);
    }
});

test('an event declared with no props or globals encodes as a fieldless event', () => {
    // identical to the explicit `{ globals: {}, props: {} }` form: with no field
    // there is no field record, so only the event record (0x3d) is written
    assert.equal(wam({ events: [{ WamDroppedEvent: {} }] }).toString('hex'), wam({ events: [DROPPED] }).toString('hex'));
    assert.equal(wam({ events: [{ WamDroppedEvent: {} }] }).toString('hex'), '57414d05010000003d0611ff');
});

// --- (e) an unknown property name ---

test('an unknown property name is rejected instead of being written as id 0', () => {
    // Buffer.writeUInt16LE(undefined) writes 0, so a typo'd field id reached the
    // wire as field 0 with no error at all
    const err = caught(() => wam({ events: [{ WamDroppedEvent: { globals: {}, props: { nope: 1 } } }] }));
    assert.ok(err instanceof Error, `expected an Error, got ${err?.constructor?.name}`);
    assert.match(err.message, /unknown WAM property "nope"/);
    assert.equal(wam({ events: [{ WamDroppedEvent: { globals: {}, props: { droppedEventCode: 7 } } }] }).toString('hex'), head('36', 1, '07'));
});

// --- (f) a sequence or protocol version outside its integer width ---

test('a sequence outside u16 throws a real Error naming the field', () => {
    for (const sequence of [65536, 70000, -1, 1.5, NaN]) {
        const err = caught(() => wam({ sequence, events: [DROPPED] }));
        assert.ok(err instanceof Error, `expected an Error for sequence ${sequence}, got ${err?.constructor?.name}`);
        assert.match(err.message, /sequence/);
    }
    assert.equal(wam({ sequence: 65535, events: [DROPPED] }).toString('hex'), '57414d0501ffff003d0611ff');
    assert.equal(wam({ sequence: 0, events: [DROPPED] }).toString('hex'), '57414d05010000003d0611ff');
});

test('a protocol version outside u8 throws a real Error naming the field', () => {
    for (const protocolVersion of [256, 300, -1, 1.5]) {
        const err = caught(() => wam({ protocolVersion, events: [DROPPED] }));
        assert.ok(err instanceof Error, `expected an Error for protocolVersion ${protocolVersion}`);
        assert.match(err.message, /protocol version/i);
    }
});

// --- (g) reduce with no initial value ---

test('a buffer with no events still totals its length', () => {
    assert.equal(wam({ events: [] }).toString('hex'), '57414d0501000000');
});

test('the returned length always equals the sum of the pushed record lengths', () => {
    for (const events of [[], [DROPPED], [{ WamDroppedEvent: { globals: {}, props: { droppedEventCode: 7, droppedEventCount: 9 } } }]]) {
        const info = new BinaryInfo({ events });
        const bytes = encodeWAM(info);
        const sum = info.buffer.reduce((a, b) => a + b.length, 0);
        assert.equal(bytes.length, sum, 'reduce must total every pushed record');
        assert.equal(bytes.readUIntBE(0, 3), 0x57414d, 'WAM magic');
        assert.ok(bytes.length >= 8, 'the 8-byte header is always present');
    }
});
