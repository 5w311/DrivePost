import { spawn } from 'node:child_process';
import { config } from './config.js';
import { streamInfo, forgetStream, routeOrder, routeWorked, routeRefused, routeNotice, linkStatus, NO_SUCH_FORMAT, TEST_PATTERN_ID } from './youtube.js';
import { isLinkId, linkStreamInfo, forgetLink, guardedFetch, LINK_PROTOCOLS } from './links.js';
import { trimList, offerList } from './segment-list.js';
import { TsSplitter, KIND_VIDEO } from './ts-chunker.js';

// How far ahead of the car's playback the server reads before pausing
// ffmpeg, and where it starts again.
//
// H.264: this is the loaded stretch on the car's seek bar, which the car can
// skip around in without a new stream. Two minutes of it, topped up every few
// seconds, so the bar keeps creeping ahead as the video plays.
// MPEG-1: the car can't skip within what it holds, and converting is real
// work for the server, so only enough to ride out a bad patch of signal.
const AHEAD = {
  h264: { high: 120, low: 117 },
  mpeg1: { high: 25, low: 12 },
};
// This much picture sent and still no sound, on a video that has sound: the route isn't delivering it.
const SILENT_AFTER = 20;
// Videos already started over for that, and when: once is enough, in case the video really is silent there.
const startedOverForSound = new Map();
const BACKLOG_HIGH = 4 * 1024 * 1024;
const BACKLOG_LOW = 1024 * 1024;

// MP2 audio needs more bits than modern formats; 192k is where it stops
// sounding rough, so the two higher tiers get that.
const PRESETS = {
  360: { height: 360, kbps: 700, audioKbps: 128 },
  480: { height: 480, kbps: 1300, audioKbps: 128 },
  720: { height: 720, kbps: 2600, audioKbps: 192 },
  1080: { height: 1080, kbps: 5000, audioKbps: 192 },
};

const AUDIO_RATES = [32000, 44100, 48000];
const HEADER_BYTES = 9; // float64 timestamp + 1 byte kind (0 video, 1 audio)

// Streams that are running, per profile, so one profile's cars can't push out another's.
const activeByGroup = new Map();

// MPEG-1 only allows a handful of frame rates. Keep the video's own rate when
// it's one of them (films stay 24, European TV stays 25) and halve 50/60.
// Converting everything to 30 wastes bits on repeated frames and stutters.
export function outputRate(fps) {
  let f = Number(fps);
  if (!(f > 0)) return { expr: '30', fps: 30 };
  while (f > 31) f /= 2;
  if (f < 23) {
    // Unusual low rates: repeat whole frames (15 → 30, 12 → 24), else use 30.
    f = [f * 2, f * 3].find((m) => m >= 23 && m <= 31) || 30;
  }
  const rates = [
    ['24000/1001', 24000 / 1001],
    ['24', 24],
    ['25', 25],
    ['30000/1001', 30000 / 1001],
    ['30', 30],
  ];
  let best = rates[0];
  for (const r of rates) if (Math.abs(r[1] - f) < Math.abs(best[1] - f)) best = r;
  return { expr: best[0], fps: best[1] };
}

export function streamPlan(info, quality) {
  const preset = PRESETS[quality] || PRESETS[480];
  return {
    height: Math.min(preset.height, info.height || preset.height),
    kbps: preset.kbps,
    audioKbps: preset.audioKbps,
    rate: outputRate(info.fps),
  };
}

// Which picture format to send.
//   h264:  YouTube's own H.264 video passed through untouched. Sharper, about
//          half the data, and almost no work for this machine. Needs a car
//          browser that can decode it (WebCodecs) and a video YouTube has in
//          H.264, which is nearly all of them up to 1080p.
//   mpeg1: converted here and decoded by JSMpeg in the car. Works everywhere.
// Live streams are always converted: their timestamps can jump, and
// converting smooths that out.
export function chooseCodec(want, info, canEncodeH264 = true) {
  if (want !== 'h264' || info.live) return 'mpeg1';
  if (info.inputs.some((i) => i.lavfi)) return canEncodeH264 ? 'h264' : 'mpeg1'; // the test pattern
  // Another site's video that can't be passed on as it is (links.js says why).
  if (info.convert) return 'mpeg1';
  return /^avc1/i.test(info.vcodec || '') ? 'h264' : 'mpeg1';
}

