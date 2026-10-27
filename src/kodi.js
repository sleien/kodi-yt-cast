// A Kodi JSON-RPC client over WebSocket (Kodi's TCP port, 9090).
//
// Requests resolve with the result or reject with Kodi's error. Notifications
// (Player.OnPlay, Other.pair, ...) are emitted as 'notification' with
// (method, params). The connection is kept up: it reconnects with backoff,
// and requests made while it is down reject at once rather than queue, since
// a cast command that arrives late is worse than one that fails.

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
  #WebSocket;

  constructor(url, { minRetryMs = 1000, maxRetryMs = 30000, timeoutMs = 10000,
    WebSocketImpl = globalThis.WebSocket } = {}) {
    super();
    this.#url = url;
    this.#minRetryMs = minRetryMs;
    this.#maxRetryMs = maxRetryMs;
    this.#retryMs = minRetryMs;
    this.#timeoutMs = timeoutMs;
    this.#WebSocket = WebSocketImpl;
  }

  get connected() {
    return this.#socket !== null && this.#socket.readyState === 1;
  }

  connect() {
    if (this.#closed) return;
    const socket = new this.#WebSocket(this.#url);
    socket.addEventListener('open', () => {
      this.#socket = socket;
      this.#retryMs = this.#minRetryMs;
      this.emit('connect');
    });
    socket.addEventListener('message', (event) => this.#onMessage(event.data));
    socket.addEventListener('close', () => {
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
    });
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
