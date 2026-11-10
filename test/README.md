# Drive Test (proof of concept)

A one-page test for the Tesla browser. It plays the same clip two ways side by side and shows which one keeps playing after the car shifts out of Park:

- **A · Normal video** — the browser's built-in `<video>` player (H.264 MP4, muted)
- **B · Canvas (JSMpeg)** — MPEG-1 decoded in JavaScript/WebAssembly and drawn to a `<canvas>`, audio through Web Audio

Each tile shows a live PLAYING / STOPPED badge, a frame counter and FPS. The log records every pause, stall and retry with a timestamp. "Browser details" lists the Tesla browser's Chrome version and whether it supports WebCodecs, WebGL, WebAssembly and Web Audio, which decides how the real app should be built.

## Files

| File | What it is |
|---|---|
| `index.html` | The test page |
| `jsmpeg.min.js` | [JSMpeg](https://github.com/phoboslab/jsmpeg) by Dominic Szablewski, MIT license (`JSMPEG-LICENSE.txt`) |
| `clip-canvas.ts` | 20 s generated test pattern, MPEG-1 video + MP2 audio in MPEG-TS (for B) |
| `clip-native.mp4` | Same pattern, H.264 + AAC (for A) |

It's all static, so there's no build step.

## Deploy to Cloudflare Pages

**From GitHub:** push this folder to a repo, create a Pages project connected to it, leave the framework preset as None, leave the build command empty and set the output directory to `/`. Then add a custom domain such as `drivetest.figari.dev`.

**Or straight from your machine:**

```sh
npx wrangler pages deploy . --project-name drive-test
```

## Running the test

1. In Park, open the page in the Tesla browser and tap **Start**. Both tiles should say PLAYING.
2. Foot on the brake, shift into **D**. You don't need to move.
3. Wait about 10 seconds and note which tiles still say PLAYING, and whether you still hear the tick.
4. Shift back to **P** and take a photo of the log and the Browser details section.

If B keeps playing in Drive, the JSMpeg pipeline (yt-dlp → ffmpeg → MPEG-1 over WebSocket → canvas) is the way to build the real app. If B stops too, the next thing to try is WebCodecs, if Browser details says it's supported.