// The test pattern has no H.264 original to pass through, so it's encoded
// here. Check once whether this ffmpeg can do that.
let x264Check = null;
export function canEncodeH264() {
  if (!x264Check) {
    x264Check = new Promise((resolve) => {
      let out = '';
      const p = spawn(config.ffmpegBin, ['-hide_banner', '-h', 'encoder=libx264'], { stdio: ['ignore', 'pipe', 'ignore'] });
      p.stdout.on('data', (d) => (out += d));
      p.on('error', () => resolve(false));
      p.on('close', () => resolve(/Encoder libx264/.test(out)));
    });
  }
  return x264Check;
}

function inputArgs(input, startAt, live, cut) {
  const a = [];
  if (input.lavfi) {
    // Generated test source: seeking would render every skipped frame, so
    // start fresh and just shorten it instead.
    const source = startAt > 0 ? input.lavfi.replace(/duration=(\d+)/, (_, d) => `duration=${Math.max(1, d - startAt)}`) : input.lavfi;
    a.push('-f', 'lavfi', '-i', source);
    return a;
  }
  // A file is picked up again where it left off if the connection drops. Not
  // for a segmented stream: there ffmpeg would take the end of every segment
  // for a dropped connection and pause to "reconnect", crawling along slower
  // than the video plays. Its own reader moves from segment to segment.
  if (!input.list) a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5');
  // Another site's link: whatever it leads to, ffmpeg reads from the web and nothing else.
  if (input.other) a.push('-protocol_whitelist', LINK_PROTOCOLS);
  const headers = Object.entries(input.headers || {})
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  if (headers) a.push('-headers', headers);
  // A list cut to begin at the right segment is read from its top: no seeking.
  if (startAt > 0 && !live && !cut) a.push('-ss', String(startAt));
  a.push('-i', cut ? cut.url : input.url);
  return a;
}

// Every segmented input cut to start at `startAt`, or nothing: a mix of cut
// and seeking inputs would put picture and sound on different clocks.
function usableCuts(info, startAt, cuts) {
  const lists = info.inputs.filter((i) => i.list);
  return startAt > 0 && !info.live && cuts && lists.length > 0 && lists.every((i) => cuts.get(i)) ? cuts : null;
}

/*
 * `cuts` is for a segmented stream started partway through (segment-list.js):
 * a Map from each such input to { url, begins }, the list cut to begin with
 * the segment that holds `startAt` and the time that segment begins at.
 */
