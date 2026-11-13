/*
 * The browser DrivePost opens pages in.
 *
 * Some links can't be turned into a video: the page has a player of its
 * own and nothing behind it that can be fetched. DrivePost then opens the
 * page itself, here, in an ordinary browser on a screen nobody sits at, and
 * shows the car a picture of that screen with its sound. A phone steers it:
 * it gets a small live view of the screen, and its taps and typing are
 * passed on.
 *
 * Nothing drives the browser but that phone. It is started the way a person
 * starts one, with the address to open, and after that this program only
 * does what a remote-desktop program does:
 *   - it gives the browser a screen that exists in memory, a sound card that
 *     plays to nobody, and a mouse and a keyboard;
 *   - it moves that mouse and presses those keys when the phone says so;
 *   - it films the screen and records the sound, and passes the recording
 *     on to DrivePost as it is made.
 * It never reaches into a page. It can't read one, change one or run
 * anything in one, and the browser has no remote-control interface switched
 * on for it to do so. All it knows of the page is the name on its window.
 * Play, pause and skipping go through the browser's own media controls, the
 * ones the keys on a keyboard and a desktop's media buttons use.
 *
 * For a profile that has "Block ads" switched on, the browser is started
 * with one extension: uBlock Origin Lite, an ad blocker, as its author
 * publishes it. That does work inside pages, as it does in anyone's browser;
 * this program still doesn't. With the switch off there is no extension.
 *
 * The container has no way out to the internet of its own. Everything the
 * browser fetches goes through DrivePost, which refuses addresses on the
 * home network.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const env = process.env;
const SERVER = env.DRIVEPOST_WS || 'ws://drivepost:8080/ws/browser';
const KEY_FILE = env.BROWSER_KEY_FILE || '/run/drivepost-browser/key';
const DATA = env.BROWSER_DATA || '/browser-data';
// uBlock Origin Lite, as its author publishes it, unpacked where the image
// keeps it (the Dockerfile says which release). It is the browser's ad
// blocker for a profile that has "Block ads" switched on, and is left out
// of the browser altogether for one that hasn't. null: this machine has none.
//
// A browser writes into the folder of an extension it is started with (it
// keeps its own index of the blocker's rules there, and refuses to load the
// extension if it can't). So the browser is never given the image's copy,
// `from`, which this program can't write to anyway. It is given a copy of
// that, `dir`, made afresh each time it is started: nothing a page managed
// to change in it outlasts that browser.
const UBLOCK = (() => {
  const from = env.UBLOCK_FROM || '/opt/ublock-origin-lite';
  const dir = env.UBLOCK_DIR || '/tmp/ublock-origin-lite';
  try {
    const version = String(JSON.parse(fs.readFileSync(path.join(from, 'manifest.json'), 'utf8')).version || '');
    return { from, dir, version };
  } catch {
    return null;
  }
})();
function freshBlocker() {
  fs.rmSync(UBLOCK.dir, { recursive: true, force: true });
  fs.cpSync(UBLOCK.from, UBLOCK.dir, { recursive: true });
}

// The screen the browser is given, which is the picture the car gets.
const WIDTH = 1280;
const HEIGHT = 720;
const VIEW = { width: 640, height: 360, fps: 5 }; // the phone's live view
const WHEEL_PX = 120; // how far one notch of a mouse wheel moves a page
// A browser's sound reaches the film a little before its picture does: the
// picture has to be drawn, put on the screen and then caught by the next of
// thirty looks a second, while the sound is taken as it is made. Measured
// with a clip that flashes and beeps at once, that is 20 to 100 ms. The
// sound is set back by the middle of that, so the two are within a frame or
// two of each other either way.
const PICTURE_LAG_S = 0.06;

/*
 * The blocker comes up a moment after the browser does: its rules for what
 * to stop within a tenth of a second or so, what it does inside pages a
 * second or two later. A page opened in that moment would get its ads. So
 * with the blocker on, the browser is started on a waiting page instead,
 * which DrivePost's guard serves under a made-up name (guard.js has the
 * page, and says how it tells that the blocker is at work). It is handed the
 * address that was asked for after a '#', which a browser keeps to itself,
 * and goes on to it once the blocker is ready, or after six seconds anyway.
 */
