# DrivePost

A self-hosted YouTube player for the Tesla browser that keeps playing after you shift out of Park, for passengers.

Tesla's browser pauses its built-in video player when the car leaves Park. DrivePost never uses that player. A small server at home fetches the video, and the car page decodes it itself and draws it on a `<canvas>`, with sound through Web Audio. The [proof of concept](test/) confirmed that canvas playback keeps going in Drive.

## What it does

- **Car page:** search YouTube or paste a link, with suggestions as you type, Up Next, Recent, resume where you left off, ±10 s, a seek bar and 360p to 1080p quality.
- **Theater button:** shows or hides the lists (Up Next, Search, Recent). Blue means they're showing; off leaves just the video and the search bar.
- **Fullscreen:** tap the video and use the corner button, or switch it from the phone. The video then fills the whole browser window while something plays, with controls on tap. **Fill** zooms the picture to cover the window, and **Fit** shows all of it. When nothing is playing, the normal page comes back so you can search. The phone can switch it too.
- **Phone remote:** scan a QR code on the car screen to pair, no passcode needed. The code closes by itself once the phone is in. Search, paste links, reorder Up Next and control playback from your phone.
- **Profiles:** each person or car can have its own passcode, and with it its own now playing, Up Next, Recent, settings, paired phones and Send to Car link, all at the same address. Someone new asks for a profile from the sign-in page, and it works once you allow it from your phone.
- **Share from any app:** use an iPhone Shortcut in the share sheet, or install the remote on Android so it appears in the share menu.
- **Two video formats:** **H.264** passes YouTube's own video straight through, and the browser decodes it (WebCodecs). It's sharper, usually uses less data, and is almost no work for the server. **MPEG-1** is converted on the server and decoded in the page by [JSMpeg](https://github.com/phoboslab/jsmpeg), which works in any browser. The car uses H.264 when it can and switches to MPEG-1 by itself when it can't.
- **Smooth playback:** the car runs its own clock. Each frame is shown at its timestamp and sound is scheduled against the same clock, so motion is even and lips stay in sync. Films keep their 24 fps.
- **Handles bad signal:** the car keeps up to 25 seconds buffered. If it runs out, picture and sound freeze together and carry on without a gap. A dropped connection reconnects at the same spot.
- **Steps down by itself:** if the screen can't keep up, or the connection keeps running dry, the car drops one quality level for that video and says why. The next video starts at your chosen quality again.
- **Feedback button:** shows a QR code in the car. Scanning it opens a new issue on the project's GitHub page on your phone, with the car's technical details (browser, format, buffer and so on) already filled in. Nothing about the video or your server is included. Set `FEEDBACK_URL` in `.env` to point it at your own fork, or leave it empty to hide the button.
- **Stats readout:** tap **Stats** under the video to see resolution, format, decoding, buffer, data rate, how fast your server is working and what the browser can decode.
- **Private:** a passcode per profile, devices stay signed in, and the iPhone Shortcut uses its own share token, which can only add videos and can be replaced at any time.

## How it works

```
Phone ──share/remote──┐
                      ▼
YouTube ─► yt-dlp ─► ffmpeg ─► MPEG-TS ─► server splits it into single video frames and
             H.264: picture copied as is     short audio runs, each tagged with its timestamp
             MPEG-1: picture converted                        │ WebSocket
             sound: converted to MP2                          ▼
     Tesla browser: buffer ─► own clock ─► decode (WebCodecs or JSMpeg) ─► canvas + Web Audio
```

The server keeps about 25 seconds ahead of the car and pauses ffmpeg after that, so it never fetches or converts more than the car will use. Seeking restarts ffmpeg at the new spot. YouTube supports fast seeking, so that takes a couple of seconds. The video that's next in line is looked up ahead of time, so it starts faster.

In the car, the decoders only decode. The page decides when each picture shows: every frame goes on screen at its timestamp, and audio is queued on the sound card half a second ahead at the matching time. That keeps playback even when data arrives in bursts or the browser repaints slowly.

### H.264 and MPEG-1

The car asks for H.264 when its browser can decode it. That needs WebCodecs, which browsers only offer on https pages. The server passes H.264 through when YouTube has the video in H.264 at the chosen quality, which is nearly always the case up to 1080p. Otherwise the picture is converted to MPEG-1, as before. Live streams are always converted. The sound is converted to MP2 either way.

A copied H.264 stream can only begin on a keyframe, which may be several seconds before the spot you seek to. The car decodes that lead-in without showing it, so playback still starts exactly where you asked.

If the browser's H.264 decoder reports an error, stops returning pictures, or can't keep up even at 360p, the car carries on from the same spot in MPEG-1 and says so. It stays on MPEG-1 for two hours, so a browser that blocks its own decoder in some situations doesn't interrupt every video. Choosing **H.264** under **Video format** on the phone remote tries it again right away, and choosing **MPEG-1** there turns H.264 off. **Stats** shows which format is playing, and why when it isn't H.264.

## Requirements

- An always-on machine on your **home internet** with Docker: a Raspberry Pi 4/5 (64-bit OS), mini PC, NAS or PC. It has to be at home because YouTube blocks most cloud servers.
- Enough upload at home, and data in the car, for the quality you pick:

  | Quality | H.264, typical | MPEG-1 | MPEG-1 per hour |
  |---|---|---|---|
  | 360p | 0.5 to 0.8 Mbps | 1.0 Mbps | 0.4 GB |
  | 480p | 0.7 to 1.3 Mbps | 1.5 Mbps | 0.7 GB |
  | 720p | 1.3 to 2.7 Mbps | 3.0 Mbps | 1.3 GB |
  | 1080p | 2.7 to 4.7 Mbps | 5.5 Mbps | 2.5 GB |

  The MPEG-1 figures are measured. The H.264 figures are what YouTube usually uses for 30 fps video plus the sound, and they vary from video to video; 60 fps videos use about half as much again. **Stats** shows the real rate of what's playing.
- A machine fast enough for the format. Passing H.264 through takes almost no CPU, so a Pi 4 should handle 1080p. Converting to MPEG-1 is real work: a Pi 4 should stay at 480p for that, and 1080p also needs a fast screen in the car, because MPEG-1 is decoded in JavaScript.
- A way to reach it from the car over HTTPS. A Cloudflare Tunnel on your own domain is built in.

## Setup

1. Clone the repo onto the machine and create your settings:

   ```sh
   git clone https://github.com/5w311/DrivePost.git && cd DrivePost
   cp .env.example .env
   nano .env   # set DRIVE_PASSCODE and SHARE_TOKEN; PUBLIC_URL and TUNNEL_TOKEN come in step 2
   ```

2. Create a tunnel. In the Cloudflare dashboard, go to Networking → Tunnels (older dashboards: Zero Trust → Networks → Tunnels) and create one. Copy its token into `TUNNEL_TOKEN` in `.env` and set `PUBLIC_URL`, for example `https://drive.figari.dev`. Then add a published application route for that hostname pointing at `http://drivepost:8080`.

3. Start it:

   ```sh
   docker compose --profile tunnel up -d --build
   ```

   Without the tunnel, `docker compose up -d --build` serves it on port 8080 of that machine.

4. In the car, open `https://drive.figari.dev`, enter the passcode, open **Recent** and tap **Play test pattern**. The pattern is generated on your server, so if it plays in Drive, the whole pipeline works without involving YouTube.

5. On your phone, tap **Phone** on the car screen and scan the code. Open **Setup & sharing** at the bottom of the remote to set up sharing from your phone.

## Profiles

A profile is one person's, or one car's, own copy of everything: what's playing, Up Next, Recent, resume points, quality and format settings, paired phones and the Send to Car link. The passcode a device signs in with decides which profile it's in, so everyone uses the same address.

- The **main profile** is the one you set up: its passcode is `DRIVE_PASSCODE` in `.env`. Only it can manage profiles.
- **Getting a profile:** the person opens your address, taps **Ask for your own profile** on the sign-in page, and picks a name and a passcode. Their screen then shows a three-digit number and waits. You see their name and the same number on your phone remote and under **Profiles** in **Setup & sharing**. Tap **Allow** and their screen signs in by itself; tap **Decline** and nothing is made. Until you allow it, their passcode opens nothing.
- Only allow a request whose number matches the one on the person's screen. Your address is public, so anyone who finds it can ask, and the number is how you know a request is really from the person you think.
- Requests wait for up to a week, also across restarts and updates, so you can answer later. The person can close the page and come back with their passcode. At most five wait at a time, and one address can only ask a few times per ten minutes.
- To stop taking requests, untick **Let new people ask for a profile** under **Profiles**. The sign-in page then only takes passcodes that already work.
- You can also add a profile yourself: under **Profiles**, open **Add a profile yourself instead**, enter a name and a passcode, and tell the person the passcode.
- From the same list you can rename a profile, give it a new passcode, sign its devices out, or remove it. Removing a profile deletes its Up Next, history and settings.
- Passcodes have to differ from each other, because the passcode is what tells profiles apart. Passcodes people choose or you add are stored scrambled.
- Each person pairs their phones from their own car's screen, or signs in on them with their passcode.
- Once there's more than one profile, the car page and the phone remote show which profile they're on.

A server set up before profiles existed keeps working unchanged: its car, phones and Shortcut become the main profile.

Each car that's playing needs its own share of the server and of your upload. Passing H.264 through is light enough for a Raspberry Pi 4 to serve two or three cars; converting to MPEG-1 at 1080p is one car's worth on a Pi 4. `MAX_STREAMS` is counted per profile.

## Sharing from an iPhone

iPhones don't let a web app appear in the share sheet, so sharing goes through a Shortcut called **Send to Car**. After that, tap Share in YouTube, Safari or any app and pick it. If nothing is playing, the video starts in the car. Otherwise it goes to Up Next.

**Setup & sharing** in the remote shows your **personal link**: your server's address with your share token in it. That link is all the Shortcut needs. The Shortcut sends what you shared to the link and shows the server's answer as a notification. It only uses actions that have been in Shortcuts since iOS 15.

To add it, open **Setup & sharing** on the iPhone in Safari and tap **Get the Shortcut**. That copies your personal link and downloads the Shortcut. Open the download, paste the link when Shortcuts asks for it, and tap **Add Shortcut**. The first time you share, iOS asks whether the Shortcut may connect to your server: tap **Always Allow**. The Setup page also lists the steps for making the same Shortcut by hand.

The Shortcut file (`server/public/send-to-car.shortcut`) is the same for everyone and has no address or token in it. `scripts/make-shortcut.mjs` builds it, and `shortcut/send-to-car.unsigned.plist` is the readable version of what it does.

iPhones only open Shortcut files that carry Apple's signature. The script gets one with the `shortcuts` tool on a Mac, or from [Shortcuty's public signing service](https://github.com/Shortcuty/Signing-Server-API-Documentation) on any other computer. The file in this repository was signed there. You only need to do this again if you change the Shortcut, or if iPhones stop opening the file because its signature has aged out:

```bash
node scripts/make-shortcut.mjs --sign      # writes server/public/send-to-car.shortcut
python3 scripts/inspect-shortcut.py        # unpacks the signed file and checks it matches the readable version
```

Making a new share token (Setup page, under Security) changes your personal link. Open Send to Car in Shortcuts and paste the new link over the old one.

## Updating

yt-dlp updates itself when the container starts and once a day. YouTube changes often, and old versions stop working. To update DrivePost itself:

```sh
git pull && docker compose --profile tunnel up -d --build --remove-orphans
```

`--remove-orphans` matters once, on a machine set up while the app was still called DriveTest: it clears away the container with the old name, which would otherwise keep port 8080. If you updated without it and got `port is already allocated`, run `docker compose --profile tunnel up -d --force-recreate --remove-orphans` to put things right. Your data is not touched either way.

### Automatic updates

To have the machine update itself whenever something is pushed to the repo, run this once:

```sh
./scripts/install-auto-update.sh
```

It sets up a timer that checks GitHub every 2 minutes. When there are new commits and nobody is watching a video, it pulls them and rebuilds. If a build fails, the version that was running stays up. An open car page reloads itself once the new version is running.

| To do this | Run |
|---|---|
| See what it did | `journalctl -u drivepost-update -n 30 --no-pager` |
| Check right now | `./scripts/auto-update.sh` |
| Turn it off | `./scripts/install-auto-update.sh --remove` |

Anything pushed to the branch this machine follows gets installed on it, so keep push access to the repo to yourself. Files you changed by hand (other than `.env`, which is never touched) can block an update; the log says which.

## Is the machine fast enough?

Each time a video starts, the log reports how fast the machine gets it ready:

```sh
docker compose logs -f drivepost
# [stream dQw4w9WgXcQ] 1080p passing H.264 through at 31.0x real time (OK)
# [stream dQw4w9WgXcQ] 480p converting at 2.6x real time (OK)
```

Passing H.264 through is limited only by your internet connection, so it's usually many times real time. For converting to MPEG-1, anything at 1.5x or above is comfortable. Between 1.1x and 1.5x works but leaves little headroom. Below 1.1x, the car will keep buffering, so drop the quality. If the line ends with "held back by the car's connection", the bottleneck is the network, not the CPU. The same number shows in the car's **Stats** readout.

Notices from the car, such as a quality step-down or a switch to MPEG-1, show up in the same log on lines starting with `[car]`.

## Moving to another machine

Your sign-ins, profiles, Up Next, history and resume points live in a Docker volume (`drivetest-data` in `docker-compose.yml`; it kept the name it had before the app was renamed). To move them, say from a Raspberry Pi to a PC:

```sh
# On the old machine, in the app's folder
docker compose --profile tunnel down
docker compose run --rm --no-deps --user root --entrypoint sh -v "$PWD":/backup drivepost -c 'tar czf /backup/drivepost-data.tgz -C /data .'

# Clone the repo on the new machine, copy drivepost-data.tgz and .env into its folder, then:
docker compose build
docker compose run --rm --no-deps --user root --entrypoint sh -v "$PWD":/backup drivepost -c 'tar xzf /backup/drivepost-data.tgz -C /data && chown -R node:node /data'
docker compose --profile tunnel up -d
```

Use the same `TUNNEL_TOKEN` and your domain moves with it. Stop the old machine first: two machines running the same tunnel would split traffic between them. If the old machine updates itself, turn that off there first with `./scripts/install-auto-update.sh --remove`, or its next update starts it again.

## Troubleshooting

| Symptom | Check |
|---|---|
| Test pattern plays, YouTube doesn't | Run `docker compose logs drivepost`. Usually yt-dlp needs updating (restart the container) or YouTube is blocking the request. Some videos (age-restricted, members-only) need a cookies file: put `cookies.txt` in the data volume and set `YTDLP_ARGS=--cookies /data/cookies.txt`. |
| Frequent buffering | The car steps down by itself after three stalls in two minutes. To find the cause, tap **Stats**: a server speed under 1.1x means the machine can't convert that quality fast enough (MPEG-1) or can't fetch it fast enough (H.264). Otherwise it's the car's connection. |
| Choppy picture at 1080p | Tap **Stats**. In MPEG-1, if decoding takes more than about half of the time available per frame, the screen is the limit. In H.264, a climbing "skipped" count means the same. Use 720p. |
| It plays MPEG-1 and you expected H.264 | Tap **Stats** and read the **Format** line: it says whether the browser can't decode H.264, the video has no H.264 version, H.264 failed earlier, or it's switched off on the phone. The **Browser** line lists what the browser can decode. H.264 needs the page to be on https. |
| H.264 misbehaves in the car | On the phone remote, set **Video format** to **MPEG-1**. Everything then works as it did before H.264 was added. |
| No sound | Tap the screen once. Browsers only allow sound after a tap. |
| Phone says "Car offline" | The car page isn't open, or the car is offline. |

## Fullscreen in a Tesla

Tesla only lets its browser take over the entire display in Park. While driving, the browser keeps its own window, so DrivePost's fullscreen fills that window. It also asks the browser for true fullscreen, which works on phones and computers and is ignored where the browser doesn't allow it.

## Notes

- A screen showing video in view of the driver while the car is moving is illegal in many places, including Florida (§316.303). This is built for passengers.
- YouTube's terms don't allow downloading videos outside their own apps. Keep this for your own use, not as a public service.
- Cloudflare's terms limit using its network mainly for video. A personal tunnel for one car is low volume, but if that's a concern, use a port forward with a reverse proxy such as Caddy instead.

## Project layout

```
scripts/         Automatic updates (timer installer and the update script), iPhone Shortcut builder and checker
shortcut/        The iPhone Shortcut, unsigned, for reading
server/src/      Node server: auth, state, yt-dlp, ffmpeg streaming, TS chunker
server/public/   Car page, phone remote, setup page, JSMpeg
server/test/     Unit tests (npm test)
test/            The original side-by-side Drive test page
```

JSMpeg is © Dominic Szablewski, MIT license (`JSMPEG-LICENSE.txt`).