export function ffmpegArgs(info, startAt, quality, audioRate = 48000, codec = 'mpeg1', cuts = null) {
  const plan = streamPlan(info, quality);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  cuts = usableCuts(info, startAt, cuts);
  // A segmented stream's picture and sound come as two lists on one shared
  // clock. Keeping that clock, instead of letting ffmpeg restart each at
  // zero, is what keeps them in step, from the start and after a skip.
  const sharedClock = !info.live && info.inputs.every((i) => i.list) && (!(startAt > 0) || !!cuts);
  if (sharedClock) args.push('-copyts');
  info.inputs.forEach((input) => args.push(...inputArgs(input, startAt, info.live, cuts && cuts.get(input))));

  const v = info.inputs.findIndex((i) => i.hasVideo);
  const a = info.inputs.findIndex((i) => i.hasAudio);
  if (v < 0) throw new Error('This video has no picture');
  args.push('-map', `${v}:v:0`);
  // Another site's file may turn out to have no sound in it after all: "?" plays it silent instead of failing.
  if (a >= 0) args.push('-map', `${a}:a:0${info.inputs[a].other ? '?' : ''}`);

  const max = Math.round(plan.kbps * 1.3);
  if (codec === 'h264' && info.inputs[v].lavfi) {
    // Test pattern: encode it the way YouTube's files are (with B-frames).
    args.push(
      '-vf', 'format=yuv420p',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-g', '60', '-crf', '23',
      '-maxrate', `${plan.kbps}k`, '-bufsize', `${plan.kbps * 2}k`
    );
  } else if (codec === 'h264') {
    // Pass YouTube's H.264 through as it is; only the container changes.
    // Another site's goes through without the notes some encoders put in
    // beside the picture (SEI). Nothing here needs them, and a browser's
    // decoder gives up on a stream that has one ahead of what it refers to.
    args.push('-c:v', 'copy', '-bsf:v', info.inputs[v].other ? 'h264_mp4toannexb,filter_units=remove_types=6' : 'h264_mp4toannexb');
  } else {
    // Converted picture from a cut list: leave out the frames before the spot asked for.
    const early = cuts ? Math.max(0, startAt - cuts.get(info.inputs[v]).begins) : 0;
    const fromSpot = early > 0 ? `select='gte(t-start_t,${early.toFixed(3)})',` : '';
    args.push(
      '-vf', `${fromSpot}scale=-2:'${info.inputs[v].other ? `trunc(min(${plan.height},ih)/2)*2` : `min(${plan.height},ih)`}':flags=bicubic,fps=${plan.rate.expr},format=yuv420p`,
      '-c:v', 'mpeg1video', '-b:v', `${plan.kbps}k`, '-maxrate', `${max}k`, '-bufsize', `${max}k`,
      '-bf', '0', '-g', String(Math.round(plan.rate.fps * 2))
    );
  }
  if (a >= 0) {
    if (cuts) {
      // The sound's segment begins before the spot asked for. Drop the part
      // before it, counted in samples, so the sound begins exactly there.
      const early = Math.max(0, startAt - cuts.get(info.inputs[a]).begins);
      args.push('-af', `aresample=${audioRate},atrim=start_sample=${Math.round(early * audioRate)}`);
    }
    args.push('-c:a', 'mp2', '-b:a', `${plan.audioKbps}k`, '-ar', String(audioRate), '-ac', '2');
  } else args.push('-an');
  // The tiny muxdelay also makes ffmpeg write each audio frame as its own
  // packet with its own timestamp, which the splitter relies on.
  args.push('-sn', '-dn', '-f', 'mpegts', '-muxdelay', '0.001', '-muxpreload', '0', 'pipe:1');
  return args;
}

