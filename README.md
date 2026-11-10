# DriveTest

A self-hosted YouTube player for the Tesla browser that keeps playing after you shift out of Park, for passengers.

Tesla's browser pauses its built-in video player when the car leaves Park. DriveTest never uses that player. A small server at home converts the video to MPEG-1 as it plays, and the car page decodes it with [JSMpeg](https://github.com/phoboslab/jsmpeg) and draws it on a `<canvas>`, with sound through Web Audio. The [proof of concept](test/) confirmed that canvas playback keeps going in Drive.

## What it does

- **Car page:** search YouTube or paste a link, with Up Next, Recent, resume where you left off, ±10 s, a seek bar and 360p to 1080p quality.
- **Fullscreen:** the video fills the whole browser window while something plays, with controls on tap. **Fill** zooms the picture to cover the window, and **Fit** shows all of it. When nothing is playing, the normal page comes back so you can search. The phone can switch it too.
- **Phone remote:** scan a QR code on the car screen to pair, no passcode needed. Search, paste links, reorder Up Next and control playback from your phone.
- **Share from any app:** use an iPhone Shortcut in the share sheet, or install the remote on Android so it appears in the share menu.
- **Smooth playback:** the car runs its own clock. Each frame is shown at its timestamp and sound is scheduled against the same clock, so motion is even and lips stay in sync. Films keep their 24 fps.
- **Handles bad signal:** the car keeps up to 25 seconds buffered. If it runs out, picture and sound freeze together and carry on without a gap. A dropped connection reconnects at the same spot.
- **Steps down by itself:** if the screen can't decode fast enough, or the connection keeps running dry, the car drops one quality level for that video and says why. The next video starts at your chosen quality again.
- **Stats readout:** tap **Stats** under the video to see resolution, decode time, buffer, data rate and how fast your server is converting.
- **Private:** one passcode, devices stay signed in, and the iPhone Shortcut uses its own revocable token.

## How it works

```
Phone ──share/remote──┐
                      ▼
YouTube ─► yt-dlp ─► ffmpeg (MPEG-1 + MP2 in MPEG-TS) ─► server splits it into single video
                                                          frames and short audio runs, each
                                                          tagged with its timestamp
                                                              │ WebSocket
                                                              ▼
              Tesla browser: buffer ─► own clock ─► JSMpeg decode ─► canvas + Web Audio
```

The server keeps about 25 seconds ahead of the car and pauses ffmpeg after that, so it never converts more than the car will use. Seeking restarts ffmpeg at the new spot. YouTube supports fast seeking, so that takes a couple of seconds. The video that's next in line is looked up ahead of time, so it starts faster.

In the car, JSMpeg only decodes and draws. The page decides when: a frame is decoded just before its timestamp comes up, and audio is queued on the sound card half a second ahead at the matching time. That keeps playback even when data arrives in bursts or the browser repaints slowly.

## Requirements

- An always-on machine on your **home internet** with Docker: a Raspberry Pi 4/5 (64-bit OS), mini PC, NAS or PC. It has to be at home because YouTube blocks most cloud servers.
- Enough upload at home, and data in the car, for the quality you pick:

  | Quality | Data rate | Data per hour |
  |---|---|---|
  | 360p | 1.0 Mbps | 0.4 GB |
  | 480p | 1.5 Mbps | 0.7 GB |
  | 720p | 3.0 Mbps | 1.3 GB |
  | 1080p | 5.5 Mbps | 2.5 GB |

  MPEG-1 is an old format, so these are higher than YouTube's own rates for the same picture. 1080p also needs a fast screen: the car decodes it in JavaScript.
- A way to reach it from the car over HTTPS. A Cloudflare Tunnel on your own domain is built in.

## Setup

1. Clone the repo onto the machine and create your settings:

   ```sh
   git clone https://github.com/5w311/DriveTest.git && cd DriveTest
   cp .env.example .env
   nano .env   # set DRIVE_PASSCODE and SHARE_TOKEN; PUBLIC_URL and TUNNEL_TOKEN come in step 2
   ```

2. Create a tunnel. In the Cloudflare dashboard, go to Networking → Tunnels (older dashboards: Zero Trust → Networks → Tunnels) and create one. Copy its token into `TUNNEL_TOKEN` in `.env` and set `PUBLIC_URL`, for example `https://drive.figari.dev`. Then add a published application route for that hostname pointing at `http://drivetest:8080`.

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

## Is the machine fast enough?

Each time a video starts, the log reports how fast the machine converts it:

```sh
docker compose logs -f drivetest
# [stream dQw4w9WgXcQ] 480p converting at 2.6x real time (OK)
```

Anything at 1.5x or above is comfortable. Between 1.1x and 1.5x works but leaves little headroom. Below 1.1x, the car will keep buffering, so drop the quality. If the line ends with "held back by the car's connection", the bottleneck is the network, not the CPU. The same number shows in the car's **Stats** readout, next to how long the car takes to decode each frame.

## Moving to another machine

Your sign-ins, Up Next, history and resume points live in the `drivetest-data` volume. To move them, say from a Raspberry Pi to a PC:

```sh
# On the old machine
docker compose --profile tunnel down
docker run --rm -v drivetest_drivetest-data:/data -v "$PWD":/backup alpine tar czf /backup/drivetest-data.tgz -C /data .

# Copy drivetest-data.tgz and .env to the new machine's DriveTest folder, then:
docker volume create drivetest_drivetest-data
docker run --rm -v drivetest_drivetest-data:/data -v "$PWD":/backup alpine sh -c "tar xzf /backup/drivetest-data.tgz -C /data && chown -R 1000:1000 /data"
docker compose --profile tunnel up -d --build
```

Use the same `TUNNEL_TOKEN` and your domain moves with it. Stop the old machine first: two machines running the same tunnel would split traffic between them.

## Troubleshooting

| Symptom | Check |
|---|---|
| Test pattern plays, YouTube doesn't | Run `docker compose logs drivetest`. Usually yt-dlp needs updating (restart the container) or YouTube is blocking the request. Some videos (age-restricted, members-only) need a cookies file: put `cookies.txt` in the data volume and set `YTDLP_ARGS=--cookies /data/cookies.txt`. |
| Frequent buffering | The car steps down by itself after three stalls in two minutes. To find the cause, tap **Stats**: a server speed under 1.1x means the machine is too slow for that quality, otherwise it's the connection. A Pi 4 should stay at 480p. |
| Choppy picture at 1080p | Tap **Stats**. If decoding takes more than about half of the time available per frame, the screen is the limit; use 720p. |
| No sound | Tap the screen once. Browsers only allow sound after a tap. |
| Phone says "Car offline" | The car page isn't open, or the car is offline. |

## Fullscreen in a Tesla

Tesla only lets its browser take over the entire display in Park. While driving, the browser keeps its own window, so DriveTest's fullscreen fills that window. It also asks the browser for true fullscreen, which works on phones and computers and is ignored where the browser doesn't allow it.

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
