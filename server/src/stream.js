import { spawn } from 'node:child_process';
import { config } from './config.js';
import { streamInfo, forgetStream, routeOrder, routeWorked, routeRefused, routeNotice, linkStatus, TEST_PATTERN_ID } from './youtube.js';
import { TsSplitter, KIND_VIDEO } from './ts-chunker.js';

// How far ahead of the car's playback we transcode before pausing ffmpeg.
const AHEAD_HIGH = 25;
const AHEAD_LOW = 12;
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

function inputArgs(input, startAt, live) {
  const a = [];
  if (input.lavfi) {
    // Generated test source: seeking would render every skipped frame, so
    // start fresh and just shorten it instead.
    const source = startAt > 0 ? input.lavfi.replace(/duration=(\d+)/, (_, d) => `duration=${Math.max(1, d - startAt)}`) : input.lavfi;
    a.push('-f', 'lavfi', '-i', source);
    return a;
  }
  a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5');
  const headers = Object.entries(input.headers || {})
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  if (headers) a.push('-headers', headers);
  if (startAt > 0 && !live) a.push('-ss', String(startAt));
  a.push('-i', input.url);
  return a;
}

export function ffmpegArgs(info, startAt, quality, audioRate = 48000, codec = 'mpeg1') {
  const plan = streamPlan(info, quality);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  info.inputs.forEach((input) => args.push(...inputArgs(input, startAt, info.live)));

  const v = info.inputs.findIndex((i) => i.hasVideo);
  const a = info.inputs.findIndex((i) => i.hasAudio);
  if (v < 0) throw new Error('This video has no picture');
  args.push('-map', `${v}:v:0`);
  if (a >= 0) args.push('-map', `${a}:a:0`);

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
    args.push('-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb');
  } else {
    args.push(
      '-vf', `scale=-2:'min(${plan.height},ih)':flags=bicubic,fps=${plan.rate.expr},format=yuv420p`,
      '-c:v', 'mpeg1video', '-b:v', `${plan.kbps}k`, '-maxrate', `${max}k`, '-bufsize', `${max}k`,
      '-bf', '0', '-g', String(Math.round(plan.rate.fps * 2))
    );
  }
  if (a >= 0) args.push('-c:a', 'mp2', '-b:a', `${plan.audioKbps}k`, '-ar', String(audioRate), '-ac', '2');
  else args.push('-an');
  // The tiny muxdelay also makes ffmpeg write each audio frame as its own
  // packet with its own timestamp, which the splitter relies on.
  args.push('-sn', '-dn', '-f', 'mpegts', '-muxdelay', '0.001', '-muxpreload', '0', 'pipe:1');
  return args;
}

