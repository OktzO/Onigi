'use strict';

const platform = process.platform;
const arch = process.arch;
let packageName;

if (platform === 'android' && arch === 'arm64') {
  packageName = '@oktz-curve25519/curve25519-android-arm64';
} else if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
  const libc = process.report?.getReport?.().header.glibcVersionRuntime ? 'gnu' : 'musl';
  packageName = `@oktz-curve25519/curve25519-linux-${arch}-${libc}`;
} else {
  throw new Error(`oktz-curve25519: unsupported platform ${platform}-${arch}`);
}

try {
  module.exports = require(packageName);
} catch (cause) {
  const error = new Error(`oktz-curve25519: missing prebuild ${packageName}`, { cause });
  error.cause = cause;
  throw error;
}
