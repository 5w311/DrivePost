/*
 * A live picture sent to this server as it is made, kept so the car can
 * play it.
 *
 * It comes from the browser DrivePost opens pages in (webpage.js, and the
 * browser container): a tab there records the page being shown and the
 * recording arrives here piece by piece. This module turns that into a short
 * live video stream on this machine, which the car then plays like any other
 * live video: converted and sent by stream.js, with the same player, sound
 * and controls.
 *
 * One at a time per profile. A new one replaces the one before it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

// What the car is asked to play while a page is open in the server's browser.
export const PAGE_ID = 'page';
export const isPageId = (id) => id === PAGE_ID;

// The row for it: named for the page, and for the site it is on.
export function pageItem({ title, site } = {}) {
  const clean = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
  return { id: PAGE_ID, title: clean(title, 200) || clean(site, 80) || 'A web page', channel: '', duration: null, live: true, site: clean(site, 80) || 'Web page', thumb: '' };
}

// The picture the recording is fitted into, whatever its own shape, and
// the most the copy kept on this machine may take per second.
export const SCREEN_SIZES = {
  480: { width: 854, height: 480, kbps: 3000 },
  720: { width: 1280, height: 720, kbps: 5000 },
  1080: { width: 1920, height: 1080, kbps: 8000 },
};
export const cleanSize = (s) => (Object.hasOwn(SCREEN_SIZES, String(s)) ? String(s) : '720');

const SEGMENT_S = 1; // the stream is kept as pieces this long
const KEPT = 12; // ...this many of them, the oldest making way for the newest
const READY_WITH = 3; // pieces there must be before the car is sent to it (stream.js starts it that far back)
const READY_WITHIN_MS = 20 * 1000; // a recording that hasn't become video by then isn't going to
const FRESH_MS = 5 * 1000; // a stream that hasn't grown for this long has stalled
// A recording that breaks off (the browser's agent reconnecting, mostly) usually comes straight
// back. The car waits this long for it before moving on.
export const BACK_WITHIN_MS = Number(process.env.SCREEN_BACK_MS) || 20 * 1000;
const WAIT_FOR_IT_MS = 20 * 1000; // how long a car that asks for the page waits for it to be there

function baseDir() {
  if (config.pages.dir) return config.pages.dir;
  // Memory, where there is some to write to: these files are rewritten every second.
  try {
    fs.accessSync('/dev/shm', fs.constants.W_OK);
    return '/dev/shm';
  } catch {
    return os.tmpdir();
  }
}

// Folders left behind by a server that was stopped while a page was open.
export function clearOldShares(dir = baseDir()) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/^drivepost-(page|screen)-/.test(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  } catch {}
}

/*
 * ffmpeg's arguments for taking the recording in (on its standard input) and
 * keeping it as a live stream: a list (`list`) of one-second pieces beside it.
 *
 * The recording is whatever the browser makes: its size changes when a
 * window is resized or another tab is chosen, and its frames come when the
 * screen changes rather than at a steady rate. Here it becomes one fixed
 * picture size at 30 frames a second, each piece starting on a whole frame,
 * so that the stream the car's ffmpeg reads never changes shape.
 */
