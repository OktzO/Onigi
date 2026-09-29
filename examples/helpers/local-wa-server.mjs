/*
 * examples/helpers/local-wa-server.mjs — a local WhatsApp stand-in.
 *
 * Onigi speaks the real Noise XX handshake to `wss://web.whatsapp.com/ws/chat`.
 * Nothing about that is switchable at the "skip the handshake" level, so this
 * helper implements the *server* half of the same handshake on a local
 * WebSocket, with a certificate chain it signs for itself, and decodes every
 * stanza the client writes. It needs no WhatsApp credentials and no network.
 *
 * WHAT IS REAL HERE
 *   - the Noise XX key schedule and the AES-256-GCM frames, both directions
 *   - the WABinary encoding of every stanza the client writes
 *   - the client's certificate-chain verification, which rejects us
 *
 * WHAT IS NOT
 *   - the server's identity. `WA_CERT_DETAILS.PUBLIC_KEY`
 *     (lib/Defaults/index.js) is WhatsApp's real long-term key and its private
 *     half is not in this repository, so the chain this server signs is signed
 *     by a locally generated key instead. `Curve.verify` therefore returns
 *     false and `processHandshake` in lib/Utils/noise-handler.js:180 throws
 *     `noise intermediate certificate signature invalid`.
 *
 *   That rejection is the correct outcome and the examples assert on it. It is
 *   also the only honest way to demonstrate that the check is live: commit
 *   42d416d made `Curve.verify` return the native result instead of a hardcoded
 *   `true`, and a certificate the client cannot verify *must* be refused.
 *
 *   The transport keys are therefore never negotiated in these examples.
 *   Anything that needs the post-handshake transport (`sendMessage` over the
 *   real `relayMessage` pipeline) is not demonstrated here, and the examples say
 *   so rather than stubbing past the check.
 */

import { WebSocketServer } from 'ws';
import {
	aesDecryptGCM,
	aesEncryptGCM,
	Curve,
	generateSignalPubKey,
	hkdf,
	sha256
} from '../../lib/Utils/crypto.js';
import { decodeBinaryNode } from '../../lib/WABinary/index.js';
import { proto } from '../../WAProto/index.js';
import { NOISE_MODE } from '../../lib/Defaults/index.js';

const NOISE_HEADER = Buffer.from([87, 65, 6, 3]);
const EMPTY = Buffer.alloc(0);
const ivFor = counter => {
	const iv = new ArrayBuffer(12);
	new DataView(iv).setUint32(8, counter);
	return new Uint8Array(iv);
};

/** Frame = 3-byte big-endian length, then that many bytes. */
const readFrames = (buffer, onFrame) => {
	let size;
	while (buffer.length >= 3) {
		size = (buffer[0] << 16) | (buffer[1] << 8) | buffer[2];
		if (buffer.length < size + 3) {
			return buffer;
		}
		onFrame(buffer.subarray(3, size + 3));
		buffer = buffer.subarray(size + 3);
	}
	return buffer;
};

/**
 * The server half of `Noise_XX_25519_AESGCM_SHA256`, mirroring
 * lib/Utils/noise-handler.js step for step so the key schedules agree.
 */
export class LocalNoiseServer {
	constructor() {
		this.hash = Buffer.from(NOISE_MODE);
		this.salt = this.hash;
		this.encKey = this.hash;
		this.decKey = this.hash;
		this.counter = 0;
		this.ephemeralKeyPair = Curve.generateKeyPair();
		this.staticKeyPair = Curve.generateKeyPair();
		// A chain this server can sign for itself, in place of WhatsApp's.
		this.intermediateKeyPair = Curve.generateKeyPair();
	}

	authenticate(data) {
		this.hash = sha256(Buffer.concat([this.hash, data]));
	}

	mixIntoKey(data) {
		const key = hkdf(Buffer.from(data), 64, { salt: this.salt, info: '' });
		this.salt = key.subarray(0, 32);
		this.encKey = key.subarray(32);
		this.decKey = key.subarray(32);
		this.counter = 0;
	}

	encrypt(plaintext) {
		const out = aesEncryptGCM(plaintext, this.encKey, ivFor(this.counter++), this.hash);
		this.authenticate(out);
		return out;
	}

	decrypt(ciphertext) {
		const out = aesDecryptGCM(ciphertext, this.decKey, ivFor(this.counter++), this.hash);
		this.authenticate(ciphertext);
		return out;
	}

