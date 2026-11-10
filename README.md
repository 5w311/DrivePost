# DriveTest

A self-hosted YouTube player for the Tesla browser that keeps playing after you shift out of Park, for passengers.

Tesla's browser pauses its built-in video player when the car leaves Park. DriveTest never uses that player. A small server at home converts the video to MPEG-1 as it plays, and the car page decodes it with [JSMpeg](https://github.com/phoboslab/jsmpeg) and draws it on a `<canvas>`, with sound through Web Audio. The [proof of concept](test/) confirmed that canvas playback keeps going in Drive.

## What it does

- **Car page:** search YouTube or paste a link, with Up Next, Recent, resume where you left off, ±10 s, a seek bar, 360p/480p/720p quality and a Theater layout.
- **Phone remote:** scan a QR code on the car screen to pair, no passcode needed. Search, paste links, reorder Up Next and control playback from your phone.
- **Share from any app:** use an iPhone Shortcut in the share sheet, or install the remote on Android so it appears in the share menu.
- **Handles bad signal:** the car keeps a few seconds buffered and feeds the decoder at real-time speed. Weak LTE causes a short buffering pause, not stutter, and a dropped connection reconnects at the same spot.
- **Private:** one passcode, devices stay signed in, and the iPhone Shortcut uses its own revocable token.

## How it works

```
Phone ──share/remote──┐
                      ▼
YouTube ─► yt-dlp ─► ffmpeg (MPEG-1 + MP2 in MPEG-TS) ─► server tags each ~0.2 s chunk
                                                          with its timestamp
                                                              │ WebSocket
                                                              ▼
                       Tesla browser: buffer ─► paced feed ─► JSMpeg ─► canvas + Web Audio
```

The server keeps about 25 seconds ahead of the car and pauses ffmpeg after that, so it never converts more than the car will use. Seeking restarts ffmpeg at the new spot. YouTube supports fast seeking, so that takes a couple of seconds.

## Requirements

- An always-on machine on your **home internet** with Docker: a Raspberry Pi 4/5 (64-bit OS), mini PC, NAS or PC. It has to be at home because YouTube blocks most cloud servers.
- About 0.85 / 1.4 / 2.7 Mbps of upload per car at 360p / 480p / 720p. The car uses the same amount of data: roughly 0.65 GB per hour at 480p.
- A way to reach it from the car over HTTPS. A Cloudflare Tunnel on your own domain is built in.

## Setup

1. Clone the repo onto the machine and create your settings:

   ```sh
   git clone https://github.com/5w311/DriveTest.git && cd DriveTest
   cp .env.example .env
   nano .env   # set DRIVE_PASSCODE and PUBLIC_URL
   ```

2. Create a tunnel. In the Cloudflare dashboard, go to Zero Trust → Networks → Tunnels and create a tunnel. Copy its token into `TUNNEL_TOKEN` in `.env`. Add a public hostname such as `drive.figari.dev` pointing at `http://drivetest:8080`.

3. Start it:

   ```sh
   docker compose --profile tunnel up -d --build
   ```

   Without the tunnel, `docker compose up -d --build` serves it on port 8080 of that machine.

4. In the car, open `https://drive.figari.dev`, enter the passcode, open **Recent** and tap **Play test pattern**. The pattern is generated on your server, so if it plays in Drive, the whole pipeline works without involving YouTube.

5. On your phone, tap **Phone** on the car screen and scan the code. Open **Setup & sharing** at the bottom of the remote to make the iPhone Shortcut.

## Updating

yt-dlp updates itself when the container starts and once a day. YouTube changes often, and old versions stop working. To update DriveTest itself:

```sh
git pull && docker compose --profile tunnel up -d --build
```

## Troubleshooting

| Symptom | Check |
|---|---|
| Test pattern plays, YouTube doesn't | Run `docker compose logs drivetest`. Usually yt-dlp needs updating (restart the container) or YouTube is blocking the request. Some videos (age-restricted, members-only) need a cookies file: put `cookies.txt` in the data volume and set `YTDLP_ARGS=--cookies /data/cookies.txt`. |
| Frequent buffering | Lower the quality, check the machine's upload speed, and check CPU use with `docker stats`. A Pi 4 should stay at 480p. |
| No sound | Tap the screen once. Browsers only allow sound after a tap. |
| Phone says "Car offline" | The car page isn't open, or the car is offline. |

## Notes

- A screen showing video in view of the driver while the car is moving is illegal in many places, including Florida (§316.303). This is built for passengers.
- YouTube's terms don't allow downloading videos outside their own apps. Keep this for your own use, not as a public service.
- Cloudflare's terms limit using its network mainly for video. A personal tunnel for one car is low volume, but if that's a concern, use a port forward with a reverse proxy such as Caddy instead.

## Project layout

```
server/src/      Node server: auth, state, yt-dlp, ffmpeg streaming, TS chunker
server/public/   Car page, phone remote, setup page, JSMpeg
server/test/     Unit tests (npm test)
test/            The original side-by-side Drive test page
```

JSMpeg is © Dominic Szablewski, MIT license (`JSMPEG-LICENSE.txt`).