export function ingestArgs({ list, size = '720', audio = true, h264 = true, copy = false }) {
  const keep = [
    '-f', 'hls', '-hls_time', String(SEGMENT_S), '-hls_list_size', String(KEPT),
    '-hls_flags', 'delete_segments+independent_segments+temp_file',
    '-hls_segment_filename', path.join(path.dirname(list), 's%06d.ts'),
    list,
  ];
  // A recording that is already as the stream is kept (the browser's own
  // film of its screen: H.264 at this size, a whole frame every second, AAC
  // sound) is only cut into pieces. Nothing is converted, which costs this
  // machine next to nothing and the picture nothing at all.
  if (copy) {
    return [
      '-hide_banner', '-loglevel', 'error',
      '-probesize', '1000000', '-analyzeduration', '1000000',
      '-i', 'pipe:0',
      '-map', '0:v:0',
      ...(audio ? ['-map', '0:a:0?'] : ['-an']),
      '-c', 'copy',
      ...keep,
    ];
  }
  const { width, height, kbps } = SCREEN_SIZES[cleanSize(size)];
  const fit = [
    'fps=30',
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    'format=yuv420p',
  ].join(',');
  const picture = h264
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '21', '-maxrate', `${kbps}k`, '-bufsize', `${kbps}k`]
    : ['-c:v', 'mpeg2video', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps}k`, '-bf', '0'];
  return [
    '-hide_banner', '-loglevel', 'error',
    // A recording still being made: start on it soon instead of studying
    // five seconds of it first. (What is read while studying is kept: the
    // recording opens with the one whole frame the frames after it build on.)
    '-probesize', '1000000', '-analyzeduration', '1000000',
    '-i', 'pipe:0',
    '-map', '0:v:0',
    ...(audio ? ['-map', '0:a:0?'] : []),
    '-vf', fit,
    ...picture,
    '-g', String(30 * SEGMENT_S), '-keyint_min', String(30 * SEGMENT_S), '-sc_threshold', '0',
    ...(audio ? ['-af', 'aresample=async=1', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'] : ['-an']),
    ...keep,
  ];
}

// How many pieces a list has, and whether it has been closed.
export function readList(text) {
  const s = String(text || '');
  return { pieces: (s.match(/^#EXTINF:/gm) || []).length, ended: /^#EXT-X-ENDLIST/m.test(s) };
}

const shares = new Map(); // profile → the share that is on
const backBy = new Map(); // profile → when a dropped share stops being waited for
const backTimers = new Map();
const listeners = new Set();

// fn(profile, what, share): 'live' when a picture can be played, 'over' when
// it has ended for good (stopped, or dropped and not come back).
export function onShare(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function tell(profile, what, share) {
  for (const fn of listeners) {
    try {
      fn(profile, what, share);
    } catch (err) {
      console.error(err);
    }
  }
}

export const shareOf = (profile) => shares.get(profile) || null;
// Is a share on for this profile, or expected back any moment?
export function shareExpected(profile, now = Date.now()) {
  return shares.has(profile) || (backBy.get(profile) || 0) > now;
}

function stopWaitingFor(profile) {
  backBy.delete(profile);
  clearTimeout(backTimers.get(profile));
  backTimers.delete(profile);
}

class Share {
  constructor(profile, { size, audio, again, h264, copy, spawnImpl = spawn }) {
    this.profile = profile;
    this.size = cleanSize(size);
    this.audio = audio !== false;
    this.again = !!again; // the same picture as a moment ago, in a fresh recording
    this.since = Date.now();
    this.dir = fs.mkdtempSync(path.join(baseDir(), 'drivepost-page-'));
    this.list = path.join(this.dir, 'index.m3u8');
    this.ready = false;
    this.done = null; // why it ended, once it has
    this.taken = 0; // bytes of recording taken in
    this.edgeAt = 0;
    this.edgeIs = 0;
    this.lastDataAt = Date.now();
    this.stderr = '';
    this.onFail = null; // (message, wasPlaying): the recording couldn't be used
    this.onReady = null;
    this.onReplaced = null;
    this.onStopped = null; // ended from outside (endShare)

    this.ff = spawnImpl(config.ffmpegBin, ingestArgs({ list: this.list, size: this.size, audio: this.audio, h264, copy: !!copy }), {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    this.ff.stdin.on('error', () => {}); // it went away mid-write: its exit is dealt with below
    this.ff.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d).slice(-2000);
    });
    this.ff.on('error', (err) => this.fail(`Could not start ffmpeg: ${err.message}`));
    this.ff.on('close', (code) => {
      clearInterval(this.watch);
      if (!this.done) this.fail(this.taken ? "The recording of the page couldn't be turned into video." : 'Nothing arrived from the browser.', code);
      // ffmpeg closes the stream when it ends in good order. When it didn't,
      // close it for it: the cars reading it then stop at once, instead of
      // waiting ten seconds for a next piece that isn't coming.
      try {
        const text = fs.readFileSync(this.list, 'utf8');
        if (!readList(text).ended) fs.appendFileSync(this.list, '#EXT-X-ENDLIST\n');
      } catch {}
      // The cars still reading the last pieces get a little time to finish.
      setTimeout(() => fs.rm(this.dir, { recursive: true, force: true }, () => {}), 30 * 1000).unref();
    });

    // Playable once the stream has a couple of pieces to start from.
    this.watch = setInterval(() => {
      if (this.done) return;
      if (!this.ready) {
        let pieces = 0;
        try {
          pieces = readList(fs.readFileSync(this.list, 'utf8')).pieces;
        } catch {}
        if (pieces >= READY_WITH) {
          this.ready = true;
          if (shares.get(profile) === this) {
            if (this.onReady) this.onReady();
            tell(profile, 'live', this);
          }
        } else if (Date.now() - this.since > READY_WITHIN_MS) {
          this.fail(this.taken ? "The recording of the page couldn't be turned into video." : 'Nothing arrived from the browser.');
        }
      }
    }, 150);
    this.watch.unref();
  }

  // A piece of the recording, as the browser sent it.
  write(chunk) {
    if (this.done) return;
    this.taken += chunk.length;
    this.lastDataAt = Date.now();
    // ffmpeg not keeping up with a recording made in real time means something is wrong with it.
    if (this.ff.stdin.writableLength > 32 * 1024 * 1024) return this.fail('This server fell too far behind the page.');
    this.ff.stdin.write(chunk);
  }

  // How many seconds of stream there have been so far: the pieces that have
  // come and gone, and the ones still listed. (Looked up at most once a second.)
  edge(now = Date.now()) {
    if (now - this.edgeAt > 1000) {
      this.edgeAt = now;
      try {
        const text = fs.readFileSync(this.list, 'utf8');
        const from = Number((/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m.exec(text) || [])[1]) || 0;
        this.edgeIs = (from + readList(text).pieces) * SEGMENT_S;
      } catch {}
    }
    return this.edgeIs;
  }

  // Is the stream growing? (Its list is rewritten with every new piece.)
  fresh(now = Date.now()) {
    try {
      return now - fs.statSync(this.list).mtimeMs < FRESH_MS;
    } catch {
      return false;
    }
  }

  // For stream.js: where the car's ffmpeg reads it from, in the shape youtube.js describes a video.
  info() {
    const { height } = SCREEN_SIZES[this.size];
    return {
      inputs: [{ url: this.list, list: true, mirror: true, hasVideo: true, hasAudio: this.audio }],
      live: true,
      mirror: true,
      height,
      fps: 30,
      duration: null,
      route: 'the page in the browser',
      routeName: 'page',
      site: 'the page',
    };
  }

  /*
   * End it. `why`:
   *   stopped   it was closed: over
   *   dropped   the connection to them went: it may be back in a moment
   *   replaced  another share took its place
   *   failed    the recording couldn't be used
   */
  finish(why) {
    if (this.done) return;
    this.done = why;
    clearInterval(this.watch);
    const current = shares.get(this.profile) === this;
    if (current) shares.delete(this.profile);
    // Closing the recording lets ffmpeg close the stream properly, so the cars reading it come to its end.
    try {
      this.ff.stdin.end();
    } catch {}
    setTimeout(() => {
      if (this.ff.exitCode === null && this.ff.signalCode === null) this.ff.kill('SIGKILL');
    }, 4000).unref();
    if (!current || why === 'replaced') return;
    if (why === 'dropped') {
      backBy.set(this.profile, Date.now() + BACK_WITHIN_MS);
      clearTimeout(backTimers.get(this.profile));
      const timer = setTimeout(() => {
        backTimers.delete(this.profile);
        backBy.delete(this.profile);
        if (!shares.has(this.profile)) tell(this.profile, 'over', this);
      }, BACK_WITHIN_MS);
      timer.unref();
      backTimers.set(this.profile, timer);
      return;
    }
    stopWaitingFor(this.profile);
    tell(this.profile, 'over', this);
  }

  fail(message, code) {
    if (this.done) return;
    const said = this.stderr.trim().split('\n').pop() || (code !== undefined ? `ffmpeg exited with ${code}` : '');
    console.warn(`[page] ${message}${said ? ` | ${said.slice(0, 300)}` : ''}`);
    // One that was playing may only have tripped over something in the
    // recording (its picture changing size, say). Whoever sends it is told
    // so and tries again with a fresh recording, and the car waits for that
    // as it does after a drop.
    const wasPlaying = this.ready;
    if (this.onFail) this.onFail(message, wasPlaying);
    this.finish(wasPlaying ? 'dropped' : 'failed');
  }
}

/*
 * Start a share for a profile, in place of the one it has (if any).
 * `opts`: { size, audio, again, h264 }.
 */
export function startShare(profile, opts = {}) {
  const before = shares.get(profile);
  if (before) {
    if (before.onReplaced) before.onReplaced();
    before.finish('replaced');
  }
  stopWaitingFor(profile);
  const share = new Share(profile, opts);
  shares.set(profile, share);
  return share;
}

// A profile was removed, or the server is stopping.
export function endShare(profile) {
  const share = shares.get(profile);
  if (share) {
    share.finish('stopped');
    if (share.onStopped) share.onStopped();
  } else if (backBy.has(profile)) {
    stopWaitingFor(profile);
    tell(profile, 'over', null);
  }
}

/*
 * For a car asking to play the page: { info } once the stream is there and
 * growing, { over: true } when the page has been closed, or { message } to
 * show when it is open but isn't coming through. One that is only
 * just starting, or that dropped a moment ago, is waited for.
 */
export async function pageStream(profile, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((done) => setTimeout(done, ms)));
  const now = deps.now || Date.now;
  const until = now() + (deps.wait ?? WAIT_FOR_IT_MS);
  for (;;) {
    const share = shares.get(profile);
    if (share && share.ready && share.fresh(now())) return { info: share.info(), share };
    // Nothing open, and nothing on its way back: for the car that is the end of it.
    if (!shareExpected(profile, now())) return { over: true };
    if (now() >= until) return { message: "The page isn't coming through from the server's browser." };
    await sleep(200);
  }
}
