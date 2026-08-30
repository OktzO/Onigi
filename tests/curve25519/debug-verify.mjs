import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const js = require('/home/user/noddjs/ourin-md/node_modules/curve25519-js/lib/index.js');
const native = require(join(HERE, 'curve25519.linux-x64-gnu.node'));

const fx = JSON.parse(readFileSync(join(HERE, 'fixtures', 'verify.json'), 'utf8'));
// ambil 1 kasus valid
const f = fx.find(x => x.expect === true);
const pk = Buffer.from(f.pk, 'hex');
const msg = Buffer.from(f.msg, 'hex');
const sig = Buffer.from(f.sig, 'hex');
console.log('pk', f.pk);
console.log('sig', f.sig);
console.log('msg', f.msg);
console.log('JS verify:', js.verify(pk, msg, sig));
console.log('Rust verify:', native.verify(pk, msg, sig));

// Debug: apa pk-nya cocok dengan generateKeyPair(sk).public? Cek dari fixture sign
const signFx = JSON.parse(readFileSync(join(HERE, 'fixtures', 'sign.json'), 'utf8'));
// tidak ada korelasi langsung; just check pubkey derivasi
const sk0 = Buffer.from('00'.repeat(32), 'hex');
const kp = js.generateKeyPair(sk0);
console.log('JS kp(sk0).public:', Buffer.from(kp.public).toString('hex'));
console.log('JS kp(sk0).private:', Buffer.from(kp.private).toString('hex'));
