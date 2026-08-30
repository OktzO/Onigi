// Bandingkan intermediate verify: JS crypto_sign_open vs Rust.
// kita replika crypto_sign_open di JS pakai curve25519-js internal? gak bisa.
// Tapi kita bisa cek: A (edpk) yang JS pakai untuk h, dari fixture pk + sig.
const c = require('/home/user/noddjs/ourin-md/node_modules/curve25519-js/lib/index.js');
const crypto = require('crypto');

// fixture valid pertama (sk=0 all-zero, msg kosong)
const pk = Buffer.from('2fe57da347cd62431528daac5fbb290730fff684afc4cfc2ed90995f58cb3b74', 'hex');
const sig = Buffer.from('1217449d83a47a5ff9b568ddaa1fd5ce79e470fbf9ff2bdd0e0004bac6e7dec92201aa948592fefb94c6b0eb3e5ec4537661ff41adfb92b9ccbd6a139b63ae8e', 'hex');
const msg = Buffer.alloc(0);

// sign ulang untuk ambil A dari sisi sign
const sk = new Uint8Array(32);
const kp = c.generateKeyPair(sk);
const sig2 = c.sign(sk, msg);
console.log('sig match:', sig2.toString('hex') === sig.toString('hex'));

// Cek: apakah sig[63] & 128 == kp.public[31] & 128 ? (sign bit A vs sig)
console.log('sig[63]&128:', sig[63] & 128, 'kp.public[31]&128:', kp.public[31] & 128);
console.log('pk:', pk.toString('hex'));
console.log('kp.public:', Buffer.from(kp.public).toString('hex'));
