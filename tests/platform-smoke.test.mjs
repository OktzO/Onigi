import assert from 'node:assert/strict';
import test from 'node:test';
import { expandAppStateKeys } from 'whatsapp-rust-bridge';
import { native as signalNative } from 'oktz-signal';
import * as curve from 'oktz-curve25519';

test('native production dependencies load on this target', () => {
  assert.equal(typeof expandAppStateKeys, 'function');
  assert.equal(typeof signalNative.ratchetEncrypt, 'function');
  assert.equal(typeof curve.sign, 'function');
  assert.match(`${process.platform}/${process.arch}`, /^(linux|android)\/(x64|arm64)$/);
});