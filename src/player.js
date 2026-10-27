// The yt-cast-receiver Player, played by Kodi's YouTube add-on.
//
// Cast commands become Kodi JSON-RPC calls. Kodi's own notifications keep the
// phone in step when someone uses the TV remote, and advance the queue when a
// video ends.

import { Player, Constants } from 'yt-cast-receiver';

const { PLAYER_STATUSES } = Constants;

export const pluginUrl = (videoId) =>
  `plugin://plugin.video.youtube/play/?video_id=${encodeURIComponent(videoId)}`;

const toSeconds = (t) =>
  t ? t.hours * 3600 + t.minutes * 60 + t.seconds + t.milliseconds / 1000 : 0;

const toTime = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  return { hours: Math.floor(s / 3600), minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60, milliseconds: 0 };
};

export class KodiPlayer extends Player {
  #kodi;
  #volumeMode;
  #keyStep;
  #keyVolume = { level: 50, muted: false };
  #pendingSeek = 0;
  #stopping = false;
  #casting = false;

  // volumeMode 'kodi': Kodi's own volume. 'keys': Kodi's volume up/down actions,
  // which CEC forwards to a soundbar, one press per keyStep points of change.
  constructor(kodi, { volumeMode = 'kodi', keyStep = 5 } = {}) {
    super();
    this.#kodi = kodi;
    this.#volumeMode = volumeMode;
    this.#keyStep = keyStep;
    kodi.on('notification', (method, params) => {
      this.#onNotification(method, params).catch((e) =>
        this.logger.error('[kodi-yt-cast] handling', method, e));
    });
  }

  async #playerId() {
    const players = await this.#kodi.call('Player.GetActivePlayers');
    const video = players.find((p) => p.type === 'video') ?? players[0];
    return video ? video.playerid : null;
  }

  async doPlay(video, position) {
    this.#pendingSeek = position > 0 ? position : 0;
    this.#casting = true;
    const result = await this.#kodi.call('Player.Open',
      { item: { file: pluginUrl(video.id) } });
    return result === 'OK';
  }

  async #setSpeed(play) {
    const playerid = await this.#playerId();
    if (playerid === null) return false;
    await this.#kodi.call('Player.PlayPause', { playerid, play });
    return true;
  }

  doPause() {
    return this.#setSpeed(false);
  }

  doResume() {
    return this.#setSpeed(true);
  }

  async doStop() {
    this.#casting = false;
    const playerid = await this.#playerId();
    if (playerid === null) return true;
    this.#stopping = true;
    await this.#kodi.call('Player.Stop', { playerid });
    return true;
  }

  async doSeek(position) {
    const playerid = await this.#playerId();
    if (playerid === null) return false;
    await this.#kodi.call('Player.Seek', { playerid, value: { time: toTime(position) } });
    return true;
  }

  async doSetVolume(volume) {
    if (this.#volumeMode === 'keys') {
      if (volume.muted !== this.#keyVolume.muted) {
        await this.#kodi.call('Input.ExecuteAction', { action: 'mute' });
      }
      const diff = volume.level - this.#keyVolume.level;
      const presses = Math.min(10, Math.round(Math.abs(diff) / this.#keyStep));
      for (let i = 0; i < presses; i++) {
        await this.#kodi.call('Input.ExecuteAction',
          { action: diff > 0 ? 'volumeup' : 'volumedown' });
      }
      this.#keyVolume = { level: volume.level, muted: volume.muted };
      return true;
    }
    await this.#kodi.call('Application.SetVolume', { volume: Math.round(volume.level) });
    await this.#kodi.call('Application.SetMute', { mute: volume.muted });
    return true;
  }

  // The receiver also asks for volume, position and duration to report state,
  // including while Kodi is restarting; those reports must not fail.
  async doGetVolume() {
    if (this.#volumeMode === 'keys') return { ...this.#keyVolume };
    try {
      const p = await this.#kodi.call('Application.GetProperties',
        { properties: ['volume', 'muted'] });
      return { level: p.volume, muted: p.muted };
    } catch {
      return { level: 0, muted: false };
    }
  }

  async #properties() {
    try {
      const playerid = await this.#playerId();
      if (playerid === null) return null;
      return await this.#kodi.call('Player.GetProperties',
        { playerid, properties: ['time', 'totaltime'] });
    } catch {
      return null;
    }
  }

  async doGetPosition() {
    return toSeconds((await this.#properties())?.time);
  }

  async doGetDuration() {
    return toSeconds((await this.#properties())?.totaltime);
  }

  async #onNotification(method, params) {
    const status = this.status;
    switch (method) {
      case 'Player.OnAVStart':
        if (this.#casting && this.#pendingSeek > 0) {
          const position = this.#pendingSeek;
          this.#pendingSeek = 0;
          await this.doSeek(position);
        }
        break;
      case 'Player.OnPause':
        if (this.#casting && status === PLAYER_STATUSES.PLAYING) {
          await this.notifyExternalStateChange(PLAYER_STATUSES.PAUSED);
        }
        break;
      case 'Player.OnResume':
      case 'Player.OnPlay':
        if (this.#casting && status === PLAYER_STATUSES.PAUSED) {
          await this.notifyExternalStateChange(PLAYER_STATUSES.PLAYING);
        }
        break;
      case 'Player.OnStop':
        if (this.#stopping) {
          this.#stopping = false;
        } else if (this.#casting && params?.data?.end === true) {
          // The video played to its end: on to the next one in the queue.
          await this.pause();
          await this.next();
        } else if (this.#casting) {
          // Stopped on the TV, or replaced by something else played there.
          this.#casting = false;
          await this.notifyExternalStateChange(PLAYER_STATUSES.STOPPED);
        }
        break;
      default:
        break;
    }
  }
}