const WAITING = 'Starting the ad blocker'; // the waiting page's name, which is not passed on as the page's
const WAIT_HOST = 'ready.drivepost.invalid'; // (guard.js has the same two)
const waitingPage = (url) => `http://${WAIT_HOST}/#${encodeURIComponent(String(url))}`;

const log = (...a) => console.log('[browser]', ...a);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function within(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took too long`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
const alive = (proc) => !!proc && proc.exitCode === null && proc.signalCode === null;

// Run a small program and wait for it. Resolves with { code, out }; never rejects.
function run(cmd, args, { input, timeout = 4000, vars } = {}) {
  return new Promise((done) => {
    const child = execFile(cmd, args, { env: vars || env, timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '') });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// Stop a program: asked first, then made to.
function stop(proc, graceMs = 3000) {
  if (!alive(proc)) return Promise.resolve();
  return new Promise((gone) => {
    const timer = setTimeout(() => alive(proc) && proc.kill('SIGKILL'), graceMs);
    timer.unref();
    proc.once('exit', () => {
      clearTimeout(timer);
      gone();
    });
    proc.kill('SIGTERM');
  });
}

/*
 * Close the browser the way a person does: its window is closed from the
 * keyboard. A browser that is closed like that writes down what it was
 * signed in to before it goes; one that is simply told to stop loses what
 * it learned in its last half minute. If it is still there a moment later
 * (a page asking "leave?", a second window), it is told to after all.
 */
async function closeBrowser(proc, vars) {
  if (!alive(proc)) return;
  const gone = new Promise((done) => proc.once('exit', done));
  await run('xdotool', ['key', 'ctrl+shift+w'], { vars, timeout: 2000 });
  await Promise.race([gone, sleep(2500)]);
  await stop(proc);
}

function chromeBin() {
  const tried = [env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
  return tried.find((p) => fs.existsSync(p)) || tried[0];
}

function readKey() {
  if (env.BROWSER_KEY) return env.BROWSER_KEY.trim();
  try {
    return fs.readFileSync(KEY_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'that address';
  }
}

// ---------- DrivePost ----------
let server = null;
function tell(msg) {
  if (server && server.readyState === 1) server.send(JSON.stringify(msg));
}
// 1: a piece of the recording. 2: a picture for the phone's live view.
function hand(kind, data) {
  if (server && server.readyState === 1) server.send(Buffer.concat([Buffer.from([kind]), data]));
}

// ---------- the desk the browser sits at ----------
// A screen that exists only in memory (Xvfb), a sound card that plays to
// nobody (PulseAudio), the message bus a desktop's media buttons talk to the
// browser over (D-Bus), and a window manager that keeps the browser's window
// in front and filling the screen. Set up once this program has found
// DrivePost, and left standing: at rest they use next to nothing, and the
// first page opens a second sooner for it.
let desk = null;
let deskComing = null; // being set up right now
function ensureDesk() {
  if (desk && desk.up) return Promise.resolve(desk);
  if (!deskComing) {
    deskComing = setUpDesk().finally(() => {
      deskComing = null;
    });
  }
  return deskComing;
}
async function setUpDesk() {
  const n = Number(env.BROWSER_DISPLAY) || 99;
  const dir = `/tmp/drivepost-desk-${n}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const left of [`/tmp/.X${n}-lock`, `/tmp/.X11-unix/X${n}`]) fs.rmSync(left, { force: true }); // from a run that was cut short
  const mine = {
    up: false,
    dir,
    display: `:${n}`,
    procs: [],
    vars: {
      ...env,
      DISPLAY: `:${n}`,
      XDG_RUNTIME_DIR: dir,
      PULSE_SERVER: `unix:${dir}/sound`,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${dir}/bus`,
      LC_ALL: 'C.UTF-8', // so that letters outside English are typed as themselves
    },
  };
  const start = (what, cmd, args, needed) => {
    const proc = spawn(cmd, args, { stdio: 'ignore', env: mine.vars });
    proc.on('error', (err) => {
      if (needed) log(`${what} couldn't be started (${err.message})`);
    });
    proc.on('exit', () => {
      if (!needed || desk !== mine || !mine.up) return;
      // The desk has lost a leg: whatever page is open goes with it, and the next one sets it up afresh.
      mine.up = false;
      log(`${what} stopped`);
      for (const p of mine.procs) if (alive(p)) p.kill();
      if (session) session.fail("The server's browser lost its screen.");
    });
    mine.procs.push(proc);
    return proc;
  };
  const there = async (file, what) => {
    for (let i = 0; i < 60 && !fs.existsSync(file); i++) await sleep(100);
    if (!fs.existsSync(file)) {
      for (const p of mine.procs) if (alive(p)) p.kill();
      throw new Error(`${what} didn't come up`);
    }
  };
  // (-s 0: a screen nobody touches for ten minutes would otherwise go blank, and the car with it.)
  start('The screen', 'Xvfb', [`:${n}`, '-screen', '0', `${WIDTH}x${HEIGHT}x24`, '-nolisten', 'tcp', '-ac', '-s', '0'], true);
  await there(`/tmp/.X11-unix/X${n}`, 'the screen');
  start('The message bus', 'dbus-daemon', ['--session', `--address=unix:path=${dir}/bus`, '--nofork', '--nopidfile'], true);
  await there(`${dir}/bus`, 'the message bus');
  start('The sound', 'pulseaudio', [
    '-n', '--daemonize=no', '--exit-idle-time=-1', '--log-target=stderr',
    `--load=module-native-protocol-unix socket=${dir}/sound auth-anonymous=1`,
    '--load=module-null-sink sink_name=drivepost rate=48000 channels=2',
    '--load=module-always-sink',
  ], true);
  await there(`${dir}/sound`, 'the sound');
  // Without it everything still works where there is one window; it is there for the second (a sign-in that pops up).
  start('The window manager', 'matchbox-window-manager', ['-use_titlebar', 'no', '-use_cursor', 'no'], false);
  await sleep(200);
  mine.up = true;
  return (desk = mine);
}

