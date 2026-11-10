import { spawn } from 'node:child_process';
import { config } from './config.js';
import { streamInfo, forgetStream } from './youtube.js';
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

const active = new Set();

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

export function ffmpegArgs(info, startAt, quality, audioRate = 48000) {
  const plan = streamPlan(info, quality);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  info.inputs.forEach((input) => args.push(...inputArgs(input, startAt, info.live)));

  const v = info.inputs.findIndex((i) => i.hasVideo);
  const a = info.inputs.findIndex((i) => i.hasAudio);
  if (v < 0) throw new Error('This video has no picture');
  args.push('-map', `${v}:v:0`);
  if (a >= 0) args.push('-map', `${a}:a:0`);

  const max = Math.round(plan.kbps * 1.3);
  args.push(
    '-vf', `scale=-2:'min(${plan.height},ih)':flags=bicubic,fps=${plan.rate.expr},format=yuv420p`,
    '-c:v', 'mpeg1video', '-b:v', `${plan.kbps}k`, '-maxrate', `${max}k`, '-bufsize', `${max}k`,
    '-bf', '0', '-g', String(Math.round(plan.rate.fps * 2))
  );
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

// One car connection = one ffmpeg process.
export async function handleStream(ws, { id, startAt, quality, audioRate }) {
  if (!AUDIO_RATES.includes(audioRate)) audioRate = 48000;
  let ff = null;
  let closed = false;
  let killed = false;
  let flowPaused = false;
  let clientClock = null;
  let lastSentPts = null;
  let stderr = '';

  const entry = { close: () => ws.close(4000, 'replaced') };
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
    console.log(`[stream ${id}] ${quality}p converting at ${x.toFixed(1)}x real time (${verdict})${note ? `, ${note}` : ''}`);
    sendJson(ws, { type: 'speed', x: Math.round(x * 10) / 10, limitedByNetwork: !!note });
  }

  let baseSent = false;
  const splitter = new TsSplitter(
    (kind, pts, frame) => {
      if (closed) return;
      if (kind === KIND_VIDEO) {
        if (!baseSent) {
          sendJson(ws, { type: 'base', pts: splitter.firstVideoPts });
          baseSent = true;
        }
        if (firstDataAt === null) firstDataAt = Date.now();
        lastSentPts = pts;
      }
      frame.writeDoubleLE(pts, 0);
      frame.writeUInt8(kind, 8);
      ws.send(frame);
      if (kind === KIND_VIDEO) {
        if (pts - splitter.firstVideoPts >= 20) logSpeed();
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
    clearInterval(flowTimer);
    if (ff) {
      killed = true;
      ff.kill('SIGKILL');
    }
  });

  let info;
  try {
    info = await streamInfo(id, quality);
  } catch (err) {
    sendJson(ws, { type: 'error', message: `Couldn't load this video: ${err.message}` });
    ws.close();
    return;
  }
  if (closed) return;

  const plan = streamPlan(info, quality);
  sendJson(ws, {
    type: 'meta',
    duration: info.duration,
    live: info.live,
    startAt: info.live ? 0 : startAt,
    fps: plan.rate.fps,
    kbps: plan.kbps,
  });

  let args;
  try {
    args = ffmpegArgs(info, startAt, quality, audioRate);
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
      const line = stderr.trim().split('\n').pop() || `ffmpeg exited with ${code}`;
      console.warn(`[stream ${id}] ffmpeg exited ${code}: ${line}`);
      // Media links expire; make the next attempt fetch fresh ones.
      forgetStream(id, quality);
      if (lastSentPts === null) {
        sendJson(ws, { type: 'error', message: `Couldn't play this video (${line.slice(0, 160)})` });
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