function sendJson(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// What YouTube's answer to a request means, in words.
export function refusalReason(status) {
  if (status === 403) return 'YouTube refused to send it (403 Forbidden)';
  if (status === 429) return 'YouTube is turning this server away for now (429 Too Many Requests)';
  if (status === 404 || status === 410) return `the link YouTube gave for it has stopped working (${status})`;
  if (status >= 500) return `YouTube's server had a problem (${status})`;
  return `YouTube answered ${status}`;
}

// When a lower quality than asked for is all there is, say so, but not for every video.
const noticedAt = new Map();
function noticeDue(group, name, now = Date.now()) {
  const key = `${group}:${name}`;
  if (now - (noticedAt.get(key) || 0) < 60 * 60 * 1000) return false;
  noticedAt.set(key, now);
  return true;
}

/*
 * Find this video by a route that really delivers (see ROUTES in
 * youtube.js). Each route's link is tried before it is used, because a
 * refused route still hands out links: they just answer 403.
 * Returns { info } or { message } to show in the car.
 */
export async function findPlayable(id, quality, deps = {}) {
  const lookup = deps.streamInfo || streamInfo;
  const status = deps.linkStatus || linkStatus;
  const order = id === TEST_PATTERN_ID ? ['direct'] : routeOrder();
  let refused = null; // YouTube's answer when a route's link was turned down
  let lookupError = null;
  for (const name of order) {
    try {
      let found = await lookup(id, quality, name);
      const check = async (info) => {
        const answers = await Promise.all(info.inputs.filter((i) => i.url).map((i) => status(i)));
        return answers.find((a) => a !== 200 && a !== 206);
      };
      let bad = await check(found);
      if (bad !== undefined && Date.now() - (found.at || 0) > 60000) {
        // Links kept from an earlier lookup go stale. Get new ones before blaming the route.
        forgetStream(id, quality);
        found = await lookup(id, quality, name);
        bad = await check(found);
      }
      if (bad === undefined) return { info: found };
      refused = refused ?? bad;
      forgetStream(id, quality);
      routeRefused(name, refusalReason(bad));
    } catch (err) {
      lookupError = lookupError || err;
      // "No such format" is about this route. Anything else (private, removed,
      // age-restricted...) is about the video, and no other route will change it.
      if (!/format is not available|no playable format|timed out|fetch failed|aborted/i.test(err.message || '')) break;
    }
  }
  if (refused !== null) return { message: `Couldn't play this video: ${refusalReason(refused)}` };
  return { message: `Couldn't load this video: ${lookupError ? lookupError.message : 'nothing playable was found'}` };
}

// Why ffmpeg gave up, in words. Its own last line starts with the whole
// media link, which is hundreds of characters long, means nothing on a car
// screen, and has this server's home address in it. So links are taken out
// and the part that says what happened is kept.
export function failureReason(stderr, code) {
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
  if (status === '403') said = 'YouTube refused to send it (403 Forbidden)';
  else if (status === '429') said = 'YouTube is turning this server away for now (429 Too Many Requests)';
  else if (status === '404' || status === '410') said = `the link YouTube gave for it has stopped working (${status})`;
  else if (status && status[0] === '5') said = `YouTube's server had a problem (${status})`;
  else if (/timed out|refused|reset|unreachable|resolve|network/i.test(raw)) said = `this server couldn't reach YouTube (${raw.slice(0, 80)})`;
  else said = raw.slice(0, 140);
  return { said, raw: raw.slice(0, 300) };
}

// One car connection = one ffmpeg process.
export async function handleStream(ws, { id, startAt, quality, audioRate, want, group = 'main' }) {
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
  const splitter = new TsSplitter(
    (kind, pts, frame) => {
      if (closed) return;
      if (kind === KIND_VIDEO) {
        if (!baseSent) {
          sendJson(ws, { type: 'base', pts: splitter.firstVideoPts });
          baseSent = true;
          if (id !== TEST_PATTERN_ID) routeWorked(info.routeName); // pictures are flowing: this route delivers
        }
        if (firstDataAt === null) firstDataAt = Date.now();
        // H.264 frames aren't sent in display order, so keep the furthest one.
        lastSentPts = lastSentPts === null ? pts : Math.max(lastSentPts, pts);
      }
      frame.writeDoubleLE(pts, 0);
      frame.writeUInt8(kind, 8);
      ws.send(frame);
      if (kind === KIND_VIDEO) {
        if (lastSentPts - splitter.firstVideoPts >= 20) logSpeed();
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
    if (!flowPaused && (a > AHEAD_HIGH || backlog > BACKLOG_HIGH)) {
      logSpeed(backlog > BACKLOG_HIGH ? "held back by the car's connection, not the CPU" : '');
      ff.stdout.pause();
      flowPaused = true;
    } else if (flowPaused && a < AHEAD_LOW && backlog < BACKLOG_LOW) {
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
    active.delete(entry);
    if (!active.size && activeByGroup.get(group) === active) activeByGroup.delete(group);
    clearInterval(flowTimer);
    if (ff) {
      killed = true;
      ff.kill('SIGKILL');
    }
  });

  const playable = await findPlayable(id, quality);
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
    // Passed-through video keeps YouTube's own frame rate and bitrate.
    fps: passthrough ? info.fps || null : codec === 'h264' ? 30 : plan.rate.fps,
    kbps: passthrough ? (info.tbr ? Math.round(info.tbr) : null) : plan.kbps,
  });
  const notice = routeNotice(info.routeName);
  if (notice && id !== TEST_PATTERN_ID && noticeDue(group, info.routeName)) sendJson(ws, { type: 'notice', message: notice });

  let args;
  try {
    args = ffmpegArgs(info, startAt, quality, audioRate, codec);
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
      const why = failureReason(stderr, code);
      // For whoever reads the log: what failed and which way the video was being fetched.
      console.warn(`[stream ${id}] ffmpeg exited ${code} ${lastSentPts === null ? 'before sending anything' : 'partway'}: ${why.raw} | ${quality}p ${codec}, ${info.route || 'unknown route'}, starting at ${Math.round(startAt)}s`);
      // Media links expire; make the next attempt fetch fresh ones.
      forgetStream(id, quality);
      if (lastSentPts === null) {
        // Checked out fine, yet ffmpeg couldn't use it: the next try takes another route.
        if (id !== TEST_PATTERN_ID) routeRefused(info.routeName, why.raw);
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
