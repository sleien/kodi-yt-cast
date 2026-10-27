import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { KodiClient } from '../src/kodi.js';

// A stand-in for Kodi's JSON-RPC WebSocket on a random local port.
async function fakeKodi(handler) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const req = JSON.parse(raw);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...handler(req) }));
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
