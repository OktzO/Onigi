const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

test('main package tarball excludes native binaries', () => {
  const [{ files }] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }));
  assert.equal(files.some(({ path }) => path.endsWith('.node')), false);
  assert.equal(files.some(({ path }) => path.startsWith('target/')), false);
});