function sendJson(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// What a site's answer to a request means, in words. `who` is the site: YouTube, unless it is someone else's link.
export function refusalReason(status, who = 'YouTube') {
  if (status === 403) return `${who} refused to send it (403 Forbidden)`;
  if (status === 429) return `${who} is turning this server away for now (429 Too Many Requests)`;
  if (status === 404 || status === 410) return `the link ${who} gave for it has stopped working (${status})`;
  if (status >= 500) return `${who}'s server had a problem (${status})`;
  return `${who} answered ${status}`;
}

// When a lower quality than asked for is all there is, say so, but not for every video.
const noticedAt = new Map();
function noticeDue(group, name, now = Date.now()) {
  const key = `${group}:${name}`;
  if (now - (noticedAt.get(key) || 0) < 60 * 60 * 1000) return false;
  noticedAt.set(key, now);
  return true;
}

const WAIT_GLADLY = 1500; // a wait this short isn't worth looking for another route
const WAIT_AT_MOST = 90 * 1000; // an ad break longer than this is treated as a refusal

/*
 * Find this video by a route that is ready and really delivers (see ROUTES
 * in youtube.js).
 *
 * A route can come back with links that aren't to be used yet (YouTube
 * holds the media back for the length of an ad). If another route is ready
 * now, that one is used; otherwise the server waits for the one that is
 * ready soonest. Every link is tried before it is used, because a refused
 * route still hands out links: they just answer 403.
 *
 * Returns { info } or { message } to show in the car. `onWait(seconds)` is
 * called when it has to sit out a wait.
 */
export async function findPlayable(id, quality, deps = {}) {
  if (isLinkId(id)) return findLinked(id, quality, deps);
  const lookup = deps.streamInfo || streamInfo;
  const status = deps.linkStatus || linkStatus;
  const sleep = deps.sleep || ((ms) => new Promise((done) => setTimeout(done, ms)));
  const now = deps.now || Date.now;
  const order = id === TEST_PATTERN_ID ? ['direct'] : routeOrder();
  let refused = null; // YouTube's answer when a route's link was turned down
  let lookupError = null; // something wrong with the video, or with looking it up
  let nothingThere = false; // a route simply had no such file for it
  const later = []; // routes whose links can't be used yet
  const lists = new Map(); // the segment lists fetched while checking, by input

  // Do this route's links deliver? Stale ones are replaced before the route is blamed.
  const delivers = async (name, found) => {
    const check = async (info) => {
      const answers = await Promise.all(info.inputs.filter((i) => i.url).map((i) => status(i, undefined, lists)));
      return answers.find((a) => a !== 200 && a !== 206);
    };
    let bad = await check(found);
    if (bad !== undefined && now() - (found.at || 0) > 60000) {
      forgetStream(id, quality);
      found = await lookup(id, quality, name);
      if ((found.readyAt || 0) - now() > WAIT_GLADLY) return { later: found };
      bad = await check(found);
    }
    if (bad === undefined) return { info: found };
    refused = refused ?? bad;
    forgetStream(id, quality);
    routeRefused(name, refusalReason(bad));
    return {};
  };

  for (const name of order) {
    // A better route is nearly ready: waiting for it beats settling for less.
    if (later.length && Math.min(...later.map((l) => l.found.readyAt)) - now() <= 15000) break;
    try {
      const found = await lookup(id, quality, name);
      if ((found.readyAt || 0) - now() > WAIT_GLADLY) {
        later.push({ name, found });
        continue;
      }
      const result = await delivers(name, found);
      if (result.info) return { info: result.info, lists };
      if (result.later) later.push({ name, found: result.later });
    } catch (err) {
      // "No such format" is about this route: on to the next.
      if (NO_SUCH_FORMAT.test(err.message || '')) {
        nothingThere = true;
        continue;
      }
      lookupError = lookupError || err;
      // Anything else that isn't a hiccup (private, removed, age-restricted...)
      // is about the video, and no other route will change it.
      if (!/timed out|fetch failed|aborted/i.test(err.message || '')) break;
    }
  }

  // Nothing was ready. Sit out the shortest wait, then the next shortest if that one is refused.
  later.sort((a, b) => a.found.readyAt - b.found.readyAt);
  for (const { name, found } of later) {
    const wait = found.readyAt - now();
    if (wait > WAIT_AT_MOST) {
      refused = refused ?? 403;
      continue;
    }
    if (wait > 0) {
      if (deps.onWait) deps.onWait(Math.ceil(wait / 1000));
      await sleep(wait + 300);
    }
    try {
      const result = await delivers(name, found);
      if (result.info) return { info: result.info, lists };
    } catch (err) {
      if (NO_SUCH_FORMAT.test(err.message || '')) nothingThere = true;
      else lookupError = lookupError || err;
    }
  }

  if (refused !== null) return { message: `Couldn't play this video: ${refusalReason(refused)}` };
  if (lookupError) return { message: `Couldn't load this video: ${lookupError.message}` };
  return { message: `Couldn't load this video: ${nothingThere ? 'YouTube has no version of it that this server can play' : 'nothing playable was found'}` };
}

/*
 * The same for a video from another site (links.js). There are no routes to
 * choose between: the site has it or it doesn't. Its media links are still
 * tried before they are used, and looked up afresh once if they have gone
 * stale. Every request is kept to addresses out on the internet.
 */
async function findLinked(id, quality, deps = {}) {
  const lookup = deps.linkStreamInfo || linkStreamInfo;
  const status = deps.linkStatus || linkStatus;
  const fetchImpl = deps.fetch || guardedFetch;
  const now = deps.now || Date.now;
  const lists = new Map();
  // A plain "no": anything less clear is left for ffmpeg to find out.
  const refusal = (a) => a === 401 || a === 403 || a === 404 || a === 410 || a === 429 || a >= 500;
  const check = async (info) => (await Promise.all(info.inputs.map((i) => status(i, fetchImpl, lists)))).find(refusal);
  let site = 'the site';
  try {
    let info = await lookup(id, quality);
    site = info.site || site;
    let bad = await check(info);
    if (bad !== undefined && now() - (info.at || 0) > 60000) {
      forgetLink(id);
      info = await lookup(id, quality);
      bad = await check(info);
    }
    if (bad === undefined) return { info, lists };
    forgetLink(id);
    return { message: `Couldn't play this video: ${refusalReason(bad, site)}` };
  } catch (err) {
    forgetLink(id);
    const said = String((err && err.message) || '');
    return { message: `Couldn't load this video: ${/fetch failed|timed out|aborted|terminated/i.test(said) ? `this server couldn't reach ${site}` : said}` };
  }
}

// Why ffmpeg gave up, in words. Its own last line starts with the whole
// media link, which is hundreds of characters long, means nothing on a car
// screen, and has this server's home address in it. So links are taken out
// and the part that says what happened is kept.
export function failureReason(stderr, code, who = 'YouTube') {
  const lines = String(stderr || '')
    .split('\n')
    .map((l) => l.replace(/https?:\/\/\S+/g, '').replace(/^\[[^\]]*\]\s*/, '').replace(/^[\s:]+/, '').trim())
    .filter(Boolean);
  const telling = /returned|HTTP error|forbidden|too many|timed out|refused|reset|unreachable|resolve|invalid data|not found|end of file|i\/o error/i;
  const raw = [...lines].reverse().find((l) => telling.test(l)) || lines.pop() || `ffmpeg exited with ${code}`;
  // The line that names the status isn't always the last one ("HTTP error 429
  // Too Many Requests" is followed by a vaguer "Server returned 4XX").
  const all = lines.join('\n');
  const status = (all.match(/HTTP error (\d{3})/i) || all.match(/returned (\d{3})\b/i) || [])[1];
  let said;
  if (status === '403') said = `${who} refused to send it (403 Forbidden)`;
  else if (status === '429') said = `${who} is turning this server away for now (429 Too Many Requests)`;
  else if (status === '404' || status === '410') said = `the link ${who} gave for it has stopped working (${status})`;
  else if (status && status[0] === '5') said = `${who}'s server had a problem (${status})`;
  else if (/timed out|refused|reset|unreachable|resolve|network/i.test(raw)) said = `this server couldn't reach ${who} (${raw.slice(0, 80)})`;
  else said = raw.slice(0, 140);
  return { said, raw: raw.slice(0, 300) };
}

/*
 * For a stream started partway through: each segmented input's list, cut to
 * begin with the segment that holds `startAt` and made fetchable by ffmpeg
 * (segment-list.js). `lists` are the lists as fetched moments ago. Returns a
 * Map from input to { url, begins }, or null when there is nothing to cut or
 * a list can't be cut; ffmpeg then seeks by itself, as it does in a file.
 * Whatever was handed over is added to `handedOver`, to be taken away again
 * when the stream closes.
 */
export async function cutLists(info, startAt, lists, handedOver = []) {
  const segmented = info.inputs.filter((i) => i.list);
  if (!(startAt > 0) || info.live || !lists || !segmented.length) return null;
  const cuts = new Map();
  for (const input of segmented) {
    const cut = lists.has(input) ? trimList(lists.get(input), input.url, startAt) : null;
    if (!cut) return null;
    try {
      const list = await offerList(cut.text);
      handedOver.push(list);
      cuts.set(input, { url: list.url, begins: cut.begins });
    } catch {
      return null;
    }
  }
  return cuts;
}

// One car connection = one ffmpeg process.
export async function handleStream(ws, { id, startAt, quality, audioRate, want, group = 'main' }) {
  const handedOver = []; // lists made fetchable for this stream's ffmpeg
  // YouTube's videos come by one of several routes, which are kept score of. The test pattern and other sites' links don't.
  const byRoute = id !== TEST_PATTERN_ID && !isLinkId(id);
  const forget = () => (isLinkId(id) ? forgetLink(id) : forgetStream(id, quality));
  if (!AUDIO_RATES.includes(audioRate)) audioRate = 48000;
  let ff = null;
  let closed = false;
  let killed = false;
  let flowPaused = false;
  let clientClock = null;
  let lastSentPts = null;
  let stderr = '';
  let codec = 'mpeg1';
  let passthrough = false;

  const entry = { close: () => ws.close(4000, 'replaced') };
  if (!activeByGroup.has(group)) activeByGroup.set(group, new Set());
  const active = activeByGroup.get(group);
  active.add(entry);
  while (active.size > config.maxStreams) {
    const oldest = active.values().next().value;
    active.delete(oldest);
    oldest.close();
  }

  // How fast this machine converts, measured while filling the car's buffer.
  // Shows in `docker compose logs` and in the car's Stats readout.
  let firstDataAt = null;
  let speedLogged = false;
  function logSpeed(note) {
    if (speedLogged || firstDataAt === null || lastSentPts === null || splitter.firstVideoPts === null) return;
    const media = lastSentPts - splitter.firstVideoPts;
    const wall = (Date.now() - firstDataAt) / 1000;
    if (media < 5 || wall <= 0) return;
    speedLogged = true;
    const x = media / wall;
    const verdict = x >= 1.5 ? 'OK' : x >= 1.1 ? 'tight' : 'too slow, try a lower quality';
    const doing = passthrough ? 'passing H.264 through' : codec === 'h264' ? 'making H.264' : 'converting';
    // Passing through runs far ahead of the car, so being held back means nothing there.
    const shown = note && !(passthrough && x >= 1.5) ? `, ${note}` : '';
    console.log(`[stream ${id}] ${quality}p ${doing} at ${x.toFixed(1)}x real time (${verdict})${shown}`);
    sendJson(ws, { type: 'speed', x: Math.round(x * 10) / 10, limitedByNetwork: !!shown });
  }

  let baseSent = false;
  let soundPieces = 0;
  let delivered = false; // picture has come through, and sound too if there is any
  let soundGivenUp = false;

  /*
   * Plenty of picture has gone out and not one piece of sound, on a video
   * that has sound. Rest this route and have the car start the video over,
   * which takes the next route. Once per video: if it comes out silent that
   * way too, it plays as it is.
   */
  function noSound() {
    if (soundGivenUp || closed || id === TEST_PATTERN_ID) return;
    soundGivenUp = true;
    const now = Date.now();
    for (const [key, when] of startedOverForSound) if (now - when > 10 * 60 * 1000) startedOverForSound.delete(key);
    console.warn(`[stream ${id}] no sound is coming through | ${quality}p ${codec}, ${info.route || 'unknown route'}, starting at ${Math.round(startAt)}s`);
    // Another site's video has no other route to come by: it plays as it is.
    if (!byRoute || startedOverForSound.has(id)) return;
    startedOverForSound.set(id, now);
    routeRefused(info.routeName, 'no sound came through');
    sendJson(ws, { type: 'notice', message: 'No sound was coming through, so the server is getting this video another way.' });
    sendJson(ws, { type: 'restart' });
    killed = true;
    if (ff) ff.kill('SIGKILL');
    ws.close();
  }

  const splitter = new TsSplitter(
    (kind, pts, frame) => {
      if (closed) return;
      if (kind === KIND_VIDEO) {
        if (!baseSent) {
          sendJson(ws, { type: 'base', pts: splitter.firstVideoPts });
          baseSent = true;
        }
        if (firstDataAt === null) firstDataAt = Date.now();
        // H.264 frames aren't sent in display order, so keep the furthest one.
        lastSentPts = lastSentPts === null ? pts : Math.max(lastSentPts, pts);
      } else {
        soundPieces++;
      }
      // Picture is flowing, and sound with it if the video has any: this route delivers.
      if (!delivered && baseSent && (soundPieces || !info.inputs.some((i) => i.hasAudio))) {
        delivered = true;
        if (byRoute) routeWorked(info.routeName);
      }
      frame.writeDoubleLE(pts, 0);
      frame.writeUInt8(kind, 8);
      ws.send(frame);
      if (kind === KIND_VIDEO) {
        if (lastSentPts - splitter.firstVideoPts >= 20) logSpeed();
        if (!delivered && lastSentPts - splitter.firstVideoPts >= SILENT_AFTER) noSound();
        checkFlow();
      }
    },
    { prefix: HEADER_BYTES }
  );

  function ahead() {
    if (lastSentPts === null) return 0;
    const base = clientClock ?? splitter.firstVideoPts ?? lastSentPts;
    return lastSentPts - base;
  }

  function checkFlow() {
    if (!ff) return;
    const a = ahead();
    const backlog = ws.bufferedAmount;
    const limit = AHEAD[codec] || AHEAD.mpeg1;
    if (!flowPaused && (a > limit.high || backlog > BACKLOG_HIGH)) {
      logSpeed(backlog > BACKLOG_HIGH ? "held back by the car's connection, not the CPU" : '');
      ff.stdout.pause();
      flowPaused = true;
    } else if (flowPaused && a < limit.low && backlog < BACKLOG_LOW) {
      ff.stdout.resume();
      flowPaused = false;
    }
  }
  const flowTimer = setInterval(checkFlow, 500);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (typeof msg.clock === 'number') {
        clientClock = msg.clock;
        checkFlow();
      }
    } catch {}
  });

  ws.on('close', () => {
    closed = true;
    handedOver.forEach((list) => list.done());
    active.delete(entry);
    if (!active.size && activeByGroup.get(group) === active) activeByGroup.delete(group);
    clearInterval(flowTimer);
    if (ff) {
      killed = true;
      ff.kill('SIGKILL');
    }
  });

  const playable = await findPlayable(id, quality, {
    // Only worth mentioning when it's long enough to wonder about.
    onWait: (seconds) => {
      if (seconds >= 4) sendJson(ws, { type: 'notice', message: `YouTube makes this server wait ${seconds} seconds before it sends this video.` });
    },
  });
  if (closed) return;
  if (!playable.info) {
    sendJson(ws, { type: 'error', message: playable.message });
    ws.close();
    return;
  }
  const info = playable.info;

  const plan = streamPlan(info, quality);
  codec = chooseCodec(want, info, await canEncodeH264());
  if (closed) return;
  passthrough = codec === 'h264' && !info.inputs.some((i) => i.lavfi);
  sendJson(ws, {
    type: 'meta',
    duration: info.duration,
    live: info.live,
    startAt: info.live ? 0 : startAt,
    codec,
    audio: info.inputs.some((i) => i.hasAudio),
    // Another site's video that has to be converted: why, for the car's Stats.
    why: (codec === 'mpeg1' && want === 'h264' && !info.live && info.convert) || undefined,
    // Passed-through video keeps YouTube's own frame rate and bitrate.
    fps: passthrough ? info.fps || null : codec === 'h264' ? 30 : plan.rate.fps,
    kbps: passthrough ? (info.tbr ? Math.round(info.tbr) : null) : plan.kbps,
  });
  const notice = byRoute ? routeNotice(info.routeName) : '';
  if (notice && noticeDue(group, info.routeName)) sendJson(ws, { type: 'notice', message: notice });

  // Starting partway through a segmented stream: give ffmpeg lists that begin there.
  const cuts = await cutLists(info, startAt, playable.lists, handedOver);
  playable.lists = null; // they can be large, and the stream may run for hours
  if (closed) {
    handedOver.forEach((list) => list.done());
    return;
  }
  if (!cuts && startAt > 0 && !info.live && info.inputs.some((i) => i.list)) {
    console.warn(`[stream ${id}] couldn't cut the segment list to start at ${Math.round(startAt)}s; ffmpeg is seeking in it by itself, so picture and sound may be out of step`);
  }

  let args;
  try {
    args = ffmpegArgs(info, startAt, quality, audioRate, codec, cuts);
  } catch (err) {
    sendJson(ws, { type: 'error', message: err.message });
    ws.close();
    return;
  }

  ff = spawn(config.ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.stdout.on('data', (d) => splitter.push(d));
  ff.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-2000);
  });
  ff.on('error', (err) => {
    sendJson(ws, { type: 'error', message: `Could not start ffmpeg: ${err.message}` });
    ws.close();
  });
  ff.on('close', (code) => {
    if (closed || killed) return;
    splitter.flush();
    logSpeed();
    if (code !== 0) {
      const why = failureReason(stderr, code, info.site || 'YouTube');
      // For whoever reads the log: what failed and which way the video was being fetched.
      console.warn(`[stream ${id}] ffmpeg exited ${code} ${lastSentPts === null ? 'before sending anything' : 'partway'}: ${why.raw} | ${quality}p ${codec}, ${info.route || 'unknown route'}, starting at ${Math.round(startAt)}s`);
      // Media links expire; make the next attempt fetch fresh ones.
      forget();
      if (lastSentPts === null) {
        // Checked out fine, yet ffmpeg couldn't use it: the next try takes another route.
        if (byRoute) routeRefused(info.routeName, why.raw);
        sendJson(ws, { type: 'error', message: `Couldn't play this video: ${why.said}` });
        ws.close();
        return;
      }
    }
    const played = lastSentPts !== null && splitter.firstVideoPts !== null ? lastSentPts - splitter.firstVideoPts : 0;
    const complete =
      code === 0 && (info.live || !info.duration || startAt + played >= info.duration - 5);
    sendJson(ws, { type: 'end', complete });
    // Let the car drain its buffer; it closes the socket when done.
  });
}
