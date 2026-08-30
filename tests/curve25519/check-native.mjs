// Fase 3 — validasi implementasi Rust vs fixture oracle (curve25519-js asli).
// Target: 100% match, satu mismatch pun = bug.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const fx = (f) => JSON.parse(readFileSync(join(HERE, 'fixtures', f), 'utf8'));

const native = require(join(HERE, 'curve25519.linux-x64-gnu.node'));

let pass = 0, fail = 0;
const failures = [];

function checkSign() {
  const list = fx('sign.json');
  for (const f of list) {
    const sk = Buffer.from(f.sk, 'hex');
    const msg = Buffer.from(f.msg, 'hex');
    const sig = native.sign(sk, msg);
    if (sig.toString('hex') !== f.sig) {
      fail++; failures.push({ case: `sign sk=${f.sk.slice(0,16)} msg_len=${f.msg.length/2}` });
      if (failures.length <= 3) console.log('  SIGN MISMATCH', f.sk.slice(0,16), f.msg.length/2, sig.toString('hex').slice(0,16), '!=', f.sig.slice(0,16));
      continue;
    }
    pass++;
  }
  console.log(`sign: ${list.length} (${pass}/${list.length} match)`);
}

function checkVerify() {
  const list = fx('verify.json');
  let localPass = 0;
  for (const f of list) {
    const pk = Buffer.from(f.pk, 'hex');
    const msg = Buffer.from(f.msg, 'hex');
    const sig = Buffer.from(f.sig, 'hex');
    let got;
    try { got = native.verify(pk, msg, sig); } catch (e) { got = e.message; }
    if (got !== f.expect) {
      fail++; failures.push({ case: `verify pk=${f.pk.slice(0,16)} expect=${f.expect} got=${got}` });
      if (failures.length <= 3) console.log('  VERIFY MISMATCH', f.pk.slice(0,16), 'expect', f.expect, 'got', got);
      continue;
    }
    localPass++;
  }
  pass += localPass;
  console.log(`verify: ${list.length} (${localPass}/${list.length} match)`);
}

checkSign();
checkVerify();
console.log(`\n=== TOTAL: pass=${pass} fail=${fail} ===`);
if (fail > 0) process.exit(1);
