// "Watch on TV" for Kodi: appears in the YouTube app's cast menu and plays
// what is cast through Kodi's YouTube add-on.
//
// Environment:
//   KODI_HOST, KODI_TCP_PORT   Kodi's JSON-RPC WebSocket (default 127.0.0.1:9090)
//   TV_NAME                    name in the cast menu (default "TV")
//   DIAL_PORT                  DIAL HTTP port (default 8098)
//   DIAL_BIND_ADDRESS          address DIAL answers on (default: all)
//   DATA_DIR                   where the pairing state lives (default /data)
//   VOLUME_MODE                kodi | keys (default kodi; see player.js)
//   VOLUME_KEY_STEP            points of volume per key press (default 5)
//   LOG_LEVEL                  error | warn | info | debug (default info)
//
// "Link with TV code" pairing: run the Kodi builtin
// NotifyAll(kodi-yt-cast,pair), for example from a favourite. The code is shown
// on the TV and logged.

import YouTubeCastReceiver from 'yt-cast-receiver';
import { join } from 'node:path';
import { KodiClient } from './kodi.js';
import { KodiPlayer } from './player.js';
import { FileDataStore } from './store.js';

const env = process.env;
const kodiUrl = `ws://${env.KODI_HOST ?? '127.0.0.1'}:${env.KODI_TCP_PORT ?? '9090'}/jsonrpc`;

const kodi = new KodiClient(kodiUrl);
const player = new KodiPlayer(kodi, {
  volumeMode: env.VOLUME_MODE === 'keys' ? 'keys' : 'kodi',
  keyStep: Number(env.VOLUME_KEY_STEP ?? 5),
});

const name = env.TV_NAME ?? 'TV';
const receiver = new YouTubeCastReceiver(player, {
  device: { name, screenName: name, brand: 'Kodi', model: 'kodi-yt-cast' },
  dial: {
    port: Number(env.DIAL_PORT ?? 8098),
    ...(env.DIAL_BIND_ADDRESS ? { bindToAddresses: [env.DIAL_BIND_ADDRESS] } : {}),
  },
  dataStore: new FileDataStore(join(env.DATA_DIR ?? '/data', 'store.json')),
  logLevel: env.LOG_LEVEL ?? 'info',
});

const log = receiver.logger;

kodi.on('connect', () => log.info(`[kodi-yt-cast] connected to Kodi at ${kodiUrl}`));
kodi.on('disconnect', () => log.warn('[kodi-yt-cast] lost Kodi; reconnecting'));

const formatCode = (code) => String(code).replace(/(\d{3})(?=\d)/g, '$1 ');

kodi.on('notification', (method, params) => {
  if (method !== 'Other.pair' || params?.sender !== 'kodi-yt-cast') return;
  const service = receiver.getPairingCodeRequestService();
  service.once('response', (code) => {
    service.stop();
    log.info(`[kodi-yt-cast] TV code: ${formatCode(code)}`);
    kodi.call('GUI.ShowNotification', {
      title: 'YouTube: Link with TV code',
      message: formatCode(code),
      displaytime: 60000,
    }).catch((e) => log.warn('[kodi-yt-cast] could not show the code', e));
  });
  service.once('error', (e) => log.error('[kodi-yt-cast] pairing code failed', e));
  service.start();
});

receiver.on('senderConnect', (s) => log.info(`[kodi-yt-cast] connected: ${s.name ?? s.id}`));
receiver.on('senderDisconnect', (s) => log.info(`[kodi-yt-cast] disconnected: ${s.name ?? s.id}`));
receiver.on('error', (e) => log.error('[kodi-yt-cast] receiver error', e));
receiver.on('terminate', (e) => {
  log.error('[kodi-yt-cast] receiver terminated', e);
  process.exit(1);
});

const shutdown = async () => {
  kodi.close();
  await receiver.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

kodi.connect();
await receiver.start();
log.info(`[kodi-yt-cast] "${name}" is in the cast menu, DIAL on port ${env.DIAL_PORT ?? 8098}`);
