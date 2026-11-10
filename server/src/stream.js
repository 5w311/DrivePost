import { spawn } from 'node:child_process';
import { config } from './config.js';
import { streamInfo, forgetStream } from './youtube.js';
import { TsChunker } from './ts-chunker.js';

// How far ahead of the car's playback we transcode before pausing ffmpeg.
const AHEAD_HIGH = 25;
const AHEAD_LOW = 12;
const BACKLOG_HIGH = 4 * 1024 * 1024;
const BACKLOG_LOW = 1024 * 1024;

const PRESETS = {
  360: { height: 360, kbps: 700 },
  480: { height: 480, kbps: 1300 },
  720: { height: 720, kbps: 2600 },
};

const active = new Set();

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

export function ffmpegArgs(info, startAt, quality) {
  const preset = PRESETS[quality] || PRESETS[480];
  const height = Math.min(preset.height, info.height || preset.height);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  info.inputs.forEach((input) => args.push(...inputArgs(input, startAt, info.live)));

  const v = info.inputs.findIndex((i) => i.hasVideo);
  const a = info.inputs.findIndex((i) => i.hasAudio);
  if (v < 0) throw new Error('This video has no picture');
  args.push('-map', `${v}:v:0`);
  if (a >= 0) args.push('-map', `${a}:a:0`);

  const max = Math.round(preset.kbps * 1.3);
  args.push(
    '-vf', `scale=-2:'min(${height},ih)':flags=bicubic,fps=30,format=yuv420p`,
    '-c:v', 'mpeg1video', '-b:v', `${preset.kbps}k`, '-maxrate', `${max}k`, '-bufsize', `${max}k`,
    '-bf', '0', '-g', '60'
  );
  if (a >= 0) args.push('-c:a', 'mp2', '-b:a', '128k', '-ar', '44100', '-ac', '2');
  else args.push('-an');
  args.push('-sn', '-dn', '-f', 'mpegts', '-muxdelay', '0.001', '-muxpreload', '0', 'pipe:1');
  return args;
}

function sendJson(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// One car connection = one ffmpeg process.
export async function handleStream(ws, { id, startAt, quality }) {
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
  // Shows in `docker compose logs`: handy for sizing a Pi vs a PC.
  let firstDataAt = null;
  let speedLogged = false;
  function logSpeed(note) {
    if (speedLogged || firstDataAt === null || lastSentPts === null || chunker.firstPts === null) return;
    const media = lastSentPts - chunker.firstPts;
    const wall = (Date.now() - firstDataAt) / 1000;
    if (media < 5 || wall <= 0) return;
    speedLogged = true;
    const x = media / wall;
    const verdict = x >= 1.5 ? 'OK' : x >= 1.1 ? 'tight' : 'too slow, try a lower quality';
    console.log(`[stream ${id}] ${quality}p converting at ${x.toFixed(1)}x real time (${verdict})${note ? `, ${note}` : ''}`);
  }

  let baseSent = false;
  const chunker = new TsChunker((pts, data) => {
    if (closed) return;
    if (!baseSent && chunker.firstPts !== null) {
      sendJson(ws, { type: 'base', pts: chunker.firstPts });
      baseSent = true;
    }
    if (firstDataAt === null) firstDataAt = Date.now();
    lastSentPts = pts;
    const frame = Buffer.allocUnsafe(8 + data.length);
    frame.writeDoubleLE(pts, 0);
    data.copy(frame, 8);
    ws.send(frame);
    if (lastSentPts - chunker.firstPts >= 20) logSpeed();
    checkFlow();
  });

  function ahead() {
    if (lastSentPts === null) return 0;
    const base = clientClock ?? chunker.firstPts ?? lastSentPts;
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

  sendJson(ws, { type: 'meta', duration: info.duration, live: info.live, startAt: info.live ? 0 : startAt });

  let args;
  try {
    args = ffmpegArgs(info, startAt, quality);
  } catch (err) {
    sendJson(ws, { type: 'error', message: err.message });
    ws.close();
    return;
  }

  ff = spawn(config.ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.stdout.on('data', (d) => chunker.push(d));
  ff.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-2000);
  });
  ff.on('error', (err) => {
    sendJson(ws, { type: 'error', message: `Could not start ffmpeg: ${err.message}` });
    ws.close();
  });
  ff.on('close', (code) => {
    if (closed || killed) return;
    chunker.flush();
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
    const played = lastSentPts !== null && chunker.firstPts !== null ? lastSentPts - chunker.firstPts : 0;
    const complete =
      code === 0 && (info.live || !info.duration || startAt + played >= info.duration - 5);
    sendJson(ws, { type: 'end', complete });
    // Let the car drain its buffer; it closes the socket when done.
  });
}