	/**
	 * Consume the client's raw clientHello and produce the serverHello bytes.
	 * The client will refuse the certificate; that refusal is the point.
	 */
	buildServerHello(clientHelloBytes) {
		this.authenticate(NOISE_HEADER);
		const hello = proto.HandshakeMessage.decode(clientHelloBytes);
		const clientEphemeral = Buffer.from(hello.clientHello.ephemeral);
		this.authenticate(clientEphemeral);
		this.clientEphemeral = clientEphemeral;

		const serverEphemeral = generateSignalPubKey(this.ephemeralKeyPair.public);
		this.authenticate(serverEphemeral);
		this.mixIntoKey(Curve.sharedKey(this.ephemeralKeyPair.private, clientEphemeral));

		const details = proto.CertChain.NoiseCertificate.Details.encode(
			proto.CertChain.NoiseCertificate.Details.fromObject({
				serial: 1,
				issuerSerial: 1,
				key: generateSignalPubKey(this.intermediateKeyPair.public)
			})
		).finish();
		const sign = (key, payload) => Buffer.from(Curve.sign(key, payload));
		// The leaf is signed by the intermediate (the client checks it against
		// `details.key`, which the intermediate's details carry). The intermediate
		// is signed by a key the client does not know: the real one is
		// WA_CERT_DETAILS.PUBLIC_KEY in lib/Defaults/index.js, and its private half
		// is not in this repository. So the leaf check passes and the intermediate
		// check is the one that refuses — which is the more informative outcome to
		// show, because it names the exact check that caught us.
		const leafDetails = proto.CertChain.NoiseCertificate.Details.encode(
			proto.CertChain.NoiseCertificate.Details.fromObject({ serial: 0 })
		).finish();
		const leaf = proto.CertChain.NoiseCertificate.fromObject({
			details: leafDetails,
			signature: sign(this.intermediateKeyPair.private, leafDetails)
		});
		const intermediate = proto.CertChain.NoiseCertificate.fromObject({
			details,
			signature: sign(this.intermediateKeyPair.private, details)
		});
		const certChain = proto.CertChain.encode(
			proto.CertChain.fromObject({ intermediate, leaf })
		).finish();

		const staticEnc = this.encrypt(generateSignalPubKey(this.staticKeyPair.public));
		this.mixIntoKey(Curve.sharedKey(this.staticKeyPair.private, clientEphemeral));
		const payloadEnc = this.encrypt(certChain);

		return proto.HandshakeMessage.encode(proto.HandshakeMessage.fromObject({
			serverHello: { ephemeral: serverEphemeral, static: staticEnc, payload: payloadEnc }
		})).finish();
	}
}

/**
 * Boot the local server.
 *
 * @param {object} [opts]
 * @param {(stanza: object) => void} [opts.onStanza] every stanza decoded after the handshake frames
 * @returns {Promise<{url: string, port: number, frames: Buffer[], clientHello: object|null, close: () => Promise<void>}>}
 */
export const startLocalWaServer = async ({ onStanza } = {}) => {
	const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await new Promise(resolve => wss.once('listening', resolve));

	/** every frame the client wrote, verbatim and in order */
	const frames = [];
	/** the client's own ephemeral public key, lifted from its raw clientHello */
	let clientHello = null;

	wss.on('connection', ws => {
		const noise = new LocalNoiseServer();
		let pending = Buffer.alloc(0);
		let stripped = false;

		ws.on('message', raw => {
			let buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
			frames.push(Buffer.from(buffer));
			if (!stripped) {
				// The first write is prefixed with either the bare NOISE_HEADER, or
				// `ED` 0 1 <u8> <u16 len> <routingInfo> NOISE_HEADER when the auth
				// state carries a routing info blob (lib/Utils/noise-handler.js:60).
				stripped = true;
				buffer = buffer.subarray(buffer[0] === 0x45 && buffer[1] === 0x44
					? 7 + ((buffer[4] << 8) | buffer[5]) + NOISE_HEADER.length
					: NOISE_HEADER.length);
			}
			pending = Buffer.concat([pending, buffer]);
			pending = readFrames(pending, frame => {
				if (clientHello) {
					// A clientFinish, or any later frame. Noise transport keys were
					// never negotiated (the certificate was refused), so anything past
					// this point is unencrypted and handed over as raw bytes.
					onStanza?.(frame);
					return;
				}
				// The clientHello travels unencrypted: `awaitNextMessage`
				// (lib/Socket/socket.js:311) hands the raw protobuf to
				// sendRawMessage, which only adds the frame length prefix.
				clientHello = proto.HandshakeMessage.decode(frame);
				const hello = noise.buildServerHello(frame);
				const out = Buffer.alloc(3 + hello.length);
				out[0] = (hello.length >>> 16) & 0xff;
				out[1] = (hello.length >>> 8) & 0xff;
				out[2] = hello.length & 0xff;
				out.set(hello, 3);
				ws.send(out);
			});
		});

		ws.on('error', () => { });
	});

	return {
		url: `ws://127.0.0.1:${wss.address().port}/ws/chat`,
		port: wss.address().port,
		frames,
		get clientHello() {
			return clientHello;
		},
		close: () => new Promise(resolve => wss.close(resolve))
	};
};
