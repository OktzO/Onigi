/*
 * docs/verify.mjs — the documentation's test suite.
 *
 * Run: npm run docs:verify
 *
 * Documentation rots silently. A code block that was correct when it was
 * written stops compiling the day a signature changes, and nothing notices
 * until a reader copies it. This script makes the docs fail instead:
 *
 *   1. every examples/*.mjs is executed as its own process
 *   2. every ```js run``` block in docs/*.md and README*.md is extracted and
 *      executed as its own process
 *
 * A block that is illustrative rather than runnable must say so — either a
 * different language tag or the literal marker `illustrative` in the info
 * string. There is no unmarked escape hatch: an unrecognised ```js``` block
 * fails the run. That is the whole point.
 *
 * A `run` block is a complete ES module. `import ... from 'onigis'` is
 * rewritten to this repository's lib/index.js, so the docs show the specifier
 * a consumer writes while running against the tree in front of them.
 * `onigis/lib/...` subpaths are rewritten the same way.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// pathToFileURL is used for the import rewrite below
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'onigi-docs-verify-'));
const LOGICAL_LANGUAGES = new Set(['js', 'javascript', 'mjs', 'node', 'ts', 'typescript']);
/** the info-string marker that opts a runnable-looking block out of execution */
const ILLUSTRATIVE = 'illustrative';
/** the info-string marker that opts a block in */
const RUNNABLE = 'run';

const failures = [];
let executed = 0;

const runOne = async (label, argv) => {
	process.stdout.write(`  ${label} … `);
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, argv, {
			cwd: root,
			timeout: 120_000,
			maxBuffer: 8 * 1024 * 1024,
			env: { ...process.env, NODE_NO_WARNINGS: '1' }
		});
		executed++;
		const lines = stdout.trim().split('\n').filter(Boolean);
		console.log(`ok${lines.length ? ` (${lines.length} lines of output)` : ''}`);
		if (stderr.trim() && process.env.DOCS_VERIFY_VERBOSE) {
			console.log(stderr.trim().split('\n').map(l => `      | ${l}`).join('\n'));
		}
		return true;
	} catch (error) {
		executed++;
		console.log('FAIL');
		failures.push({
			label,
			detail: [
				`command: ${process.execPath} ${argv.join(' ')}`,
				`exit:    ${error.code ?? error.signal ?? 'unknown'}`,
				'',
				(error.stdout || '').trim(),
				'',
				(error.stderr || String(error)).trim()
			].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n')
		});
		return false;
	}
};

// ---------------------------------------------------------------- examples

console.log('examples/');
const examplesDir = join(root, 'examples');
const exampleFiles = (await readdir(examplesDir))
	.filter(name => name.endsWith('.mjs') && !name.startsWith('helpers'))
	.sort();
if (exampleFiles.length === 0) {
	failures.push({ label: 'examples/', detail: 'no examples/*.mjs found' });
}
for (const name of exampleFiles) {
	await runOne(name, [join(examplesDir, name)]);
}

// ------------------------------------------------- runnable blocks in markdown

/**
 * Extract fenced blocks. Returns { info, code, line } per block, where `line`
 * is the 1-based line of the opening fence in the source file.
 */
const fencedBlocks = (markdown) => {
	const lines = markdown.split('\n');
	const blocks = [];
	for (let i = 0; i < lines.length; i++) {
		const open = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[i]);
		if (!open) {
			continue;
		}
		const marker = open[2][0];
		const length = open[2].length;
		const body = [];
		let j = i + 1;
		for (; j < lines.length; j++) {
			if (new RegExp(`^\\s*${marker}{${length},}\\s*$`).test(lines[j])) {
				break;
			}
			body.push(lines[j]);
		}
		blocks.push({ info: open[3].trim(), code: body.join('\n'), line: i + 1, closed: j < lines.length });
		i = j;
	}
	return blocks;
};

/** Rewrite the specifier a consumer writes into the path in this tree. */
const rewriteImports = (code) => code
	.replace(/(['"])onigis\/lib\//g, `$1${join(root, 'lib').replace(/\\/g, '\\\\')}/`)
	.replace(/(['"])onigis\1/g, `$1${pathToFileURL(join(root, 'lib', 'index.js')).href}$1`);

const markdownFiles = [
	...['README.md', 'README.id.md'],
	...(existsSync(join(root, 'docs')) ? (await readdir(join(root, 'docs')))
		.filter(name => name.endsWith('.md'))
		.map(name => join('docs', name)) : [])
];

for (const rel of markdownFiles) {
	const abs = join(root, rel);
	if (!existsSync(abs)) {
		continue;
	}
	const markdown = await readFile(abs, 'utf8');
	const blocks = fencedBlocks(markdown);
	const runnable = blocks.filter(b => b.info.split(/\s+/).includes(RUNNABLE));
	const illustrative = blocks.filter(b => b.info.split(/\s+/).includes(ILLUSTRATIVE));
	const unmarked = blocks.filter(b => {
		const language = b.info.split(/\s+/)[0];
		return LOGICAL_LANGUAGES.has(language) && !b.info.includes(RUNNABLE) && !b.info.includes(ILLUSTRATIVE);
	});

	console.log(`${rel}/`);
	if (blocks.length === 0) {
		console.log('  (no code blocks)');
	}
	for (const block of unmarked) {
		failures.push({
			label: `${rel}:${block.line}`,
			detail: [
				`an unmarked \`${block.info}\` block. docs:verify will not silently ignore a`,
				'runnable-looking block, and it will not guess either. Mark it:',
				'',
				'  ```js run          — a complete module that must execute',
				'  ```js illustrative  — shown for reading only, not executed',
				'',
				'If it should run, it needs imports and must not depend on a live server.'
			].join('\n')
		});
		console.log(`  line ${block.line}: UNMARKED \`${block.info}\` block`);
	}
	for (const block of runnable) {
		if (!block.closed) {
			failures.push({ label: `${rel}:${block.line}`, detail: 'unterminated code fence' });
			continue;
		}
		const code = rewriteImports(block.code.replace(/^\n+|\n+$/g, ''));
		const file = join(scratch, `block-${rel.replace(/[^\w.]+/g, '_')}-${block.line}.mjs`);
		await writeFile(file, `${code}\n`, 'utf8');
		await runOne(`${rel}:${block.line} (run)`, [file]);
	}
	if (runnable.length === 0 && illustrative.length === 0 && unmarked.length === 0 && blocks.length) {
		console.log(`  ${blocks.length} block(s), none in a language docs:verify can run`);
	}
	if (illustrative.length) {
		console.log(`  ${illustrative.length} block(s) marked illustrative (skipped)`);
	}
}

// ---------------------------------------------------------------- report

await rm(scratch, { recursive: true, force: true });

console.log('');
if (failures.length) {
	console.log(`docs:verify FAILED — ${failures.length} of ${executed + failures.length} checks\n`);
	for (const failure of failures) {
		console.log(`--- ${failure.label} ---`);
		console.log(failure.detail);
		console.log('');
	}
	process.exitCode = 1;
} else {
	console.log(`docs:verify passed — ${executed} executed, 0 failed.`);
}
