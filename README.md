# DrivePost

A self-hosted YouTube player for the Tesla browser that keeps playing after you shift out of Park, for passengers. It also plays the video behind a link to somewhere else: a post on X, Reddit or Instagram, a page with a video player on it, or a video file.

Tesla's browser pauses its built-in video player when the car leaves Park. DrivePost never uses that player. A small server at home fetches the video, and the car page decodes it itself and draws it on a `<canvas>`, with sound through Web Audio. The [proof of concept](test/) confirmed that canvas playback keeps going in Drive.

## What it does

- **Car page:** search YouTube or paste a link, with suggestions as you type, Up Next, Recent, resume where you left off, ±10 s, a seek bar and 360p to 1080p quality.
- **Other sites too:** paste or share a link to a post on X, Reddit or Instagram, to a page with a video player on it, or straight to a video file. It plays like any other video, with Up Next, Recent, resume and skipping. Search and For You stay YouTube's. See [Videos from other sites](#videos-from-other-sites) for what works and what a site can refuse.
- **Open a page:** for a link with no video in it to fetch (a site with a player of its own), the server opens the page itself in a browser of its own, shows it in the car with its sound, and a phone works it like a remote desktop. The car's own pause and ten-second buttons work the page's video. See [Opening a page](#opening-a-page).
- **Skipping without waiting:** the car loads two minutes ahead (the lighter part of the seek bar, which keeps creeping forward as the video plays) and keeps the last few minutes played. A skip to anywhere in that happens at once; only a skip further away loads again.
- **Recent searches:** the last 20 searches are kept. Tap the empty search box, or open **Search**, to run one again. × forgets one, **Clear** forgets them all.
- **For You:** videos like the ones you've been watching, on the car page and the phone remote.
- **Theater button:** shows or hides the lists (Up Next, For You, Search, Recent). Blue means they're showing; off leaves just the video and the search bar.
- **Fullscreen:** tap the video and use the corner button, or switch it from the phone. The video then fills the whole browser window while something plays, with controls on tap. **Fill** zooms the picture to cover the window, and **Fit** shows all of it. When nothing is playing, the normal page comes back so you can search. The phone can switch it too.
- **Pauses when the browser is closed:** closing or leaving the browser in the car pauses the video, so the sound doesn't carry on out of sight. It stays paused until someone presses play. Opening the page again shows **Tap to play**, which carries on from the same spot. Pressing play on the phone while the car's browser is closed is respected, so you can still listen that way.
- **Phone remote:** scan a QR code on the car screen to pair, no passcode needed. The code closes by itself once the phone is in. Search, reorder Up Next and control playback from your phone. To send a video, copy its link in any app and tap **Paste & Play** or **Paste & Up Next**.
- **Profiles:** each person or car can have its own passcode, and with it its own now playing, Up Next, Recent, searches, recommendations, settings, paired phones and Send to Car link, all at the same address. Someone new asks for a profile from the sign-in page, and it works once you allow it.
- **Admin page:** `/admin`, opened with the passcode from `.env` and nothing else, shows who is waiting for a profile, every profile and its car, and the running build. It says what is new as it happens: an update shows up within seconds of being pushed, and the page loads the new version by itself once it is running.
- **Share from any app:** use an iPhone Shortcut in the share sheet, or install the remote on Android so it appears in the share menu.
- **Two video formats:** **H.264** passes YouTube's own video straight through, and the browser decodes it (WebCodecs). It's sharper, usually uses less data, and is almost no work for the server. **MPEG-1** is converted on the server and decoded in the page by [JSMpeg](https://github.com/phoboslab/jsmpeg), which works in any browser. The car uses H.264 when it can and switches to MPEG-1 by itself when it can't.
- **Smooth playback:** the car runs its own clock. Each frame is shown at its timestamp and sound is scheduled against the same clock, so motion is even and lips stay in sync. Films keep their 24 fps.
- **Handles bad signal:** the car keeps up to 25 seconds buffered. If it runs out, picture and sound freeze together and carry on without a gap. A dropped connection reconnects at the same spot.
- **Steps down by itself:** if the screen can't keep up, or the connection keeps running dry, the car drops one quality level for that video and says why. The next video starts at your chosen quality again.
- **Feedback button:** shows a QR code in the car. Scanning it opens a new issue on the project's GitHub page on your phone, with the car's technical details (browser, format, buffer and so on) already filled in. Nothing about the video or your server is included. Set `FEEDBACK_URL` in `.env` to point it at your own fork, or leave it empty to hide the button.
- **Stats readout:** tap **Stats** under the video to see resolution, format, decoding, buffer, data rate, how fast your server is working and what the browser can decode.
- **Private:** a passcode per profile, a separate one for Admin, devices stay signed in, and the iPhone Shortcut uses its own share token, which can only add videos and can be replaced at any time.

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

### Getting the video from YouTube

Two things can stand between looking a video up and playing it:

- **A wait.** Where an ad would play first, YouTube refuses the video (403) until the ad's time is up, usually several seconds after the lookup. The server is told when each file becomes available and holds off until then. A video that was looked up ahead of time, like the next one in Up Next, has usually sat its wait out already.
- **A refusal.** YouTube closes one way of fetching or another from time to time, for some connections and not others. The lookup still hands out links; they just keep answering 403.

So the server has three routes and doesn't count on any one of them:

- **hls:** the stream in short segments that YouTube gives embedded players, up to 1080p. No ad break in front of it, and it comes in many times faster than it plays. This is the first choice.
- **direct:** the separate picture and sound files, also up to 1080p. Usually behind a wait of a few seconds, and YouTube feeds a plain download of them at barely twice the speed they play at. Used for videos that have no stream, such as ones that can't be embedded.
- **basic:** the one small ready-made 360p file every video has.

(Measured from a home connection in November 2026: hls no wait and 23x, direct a 4 second wait and 1.8x, basic a 5 second wait and 200x.)

Before playing, the server asks for the first bytes of what it was given. If YouTube refuses, it moves to the next route, remembers that, and comes back to the better route later. A route that simply has nothing for one video is skipped for that video. If the first choice is behind a wait of more than about 15 seconds, it starts with a route that is ready instead. A wait of 4 seconds or more is shown in the car, and so is having only the basic file (once an hour).

A route also has to deliver the sound. If 20 seconds of picture have gone out without any, on a video that has sound, the server rests that route, says so in the car, and starts the video over from the same spot by the next route. It does that once per video.

### Skipping around in a segmented stream

To start partway through (a skip, a resume, a change of quality), the server doesn't let ffmpeg seek in the stream's list of segments. ffmpeg's seeking there can begin the picture a whole segment late, and can begin the sound at the start of its segment while labelling it as the spot asked for, which leaves the sound seconds out of step. Instead the server writes ffmpeg a shorter list that begins with the segment holding the spot, hands it over from a small web server of its own (this machine only), and keeps the stream's own timestamps. The picture begins on that segment's first frame, which the car decodes without showing, and the sound is cut to begin exactly at the spot. See `server/src/segment-list.js`.

### Skipping within what has loaded

In H.264 the server reads two minutes ahead of where the car is playing and tops that up every few seconds, so the loaded part of the seek bar keeps creeping ahead as the video plays instead of filling in jumps. After a skip back there is more than two minutes ahead already, so it waits until playback is within two minutes of the loaded edge again and then carries on.

The car keeps everything it has received, played or not, for as long as there is room: at most 160 MB in all, with the oldest let go first and what is still to come never touched. At 1080p that is the two minutes ahead plus the last two to four minutes played. On the seek bar, the played part that is no longer on hand is drawn dimmer.

±10 s, the seek bar and skips from a phone first try to go there within what the car holds: the decoder starts over at the keyframe before the spot, the frames up to the spot are decoded without being shown, the sound already queued is cut, and playback carries on. No request is made and the stream that is open stays open; the server just hears the new position. A spot that isn't on hand opens a new stream there, as before.

In MPEG-1 every skip opens a new stream, and the server reads only about 25 seconds ahead, because converting is real work for it.

### Where the recommendations come from

There is no YouTube account behind DrivePost, so there are no personal recommendations to ask YouTube for. What YouTube gives anyone is the list of related videos it shows beside a video. For You asks for that list for what is playing and for the last five videos the profile played, and deals them into one list a round at a time, newest first, leaving out what has been watched or is already in Up Next. Each video's list is kept for 12 hours, so opening For You again costs nothing. Nothing about the profile is sent to YouTube beyond the IDs of those videos, which it has seen already when they were played. See `server/src/recommend.js`.

### H.264 and MPEG-1

The car asks for H.264 when its browser can decode it. That needs WebCodecs, which browsers only offer on https pages. The server passes H.264 through when YouTube has the video in H.264 at the chosen quality, which is nearly always the case up to 1080p. Otherwise the picture is converted to MPEG-1, as before. Live streams are always converted. The sound is converted to MP2 either way.

A copied H.264 stream can only begin on a keyframe, which may be several seconds before the spot you seek to. The car decodes that lead-in without showing it, so playback still starts exactly where you asked.

If the browser's H.264 decoder reports an error, stops returning pictures, or can't keep up even at 360p, the car carries on from the same spot in MPEG-1 and says so. It stays on MPEG-1 for two hours, so a browser that blocks its own decoder in some situations doesn't interrupt every video. Choosing **H.264** under **Video format** on the phone remote tries it again right away, and choosing **MPEG-1** there turns H.264 off. **Stats** shows which format is playing, and why when it isn't H.264.

A video from another site is the exception. If the decoder gives up on one of those, only that video goes to MPEG-1, for as long as the car page stays open: it says something about that site's file, not about the browser, and YouTube videos keep playing in H.264.

### Videos from other sites

A link that isn't YouTube's is handed to yt-dlp, which knows how to find the video behind the links of hundreds of sites and reads any other page for a player the way a browser would. It answers with what the video is called and every version of it the site has. The server picks one, has ffprobe look at what it really is, and from there it is played like any other video. See `server/src/links.js`.

**Sending one.** On the phone remote, copy the link in any app and tap **Paste & Play** (plays now) or **Paste & Up Next**. An iPhone shows a small **Paste** button of its own first: tap that too. With a link typed or pasted into the box, the same two buttons read **Play** and **Up Next** and send that instead. The car's search box takes a pasted link as well, and so do the iPhone Shortcut and Android's share menu. A page with several videos plays the first.

**Which version.** One with sound over one without; one that fits the quality you chose; H.264, which can be passed straight on to the car, over anything that has to be converted; then the biggest picture. A plain file with picture and sound together comes before separate files, and those before lists of segments, because that is the order of how simple they are to play and to skip around in.

**Passed on or converted.** The picture goes to the car as it is when it is H.264 that a browser decodes: 8-bit, not interlaced, not stored on its side, and no bigger than the quality chosen. Anything else is converted to MPEG-1 on your server, and **Stats** says why ("it is vp9", "it is bigger than 720p"). A stream with no end in sight plays as live. On the way through, the server leaves out the notes some encoders put beside the picture (SEI): nothing here uses them, and a browser's decoder gives up on a file that has one ahead of what it refers to.

**What to expect.** Tried from a test machine in November 2026, with real links:

| Link | Result |
|---|---|
| A post on X with a video | Plays, passed through as H.264, with the post's picture and who posted it in the lists |
| A link straight to a video file | Plays. Its length shows once it has started |
| A page with an ordinary video player | Plays |
| Reddit, Instagram | Refused from that machine: "only shows that video to signed-in visitors". These sites decide by where the request comes from, so a home connection may do better. Otherwise see below |
| Anything copy-protected (Netflix and the like) | Never: it can only be played on the site itself |
| Sound with no picture, or a video a site only delivers in many small pieces (DASH) with nothing else on offer | Not played |

To find out about a link from your own server:

```bash
docker compose exec -T drivepost node src/check-link.js "https://x.com/someone/status/123"
```

It looks the link up, says what it picked and whether that is passed on or converted, asks for the first bytes, has ffmpeg read some of it and tries a skip. There are no links in the output.

**A site that wants a sign-in.** yt-dlp can use your sign-in from a browser, as a cookies file. Sign in to the site in a browser on your computer, export its cookies with an extension that saves a `cookies.txt` (the Netscape format), copy the file to the server, and then:

```bash
docker compose cp cookies.txt drivepost:/data/cookies-sites.txt
docker compose exec -u root drivepost chown node /data/cookies-sites.txt
```

The second line makes the file the app's own. yt-dlp keeps a cookies file up to date as it goes, and a lookup fails if it can't write to it. Then add `OTHER_SITES_ARGS=--cookies /data/cookies-sites.txt` to `.env` and run `docker compose up -d`. This is for other sites only, so YouTube is still fetched without a sign-in. That file is your sign-in: whoever has it is you on that site, so an account made for the purpose is the safer choice.

**Only out onto the internet.** Your server sits on your home network and can reach things the internet can't: the router's settings page, other machines, itself. Fetching whatever link someone pastes would be a way to reach those through it. So a link is only followed when it is http or https and leads to an address out on the internet, by every address its name leads to. That is checked for the link that was pasted, for every media address yt-dlp hands back, and for each hop of the server's own requests, and ffmpeg is kept to web addresses. What isn't covered: yt-dlp and ffmpeg follow redirects by themselves, so a page out on the internet could still send them to an address on your network. Only someone signed in to your DrivePost can send a link at all, and nothing that comes back from such a request is shown to anyone beyond a page's title.

- `OTHER_SITES_LOCAL=on` lets links lead to your own network, for a video on a NAS. Leave it off unless you want that.
- `OTHER_SITES=off` makes this a YouTube-only server again.

**Pictures in the lists** for these videos come from the other site, and your phone and car fetch them from it directly, without telling it which page asked. One that has stopped working is replaced by the site's name.

### Opening a page

Some links have no video in them that can be fetched: the page has a player of its own and nothing behind it to hand over. For those the server opens **the page itself**, in a browser of its own, and shows the car a picture of that browser's screen with its sound. A phone works it the way a remote-desktop app works a computer. Nothing is taken out of the site: the page plays in an ordinary browser as it would on any computer, and the car is shown that browser.

**Opening one.** On the phone remote, under **Send a video**, paste or copy the link and tap **No video to find? Open the page itself**. Within about ten seconds the car is playing the page as a live item named after it. A **Page** card appears on every phone of the profile:

- **The page, in a small browser window.** Its bar has **Back**, **Reload**, the site and the page's name, and a button at the right end that makes it **bigger**. Under the bar is a live view of the browser's screen. A tap on it is a click, and a drag scrolls. **Press and hold** moves the mouse there without clicking, and it then follows your finger: that is how a player's buttons, which hide until the mouse comes near, are woken so you can tap them. A ring shows where you tapped or are pointing, and the mouse pointer shows in the live view (not in the car).
- **Bigger** puts the live view over the whole of the phone's screen, the long way round, for small buttons. On a phone held upright the page lies on its side: turn the phone to look at it. It makes no difference whether the phone turns its own screen. The round button in its corner puts it back.
- **Type into the page** and **Send**, with **Enter**, **Delete**, **Esc** and **Tab**, for search boxes and sign-ins. Tap the box on the page first; Tab moves on to a form's next box.
- **Full screen** and **Captions** press the F and C keys, which most players use for those. A player that doesn't has its own buttons for them: press and hold on the video to bring them up, then tap. Esc leaves full screen. Most sites keep what you chose, so captions switched on once stay on.
- **Block ads**, a switch, off to begin with. See "Blocking ads" below.
- The card's head says how the page stands with the car (**In the car**, **Paused**, **Not in the car**, **Car offline**) and has **Close**, which ends it; the car goes on to Up Next. When the car is on another video, the card offers **Show it in the car**.

**To open one again.** A page you have opened is kept under **Recent**, on the phone and in the car, marked *Page*: tap it there and it is opened again, at the address it was first opened at. It can't be lined up in Up Next, since a page isn't a video with an end.

The live view stops after a minute untouched, to save the phone's data, and comes back with a tap. Once the video is playing, the phone is free. The car runs about five seconds behind the page, so steer by the phone's live view, which is immediate, and not by the car.

**The car's own buttons work the page's video.** Pause, in the car or on a phone, pauses the video in the page itself, and Play takes it back to where the car's picture had got to before playing on, so nothing is missed. The two ten-second buttons skip back and on in it. This goes through the browser's own media controls, the ones a keyboard's play key uses, so it works with any site's player that the browser knows is playing. What a site doesn't let you skip in (most live television) can't be skipped in from here either.

**What it remembers.** Each profile has its own browser data, kept in a Docker volume, so a site you signed in to stays signed in. The tabs themselves are not kept: every page starts in a clean window. The browser keeps UTC time unless `.env` says where it is (`TZ=America/New_York`), which is what makes a site's TV guide show your hours.

**How it works.** A second container (`browser/`) holds an ordinary Chromium at a desk nobody sits at: a screen that exists only in memory (Xvfb), a sound card that plays to nobody (PulseAudio), a window manager, and a mouse and keyboard. A small program there (`browser/agent.js`) is that desk's remote desktop. It connects to DrivePost, signs in with a key the two share, starts the browser on the address it is given, moves the mouse and presses the keys when a phone says so, and has ffmpeg film the screen and record the sound. The film is handed to DrivePost as it is made, which keeps it in memory as a live stream of one-second pieces (`server/src/mirror.js`, nothing converted), and the car's stream is made from that like any live video. The screen and the sound are two feeds that don't start at the same instant, so each is stamped with the time on the clock as it is taken and they are lined up by that; the sound is then set back 60 ms, which is about how much longer a picture takes to reach the screen.

No program drives the browser. It is started without a remote-control interface, and the program beside it never reaches into a page: it can't read one, change one or run anything in one. All it knows of the page is the name on its window. A site sees an ordinary browser being used by a person, which is what is happening. With **Block ads** on, that browser has one extension, an ad blocker, which works inside pages as it does in anyone's browser; with it off, the browser has none.

**Kept apart.** A web page is the least trusted thing this server touches, so the browser's container:

- has none of DrivePost's settings, passcodes or data;
- runs without extra privileges, as an ordinary user;
- is on a Docker network with **no way out**: no route to the internet, to your home network, or to the machine it runs on (so not to that machine's SSH either). Everything it fetches goes through DrivePost (`server/src/guard.js`), which refuses addresses on your home network: the router's settings page, other machines, the server itself. `OTHER_SITES_LOCAL=on` lifts that, as it does for links.

Chromium's own inner sandbox can't be built inside a container without giving the container powers it shouldn't have, so it runs with `--no-sandbox` and the container is the wall. A short list of house rules (`browser/policies.json`) keeps the browser's own offers out of the picture: no saving of passwords, no translating, no downloads.

**One at a time.** A browser playing video is the heaviest thing this server does, so there is one page for the whole server. While one profile's car is showing a page, another profile is told the browser is taken; once that car is on something else, the next page takes its place. A page that no car is playing and no phone is steering is closed after five minutes (`PAGE_IDLE_SECONDS`).

**Blocking ads.** With **Block ads** switched on in the Page card, the server's browser blocks ads in that profile's pages, in two layers:

- **[uBlock Origin Lite](https://github.com/uBlockOrigin/uBOL-home)**, in the browser itself. It is today's uBlock Origin, by the same author (Raymond Hill; GPLv3); the original can no longer run in Chromium, which dropped the kind of extension it is during 2026. It goes by the whole address of what a page asks for, so it also stops ads that come from the site's own machine, and it tidies away the boxes they would have sat in. The browser's image carries one named release of it, taken from its author's repository when the image is built (`browser/Dockerfile` names the commit; put a newer one there to move on). It is set to its fullest filtering mode, "complete" (`browser/ublock-policy.js`), and otherwise left as its author ships it. The browser is given a fresh copy of it each time it starts, so nothing a page did to it carries over. With the switch off, the browser is started with no extension at all.
- **DrivePost's own list**, behind it: whatever a page asks of a machine on a block list is refused at the door the browser fetches everything through (`server/src/adblock.js`, `server/src/guard.js`), the way a Pi-hole does it for a home network. The list is a public one in the format of a hosts file: by default [StevenBlack/hosts](https://github.com/StevenBlack/hosts), the one a Pi-hole starts with (about 78,000 names). The server fetches it the first time someone switches blocking on, keeps a copy with its data, and fetches it again once a week. `PAGE_BLOCKLIST_URL` in `.env` names another list. The site you opened is never refused by it, whatever the list says.

What to know about it:

- It is each profile's own setting and it is off until switched on. It is a switch because a few sites won't play with their ads blocked: switch it off for those.
- A browser takes an extension on as it starts. So switching with a page open **opens that page again**, at the address it was first opened at; what the browser is signed in to is kept.
- An ad blocker comes up a moment after its browser does, and a page opened in that moment would get its ads. So with the switch on, the browser starts on a waiting page of DrivePost's own, which the guard serves, and goes on to yours once the blocker is seen to be at work (`server/src/guard.js` says how it tells). That adds a second or two to opening a page.
- What it can't stop is an ad that is part of the video. Most free television splices its breaks into the stream itself, and nothing in a browser can tell those from the show.

**On mobile data.** A page can't be loaded ahead the way a video can, so it is the first thing to stutter on a weak signal. Three things are done about that:

- A car that can play H.264 is sent the page as H.264: about 1.6 Mbit/s at 720p, 0.85 at 480p and 0.45 at 360p, where MPEG-1 needs 2.6, 1.3 and 0.7.
- A car starts with a few seconds in hand. Each time the signal dips it waits for six seconds' worth before carrying on, and from then on runs that much further behind the page with that much in reserve. It is only started afresh from where the page is now once it is 20 seconds behind.
- As with any video, three stalls in two minutes step the quality down by itself, and **Quality** on the remote sets it by hand: each step down is about half the data.

**What it costs.** Measured with both containers on a two-core machine with no graphics card, while a video filled the screen: about 0.6 of a core for the browser's container (the browser, and filming its screen) and 0.2 for the app's (converting for the car at 360p), with about 750 MB of memory in the browser's. Its image takes about 1.45 GB of disk, 35 MB of that the ad blocker and its lists. At rest that container uses about 70 MB and no CPU.

**What it can't do.**

- **Copy-protected video.** Chromium here has no way to play it and DrivePost does nothing to get around that. Such a player shows its own error.
- **Every site's robot check.** An "I'm not a robot" box judges the browser and where it runs, not the tap. This is an ordinary browser used by a person, which is what such a check looks for, but it runs on a server with no graphics card, and a check that holds that against it will fail it however often the box is tapped. DrivePost doesn't disguise the browser to get through.
- **Ads that are part of the video.** **Block ads** stops the ads a page fetches and shows around and over its video. A break spliced into the stream itself, as most free television does it, is part of the same video as the show and stays.

`PAGES=off` in `.env` takes the feature away. The browser's container still starts with the rest, and waits there doing nothing.

## Requirements

- An always-on machine on your **home internet** with Docker (Engine 28 or newer; `docker --version` says): a Raspberry Pi 4/5 (64-bit OS), mini PC, NAS or PC. It has to be at home because YouTube blocks most cloud servers.
- Enough upload at home, and data in the car, for the quality you pick:

  | Quality | H.264, typical | MPEG-1 | MPEG-1 per hour |
  |---|---|---|---|
  | 360p | 0.5 to 0.8 Mbps | 1.0 Mbps | 0.4 GB |
  | 480p | 0.7 to 1.3 Mbps | 1.5 Mbps | 0.7 GB |
  | 720p | 1.3 to 2.7 Mbps | 3.0 Mbps | 1.3 GB |
  | 1080p | 2.7 to 4.7 Mbps | 5.5 Mbps | 2.5 GB |

  The MPEG-1 figures are measured. The H.264 figures are what YouTube usually uses for 30 fps video plus the sound, and they vary from video to video; 60 fps videos use about half as much again. **Stats** shows the real rate of what's playing.
- A machine fast enough for the format. Passing H.264 through takes almost no CPU, so a Pi 4 should handle 1080p. Converting to MPEG-1 is real work: a Pi 4 should stay at 480p for that, and 1080p also needs a fast screen in the car, because MPEG-1 is decoded in JavaScript.
- For [opening pages](#opening-a-page): about a core to spare and a gigabyte of memory while a page is open. A mini PC is comfortable; a Pi 4 is not.
- A way to reach it from the car over HTTPS. A Cloudflare Tunnel on your own domain is built in.

## Setup

1. Clone the repo onto the machine and create your settings:

   ```sh
   git clone https://github.com/5w311/DrivePost.git && cd DrivePost
   cp .env.example .env
   nano .env   # set DRIVE_PASSCODE, the passcode for the Admin page; PUBLIC_URL and TUNNEL_TOKEN come in step 2
   ```

2. Create a tunnel. In the Cloudflare dashboard, go to Networking → Tunnels (older dashboards: Zero Trust → Networks → Tunnels) and create one. Copy its token into `TUNNEL_TOKEN` in `.env` and set `PUBLIC_URL`, for example `https://drive.figari.dev`. Then add a published application route for that hostname pointing at `http://drivepost:8080`.

3. Start it:

   ```sh
   docker compose --profile tunnel up -d --build
   ```

   Without the tunnel, `docker compose up -d --build` serves it on port 8080 of that machine.

4. On your phone, open `https://drive.figari.dev/admin` and enter `DRIVE_PASSCODE`. This is the Admin page, where you allow profiles. Keep it open.

5. In the car, open `https://drive.figari.dev`, tap **Ask for your own profile**, and pick a name and a passcode for the car. The car shows a three-digit number. The same number appears in Admin on your phone: tap **Allow**, and the car signs in.

6. In the car, open **Recent** and tap **Play test pattern**. The pattern is generated on your server, so if it plays in Drive, the whole pipeline works without involving YouTube.

7. To use your phone as the remote, tap **Phone** on the car screen and scan the code. Open **Setup & sharing** at the bottom of the remote to set up sharing from your phone.

## Profiles

A profile is one person's, or one car's, own copy of everything: what's playing, Up Next, Recent, recent searches, For You, resume points, quality and format settings, paired phones and the Send to Car link. The passcode a device signs in with decides which profile it's in, so everyone uses the same address.

- **Getting a profile:** the person opens your address, taps **Ask for your own profile** on the sign-in page, and picks a name and a passcode. Their screen then shows a three-digit number and waits. You see their name and the same number in **Admin** (below). Tap **Allow** and their screen signs in by itself; tap **Decline** and nothing is made. Until you allow it, their passcode opens nothing.
- Only allow a request whose number matches the one on the person's screen. Your address is public, so anyone who finds it can ask, and the number is how you know a request is really from the person you think.
- Requests wait for up to a week, also across restarts and updates, so you can answer later. The person can close the page and come back with their passcode. At most five wait at a time, and one address can only ask a few times per ten minutes.
- Passcodes have to differ from each other, because the passcode is what tells profiles apart. Passcodes people choose or you add are stored scrambled.
- Each person pairs their phones from their own car's screen, or signs in on them with their passcode.
- Once there's more than one profile, the car page and the phone remote show which profile they're on.

A server set up before profiles existed keeps its car, phones and Shortcut as a profile called **Main**. `DRIVE_PASSCODE` used to open that profile and no longer does, so Main has no passcode: devices already on it stay signed in, and no new device can join except a phone paired from its car. In Admin you can give it a passcode and a new name and carry on with it, or remove it and start over with profiles of your own.

Each car that's playing needs its own share of the server and of your upload. Passing H.264 through is light enough for a Raspberry Pi 4 to serve two or three cars; converting to MPEG-1 at 1080p is one car's worth on a Pi 4. `MAX_STREAMS` is counted per profile.

### Admin

`https://your-address/admin` is where you run the server: it lists people waiting for a profile, every profile and whether its car is connected, and which update is running and since when.

- **Admin is opened with `DRIVE_PASSCODE`**, the passcode in `.env`, and that passcode opens nothing else. It isn't a profile's passcode and can't be chosen as one. Typed on the ordinary sign-in page, it takes you to Admin.
- **Being signed in to a profile doesn't open Admin.** A phone paired from a car's QR code is on that car's profile without ever having typed a passcode, so profiles and Admin are kept apart. The car page, the remote and Setup & sharing show nothing of Admin, and Admin has nothing of theirs.
- It works from any device and doesn't touch the profile that device is on. The device stays signed in to Admin for 30 days, or until you tap **Sign out of Admin on this device**. Changing `DRIVE_PASSCODE` signs every device out of Admin.
- People asking for a profile show up in Admin within a few seconds while the page is open. There is no notification anywhere else, so open Admin when someone tells you they've asked.
- From the profile list you can rename a profile, give it a new passcode, sign its devices out, or remove it. Removing a profile deletes its Up Next, history and settings.
- Pull down from the top of the page to reload it. That is for when Admin is on a phone's home screen, where there is no browser button to do it with.
- **Server** has a **Force update** button. It makes the server look for an update right now and install what it finds, even if a video is playing. The box around it says what the updater is doing: nothing, holding an update back for a video, installing one, or that one failed. See "Automatic updates" below.
- To stop taking requests, untick **Let new people ask for a profile**. The sign-in page then only takes passcodes that already work.
- You can also add a profile yourself: open **Add a profile yourself instead**, enter a name and a passcode, and tell the person the passcode.

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

It sets up a timer that keeps the updater running, and the updater looks at GitHub every couple of minutes. When there are new commits and nobody is watching a video, it pulls them and rebuilds. If a build fails, the version that was running stays up. An open car page reloads itself once the new version is running.

**An update never interrupts a video by itself.** While one is playing, the update waits, and goes in within a couple of minutes of the video being paused or ending.

**Force update** on the Admin page, under **Server**, is for when you don't want to wait. Tap it and the server looks on GitHub right then and installs whatever is new, whether or not a video is playing. If a video is playing it asks first, because the video stops when the server restarts; it then waits for a tap in the car, at the spot it had reached, and the car and the phone get a notice saying why. The box the button is in says where things stand:

| It says | Meaning |
|---|---|
| Updates | Nothing going on. Under the button it says when the server last looked on GitHub. |
| Up to date | You tapped the button and there was nothing newer on GitHub. |
| An update is waiting | An update, named by its ID and title, is being held back because a video is playing. Force update installs it now. |
| Installing an update | The new version is being built. The server restarts when it is ready. |
| Restarting with the new version | The server has stopped answering in the middle of an install: the new version is starting. The page reloads by itself once it is up, and says which update is now running. |
| An update couldn't be installed | The build failed and the old version is still running. The updater tries again in an hour; Force update tries again now. |
| Force update is lined up / about to be installed | The button was tapped in the short gap between two of the updater's runs. It takes effect at the next one, within about two minutes, and can be taken back until then. |
| Automatic updates aren't running | The updater hasn't been in touch for six minutes: it was never turned on, or the server can't reach GitHub. |
| Can't reach the server | The page itself can't get an answer (no update was going in). It keeps trying and carries on by itself. |

**The Admin page doesn't need reloading.** While it is open and in view, it keeps one request waiting on the server, which is answered the moment anything on the page changes: an update arriving, going in or failing, someone asking for a profile, a car coming or going. For as long as that page is open the server also looks on GitHub about every ten seconds instead of every couple of minutes (every thirty once the page has been open five minutes), so an update shows up within seconds of being pushed. When an update restarts the server, the page waits for the new version and loads its pages, unless you're in the middle of typing a name or passcode; then it waits for that. If the update didn't change the pages, it stays as it is and just says the server restarted.

The button and the page work at once because the updater doesn't just run every two minutes and leave. Started by its timer, it stays on the line to the app for up to half an hour at a time (a request the app answers the moment you tap, or when it is time for another look), looking at GitHub again every 100 seconds when nobody has the Admin page open. After installing an update it goes straight back on the line, to the new version. When its half hour is up it leaves and the timer starts it afresh two minutes later; in that gap the page says how long ago the last look was, and a tap on Force update is taken up at the next run. Run by hand in a terminal it doesn't stay, and isn't blocked by a run that is on the line.

To see which update is running, open **Admin** and look at **Version** under **Server**: it shows the commit's short ID and title, the same ones GitHub lists. The updater tells the build which commit it is. An image built by hand (`docker compose up -d --build`) isn't told, so Version says it wasn't recorded; the updater notices on its next run and builds once more to record it, which takes seconds because the code is the same.

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

## Security

DrivePost answers on a public address, so it is built to be left on one. This is what guards it, and what stays with you.

**What the app does**

- **Nothing opens without a sign-in.** A visitor without one gets the sign-in page and can ask for a profile, which opens nothing until you allow it in Admin. A device is signed in by a passcode, or by the one-time code in its car's QR (good for ten minutes). A profile's Send to Car link can send a link to that profile's car and nothing else.
- **Passcodes can't be guessed at any speed.** One address gets eight tries in ten minutes, and all the addresses of one IPv6 network count as one. After 40 wrong passcodes within an hour, from anywhere at all, signing in with a passcode closes until those are an hour old. Devices that are signed in don't notice, and a phone can still join from the QR on its car. Passcodes are stored scrambled (scrypt), so the data doesn't give them away either.
- **Only its own pages can work it.** A phone that is signed in visits other sites too. Anything that changes something, and every live connection, is refused unless it was made by one of DrivePost's own pages, so no other site can play, skip or steer anything with that phone's sign-in. That includes sites on sister addresses of your domain, which a browser trusts more than strangers. A link somewhere else that leads to `/share` only puts its address in the remote's box, where it waits for a tap.
- **Browsers are told to keep its pages to themselves.** The pages can't be shown inside another site's page, run no script but their own, and tell the sites they link to nothing about where the visitor came from. Reached over https, browsers are told to use nothing else for the next year.
- **Links and pages are kept off your home network.** A link that leads to an address on your own network is refused before anything is fetched, unless `OTHER_SITES_LOCAL=on`. The server's browser lives in a container with no network of its own; everything it fetches goes through the app, which refuses the same addresses, anything but web ports, and the app's own doors (see [Opening a page](#opening-a-page)).
- **The containers have no powers to lose.** Both run as an ordinary user, with every capability dropped and no way of gaining one.
- **Nonsense doesn't stop it.** A request or message it can't make sense of is dropped, whoever sent it, and the server carries on.

**What stays with you**

- **Passcodes.** The limits above make a long passcode impossible to guess and only slow down a short one: at 40 guesses an hour, four digits last days, and a few words last longer than the server will. That goes for `DRIVE_PASSCODE` most of all. Any passcode that works picks its own profile, so the shortest one on the server is the one a guesser finds.
- **Your GitHub account**, if automatic updates are on. Whatever is pushed to the branch the machine follows is built and run on it, so the account that can push there is a key to the machine: give it two-factor sign-in.
- **`.env`.** It holds the Admin passcode and the tunnel's token. Keep it readable by you alone (`chmod 600 .env`). If either has been pasted or photographed somewhere, replace it: a new `DRIVE_PASSCODE` signs every device out of Admin, and the tunnel's token is renewed in the Cloudflare dashboard.
- **Port 8080 on your home network.** Besides the tunnel, the app answers every device on your home network there, without https. If the tunnel is all you use, `LISTEN_ON=127.0.0.1` in `.env` keeps that port to the machine itself. A firewall such as `ufw` doesn't do this: Docker opens its ports past it.
- **The Send to Car link.** It has its key in it, so treat it as a password. **Setup & sharing** makes a new one, which stops the old one working.
- **The machine.** Keep its system updated, and its own sign-in (SSH) to keys or a good password.

**What isn't covered.** Once yt-dlp or ffmpeg is fetching a video, a site that sends them on to another address isn't checked again at each hop, so a link from the internet can still make the server ask for something on your home network. It takes a signed-in device to send such a link, and nothing but a video comes back from it. DrivePost also trusts the people you give profiles to with what they play: a profile can open any site in the server's browser.

A wrong passcode limit that suits a busier server is `WRONG_PASSCODES_AN_HOUR` in `.env` (40 if you don't say). Restarting the app (`docker compose restart drivepost`) forgets the count.

## Troubleshooting

| Symptom | Check |
|---|---|
| Test pattern plays, YouTube doesn't, or videos keep stopping to load | Run `docker compose exec -T drivepost node src/check-youtube.js`. It tries each way the server has of getting a video (see "Getting the video from YouTube"), and says which ones YouTube lets through from your connection right now, how long a wait each is behind, how fast the video comes in compared with how fast it plays, whether the sound comes with it, and how a skip lands. There are no links in the output. Add `--details` at the end for what each stream is made of and the skip tried several ways, which is what to send along when asking for help. If none work, yt-dlp probably needs updating (restart the container). Some videos (age-restricted, members-only) need a cookies file: put `cookies.txt` in the data volume and set `YTDLP_ARGS=--cookies /data/cookies.txt`. |
| "YouTube refused to send it (403 Forbidden)" | YouTube handed out links for the video and then refused to serve them, on every route. Run the check above. This is on YouTube's side and usually clears up by itself or with a yt-dlp update. |
| The picture is only 360p and a notice says so | YouTube is refusing the better routes from your connection, and the basic file is all that gets through. The server tries the better ones again after half an hour, then less often, and switches back by itself. |
| Frequent buffering | The car steps down by itself after three stalls in two minutes. To find the cause, tap **Stats**: a server speed under 1.1x means the machine can't convert that quality fast enough (MPEG-1) or can't fetch it fast enough (H.264). Otherwise it's the car's connection. |
| Choppy picture at 1080p | Tap **Stats**. In MPEG-1, if decoding takes more than about half of the time available per frame, the screen is the limit. In H.264, a climbing "skipped" count means the same. Use 720p. |
| A link from another site doesn't play | The car or phone says why in words. To look closer, run `docker compose exec -T drivepost node src/check-link.js "the link"` (see "Videos from other sites"). "Only shows that video to signed-in visitors" needs a cookies file, also described there. "No video was found at that link" means yt-dlp couldn't find a player on the page: a newer yt-dlp may (restart the container), and some sites it can't read at all. |
| No **Open the page itself** under Send a video | The browser container isn't connected. `docker compose ps` should list `browser` as running, and `docker compose logs browser` should end with `connected to DrivePost`. `PAGES=off` also takes it away. |
| A page opens but stays blank, or says the site can't be reached | Everything the browser fetches goes through DrivePost. `docker compose logs drivepost` has a `[page]` line for every opening and closing, and `docker compose logs browser` says what the browser made of the address. An address on your own network is refused on purpose. |
| A page's video is black or shows an error about protected content | The video is copy-protected, which this browser can't play. |
| A player's buttons on a page can't be found or hit | They hide until the mouse comes near. **Press and hold** on the video in the live view to bring them up, and tap the button at the right end of the Page card's bar for the big view, which makes them easy to hit. |
| Pause or the ten-second buttons do nothing on a page | They work what the browser knows is playing. A video that hasn't been started yet has to be started on the page first, and live television can't be skipped in. |
| A site on a page won't play, or asks for an ad blocker to be switched off | Switch **Block ads** off on the Page card. The page opens again without the blocker. |
| **Block ads** is on and a page still shows ads | If they are breaks in the video itself, they are part of the stream and can't be removed. Otherwise `docker compose logs browser` should have a line `ad blocker: uBlock Origin Lite` with its version near the top; if it says `none here`, the browser's image was built without it and only the block list is at work. |
| The update fails while building the `browser` image, at a `git fetch` step | That step fetches uBlock Origin Lite from GitHub. The old version keeps running and the updater tries again within the hour. |
| A page's "I'm not a robot" box spins and comes back | The site's check is failing the browser, not your tap (see "What it can't do" under [Opening a page](#opening-a-page)). |
| A page stutters in the car, or the car keeps starting it afresh | Usually the car's connection: tap **Stats** in the car, and lower **Quality** (each step is about half the data). If Stats shows the server behind instead, `docker stats` while it plays shows how busy `drivepost` and `browser` are. |
| `docker compose up` fails while creating the `fence` network (it may say *unknown gateway mode*) | The Docker on that machine is older than 28, the first that can keep a network off the machine it runs on. Update Docker (`curl -fsSL https://get.docker.com \| sh`) and run it again. |
| **The server's browser is showing a page in another car** | One page at a time for the whole server. It frees up when that car plays something else or the page is closed. |
| It plays MPEG-1 and you expected H.264 | Tap **Stats** and read the **Format** line: it says whether the browser can't decode H.264, the video has no H.264 version, H.264 failed earlier, or it's switched off on the phone. The **Browser** line lists what the browser can decode. H.264 needs the page to be on https. |
| H.264 misbehaves in the car | On the phone remote, set **Video format** to **MPEG-1**. Everything then works as it did before H.264 was added. |
| No sound | Tap the screen once. Browsers only allow sound after a tap. |
| Phone says "Car offline" | The car page isn't open, or the car is offline. |
| Sign-in says it is closed for a while | Forty wrong passcodes were tried within an hour, by you or by someone guessing (see [Security](#security)). It opens again by itself as they pass an hour old, and `docker compose restart drivepost` opens it now. `docker compose logs drivepost` has a `[security]` line for when it closed. Devices that are signed in are not affected. |
| Buttons do nothing and the page says it can't connect, right after putting the server behind a different address or proxy | The app only takes orders from its own pages, and tells them by their address. `docker compose logs drivepost` then has a line starting `[security] turned away a request made by a page on`. Set `PUBLIC_URL` in `.env` to the address people type, and restart. |
| A link shared to DrivePost lands in the remote's box instead of playing | It came by way of another site's page or link, not from the phone's own share sheet. That is on purpose (see [Security](#security)): tap a button to send it. |

## Fullscreen in a Tesla

Tesla only lets its browser take over the entire display in Park. While driving, the browser keeps its own window, so DrivePost's fullscreen fills that window. It also asks the browser for true fullscreen, which works on phones and computers and is ignored where the browser doesn't allow it.

## Notes

- A screen showing video in view of the driver while the car is moving is illegal in many places, including Florida (§316.303). This is built for passengers.
- YouTube's terms don't allow downloading videos outside their own apps, and other sites' terms say much the same. Keep this for your own use, not as a public service.
- Cloudflare's terms limit using its network mainly for video. A personal tunnel for one car is low volume, but if that's a concern, use a port forward with a reverse proxy such as Caddy instead.

## The look

The pages are drawn in the style of Rig UI, a component library by the same author: its colours, corner radii and shadows, with buttons, fields, cards, tabs, the toggle group, the alert and the player's bar each drawn the way the matching Rig UI component is. It is the style only. The pages are still plain HTML with one stylesheet, `server/public/app.css`, and don't load the component library, so there is none of its motion or sound.

- The tokens at the top of `app.css` (`--rig-bg`, `--rig-accent` and so on) are copied from Rig UI's `rig.css`. To pick up a change there, copy the three token blocks across again: light, dark by the device's setting, and dark by `data-theme`.
- Rig UI's amber "signal" colour is left out on purpose. The seek bar, watched-so-far marks and focus rings are the accent blue.
- The phone pages (remote, setup, sign-in, Admin) follow the phone's light or dark setting. The car page is always dark, because it is a video player on a screen next to the driver: `car.html` says `data-theme="dark"`. Take that attribute off and it follows the car's browser instead.

## Project layout

```
browser/         The browser pages are opened in: its image, and the program that is its remote desktop
scripts/         Automatic updates (timer installer and the update script), iPhone Shortcut builder and checker
shortcut/        The iPhone Shortcut, unsigned, for reading
server/src/      Node server: auth, state, yt-dlp, links to other sites, pages, ffmpeg streaming, TS chunker
server/public/   Car page, phone remote, setup page, Admin, the one stylesheet (app.css), JSMpeg
server/test/     Unit tests (npm test)
test/            The original side-by-side Drive test page
```

JSMpeg is © Dominic Szablewski, MIT license (`JSMPEG-LICENSE.txt`).
