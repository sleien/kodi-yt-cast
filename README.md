# kodi-yt-cast

"Watch on TV" for Kodi. In the YouTube app on Android or iPhone, the cast
button lists the TV. The video then plays in Kodi through its YouTube add-on:
ad-free, and signed in if the add-on is. The phone stays the remote: play,
pause, seek, volume, and a queue that everyone on the Wi-Fi can add to.

Built on [yt-cast-receiver](https://github.com/patrickkfkan/yt-cast-receiver),
which speaks YouTube's cast (lounge) protocol and announces the receiver by
DIAL. This repository adds only the player, which drives Kodi over JSON-RPC.
It was written for the `kodi-yt-cast` stack in
[sleien/homelab](https://github.com/sleien/homelab), beside
[kodi-gbm](https://github.com/sleien/kodi-gbm).

## How it maps

| Phone | Kodi (JSON-RPC over WebSocket, port 9090) |
|---|---|
| play a video | `Player.Open` `plugin://plugin.video.youtube/play/?video_id=…`, then `Player.Seek` once the stream starts, if a position was given |
| pause / resume | `Player.PlayPause` |
| seek | `Player.Seek` |
| stop | `Player.Stop` |
| volume, `VOLUME_MODE=kodi` | `Application.SetVolume`, `Application.SetMute` |
| volume, `VOLUME_MODE=keys` | `Input.ExecuteAction` `volumeup`/`volumedown`/`mute`, one press per `VOLUME_KEY_STEP` points. Kodi forwards these over CEC to a TV or soundbar |

Kodi's notifications go back the other way:
- **Pausing or resuming on the TV remote** shows on the phone.
- **The end of a video** plays the next one in the queue.
- **Stopping on the TV, or playing something else there,** ends the cast.

## Running it

It needs the **host network**: DIAL's SSDP announcement is multicast, and a
Docker bridge does not carry it.

| Variable | Default | |
|---|---|---|
| `KODI_HOST`, `KODI_TCP_PORT` | `127.0.0.1`, `9090` | Kodi's JSON-RPC. Kodi needs "Allow remote control from applications on other systems" on |
| `TV_NAME` | `TV` | the name in the cast menu |
| `DIAL_PORT` | `8098` | DIAL's HTTP port; SSDP itself is 1900/udp |
| `DIAL_BIND_ADDRESS` | all | the one address to announce and answer on, such as the LAN address |
| `DATA_DIR` | `/data` | `store.json`: the receiver's identity, so phones find the same TV after a restart |
| `VOLUME_MODE` | `kodi` | `keys` once CEC carries volume to a soundbar |
| `VOLUME_KEY_STEP` | `5` | phone volume points per key press, in `keys` mode |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |

**"Link with TV code"** pairs a phone that is not on the same Wi-Fi, for
example over a VPN:
1. Run the Kodi builtin `NotifyAll(kodi-yt-cast,pair)`, for example from a
   favourite: `<favourite name="YouTube koppeln">NotifyAll(kodi-yt-cast,pair)</favourite>`.
2. The code shows on the TV for a minute, and in the log.
3. Enter it in the YouTube app: Settings → Watch on TV → Enter TV code.

## Development

```
npm ci
npm test
```

`test/player.test.js` drives the player against a fake Kodi;
`test/kodi.test.js` runs the JSON-RPC client against a local WebSocket server.
CI also starts the image and checks that DIAL answers with the configured
name.

**Known:** `npm audit` reports two moderate advisories, both in
yt-cast-receiver's own dependencies, with no fix that its version ranges
allow:
- `decode-uri-component` 0.2.2, through `query-string` 7
- `uuid` 9

The receiver answers only on the LAN.

**yt-cast-receiver calls itself work in progress.** YouTube can change the
protocol at any time. When casting breaks, sharing a video to a Kodi remote
app still works.
