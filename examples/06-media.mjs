/*
 * examples/06-media.mjs — what works with no optional dependency, and what does not.
 *
 * Run: node examples/06-media.mjs
 *
 * The media helpers in lib/Utils/media-processor.js load their heavy
 * dependencies lazily, so a process that never touches media never pays for
 * them. This example shows both halves of that:
 *
 *   - `getMp4Duration` parses the MP4 `moov`/`mvhd` atoms directly. It needs
 *     nothing but node:buffer, and it is exercised here on a byte-exact MP4
 *     atom tree this example builds itself.
 *   - `resizeImage`, `convertToWhatsAppVideo`, `convertToOpusAudio` and
 *     `getVideoThumbnail` need `sharp` / `fluent-ffmpeg` / `audio-decode`,
 *     which are OPTIONAL peer dependencies. This example asserts that calling
 *     them without those packages throws an error naming the package to install,
 *     rather than an unresolved-import crash or a silent no-op.
 *
 * `probeMedia` uses `music-metadata`, which IS a hard dependency, so it runs —
 * on a synthetic file this example generates, since there is no media in the repo.
 */

import assert from 'node:assert/strict';
import {
	convertToOpusAudio,
	convertToWhatsAppVideo,
	getMp4Duration,
	getVideoThumbnail,
	probeMedia,
	resizeImage
} from '../lib/index.js';

const atom = (type, payload) => {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(payload.length + 8, 0);
	head.write(type, 4, 'ascii');
	return Buffer.concat([head, payload]);
};

const buildFtypOnly = () => atom('ftyp', Buffer.from('isomiso2avc1mp41', 'ascii'));

/**
 * A minimal but structurally valid MP4: ftyp + moov(mvhd) + mdat.
 * The mvhd declares a 1000 Hz timescale and a 7500-unit duration = 7.5 s.
 */
const buildMp4 = (timescale = 1000, duration = 7500) => {
	const ftyp = atom('ftyp', Buffer.concat([
		Buffer.from('isom', 'ascii'), Buffer.from([0, 0, 2, 0]),
		Buffer.from('isomiso2avc1mp41', 'ascii')
	]));
	// mvhd v0: version+flags(4) creation(4) modification(4) timescale(4) duration(4)
	const mvhd = atom('mvhd', Buffer.concat([
		Buffer.alloc(4),                        // version 0 + flags
		Buffer.alloc(4),                        // creation time
		Buffer.alloc(4),                        // modification time
		(() => { const b = Buffer.alloc(4); b.writeUInt32BE(timescale); return b; })(),
		(() => { const b = Buffer.alloc(4); b.writeUInt32BE(duration); return b; })(),
		Buffer.alloc(80)                        // rate, volume, matrix, next track id
	]));
	const moov = atom('moov', mvhd);
	const mdat = atom('mdat', Buffer.alloc(16));
	return Buffer.concat([ftyp, moov, mdat]);
};

