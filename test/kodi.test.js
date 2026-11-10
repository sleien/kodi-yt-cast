import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { KodiClient } from '../src/kodi.js';

// A stand-in for Kodi's JSON-RPC WebSocket on a random local port.
async function fakeKodi(handler) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const req = JSON.parse(raw);
      // A handler that returns nothing leaves the request unanswered.
      const reply = handler(req);
      if (reply) socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...reply }));
    });
  });
  const url = `ws://127.0.0.1:${server.address().port}/jsonrpc`;
  return { server, url };
}

test('requests resolve with the result, errors reject', async () => {
  const { server, url } = await fakeKodi((req) =>
    req.method === 'JSONRPC.Ping' ? { result: 'pong' }
      : { error: { code: -32601, message: 'Method not found.' } });
  const kodi = new KodiClient(url);
  kodi.connect();
  await once(kodi, 'connect');
  assert.equal(await kodi.call('JSONRPC.Ping'), 'pong');
  await assert.rejects(kodi.call('Nope.Nope'), /Method not found/);
  kodi.close();
  server.close();
});

test('notifications are emitted', async () => {
  const { server, url } = await fakeKodi(() => ({ result: 'OK' }));
  const kodi = new KodiClient(url);
  kodi.connect();
  await once(kodi, 'connect');
  const [socket] = server.clients;
  socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'Other.pair',
    params: { sender: 'kodi-yt-cast', data: null } }));
  const [method, params] = await once(kodi, 'notification');
  assert.equal(method, 'Other.pair');
  assert.equal(params.sender, 'kodi-yt-cast');
  kodi.close();
  server.close();
});

test('calls fail at once while Kodi is away, and the client reconnects', async () => {
  const { server, url } = await fakeKodi(() => ({ result: 'pong' }));
  const kodi = new KodiClient(url, { minRetryMs: 20 });
  kodi.connect();
  await once(kodi, 'connect');
  for (const socket of server.clients) socket.terminate();
  await once(kodi, 'disconnect');
  await assert.rejects(kodi.call('JSONRPC.Ping'), /not connected/);
  await once(kodi, 'connect');
  assert.equal(await kodi.call('JSONRPC.Ping'), 'pong');
  kodi.close();
  server.close();
});

// What docker-proxy did on 2026-11-08 while Kodi was away for a game: took
// the TCP connection and never answered the WebSocket handshake. The client
// sat in CLOSE_WAIT for two days and casting failed with "Kodi not connected".
test('a handshake that never completes is given up, and retried', async () => {
  let attempts = 0;
  const server = net.createServer((socket) => {
    attempts++;
    if (attempts === 1) socket.end(); // half-closes without an answer
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const kodi = new KodiClient(`ws://127.0.0.1:${server.address().port}/jsonrpc`,
    { minRetryMs: 20, timeoutMs: 100 });
  kodi.connect();
  await once(kodi, 'disconnect');
  await once(kodi, 'disconnect');
  assert.ok(attempts >= 2, `attempts: ${attempts}`);
  kodi.close();
  server.close();
});

test('a connection that stops answering pings is dropped and reconnected', async () => {
  let answer = true;
  const { server, url } = await fakeKodi(() => (answer ? { result: 'pong' } : null));
  const kodi = new KodiClient(url, { minRetryMs: 20, timeoutMs: 100, heartbeatMs: 50 });
  kodi.connect();
  await once(kodi, 'connect');
  answer = false;
  await once(kodi, 'disconnect');
  answer = true;
  await once(kodi, 'connect');
  assert.equal(await kodi.call('JSONRPC.Ping'), 'pong');
  kodi.close();
  server.close();
});
