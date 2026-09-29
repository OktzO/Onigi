/*
 * docs/pack-install-check.mjs — the publish-artifact gate.
 *
 * Run: node docs/pack-install-check.mjs
 *
 * `npm test` proves the code works in this repository. It cannot prove that what
 * we *publish* works for someone who runs `npm install onigis`. Those are
 * different trees, and the differences are exactly where a release breaks:
 *
 *   1. the tarball can carry something it should not — a native binary, a
 *      stray credential file, a secret;
 *   2. `files` in package.json can drop something the entry point needs;
 *   3. a consumer who installs the tarball gets their native modules from
 *      optionalDependencies, not from us, and that resolution has to work;
 *   4. the package can import cleanly as an installed dependency rather than as
 *      a relative path into the repo.
 *
 * So this packs the tarball, installs it into a throwaway directory OUTSIDE the
 * repository, and imports the main entry point from there. If the install
 * resolves to the repo's own node_modules this check is worthless, so that is
 * asserted first.
 *
 * Consumers reach the native surface through `optionalDependencies`, which is
 * why a `.node` file in our tarball would be wrong rather than merely redundant:
 * it would pin one platform's binary into a package that has to work on four.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const say = (...parts) => console.log('  ' + parts.join(' '));

// ---------------------------------------------------------------- 1. the tarball

say('packing…');
const [{ files }] = JSON.parse(npm(['pack', '--dry-run', '--json'], root));
say(`${files.length} entries`);

const paths = files.map(f => f.path);

const natives = paths.filter(p => p.endsWith('.node'));
assert.deepEqual(natives, [],
  `the tarball must not ship native binaries — consumers get those through ` +
  `optionalDependencies. Found: ${natives.join(', ')}`);

// The vendored Rust project under native/ is a separate upstream package with
// its own CI. Shipping it would double the tarball and pin its sources.
const vendored = paths.filter(p => p.startsWith('native/'));
assert.deepEqual(vendored, [], `native/ is vendored upstream and must not be published. Found: ${vendored.join(', ')}`);

// Nothing that has ever held key material, and nothing that is a development
// leftover, may be in `files`. package.json already restricts this to
// lib/** and WAProto/**; this is the assertion that it stayed that way.
const FORBIDDEN = [
	/^\.env(\..*)?$/,
	/^.*\.pem$/,
	/^.*\.key$/,
	/^id_rsa/,
	/^\.npmrc$/,
	/creds\.json$/,
	/^auth_info\//,
	/^tests\//,
	/^examples\//,
	/^node_modules\//
];
const secretish = paths.filter(p => FORBIDDEN.some(re => re.test(p)));
assert.deepEqual(secretish, [], `the tarball must not carry these. Found: ${secretish.join(', ')}`);

// And the entry points package.json advertises must actually be in there.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const required of [pkg.main, pkg.types, 'lib/index.js', 'lib/Socket/index.js', 'WAProto/index.js']) {
	assert.ok(paths.includes(required), `${required} is declared or imported but missing from the tarball`);
}

// A real credential, in case the pattern list above ever misses a name. The
// fixture below is the shape of an actual creds.json; it must not appear.
const CRED_SHAPED = /"noiseKey"\s*:\s*\{[^}]*"private"\s*:\s*\{\s*"type"\s*:\s*"Buffer"/;
const credShaped = [];
for (const entry of files) {
	if (entry.path.endsWith('.d.ts') || entry.path.endsWith('.map')) {
		continue;
	}
	const abs = join(root, entry.path);
	try {
		if (CRED_SHAPED.test(readFileSync(abs, 'utf8'))) {
			credShaped.push(entry.path);
		}
	} catch { /* a file npm listed that is not on disk: npm's problem, not ours */ }
}
assert.deepEqual(credShaped, [], `these files contain creds.json-shaped key material: ${credShaped.join(', ')}`);

// ------------------------------------------------- 2. install it somewhere else

const scratch = mkdtempSync(join(tmpdir(), 'onigi-pack-install-'));
try {
	say('installing the tarball into', scratch);
	npm(['pack', '--pack-destination', scratch], root);
	const tarball = readdirSync(scratch).find(name => name.endsWith('.tgz'));
	assert.ok(tarball, 'npm pack produced no tarball');

	// A consumer's directory: its own package.json, and nothing else.
	writeFileSync(join(scratch, 'package.json'), JSON.stringify({
		name: 'onigis-pack-consumer', version: '0.0.0', private: true, type: 'module'
	}, null, 2));

	// --ignore-scripts and --no-audit keep this to a resolution check: this gate
	// is about what the package CONTAINS and whether it imports, not about
	// re-running anyone's install hooks.
	npm(['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', `./${tarball}`], scratch);

	// The whole point: the import must resolve into the scratch tree. If it
	// silently found ../node_modules this gate proves nothing.
	const probe = `
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const resolved = require.resolve('onigis');
if (!resolved.startsWith(${JSON.stringify(join(scratch, 'node_modules'))})) {
  throw new Error('onigis resolved outside the scratch tree: ' + resolved);
}
const ns = await import('onigis');
const names = Object.keys(ns);
if (typeof ns.default !== 'function') throw new Error('default export is not makeWASocket');
if (typeof ns.makeWASocket !== 'function') throw new Error('named makeWASocket is missing');
if (typeof ns.jidDecode !== 'function') throw new Error('jidDecode is missing');
if (typeof ns.proto?.Message?.encode !== 'function') throw new Error('proto is missing');

// The non-E2EE surface must work with no engine loaded at all.
const jid = ns.jidDecode('15551234567@s.whatsapp.net');
if (jid.user !== '15551234567') throw new Error('jidDecode is wrong: ' + JSON.stringify(jid));
const bytes = ns.proto.Message.encode(
  ns.proto.Message.fromObject({ conversation: 'from a packed install' })
).finish();
if (ns.proto.Message.decode(bytes).conversation !== 'from a packed install') {
  throw new Error('protobuf round trip failed');
}
const frame = ns.encodeBinaryNode({ tag: 'iq', attrs: { id: 'A1', type: 'result', to: 's.whatsapp.net' } });
const back = await ns.decodeBinaryNode(frame);
if (back.attrs.id !== 'A1') throw new Error('WABinary round trip failed: ' + JSON.stringify(back));

// The optional peers must be absent, not half-installed: this is the state a
// consumer is in when they did not ask for ffmpeg.
for (const optional of ['sharp', 'fluent-ffmpeg', 'jimp', 'audio-decode']) {
  let present = true;
  try { require.resolve(optional); } catch { present = false; }
  if (present) throw new Error('optional peer ' + optional + ' was pulled in transitively');
}

console.log(JSON.stringify({ exports: names.length, resolved }));
`;
	writeFileSync(join(scratch, 'probe.mjs'), probe);
	const out = execFileSync(process.execPath, [join(scratch, 'probe.mjs')], { encoding: 'utf8' });
	const { exports, resolved } = JSON.parse(out.trim());
	say(`imported from ${resolved.replace(scratch + '/', '')}`);
	say(`${exports} exports`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log('\nok — the published tarball contains what it should, omits what it should,');
console.log('     installs outside the repo, imports, and round-trips without the engine.');
