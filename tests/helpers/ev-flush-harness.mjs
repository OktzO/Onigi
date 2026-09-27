import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeEventBuffer } from '../../lib/Utils/event-buffer.js';

const execFileAsync = promisify(execFile);

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const upsert = id => ({
	messages: [{ key: { remoteJid: '1@s', id, fromMe: false }, message: { conversation: id } }],
	type: 'notify'
});

/**
 * A logger whose debug() throws the first time flush() logs its { bufferCount }
 * line -- the same trigger tests/crash-53-flush-guards.test.mjs uses. flush()
 * logs before it emits anything, so this reaches the deferred flush paths with
 * no user handler and no user event involved. `arm()` re-arms it for tests that
 * want more than one failure.
 */
export const flushBoomLogger = (onBoom) => {
	const logger = {
		armed: true,
		debug: (obj) => {
			if (logger.armed && obj && typeof obj === 'object' && 'bufferCount' in obj) {
				logger.armed = false;
				throw new Error('logger.debug is broken');
			}
		},
		trace() { },
		warn() { },
		error: (...args) => onBoom(args[0]?.err?.message ?? 'logged')
	};
	return logger;
};

/**
 * makeEventBuffer plus the two sinks a flush failure has to reach: the buffer's
 * own 'error' event and the events that were released anyway.
 */
export const makeProbe = ({ logger } = {}) => {
	const seen = [];
	const released = [];
	const ev = makeEventBuffer(logger || flushBoomLogger(() => { }));
	ev.on('error', (err, events) => seen.push(err.message + '|' + events.join(',')));
	ev.on('messages.upsert', ({ messages }) => released.push(messages.map(m => m.message.conversation).join(',')));
	return { ev, seen, released };
};

export const report = (probe) => {
	process.stdout.write('seen=' + JSON.stringify(probe.seen) + '\n');
	process.stdout.write('released=' + JSON.stringify(probe.released) + '\n');
	process.stdout.write('survived\n');
};

/**
 * Runs `body` with the probe in scope and reports the raw exit outcome. The
 * uncaught-exception class of bug is a process-level event, so the only faithful
 * assertion is the child's exit code -- an in-process listener would suppress
 * the very default under test.
 */
export const runChild = async body => {
	const prelude = `import { makeProbe, flushBoomLogger, upsert, sleep, report } from ${JSON.stringify(new URL(import.meta.url).href)};
const probe = makeProbe({ logger: flushBoomLogger(m => { process.stderr.write('LOGGED ' + m + '\\n'); }) });
const { ev, seen, released } = probe;
`;
	const script = prelude + body + '\nreport(probe);\nprocess.exit(0);\n';
	try {
		const { stdout, stderr } = await execFileAsync(
			process.execPath,
			['--input-type=module', '-e', script],
			{ timeout: 60000, maxBuffer: 4 * 1024 * 1024 }
		);
		return { code: 0, stdout, stderr };
	}
	catch (err) {
		return { code: err.code ?? err.signal ?? 'error', stdout: err.stdout || '', stderr: err.stderr || String(err) };
	}
};
