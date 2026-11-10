// A Kodi JSON-RPC client over WebSocket (Kodi's TCP port, 9090).
//
// Requests resolve with the result or reject with Kodi's error. Notifications
// (Player.OnPlay, Other.pair, ...) are emitted as 'notification' with
// (method, params). The connection is kept up: it reconnects with backoff,
// and requests made while it is down reject at once rather than queue, since
// a cast command that arrives late is worse than one that fails.
//
// A connection the socket itself never reports closed is given up too: a
// handshake that has not completed within timeoutMs, and an open connection
// that leaves a JSONRPC.Ping every heartbeatMs unanswered. While Kodi was
// away for a game, docker-proxy once took the TCP connection and never
// answered the handshake; the socket waited in CLOSE_WAIT for two days.

import { EventEmitter } from 'node:events';

export class KodiClient extends EventEmitter {
  #url;
  #socket = null;
  #nextId = 1;
  #pending = new Map();
  #closed = false;
  #retryMs;
  #minRetryMs;
  #maxRetryMs;
  #timeoutMs;
  #heartbeatMs;
  #WebSocket;

  constructor(url, { minRetryMs = 1000, maxRetryMs = 30000, timeoutMs = 10000,
    heartbeatMs = 30000, WebSocketImpl = globalThis.WebSocket } = {}) {
    super();
    this.#url = url;
    this.#minRetryMs = minRetryMs;
    this.#maxRetryMs = maxRetryMs;
    this.#retryMs = minRetryMs;
    this.#timeoutMs = timeoutMs;
    this.#heartbeatMs = heartbeatMs;
    this.#WebSocket = WebSocketImpl;
  }

  get connected() {
    return this.#socket !== null && this.#socket.readyState === 1;
  }

  connect() {
    if (this.#closed) return;
    const socket = new this.#WebSocket(this.#url);
    let heartbeat = null;
    let ended = false;
    // Runs once per socket, whether the socket closed or was given up on.
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(handshake);
      clearInterval(heartbeat);
      if (this.#socket === socket) this.#socket = null;
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(new Error('Kodi connection closed'));
      }
      this.#pending.clear();
      this.emit('disconnect');
      if (!this.#closed) {
        setTimeout(() => this.connect(), this.#retryMs);
        this.#retryMs = Math.min(this.#retryMs * 2, this.#maxRetryMs);
      }
    };
    const giveUp = () => {
      end();
      try {
        socket.close();
      } catch {
        // Closing a socket that never opened may throw; it is abandoned anyway.
      }
    };
    const handshake = setTimeout(giveUp, this.#timeoutMs);
    socket.addEventListener('open', () => {
      if (ended) return;
      clearTimeout(handshake);
      this.#socket = socket;
      this.#retryMs = this.#minRetryMs;
      heartbeat = setInterval(() => {
        // A failed call means no answer within timeoutMs, or already closed.
        this.call('JSONRPC.Ping').catch(() => {
          if (this.#socket === socket) giveUp();
        });
      }, this.#heartbeatMs);
      this.emit('connect');
    });
    socket.addEventListener('message', (event) => {
      if (!ended) this.#onMessage(event.data);
    });
    socket.addEventListener('close', end);
    // An error is always followed by close, which does the handling.
    socket.addEventListener('error', () => {});
  }

  close() {
    this.#closed = true;
    this.#socket?.close();
  }

  call(method, params = {}) {
    if (!this.connected) {
      return Promise.reject(new Error(`Kodi not connected (${method})`));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Kodi did not answer ${method}`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  #onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const { resolve, reject, timer } = this.#pending.get(msg.id);
      clearTimeout(timer);
      this.#pending.delete(msg.id);
      if (msg.error) reject(new Error(`Kodi: ${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      this.emit('notification', msg.method, msg.params ?? {});
    }
  }
}
