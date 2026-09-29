/*
 * docs/verify.mjs — the documentation's test suite.
 *
 * Run: npm run docs:verify
 *
 * Prose about an API rots silently. The signature in the paragraph stops
 * matching the function, the example keeps "working" because nobody ran it,
 * and the README ends up describing a package that no longer exists. This
 * script makes the documentation fail instead.
 *
 * What it does, for README.md, CHANGELOG.md and every .md under docs:
 *
 *   1. Extracts every fenced code block, with its info string and its line.
 *   2. Classifies it. A block is RUN when its info string names a JavaScript
 *      dialect (`js`, `javascript`, `mjs`, `node`) and carries the `run`
 *      marker. It is SKIPPED when it carries `illustrative`, or when the
 *      language is not a JavaScript dialect (`bash`, `json`, `rust`, `text`).
 *      An *untagged* fence is an error, not a skip: it is the one shape that
 *      could be JavaScript and is not claiming to be.
 *   3. An *unmarked* JavaScript-dialect block is also a hard failure. There is
 *      no silent escape hatch: a `js` block that is neither run nor
 *      illustrative fails the run, because that is exactly the block that
 *      quietly goes stale. Marking it is a one-word edit; a stale example is
 *      not.
 *   4. Writes each runnable block to a dot-prefixed .mjs file *next to the .md
 *      it came from*, so the relative specifier a reader would type
 *      (`../index.cjs` from docs/, `./index.cjs` from the README) resolves
 *      exactly as written, and runs it with node.
 *   5. Runs every .mjs under examples/ the same way.
 *   6. Prints each block's stdout indented under its source location, so a
 *      reader sees what the example actually did.
 *
 * A runnable block is held to the same bar as a test: it must exit 0. There is
 * no "warn and continue" path, because a failing example that does not fail
 * the build is the exact problem this script exists to remove.
 *
 * A `run` block is a complete ES module that names the package the way a
 * consumer would:
 *
 *     import { createRequire } from 'node:module';
 *     const require = createRequire(import.meta.url);
 *     const curve = require('oktz-curve25519');
 *
 * Before it runs, the verifier rewrites that one specifier to this directory's
 * own `index.cjs`. This is not cosmetic. An enclosing repository that depends
 * on the *published* package has `node_modules/oktz-curve25519` in scope, and
 * without the rewrite every block would silently exercise the published
 * linux-x64-only artifact — the one this README's first section is about —
 * instead of the source it documents. `oktz-signal` is deliberately NOT
 * rewritten: the cross-implementation blocks are only meaningful against the
 * real installed one, and they skip when it does not resolve.
 *
 * Every block therefore needs the native binding to load, which is why
 * `docs:verify` runs in the same CI leg as the JS test suite and on the same
 * leg — the one built for the host.
 *
 * Usage:
 *   node docs/verify.mjs                  verify README.md, CHANGELOG.md, docs/, examples/
 *   node docs/verify.mjs docs             verify one path
 *   node docs/verify.mjs --quiet          only the summary and failures
 *   DOCS_VERIFY_VERBOSE=1                 print stderr from passing blocks too
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The entry point a `run` block is documented against. */
const entry = join(root, 'index.cjs');

/** Info strings whose first token means "this is JavaScript". */
const RUNNABLE = new Set(['js', 'javascript', 'mjs', 'node']);
/** Markers in the info string, after the language. */
const RUN = 'run';
const ILLUSTRATIVE = 'illustrative';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const targets = args.filter((a) => !a.startsWith('-'));
const DEFAULT_SOURCES = ['README.md', 'CHANGELOG.md', 'docs', 'examples'];

const walk = (path, out = []) => {
	let st;
	try {
		st = statSync(path);
	} catch {
		return out;
	}
	if (st.isDirectory()) {
		for (const entry of readdirSync(path).sort()) {
			walk(join(path, entry), out);
		}
	} else {
		out.push(path);
	}
	return out;
};

/**
 * Line-based fence scan. A regex over the whole file cannot tell an opening
 * fence from a closing one that happens to carry an info string, and it cannot
 * report a line number without a second pass; walking lines once does both and
 * keeps the line numbers the error messages quote. ``` fences only.
 */
