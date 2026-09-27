import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './helpers/ev-socket-harness.mjs';

/*
 * WebSocketClient.connect() was:
 *
 *     connect() {
 *         if (this.socket) { return; }
 *         this.socket = new WebSocket(this.url, {...});
 *         ...
 *     }
 *
 * but nothing ever cleared this.socket. After a drop the client is holding a
 * WebSocket whose readyState is 3 (CLOSED) -- isClosed === true, socket !==
 * null -- and the guard reads the reference, not the state, so every manual
 * reconnect is a silent no-op: no socket, no error, no log. The audit saw
 *
 *     isClosed=true socket!=null=true readyState=3
 *     connect() -> isOpen=false isConnecting=false newServerConns=0
 *
 * The contract: a closed socket is not a socket. The client drops the
 * reference when the close event lands, so the existing guard means what it
 * says, and connect() works again.
 */
const PRELUDE = `import { WebSocketServer } from 'ws';
import { WebSocketClient } from '/home/user/noddjs/Onigi/lib/Socket/Client/index.js';
import WebSocket from 'ws';

const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(res => wss.once('listening', res));
const url = 'ws://127.0.0.1:' + wss.address().port + '/ws/chat';
let conns = 0;
wss.on('connection', () => { conns++; });
const client = new WebSocketClient(new URL(url), { connectTimeoutMs: 5000 });
const opened = () => new Promise(res => client.once('open', res));
const closed = () => new Promise(res => client.once('close', res));
const settle = ms => new Promise(res => setTimeout(res, ms));
const state = c => 'isOpen=' + c.isOpen + ' isConnecting=' + c.isConnecting
	+ ' isClosed=' + c.isClosed + ' socketNull=' + (c.socket === null)
	+ ' readyState=' + (c.socket?.readyState ?? 'none');`;

test('connect() after a drop creates a new socket', async () => {
	const { code, stdout, stderr } = await runScenario(`
${PRELUDE}
client.connect();
await opened();
const rawClosed = new Promise(res => client.socket.once('close', res));
const clientClosed = closed();
client.socket.terminate();
await Promise.all([rawClosed, clientClosed]);
await settle(50);
console.log('beforeConnect ' + state(client));
console.log('beforeConnect conns=' + conns);
client.connect();
const raced = await Promise.race([opened().then(() => 'opened'), settle(2000).then(() => 'never-opened')]);
console.log('connectResult=' + raced);
console.log('afterConnect ' + state(client));
console.log('afterConnect conns=' + conns);
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	// the defect, as the audit saw it, was
	//   beforeConnect isOpen=false isConnecting=false isClosed=true
	//     socketNull=false readyState=3      <- a live-looking reference
	//   connectResult=never-opened  beforeConnect conns=1  afterConnect conns=1
	assert.match(stdout, /beforeConnect isOpen=false isConnecting=false isClosed=true socketNull=true readyState=none/);
	assert.match(stdout, /beforeConnect conns=1/);
	assert.match(stdout, /connectResult=opened/);
	assert.match(stdout, /afterConnect isOpen=true isConnecting=false/);
	assert.match(stdout, /afterConnect conns=2/);
});

test('a client drops the reference once the socket is closed', async () => {
	const { code, stdout, stderr } = await runScenario(`
${PRELUDE}
client.connect();
await opened();
client.socket.close();
await closed();
await settle(50);
console.log(state(client));
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	// isClosed already said true here (readyState 3), so only the reference was wrong
	assert.match(stdout, /isOpen=false isConnecting=false isClosed=true socketNull=true readyState=none/);
});

test('connect() while a socket is open is still a no-op', async () => {
	const { code, stdout, stderr } = await runScenario(`
${PRELUDE}
client.connect();
client.connect();
client.connect();
await opened();
await settle(100);
console.log(state(client));
console.log('conns=' + conns);
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /isOpen=true/);
	assert.match(stdout, /conns=1/, 'connect() must not stack sockets');
});

test('connect() while a socket is still connecting is still a no-op', async () => {
	const { code, stdout, stderr } = await runScenario(`
${PRELUDE}
client.connect();
const first = client.socket;
client.connect();
console.log('sameSocket=' + (client.socket === first));
await opened();
await settle(100);
console.log('conns=' + conns);
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /sameSocket=true/);
	assert.match(stdout, /conns=1/, 'connect() must not stack sockets');
});

test('a manual reconnect through makeWASocket reaches the server again', async () => {
	const { code, stdout, stderr } = await runScenario(`
const state = c => 'isOpen=' + c.isOpen + ' isConnecting=' + c.isConnecting
	+ ' isClosed=' + c.isClosed + ' socketNull=' + (c.socket === null);
const h = await startHarness();
const rawClosed = new Promise(res => h.sock.ws.socket.once('close', res));
const clientClosed = new Promise(res => h.sock.ws.once('close', res));
h.sock.ws.socket.close();
await Promise.all([rawClosed, clientClosed]);
await tick(50);
console.log('before ' + state(h.sock.ws));
h.sock.ws.connect();
const raced = await Promise.race([
	new Promise(res => h.sock.ws.once('open', res)).then(() => 'opened'),
	tick(2000).then(() => 'never-opened')
]);
console.log('connectResult=' + raced);
console.log('after isOpen=' + h.sock.ws.isOpen);
process.exit(0);
`);
	assert.equal(code, 0, stderr);
	assert.match(stdout, /before isOpen=false isConnecting=false isClosed=true/);
	assert.match(stdout, /connectResult=opened/);
	assert.match(stdout, /after isOpen=true/);
});
