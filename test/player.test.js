import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Constants } from 'yt-cast-receiver';
import { KodiPlayer, pluginUrl } from '../src/player.js';

const { PLAYER_STATUSES } = Constants;

// Kodi as the player sees it: JSON-RPC calls recorded and answered, and
// notifications sent on demand.
class FakeKodi extends EventEmitter {
  calls = [];
  playing = false;
  volume = { volume: 40, muted: false };

  async call(method, params = {}) {
    this.calls.push([method, params]);
    switch (method) {
      case 'Player.Open': this.playing = true; return 'OK';
      case 'Player.GetActivePlayers': return this.playing ? [{ playerid: 1, type: 'video' }] : [];
      case 'Player.Stop': this.playing = false; return 'OK';
      case 'Player.GetProperties':
        return { time: { hours: 0, minutes: 1, seconds: 30, milliseconds: 500 },
          totaltime: { hours: 1, minutes: 0, seconds: 0, milliseconds: 0 } };
      case 'Application.GetProperties': return this.volume;
      default: return 'OK';
    }
  }

  notify(method, data = {}) {
    this.emit('notification', method, { sender: 'xbmc', data });
  }

  methods() {
    return this.calls.map(([m]) => m);
  }
}

const video = { id: 'dQw4w9WgXcQ', client: { key: 'YT' } };

// The receiver gives a player its logger; these tests have no receiver.
const silent = { error() {}, warn() {}, info() {}, debug() {}, setLevel() {} };
const newPlayer = (kodi, options) => {
  const player = new KodiPlayer(kodi, options);
  player.setLogger(silent);
  return player;
};
const tick = () => new Promise((r) => setImmediate(r));

test('a cast video plays through the YouTube add-on', async () => {
  const kodi = new FakeKodi();
  const player = newPlayer(kodi);
  assert.equal(await player.play(video), true);
  assert.deepEqual(kodi.calls.find(([m]) => m === 'Player.Open')[1],
    { item: { file: 'plugin://plugin.video.youtube/play/?video_id=dQw4w9WgXcQ' } });
  assert.equal(player.status, PLAYER_STATUSES.PLAYING);
});

test('video IDs are encoded into the plugin URL', () => {
  assert.equal(pluginUrl('a&b=c'), 'plugin://plugin.video.youtube/play/?video_id=a%26b%3Dc');
});

test('a start position is sought once Kodi has started the stream', async () => {
  const kodi = new FakeKodi();
  const player = newPlayer(kodi);
  await player.play(video, 3725);
  assert.ok(!kodi.methods().includes('Player.Seek'));
  kodi.notify('Player.OnAVStart');
  await tick();
  const seek = kodi.calls.find(([m]) => m === 'Player.Seek');
  assert.deepEqual(seek[1], { playerid: 1,
    value: { time: { hours: 1, minutes: 2, seconds: 5, milliseconds: 0 } } });
});

test('pause, resume and stop from the phone reach Kodi', async () => {
  const kodi = new FakeKodi();
  const player = newPlayer(kodi);
  await player.play(video);
  await player.pause();
  await player.resume();
  await player.stop();
  const ops = kodi.calls.filter(([m]) => ['Player.PlayPause', 'Player.Stop'].includes(m));
  assert.deepEqual(ops, [
    ['Player.PlayPause', { playerid: 1, play: false }],
    ['Player.PlayPause', { playerid: 1, play: true }],
    ['Player.Stop', { playerid: 1 }],
  ]);
});

test('position and duration come from Kodi, in seconds', async () => {
  const kodi = new FakeKodi();
  const player = newPlayer(kodi);
  await player.play(video);
  assert.equal(await player.getPosition(), 90.5);
  assert.equal(await player.getDuration(), 3600);
});

test('pausing on the TV remote is reported to the phone', async () => {
  const kodi = new FakeKodi();
  const player = newPlayer(kodi);
  await player.play(video);
  kodi.notify('Player.OnPause');
  await tick();
  assert.equal(player.status, PLAYER_STATUSES.PAUSED);
  kodi.notify('Player.OnResume');
  await tick();
  assert.equal(player.status, PLAYER_STATUSES.PLAYING);
});

test('the end of a video moves on to the next in the queue', async () => {
  const kodi = new FakeKodi();
  const player = newPlayer(kodi);
  let nexts = 0;
  player.next = async () => { nexts++; return true; };
  await player.play(video);
  kodi.notify('Player.OnStop', { end: true });
  await tick();
  assert.equal(nexts, 1);
});

test('stopping on the TV, or playing something else, ends the cast', async () => {
  const kodi = new FakeKodi();
  const player = newPlayer(kodi);
  let nexts = 0;
  player.next = async () => { nexts++; return true; };
  await player.play(video);
  kodi.notify('Player.OnStop', { end: false });
  await tick();
  assert.equal(player.status, PLAYER_STATUSES.STOPPED);
  assert.equal(nexts, 0);
  // Later playback in Kodi (a Jellyfin film) is none of the cast's business.
  kodi.notify('Player.OnStop', { end: true });
  kodi.notify('Player.OnPause');
  await tick();
  assert.equal(nexts, 0);
  assert.equal(player.status, PLAYER_STATUSES.STOPPED);
});

test('a stop sent from the phone is not mistaken for one on the TV', async () => {
  const kodi = new FakeKodi();
  const player = newPlayer(kodi);
  await player.play(video);
  await player.stop();
  kodi.notify('Player.OnStop', { end: false });
  await tick();
  assert.equal(player.status, PLAYER_STATUSES.STOPPED);
});

test('volume in kodi mode sets Kodi volume and mute', async () => {
  const kodi = new FakeKodi();
  const player = newPlayer(kodi);
  await player.setVolume({ level: 70, muted: false });
  assert.deepEqual(kodi.calls.filter(([m]) => m.startsWith('Application.Set')), [
    ['Application.SetVolume', { volume: 70 }],
    ['Application.SetMute', { mute: false }],
  ]);
  assert.deepEqual(await player.getVolume(), { level: 40, muted: false });
});

test('volume in keys mode presses volume up/down, for CEC to forward', async () => {
  const kodi = new FakeKodi();
  const player = newPlayer(kodi, { volumeMode: 'keys', keyStep: 5 });
  await player.setVolume({ level: 65, muted: false });   // 50 -> 65: three presses up
  await player.setVolume({ level: 55, muted: true });    // two down, and mute
  const actions = kodi.calls.filter(([m]) => m === 'Input.ExecuteAction').map(([, p]) => p.action);
  assert.deepEqual(actions, ['volumeup', 'volumeup', 'volumeup', 'mute', 'volumedown', 'volumedown']);
  assert.deepEqual(await player.getVolume(), { level: 55, muted: true });
  assert.ok(!kodi.methods().includes('Application.SetVolume'));
});

test('state reports survive Kodi being away', async () => {
  const kodi = new FakeKodi();
  kodi.call = async (method) => { throw new Error(`Kodi not connected (${method})`); };
  const player = newPlayer(kodi);
  assert.equal(await player.getPosition(), 0);
  assert.equal(await player.getDuration(), 0);
  assert.deepEqual(await player.getVolume(), { level: 0, muted: false });
});