const extract = (file) => {
	const lines = readFileSync(file, 'utf8').split('\n');
	const blocks = [];
	let open = null;
	lines.forEach((line, i) => {
		const fence = /^(\s*)```(.*)$/.exec(line);
		if (!fence) {
			if (open) {
				open.lines.push(line);
			}
			return;
		}
		if (open) {
			open = null; // closing fence; an info string here is ignored
			return;
		}
		open = { info: fence[2].trim(), line: i + 1, lines: [] };
		blocks.push(open);
	});
	if (open) {
		blocks.push({ ...open, unterminated: true });
	}
	return blocks.map(({ info, line, lines: body, unterminated }) => ({
		info,
		line,
		unterminated,
		body: `${body.join('\n').replace(/^\n+|\n+$/g, '')}\n`
	}));
};

/** @returns {'run'|'skip'|'error'} */
const classify = (info) => {
	const tokens = info.split(/\s+/);
	if (tokens.includes(ILLUSTRATIVE)) {
		return 'skip';
	}
	if (tokens.includes(RUN)) {
		return RUNNABLE.has(tokens[0]) ? 'run' : 'error';
	}
	// An untagged fence could be JavaScript and is not saying. Same bar as an
	// unmarked `js` block: it has to be told what it is.
	if (tokens[0] === '') {
		return 'error';
	}
	return RUNNABLE.has(tokens[0]) ? 'error' : 'skip';
};

/**
 * Point the documented package specifier at this tree, leaving every other
 * specifier alone. Only the exact bare specifier is rewritten, so a block that
 * deliberately reaches the installed package (there are none) still can.
 */
const rewriteImports = (code) => code
	.replace(/(['"])oktz-curve25519\1/g, `$1${entry.replace(/\\/g, '\\\\')}$1`);

const indent = (text) => text.split('\n').map((l) => (l ? `      │ ${l}` : '      │')).join('\n');

const runNode = (file) => spawnSync(process.execPath, [file], {
	cwd: root,
	encoding: 'utf8',
	timeout: 120_000,
	env: { ...process.env, NODE_NO_WARNINGS: '1' }
});

let ran = 0;
let examples = 0;
let skipped = 0;
const failures = [];
const notes = [];

const say = (line) => {
	if (!quiet) {
		process.stdout.write(`${line}\n`);
	}
};

const fail = (label, detail) => {
	failures.push({ label, detail });
};

const emit = (label, result) => {
	if (result.status === 0) {
		say(`  run   ${label}`);
		if (result.stdout && result.stdout.trim()) {
			say(indent(result.stdout.trimEnd()));
		}
		if (process.env.DOCS_VERIFY_VERBOSE && result.stderr && result.stderr.trim()) {
			say(indent(result.stderr.trimEnd()));
		}
		return;
	}
	say(`  FAIL  ${label}`);
	fail(label, `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() || 'no output');
};

// ---------------------------------------------------------------- markdown

const markdownFiles = (targets.length ? targets : DEFAULT_SOURCES)
	.flatMap((t) => walk(resolve(root, t)))
	.filter((f) => extname(f) === '.md');

const exampleDir = resolve(root, 'examples');
const exampleFiles = (!targets.length || targets.some((t) => resolve(root, t) === exampleDir))
	? walk(exampleDir).filter((f) => extname(f) === '.mjs')
	: [];

// Bailing on "no markdown" alone would be a trap: `node docs/verify.mjs
// examples` is a reasonable thing to type, and a broken example under it would
// have been skipped while the run still exited 0. Only a run with nothing at
// all to do is an error.
if (markdownFiles.length === 0 && exampleFiles.length === 0) {
	process.stderr.write('docs:verify found nothing to check — pass a path\n');
	process.exit(1);
}

for (const file of markdownFiles) {
	const rel = relative(root, file);
	for (const block of extract(file)) {
		const kind = classify(block.info);
		const label = `${rel}:${block.line}`;
		if (kind === 'skip') {
			skipped += 1;
			notes.push(`${label}  skipped (${block.info || 'no language'})`);
			continue;
		}
		if (block.unterminated) {
			fail(label, 'the fence opened here is never closed with a bare ``` line');
			say(`  FAIL  ${label}  (unterminated fence)`);
			continue;
		}
		if (kind === 'error') {
			fail(
				label,
				[
					block.info === ''
						? 'unmarked code block with an empty info string. It could be JavaScript.'
						: `unmarked JavaScript block with info string ${JSON.stringify(block.info)}.`,
					'docs:verify will not silently ignore a runnable-looking block, and it',
					'will not guess either. Mark it:',
					'',
					'  ```js run           a complete module that must execute',
					'  ```js illustrative  shown for reading only, not executed',
					'  ```text             output, not code',
					'',
					'If it should run it needs the createRequire idiom and a built native',
					'binding, or it will not.'
				].join('\n')
			);
			say(`  FAIL  ${label}  (unmarked \`${block.info || 'no language'}\`)`);
			continue;
		}

		// Same directory as the .md, so `../index.cjs` resolves the way a
		// reader running the file would see it. Dot-prefixed so a stray file
		// left by a killed run is not mistaken for a real example.
		const tmp = join(dirname(file), `.docs-verify.${basename(file, '.md')}.${block.line}.mjs`);
		writeFileSync(tmp, rewriteImports(block.body), 'utf8');
		let result;
		try {
			result = runNode(tmp);
		} finally {
			rmSync(tmp, { force: true });
		}
		ran += 1;
		emit(label, result);
	}
}

// --------------------------------------------------------------- examples

for (const file of exampleFiles) {
	examples += 1;
	emit(relative(root, file), runNode(file));
}

// ----------------------------------------------------------------- report

process.stdout.write('\n');
if (!quiet) {
	for (const note of notes) {
		process.stdout.write(`  note  ${note}\n`);
	}
	if (notes.length) {
		process.stdout.write('\n');
	}
}
process.stdout.write(
	`docs:verify  ${ran} code block(s) executed, ${examples} example(s) executed, `
	+ `${skipped} not executed, ${failures.length} failure(s)\n`
);

if (failures.length) {
	process.stderr.write('\n');
	for (const { label, detail } of failures) {
		process.stderr.write(`FAIL ${label}\n${indent(detail)}\n\n`);
	}
	process.exit(1);
}