const main = async () => {
	// --- getMp4Duration: no external tool, no optional dependency -------------------

	const mp4 = buildMp4();
	assert.equal(getMp4Duration(mp4), 7.5, '7500 units at a 1000 Hz timescale is 7.5 s');
	console.log('getMp4Duration: a 7.5 s MP4 reports', getMp4Duration(mp4), 'seconds');

	assert.equal(getMp4Duration(buildMp4(48000, 96000)), 2, 'the timescale is honoured, not assumed');
	console.log('getMp4Duration: 96000/48000 reports', getMp4Duration(buildMp4(48000, 96000)), 'seconds');

	// It is `silent: true` by default: a buffer that is not an MP4 yields 0
	// rather than throwing, because it runs on caller-supplied bytes.
	assert.equal(getMp4Duration(Buffer.from('definitely not an mp4')), 0);
	assert.equal(getMp4Duration(Buffer.alloc(4)), 0);
	assert.equal(getMp4Duration('not a buffer'), 0);
	// …and the strict mode still exists. Its message names which guard tripped:
	// too short to be a buffer at all, a walkable atom with a bad size, or a
	// well-formed tree with no mvhd in it.
	assert.throws(() => getMp4Duration(Buffer.alloc(4), { silent: false }), /Invalid buffer/);
	assert.throws(() => getMp4Duration(Buffer.alloc(64, 0x41), { silent: false }), /Invalid atom size/);
	// ftyp only, no moov: walkable, and nothing to find
	assert.throws(() => getMp4Duration(buildFtypOnly(), { silent: false }), /No mvhd found/);
	console.log('getMp4Duration: non-MP4 input yields 0 by default, throws with { silent: false }');

	// --- probeMedia: music-metadata is a hard dependency ----------------------------

	// A 1-second silent WAV, built here because the repo ships no media.
	const wav = (() => {
		const samples = 8000;
		const data = Buffer.alloc(samples * 2);
		const head = Buffer.alloc(44);
		head.write('RIFF', 0, 'ascii');
		head.writeUInt32LE(36 + data.length, 4);
		head.write('WAVE', 8, 'ascii');
		head.write('fmt ', 12, 'ascii');
		head.writeUInt32LE(16, 16);
		head.writeUInt16LE(1, 20);            // PCM
		head.writeUInt16LE(1, 22);            // mono
		head.writeUInt32LE(8000, 24);         // sample rate
		head.writeUInt32LE(16000, 28);        // byte rate
		head.writeUInt16LE(2, 32);            // block align
		head.writeUInt16LE(16, 34);           // bits per sample
		head.write('data', 36, 'ascii');
		head.writeUInt32LE(data.length, 40);
		return Buffer.concat([head, data]);
	})();
	const meta = await probeMedia(wav, 'audio/wav');
	assert.equal(typeof meta.duration, 'number', 'probeMedia reports a duration');
	assert.ok(meta.duration > 0.99 && meta.duration <= 1.01, `expected ~1 s, got ${meta.duration}`);
	console.log(`\nprobeMedia: 8000 samples at 8000 Hz reports ${meta.duration.toFixed(3)} s,` +
		` container ${meta.container}, codec ${meta.codec}`);

	// --- the optional-dependency contract --------------------------------------------

	// These four need packages that are optional peers. Whether they are present
	// depends on the install, so each is handled the same way: if the package is
	// there the call is attempted and the error is only acceptable if it is a
	// real media failure; if it is absent the error must name the package.
	const OPTIONAL = [
		['resizeImage', () => resizeImage(wav, { width: 8, height: 8 })],
		['convertToWhatsAppVideo', () => convertToWhatsAppVideo(wav)],
		['convertToOpusAudio', () => convertToOpusAudio(wav)],
		['getVideoThumbnail', () => getVideoThumbnail(wav, 0)]
	];
	const missing = [];
	for (const [name, call] of OPTIONAL) {
		try {
			await call();
			console.log(`${name}: ran (its optional dependency is installed)`);
		} catch (error) {
			// The message is the contract: it must name the package to install.
			assert.ok(
				/npm install (sharp|jimp|fluent-ffmpeg|audio-decode)/.test(error.message),
				`${name} threw an unexpected error: ${error.message}`
			);
			missing.push(`${name} -> ${/npm install [\w-]+/.exec(error.message)[0]}`);
		}
	}
	if (missing.length) {
		console.log('\noptional dependencies are not installed here, and the errors say so:');
		for (const line of missing) {
			console.log('  ' + line);
		}
		console.log('  This is the documented behaviour: a clear error naming the package,');
		console.log('  not an unresolved import and not a silent no-op.');
	}

	// Nothing above loaded sharp or ffmpeg into this process unless it was called
	// and found. That is the point of the lazy import: it is asserted by the fact
	// that this script runs at all in a tree with none of them installed.
};

await main();
console.log('\nok — the dependency-free paths work, and the optional ones fail legibly.');
