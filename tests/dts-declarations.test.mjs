import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The .d.ts files in this repo are committed build artifacts with no tsconfig and
// no tsc in the tree, so nothing catches them drifting from the runtime. These
// tests pin the declarations that consumers depend on to the code they describe.

const read = (rel) => readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('sender-key-name.d.ts declares the sender fields serialize() actually reads', async () => {
  const dts = await read('../lib/Signal/Group/sender-key-name.d.ts');
  const js = await read('../lib/Signal/Group/sender-key-name.js');

  // oktz-signal's ProtocolAddress exposes `name`, not `id`; commit 4ca7553 moved
  // serialize() onto `.name`, and this declaration had to follow.
  assert.match(js, /this\.sender\.name/, 'runtime must read sender.name');
  assert.doesNotMatch(js, /this\.sender\.id\b/, 'runtime must not read sender.id');
  assert.match(dts, /name:\s*string;/, 'declaration must expose name');
  assert.doesNotMatch(dts, /\bid:\s*string;/, 'declaration must not expose a phantom id');
  assert.match(dts, /deviceId:\s*number;/, 'declaration must expose deviceId');
});

test('Events.d.ts declares the error event carrying (err, events)', async () => {
  const dts = await read('../lib/Types/Events.d.ts');
  const js = await read('../lib/Utils/event-buffer.js');

  assert.match(js, /ev\.emit\('error',\s*err,\s*events\)/, 'runtime must emit (err, events)');
  assert.match(dts, /^\s*error:\s*Error;$/m, "BaileysEventMap must declare the 'error' key");
  // sock.ev.on('error', (err, events) => ...) has to resolve; the single-arg
  // generic signature cannot carry the second argument.
  assert.match(
    dts,
    /on\(event:\s*'error',\s*listener:\s*BaileysEventErrorListener\):\s*void;/,
    'on() needs a two-argument overload for error'
  );
  assert.match(
    dts,
    /off\(event:\s*'error',\s*listener:\s*BaileysEventErrorListener\):\s*void;/,
    'off() needs a two-argument overload for error'
  );
  assert.match(
    dts,
    /BaileysEventErrorListener\s*=\s*\(err:\s*Error,\s*events:\s*string\[\]\)\s*=>\s*void;/,
    'the error listener must be (err, events: string[])'
  );
});

test('event-buffer.d.ts keeps the synthetic error key out of batched handlers', async () => {
  const dts = await read('../lib/Utils/event-buffer.d.ts');
  assert.match(
    dts,
    /BaileysEventData\s*=\s*Partial<Omit<BaileysEventMap,\s*'error'>>/,
    'process() handlers receive the consolidated map, which never carries error'
  );
});

test('the error event is only emitted when a listener is attached', async () => {
  const js = await read('../lib/Utils/event-buffer.js');
  // An unlistened 'error' emit throws ERR_UNHANDLED_ERROR, so the gate is load-bearing.
  assert.match(js, /if\s*\(ev\.listenerCount\('error'\)\)/, 'error emit must stay behind the listenerCount gate');
});
