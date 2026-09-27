import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { proto } from '../WAProto/index.js';
import { makeLtHashGenerator, newLTHashState } from '../lib/Utils/chat-utils.js';
import { LT_HASH_ANTI_TAMPERING } from '../lib/Utils/lt-hash.js';

// lt-hash.js:7 exports a module-level `new LTHashAntiTampering()` shared by
// every auth state in the process. These tests pin the property that sharing
// it is safe: whatsapp-rust-bridge's LTHashAntiTampering.subtractThenAdd is a
// pure function of (base, subtract, add) — it holds no cumulative state — so
// the per-account state that actually matters (hash / version / indexValueMap)
// travels in and out of makeLtHashGenerator's argument, not through the
// shared object. If a future version of the bridge ever makes the accumulator
// stateful, these tests fail instead of two accounts silently bleeding LT-hash
// state into each other's snapshot/patch MACs.

const SET = proto.SyncdMutation.SyncdOperation.SET;
const REMOVE = proto.SyncdMutation.SyncdOperation.REMOVE;

const scenario = (seed) => {
    const rng = (n) => randomBytes(n);
    const steps = [
        { indexMac: rng(32), valueMac: rng(32), operation: SET },
        { indexMac: rng(32), valueMac: rng(32), operation: SET },
        { indexMac: rng(32), valueMac: rng(32), operation: SET },
        { indexMac: rng(32), valueMac: rng(32), operation: SET }
    ];
    // step 2 is overwritten and then removed, exercising the subtract branch
    steps.push({ ...steps[1], valueMac: rng(32) });
    steps.push({ ...steps[1], operation: REMOVE });
    return steps;
};

const runAlone = (steps, startHash) => {
    const gen = makeLtHashGenerator({ indexValueMap: {}, hash: Buffer.from(startHash) });
    for (const step of steps) {
        gen.mix(step);
    }
    return gen.finish().hash;
};
const runInterleaved = (scenarios, startHash) => {
    const gens = scenarios.map((steps) => makeLtHashGenerator({ indexValueMap: {}, hash: Buffer.from(startHash) }));
    for (let i = 0; i < scenarios[0].length; i++) {
        for (let g = 0; g < gens.length; g++) {
            gens[g].mix(scenarios[g][i]);
        }
    }
    return gens.map((gen) => gen.finish().hash);
};

test('the shared accumulator holds no mutable state of its own', () => {
    const own = Object.getOwnPropertyNames(LT_HASH_ANTI_TAMPERING).filter((k) => k !== '__wbg_ptr');
    assert.deepEqual(own, [], `LTHashAntiTampering instance carries fields: ${own.join(', ')}`);
});

test('two interleaved accounts produce the same LT-hash as each account alone', () => {
    const start = Buffer.alloc(128, 5);
    const accountA = scenario();
    const accountB = scenario();
    const aAlone = runAlone(accountA, start);
    const bAlone = runAlone(accountB, start);
    const [aShared, bShared] = runInterleaved([accountA, accountB], start);
    assert.ok(aAlone.equals(aShared), 'account A was contaminated by account B');
    assert.ok(bAlone.equals(bShared), 'account B was contaminated by account A');
    assert.ok(!aAlone.equals(bAlone), 'the two accounts must not collapse to one hash');
});

test('three interleaved accounts are all mutually independent', () => {
    const start = Buffer.alloc(128, 9);
    const accounts = [scenario(), scenario(), scenario()];
    const alone = accounts.map((steps) => runAlone(steps, start));
    const shared = runInterleaved(accounts, start);
    for (let i = 0; i < accounts.length; i++) {
        assert.ok(alone[i].equals(shared[i]), `account ${i} was contaminated`);
    }
    assert.equal(new Set(alone.map((h) => h.toString('hex'))).size, accounts.length);
});

test('replaying the same sequence on the shared accumulator is stable', () => {
    const start = Buffer.alloc(128, 1);
    const steps = scenario();
    const first = runAlone(steps, start);
    for (let i = 0; i < 5; i++) {
        assert.ok(first.equals(runAlone(steps, start)), 'repeated runs drifted');
    }
});

test('newLTHashState starts each account from the same zero state', () => {
    const a = newLTHashState();
    const b = newLTHashState();
    assert.notEqual(a, b, 'each auth state must get its own object');
    assert.equal(a.version, 0);
    assert.deepEqual(a.indexValueMap, {});
    assert.equal(a.hash.length, 128);
    a.hash[0] = 0xff;
    a.indexValueMap.injected = { valueMac: Buffer.alloc(32) };
    assert.equal(b.hash[0], 0, 'hash buffers are not shared between accounts');
    assert.deepEqual(b.indexValueMap, {});
});

test('subtractThenAdd does not mutate the caller state it is handed', () => {
    const hash = Buffer.alloc(128, 5);
    const hashBefore = Buffer.from(hash);
    const sub = [randomBytes(32)];
    const subBefore = Buffer.from(sub[0]);
    const add = [randomBytes(32)];
    const addBefore = Buffer.from(add[0]);
    LT_HASH_ANTI_TAMPERING.subtractThenAdd(hash, sub, add);
    assert.ok(hash.equals(hashBefore), 'the stored hash buffer was mutated in place');
    assert.ok(sub[0].equals(subBefore), 'a subtract value mac was mutated in place');
    assert.ok(add[0].equals(addBefore), 'an add value mac was mutated in place');
});