// ---------- one page ----------
let session = null;
// The browser of the page before this one, on its way out. The next one
// waits for it: two browsers can't share one profile's files.
let leaving = Promise.resolve();

// The keys a phone can ask for, by the names a keyboard gives them here.
const KEYS = {
  Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Escape: 'Escape', Space: 'space',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  F: 'f', C: 'c', M: 'm',
};

class Session {
  constructor({ id, url, profile, guardPort, blockAds }) {
    this.id = id;
    this.url = String(url);
    this.blockAds = !!blockAds; // this profile wants ads blocked
    this.profile = String(profile || 'main').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || 'main';
    // The way out: DrivePost's guard, on the machine this program is connected to.
    this.proxy = Number(guardPort) ? `http://${new URL(SERVER).hostname}:${Number(guardPort)}` : '';
    this.proc = null; // the browser
    this.ff = null; // what films its screen
    this.over = false;
    this.up = false; // DrivePost has been told the picture is coming
    this.filmFails = 0;
    this.viewing = false; // a phone has the live view open
    this.viewBuf = Buffer.alloc(0);
    this.viewLast = null; // the last picture sent, so the same one isn't sent twice
    this.named = ''; // the name on the window, as last passed on
    this.owed = 0; // scrolling asked for that hasn't added up to a notch of the wheel yet
    this.poll = null;
    this.stderr = '';
    this.todo = []; // steering that is waiting its turn (see steer)
    this.steering = false;
  }

  say(phase, extra = {}) {
    tell({ t: 'state', id: this.id, phase, ...extra });
  }

  async start() {
    this.desk = await ensureDesk();
    await leaving;
    if (this.over) return;
    this.launch(this.url);
    this.film();
    // What the page calls itself can change at any time.
    this.poll = setInterval(() => this.look().catch(() => {}), 2000);
  }

