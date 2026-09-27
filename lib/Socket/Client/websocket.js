import WebSocket from 'ws';
import { DEFAULT_ORIGIN } from '../../Defaults/index.js';
import { AbstractSocketClient } from './types.js';
export class WebSocketClient extends AbstractSocketClient {
    constructor() {
        super(...arguments);
        this.socket = null;
    }
    get isOpen() {
        return this.socket?.readyState === WebSocket.OPEN;
    }
    get isClosed() {
        return this.socket === null || this.socket?.readyState === WebSocket.CLOSED;
    }
    get isClosing() {
        return this.socket === null || this.socket?.readyState === WebSocket.CLOSING;
    }
    get isConnecting() {
        return this.socket?.readyState === WebSocket.CONNECTING;
    }
    connect() {
        if (this.socket) {
            return;
        }
        this.socket = new WebSocket(this.url, {
            origin: DEFAULT_ORIGIN,
            headers: this.config.options?.headers,
            handshakeTimeout: this.config.connectTimeoutMs,
            timeout: this.config.connectTimeoutMs,
            agent: this.config.agent
        });
        this.socket.setMaxListeners(50);
        const events = ['close', 'error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response'];
        for (const event of events) {
            this.socket?.on(event, (...args) => this.emit(event, ...args));
        }
        // a closed socket is not a socket: connect()'s guard reads the reference,
        // so keeping a CLOSED one around made every manual reconnect a silent
        // no-op -- no socket, no error, no log
        this.socket.on('close', () => {
            this.socket = null;
        });
    }
    async close() {
        const socket = this.socket;
        if (!socket) {
            return;
        }
        // a CLOSED socket will not emit 'close' again, so waiting on one blocks
        // for the full terminate fallback
        if (socket.readyState === WebSocket.CLOSED) {
            this.socket = null;
            return;
        }
        const closePromise = new Promise(resolve => {
            socket.once('close', resolve);
        });
        socket.close();
        // Server may never send a close frame (dead TCP) — force terminate after 5s.
        // The fallback handle has to go when the close wins: an uncancelled one
        // pins the host's event loop for 5s after the socket is already gone.
        let fallback;
        try {
            await Promise.race([
                closePromise,
                new Promise(resolve => {
                    fallback = setTimeout(() => {
                        socket.terminate();
                        resolve();
                    }, 5000);
                })
            ]);
        }
        finally {
            clearTimeout(fallback);
        }
        // only if connect() has not already put a live socket in its place
        if (this.socket === socket) {
            this.socket = null;
        }
    }
    send(str, cb) {
        this.socket?.send(str, cb);
        return Boolean(this.socket);
    }
}
//# sourceMappingURL=websocket.js.map