  // Start the browser on an address, as a person would from a desktop.
  launch(url) {
    const dir = path.join(DATA, this.profile);
    fs.mkdirSync(dir, { recursive: true });
    // One browser at a time uses these files. A lock left by one that was cut short would turn this one away.
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(dir, f), { force: true });
    // The browser would bring back the tabs it had last time, and load them
    // all again behind the page that was asked for. What it remembers of its
    // tabs is thrown away; what it is signed in to is kept.
    fs.rmSync(path.join(dir, 'Default', 'Sessions'), { recursive: true, force: true });
    // The ad blocker, for a profile that wants one.
    let blocker = false;
    if (this.blockAds && UBLOCK) {
      try {
        freshBlocker();
        blocker = true;
      } catch (err) {
        log(`the ad blocker couldn't be set out for the browser (${err.message}): starting without it`);
      }
    }
    const args = [
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
      '--hide-crash-restore-bubble',
      // Nothing leaves except through DrivePost's guard (and no side doors around it).
      ...(this.proxy ? [`--proxy-server=${this.proxy}`, '--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : []),
      // One window, filling the screen, with none of the browser's own bars: the screen is the picture.
      '--window-position=0,0',
      `--window-size=${WIDTH},${HEIGHT}`,
      '--kiosk',
      // In its container the browser can't build its own inner sandbox; the container is the wall.
      ...(env.BROWSER_NO_SANDBOX === '0' ? [] : ['--no-sandbox']),
      // That blocker and no other extension, or no extension at all.
      ...(blocker ? [`--disable-extensions-except=${UBLOCK.dir}`, `--load-extension=${UBLOCK.dir}`] : ['--disable-extensions']),
      // (With the blocker: by way of the waiting page, until the blocker is at work. The guard is who it asks.)
      blocker && this.proxy ? waitingPage(url) : url,
    ];
    const proc = (this.proc = spawn(chromeBin(), args, { stdio: ['ignore', 'ignore', 'pipe'], env: this.desk.vars }));
    proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d).slice(-3000);
    });
    proc.on('error', (err) => {
      if (this.proc === proc) this.fail(`The browser couldn't be started (${err.message}).`);
    });
    proc.on('exit', () => {
      if (this.proc === proc) this.fail('The browser stopped.');
    });
  }

  /*
   * Film the screen and record the sound, and pass both on as they are
   * made. A second, smaller picture a few times a second is for the phone's
   * live view, and shows the mouse pointer, which the car's doesn't.
   *
   * The screen and the sound are two feeds, and they don't start at the
   * same instant: the sound can be most of a second behind the screen in
   * getting going. So each is stamped with the time on the clock as it is
   * taken, and those times are kept (-copyts) instead of each feed being
   * counted from its own start, which is what would put them out of step
   * by however far apart they started. (The clock's time is a very large
   * number: the same amount is taken off both on the way out.)
   */
  film() {
    if (this.over) return;
    const screen = ['-f', 'x11grab', '-video_size', `${WIDTH}x${HEIGHT}`, '-use_wallclock_as_timestamps', '1'];
    const since = (Date.now() / 1000 - 3).toFixed(3);
    const args = [
      '-hide_banner', '-loglevel', 'error', '-copyts',
      ...screen, '-framerate', '30', '-draw_mouse', '0', '-thread_queue_size', '512', '-i', this.desk.display,
      '-f', 'pulse', '-itsoffset', String(PICTURE_LAG_S), '-fragment_size', '8192', '-thread_queue_size', '512', '-i', 'drivepost.monitor',
      ...screen, '-framerate', String(VIEW.fps), '-draw_mouse', '1', '-thread_queue_size', '64', '-i', this.desk.display,
      // The recording never leaves this machine, so it can be a sharp one. DrivePost makes of it what the car needs.
      '-map', '0:v', '-map', '1:a',
      // (Each frame keeps the time it was taken at: none are added or dropped here to even them out.)
      '-fps_mode', 'passthrough',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '20', '-maxrate', '8M', '-bufsize', '8M', '-g', '30', '-pix_fmt', 'yuv420p',
      // (The sound is held to its times too, should the two clocks ever drift over a long evening.)
      '-af', 'aresample=async=1', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
      '-output_ts_offset', `-${since}`,
      '-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1', 'pipe:1',
      '-map', '2:v', '-fps_mode', 'passthrough', '-vf', `scale=${VIEW.width}:${VIEW.height}:flags=bilinear`, '-pix_fmt', 'yuvj420p', '-c:v', 'mjpeg', '-q:v', '9',
      '-f', 'mpjpeg', '-flush_packets', '1', 'pipe:3',
    ];
    const ff = (this.ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: this.desk.vars }));
    let first = true;
    let said = '';
    ff.stdout.on('data', (chunk) => {
      if (this.ff !== ff || this.over) return;
      if (first) {
        first = false;
        // Said before the first piece, so DrivePost knows a new recording starts here.
        tell({ t: 'rec', id: this.id, type: 'video/mp2t' });
        if (!this.up) {
          this.up = true;
          this.say('capturing', { sound: true });
        }
      }
      hand(1, chunk);
    });
    ff.stdio[3].on('data', (chunk) => {
      if (this.ff === ff && !this.over) this.viewData(chunk);
    });
    ff.stderr.on('data', (d) => {
      said = (said + d).slice(-600);
    });
    ff.on('error', (err) => {
      if (this.ff === ff) this.fail(`The screen couldn't be filmed (${err.message}).`);
    });
    ff.on('exit', () => {
      if (this.ff !== ff || this.over) return;
      // It stopped by itself. Started again a few times; after that something is wrong for good.
      this.ff = null;
      log(`filming the screen stopped${said.trim() ? ` | ${said.trim().split('\n').pop().slice(0, 200)}` : ''}`);
      if (++this.filmFails > 3) return this.fail("The page's picture stopped.");
      setTimeout(() => this.film(), 500);
    });
  }

  // A fresh recording: asked for when the one being sent couldn't be used.
  async again() {
    if (this.over) return;
    const old = this.ff;
    this.ff = null;
    if (alive(old)) old.kill('SIGKILL');
    this.viewBuf = Buffer.alloc(0);
    this.film();
  }

  // The live view arrives as one small picture after another, each with its length said first.
  viewData(chunk) {
    this.viewBuf = this.viewBuf.length ? Buffer.concat([this.viewBuf, chunk]) : chunk;
    for (;;) {
      const head = this.viewBuf.indexOf('\r\n\r\n');
      if (head < 0) break;
      const m = /content-length:\s*(\d+)/i.exec(this.viewBuf.subarray(0, head).toString('latin1'));
      const from = head + 4;
      if (!m) {
        this.viewBuf = this.viewBuf.subarray(from);
        continue;
      }
      const size = Number(m[1]);
      if (this.viewBuf.length < from + size) break;
      const picture = Buffer.from(this.viewBuf.subarray(from, from + size));
      this.viewBuf = this.viewBuf.subarray(from + size);
      // Only to a phone that is looking, and only when the screen has changed.
      if (this.viewing && !(this.viewLast && picture.equals(this.viewLast))) {
        this.viewLast = picture;
        hand(2, picture);
      }
    }
    if (this.viewBuf.length > 4 * 1024 * 1024) this.viewBuf = Buffer.alloc(0);
  }

  view(on) {
    this.viewing = !!on;
    this.viewLast = null; // the next picture goes out whatever it shows
  }

  // The mouse and keyboard.
  xdo(...args) {
    return run('xdotool', args.map(String), { vars: this.desk.vars });
  }

  // What the page calls itself: the name on the browser's window.
  async look() {
    if (this.over || !alive(this.proc)) return;
    let r = await this.xdo('getactivewindow', 'getwindowname');
    if (r.code !== 0) {
      // (No window manager to say which window is in front: take the browser's newest.)
      const found = await this.xdo('search', '--onlyvisible', '--class', 'chrom');
      const id = found.out.trim().split('\n').pop();
      if (!id) return;
      r = await this.xdo('getwindowname', id);
      if (r.code !== 0) return;
    }
    const name = r.out.trim().replace(/ - (Chromium|Google Chrome for Testing|Google Chrome)$/, '').slice(0, 200);
    // (Not the waiting page's name, nor its address, which a browser shows until a page has said its name.)
    if (!name || name === this.named || name === WAITING || name.startsWith(WAIT_HOST) || /^(New Tab|Untitled|about:blank)$/i.test(name)) return;
    this.named = name;
    tell({ t: 'page', id: this.id, url: this.url, title: name });
  }

  /*
   * Steering (taps, typing, Back and the rest) is done one thing at a time,
   * in the order it came: what was typed right behind a tap must not land
   * before the click has.
   */
  steer(msg, work) {
    const last = this.todo[this.todo.length - 1];
    const both = (kind) => last && last.msg.t === 'input' && last.msg.kind === kind && msg.t === 'input' && msg.kind === kind;
    // A drag sends scroll after scroll. Those still waiting are added up, so
    // a busy page doesn't go on scrolling after the finger has left.
    if (both('scroll')) {
      last.msg = { ...last.msg, dy: (Number(last.msg.dy) || 0) + (Number(msg.dy) || 0) };
      return;
    }
    // And of the places a finger has pointed at on its way, only the newest matters.
    if (both('point')) {
      last.msg = msg;
      return;
    }
    this.todo.push({ msg, work });
    if (!this.steering) this.steerOn();
  }

  async steerOn() {
    this.steering = true;
    while (this.todo.length && !this.over) {
      const { msg, work } = this.todo.shift();
      try {
        // One step that never comes back doesn't hold up the rest.
        await within(Promise.resolve(work(msg)), 8000, msg.t);
      } catch (err) {
        log(`${msg.t} failed: ${err.message}`);
      }
    }
    this.todo = [];
    this.steering = false;
  }

  async input(msg) {
    if (this.over || !alive(this.proc)) return;
    const at = (v, size) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * (size - 1));
    const x = at(msg.x, WIDTH);
    const y = at(msg.y, HEIGHT);
    if (msg.kind === 'tap') {
      // The mouse arrives, and then clicks: a player that shows its buttons
      // when the mouse comes near has them up by the time of the click.
      await this.xdo('mousemove', x, y, 'sleep', '0.12', 'click', '1');
    } else if (msg.kind === 'point') {
      // The mouse goes there and doesn't click (a finger held on the live view).
      await this.xdo('mousemove', x, y);
    } else if (msg.kind === 'scroll') {
      this.owed += Math.min(3, Math.max(-3, Number(msg.dy) || 0)) * HEIGHT;
      const notches = Math.trunc(this.owed / WHEEL_PX);
      if (!notches) return;
      this.owed -= notches * WHEEL_PX;
      await this.xdo('mousemove', x, y, 'click', '--repeat', Math.min(30, Math.abs(notches)), '--delay', '12', notches > 0 ? '5' : '4');
    } else if (msg.kind === 'text') {
      const text = String(msg.text || '').slice(0, 500);
      if (!text) return;
      // Plain letters are typed. Anything else (accents, other alphabets) is
      // pasted, which a keyboard that has no such keys can't get wrong.
      if (/^[\x20-\x7e]*$/.test(text) || !(await this.paste(text))) await this.xdo('type', '--delay', '14', '--', text);
    } else if (msg.kind === 'key' && Object.hasOwn(KEYS, msg.key)) {
      await this.xdo('key', KEYS[msg.key]);
    }
  }

  async paste(text) {
    let failed = false;
    // (It stays to hand the text over when the browser asks for it, and is taken away again afterwards.)
    const clip = spawn('xclip', ['-quiet', '-selection', 'clipboard', '-i'], { stdio: ['pipe', 'ignore', 'ignore'], env: this.desk.vars });
    clip.on('error', () => (failed = true));
    clip.stdin.on('error', () => {});
    clip.stdin.end(text);
    await sleep(150);
    if (failed) return false;
    await this.xdo('key', 'ctrl+v');
    await sleep(350);
    clip.kill();
    return true;
  }

  async nav(what) {
    if (this.over || !alive(this.proc)) return;
    await this.xdo('key', what === 'reload' ? 'F5' : what === 'forward' ? 'alt+Right' : 'alt+Left');
  }

  // Somewhere new in the same browser: it is closed and started again on the new address.
  async go(url) {
    if (this.over) return;
    this.url = String(url);
    this.named = '';
    const old = this.proc;
    this.proc = null;
    await closeBrowser(old, this.desk.vars);
    if (this.over) return;
    this.launch(this.url);
  }

  // "Block ads" was switched on or off. A browser takes an extension on as it
  // starts, so it is closed and started again, on the address it was opened at.
  async ads(on) {
    if (this.over || this.blockAds === !!on) return;
    this.blockAds = !!on;
    if (UBLOCK) await this.go(this.url);
  }

  /*
   * Play, pause and skip, through the browser's own media controls: the ones
   * a keyboard's play key and a desktop's media buttons use. They act on
   * whatever in the page is playing, without anything being done to the page.
   */
  async media(what, by) {
    if (this.over || !alive(this.proc)) return;
    const bus = (dest, ...rest) => run('dbus-send', ['--session', `--dest=${dest}`, '--type=method_call', '--print-reply', '--reply-timeout=2000', ...rest], { vars: this.desk.vars });
    const names = await bus('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListNames');
    const player = /org\.mpris\.MediaPlayer2\.chrom[A-Za-z0-9_.]*/.exec(names.out);
    // Nothing in the page is playing or paused that the browser knows of.
    if (!player) return tell({ t: 'said', id: this.id, what, result: 'none' });
    const call = (method, ...args) => bus(player[0], '/org/mpris/MediaPlayer2', `org.mpris.MediaPlayer2.Player.${method}`, ...args);
    const micros = (s) => `int64:${Math.round(s * 1e6)}`;
    if (what === 'pause') await call('Pause');
    else if (what === 'play') await call('Play');
    else if (what === 'seek') {
      const s = Math.min(600, Math.max(-600, Number(by) || 0));
      if (s) await call('Seek', micros(s));
    }
  }

  fail(message) {
    if (this.over) return;
    // (The browser grumbles about things a container doesn't have; those lines say nothing about this.)
    const last = this.stderr.trim().split('\n').filter((l) => !/dbus|DBus|component_updater|gcm|registration_request|vaapi|gpu/i.test(l)).pop();
    log(`${message}${last ? ` | ${last.slice(0, 300)}` : ''}`);
    this.end('failed', message);
  }

  close() {
    this.end('closed');
  }

  end(phase, message) {
    if (this.over) return;
    this.over = true;
    clearInterval(this.poll);
    if (session === this) session = null;
    this.say(phase, message ? { message } : {});
    const ff = this.ff;
    this.ff = null;
    if (alive(ff)) ff.kill('SIGKILL');
    const proc = this.proc;
    this.proc = null;
    if (alive(proc)) leaving = closeBrowser(proc, this.desk.vars);
  }
}

async function open(msg) {
  if (session) session.close();
  const s = (session = new Session(msg));
  log(`opening ${safeHost(msg.url)}`);
  try {
    await s.start();
  } catch (err) {
    s.fail(`The page couldn't be opened: ${err.message}.`);
  }
}

function handle(msg) {
  if (msg.t === 'open') return void open(msg);
  const s = session;
  if (!s || s.id !== msg.id) return;
  const run = (p) => Promise.resolve(p).catch((err) => log(`${msg.t} failed: ${err.message}`));
  if (msg.t === 'close') s.close();
  else if (msg.t === 'go') s.steer(msg, (m) => s.go(m.url));
  else if (msg.t === 'ads') s.steer(msg, (m) => s.ads(m.on));
  else if (msg.t === 'input') s.steer(msg, (m) => s.input(m));
  else if (msg.t === 'nav') s.steer(msg, (m) => s.nav(m.what));
  else if (msg.t === 'media') s.steer(msg, (m) => s.media(m.what, m.by));
  else if (msg.t === 'view') s.view(!!msg.on);
  else if (msg.t === 'again') run(s.again());
}

let waits = 0;
let saidWaiting = false;
function connect() {
  const key = readKey();
  if (!key) {
    if (!saidWaiting) log('waiting for DrivePost to write the key the two of them share...');
    saidWaiting = true;
    return setTimeout(connect, 2000);
  }
  const ws = new WebSocket(SERVER, { headers: { 'x-drivepost-browser': key }, maxPayload: 1024 * 1024 });
  ws.on('open', () => {
    server = ws;
    waits = 0;
    log('connected to DrivePost');
    tell({ t: 'hello', width: WIDTH, height: HEIGHT, ublock: UBLOCK ? UBLOCK.version : '' });
    ensureDesk().catch((err) => log(`the browser's desk couldn't be set up yet (${err.message})`));
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      handle(JSON.parse(data));
    } catch (err) {
      log(`a message from DrivePost couldn't be read: ${err.message}`);
    }
  });
  ws.on('error', (err) => {
    if (waits === 0 || waits % 30 === 0) log(`can't reach DrivePost yet (${err.message})`);
  });
  ws.on('close', () => {
    if (server === ws) {
      server = null;
      log('lost DrivePost: closing the page and trying again');
    }
    // Nobody is there to watch it or to stop it.
    if (session) session.close();
    waits++;
    setTimeout(connect, Math.min(10000, 1000 + waits * 500));
  });
}

function quit() {
  // (Said in words: a page that closes under someone deserves a reason.)
  if (session) session.end('failed', "The server's browser is restarting.");
  const mine = desk;
  desk = null;
  // The browser first, so it can write down what it was signed in to; then the desk it sat at.
  leaving.then(() => {
    if (mine) for (const p of mine.procs) if (alive(p)) p.kill();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 7000).unref();
}
process.on('SIGTERM', quit);
process.on('SIGINT', quit);

log(`ready (browser: ${chromeBin()})`);
log(UBLOCK ? `ad blocker: uBlock Origin Lite ${UBLOCK.version}` : 'ad blocker: none here (DrivePost\'s own list still applies)');
connect();
