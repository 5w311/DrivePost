/*
 * The browser DrivePost opens pages in.
 *
 * Some links can't be turned into a video: the page has a player of its
 * own and nothing behind it that can be fetched. DrivePost then opens the
 * page itself, here, in an ordinary browser on a screen nobody looks at, and
 * shows the car a picture of it with its sound. A phone steers it: it gets a
 * small live view of the page, and its taps and typing are passed on.
 *
 * This program is all that runs in this container besides the browser. It
 *   - connects out to DrivePost and does what it is told (open this address,
 *     tap here, go back, close);
 *   - starts the browser for one page at a time, each profile with its own
 *     sign-ins;
 *   - has a second tab record the first, the way a video call shares a tab
 *     (capture.html), and passes the recording on to DrivePost as it is made.
 *
 * The container has no way out to the internet of its own. Everything the
 * browser fetches goes through DrivePost, which refuses addresses on the
 * home network. The page being shown is never trusted: it can't reach this
 * program (the two addresses it serves carry a code only this browser's own
 * tabs are given), and the browser is driven over a pipe, not a port.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { Cdp } from './cdp.js';

const env = process.env;
const SERVER = env.DRIVEPOST_WS || 'ws://drivepost:8080/ws/browser';
const KEY_FILE = env.BROWSER_KEY_FILE || '/run/drivepost-browser/key';
const DATA = env.BROWSER_DATA || '/browser-data';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// The screen the browser is given, and so the size of a video that fills it.
// (While a page is only being looked through, the browser's own bars take a
// strip of that, and the picture is a little wider than it is tall for it.)
const WIDTH = 1280;
const HEIGHT = 720;
const RECORD_BPS = 6000000; // the recording never leaves this machine, so it can be a sharp one
const VIEW = { width: 640, height: 360, quality: 50, everyMs: 250 }; // the phone's live view

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

// ---------- the two pages of its own this browser is given ----------
// Served on this machine only, at addresses that carry a code made afresh
// each time this program starts.
const code = crypto.randomBytes(16).toString('hex');
const MARK = `DrivePost stage ${code.slice(0, 8)}`; // the capture finds the tab to record by this title
const STAGE = `<!doctype html><meta charset="utf-8"><title>${MARK}</title>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0f14;color:#8b98a8;font:28px system-ui,sans-serif">Opening the page…</body>`;
const CAPTURE = fs.readFileSync(path.join(HERE, 'capture.html'));
const PUMP = fs.readFileSync(path.join(HERE, 'pump.js'));

const HOME_BASE = 'http://127.0.0.1';
const local = http.createServer((req, res) => {
  const p = (req.url || '').split('?')[0];
  const send = (type, body) => {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  if (p === `/stage/${code}`) return send('text/html; charset=utf-8', STAGE);
  if (p === `/capture/${code}`) return send('text/html; charset=utf-8', CAPTURE);
  if (p === '/pump.js') return send('text/javascript; charset=utf-8', PUMP);
  res.writeHead(404);
  res.end();
});
const uploads = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
local.on('upgrade', (req, socket, head) => {
  // Only the recording tab of the page that is open now. (A browser can
  // bring back the tabs it had last time; one of those is turned away here.)
  const u = new URL(req.url || '/', HOME_BASE);
  const s = session;
  if (u.pathname !== `/up/${code}` || !s || u.searchParams.get('s') !== s.nonce) return socket.destroy();
  uploads.handleUpgrade(req, socket, head, (ws) => {
    if (session === s && !s.over) s.capturePage(ws);
    else ws.close();
  });
});
await new Promise((done) => local.listen(0, '127.0.0.1', done));
const HOME = `http://127.0.0.1:${local.address().port}`;

// ---------- a screen for the browser ----------
// An ordinary windowed browser needs a screen, so it gets one that exists
// only in memory. Without one (Xvfb missing, or it won't start) the browser
// runs with no window at all, which works too.
let display = null;
async function ensureDisplay() {
  if (display) return display;
  if (env.BROWSER_HEADLESS === '1') return (display = { headless: true });
  const n = Number(env.BROWSER_DISPLAY) || 99;
  try {
    fs.rmSync(`/tmp/.X${n}-lock`, { force: true }); // left by a run that was cut short
    const proc = spawn('Xvfb', [`:${n}`, '-screen', '0', `${WIDTH}x${HEIGHT}x24`, '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
    let failed = null;
    proc.on('error', (err) => (failed = err));
    proc.on('exit', () => {
      failed = failed || new Error('it stopped');
      if (display && display.proc === proc) display = null;
    });
    for (let i = 0; i < 50 && !failed && !fs.existsSync(`/tmp/.X11-unix/X${n}`); i++) await sleep(100);
    if (failed || !fs.existsSync(`/tmp/.X11-unix/X${n}`)) {
      proc.kill();
      throw failed || new Error('it never came up');
    }
    display = { name: `:${n}`, proc };
  } catch (err) {
    log(`no virtual screen (${err.message}): the browser will run without a window`);
    display = { headless: true };
  }
  return display;
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

// ---------- one page ----------
let session = null;
// The browser of the page before this one, on its way out. The next one
// waits for it: two browsers can't share one profile's files.
let leaving = Promise.resolve();

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
};

/*
 * Run in the page: make its video fill the screen. The biggest video in view
 * is the one; a player that sits in a frame of its own (most embedded ones
 * do) is filled by its frame.
 */
const FILL = `(() => {
  const found = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'VIDEO' || el.tagName === 'IFRAME') found.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  let best = null, most = 200 * 110;
  for (const el of found) {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    if (w <= 0 || h <= 0) continue;
    const area = w * h * (el.tagName === 'VIDEO' && !el.paused ? 1.5 : 1);
    if (area > most) { most = area; best = el; }
  }
  if (!best) return 'none';
  return best.requestFullscreen().then(() => 'ok', (e) => 'refused');
})()`;
const UNFILL = `(document.fullscreenElement ? document.exitFullscreen().then(() => 'ok', () => 'refused') : 'ok')`;

class Session {
  constructor({ id, url, profile, guardPort }) {
    this.id = id;
    this.nonce = crypto.randomBytes(8).toString('hex'); // tells this page's recording tab from any other
    this.url = String(url);
    this.profile = String(profile || 'main').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || 'main';
    // The way out: DrivePost's guard, on the machine this program is connected to.
    this.proxy = Number(guardPort) ? `http://${new URL(SERVER).hostname}:${Number(guardPort)}` : '';
    this.proc = null;
    this.cdp = null;
    this.stage = null; // the tab that shows the page
    this.stageTarget = null;
    this.cap = null; // the tab that records it
    this.capTarget = null;
    this.capSocket = null;
    this.capArrived = null;
    this.capHere = new Promise((done) => (this.capArrived = done));
    this.over = false;
    this.up = false; // the browser is running and the page is being captured
    this.wantView = false;
    this.viewing = false;
    this.viewAt = 0;
    this.viewNext = null; // the newest picture, waiting to be sent
    this.viewTimer = null;
    this.shown = { url: '', title: '' };
    this.size = { w: WIDTH, h: HEIGHT }; // how big the page is on its screen right now
    this.poll = null;
    this.stderr = '';
    this.todo = []; // steering that is waiting its turn (see steer)
    this.steering = false;
  }

  /*
   * Steering (taps, typing, Back and the rest) is done one thing at a time,
   * in the order it came. A tap is several steps, each answered by the
   * browser before the next is sent, and what was typed right behind it must
   * not land between them: it would be typed before the box had been
   * clicked, into nothing.
   */
  steer(msg, work) {
    const last = this.todo[this.todo.length - 1];
    // A drag sends scroll after scroll. Those still waiting are added up, so
    // a busy page doesn't go on scrolling after the finger has left.
    if (last && last.msg.t === 'input' && last.msg.kind === 'scroll' && msg.t === 'input' && msg.kind === 'scroll') {
      last.msg = { ...last.msg, dy: (Number(last.msg.dy) || 0) + (Number(msg.dy) || 0) };
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
        await within(Promise.resolve(work(msg)), 5000, msg.t);
      } catch (err) {
        log(`${msg.t} failed: ${err.message}`);
      }
    }
    this.todo = [];
    this.steering = false;
  }

  say(phase, extra = {}) {
    tell({ t: 'state', id: this.id, phase, ...extra });
  }

  async start() {
    const screen = await ensureDisplay();
    await leaving;
    if (this.over) return;
    const dir = path.join(DATA, this.profile);
    fs.mkdirSync(dir, { recursive: true });
    // One browser at a time uses these files. A lock left by one that was cut short would turn this one away.
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(dir, f), { force: true });
    // The browser would bring back the tabs it had last time, and load them all
    // again behind the page that was asked for. What it remembers of its tabs
    // is thrown away; what it is signed in to is kept.
    fs.rmSync(path.join(dir, 'Default', 'Sessions'), { recursive: true, force: true });

    const args = [
      `--user-data-dir=${dir}`,
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
      '--disable-sync',
      '--disable-notifications',
      '--hide-crash-restore-bubble',
      '--disable-session-crashed-bubble',
      '--disable-features=Translate,MediaRouter,PrivacySandboxSettings4',
      // Both tabs keep working at full pace whichever is in front.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      // A page's video may start without the tap a person would give it: the tap comes from a phone.
      '--autoplay-policy=no-user-gesture-required',
      // The recording tab is given the page's tab without anyone choosing it in a window.
      `--auto-select-tab-capture-source-by-title=${MARK}`,
      // Nothing leaves except through DrivePost's guard (and no side doors around it).
      ...(this.proxy
        ? [`--proxy-server=${this.proxy}`, `--proxy-bypass-list=<-loopback>;127.0.0.1:${local.address().port}`, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']
        : []),
      '--window-position=0,0',
      `--window-size=${WIDTH},${HEIGHT}`,
      ...(screen.headless ? ['--headless=new', `--screen-info={${WIDTH}x${HEIGHT}}`] : ['--kiosk']),
      // In its container the browser can't build its own inner sandbox; the container is the wall.
      ...(env.BROWSER_NO_SANDBOX === '0' ? [] : ['--no-sandbox']),
      'about:blank',
    ];
    this.proc = spawn(chromeBin(), args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      env: { ...env, ...(screen.name ? { DISPLAY: screen.name } : {}) },
    });
    this.proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d).slice(-3000);
    });
    this.proc.on('error', (err) => this.fail(`The browser couldn't be started (${err.message}).`));
    this.proc.on('exit', () => this.fail('The browser stopped.'));
    const cdp = (this.cdp = new Cdp(this.proc.stdio[3], this.proc.stdio[4]));
    this.listen(cdp);

    await cdp.send('Target.setDiscoverTargets', { discover: true });
    let first = null;
    for (let i = 0; i < 100 && !first; i++) {
      first = (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page');
      if (!first) await sleep(100);
    }
    if (!first) throw new Error('the browser opened no window');
    this.stageTarget = first.targetId;
    this.stage = (await cdp.send('Target.attachToTarget', { targetId: first.targetId, flatten: true })).sessionId;
    await cdp.send('Page.enable', {}, this.stage);
    // Without a window there is nothing to give the page its size, so it is told one.
    if (screen.headless) await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, this.stage);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    const loaded = this.once('Page.loadEventFired', this.stage);
    await cdp.send('Page.navigate', { url: `${HOME}/stage/${code}` }, this.stage);
    await within(loaded, 15000, 'starting the browser');

    // The second tab, which records the first.
    const made = await cdp.send('Target.createTarget', { url: `${HOME}/capture/${code}?s=${this.nonce}`, newWindow: true });
    this.capTarget = made.targetId;
    this.cap = (await cdp.send('Target.attachToTarget', { targetId: made.targetId, flatten: true })).sessionId;
    // Two tabs and no more: anything the browser brought back from last time is closed.
    for (const t of (await cdp.send('Target.getTargets')).targetInfos) {
      if (t.type === 'page' && t.targetId !== this.stageTarget && t.targetId !== this.capTarget) await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    }
    await within(this.capHere, 15000, 'getting the recording tab ready');
    const began = await within(
      cdp.send('Runtime.evaluate', {
        expression: `start(${JSON.stringify({ width: WIDTH, height: HEIGHT, bps: RECORD_BPS })})`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      }, this.cap),
      20000,
      'capturing the page',
    );
    if (began.exceptionDetails) throw new Error(`the page couldn't be captured (${(began.exceptionDetails.exception || {}).description || began.exceptionDetails.text})`);
    if (this.over) return;
    this.say('capturing', { sound: !!(began.result.value || {}).sound, windowed: !screen.headless });
    this.up = true;
    // The page's tab in front, as the one being looked at: the recording tab works on behind it.
    await cdp.send('Page.bringToFront', {}, this.stage).catch(() => {});
    await this.measure();
    await this.go(this.url);
    if (this.wantView) this.view(true).catch((err) => log(`the live view couldn't start: ${err.message}`));
    // What the page calls itself can change at any time without it going anywhere.
    this.poll = setInterval(() => this.look().catch(() => {}), 3000);
  }

  // How big the page is on its screen (taps are placed by it).
  async measure() {
    if (this.over || !this.stage) return;
    const m = await this.cdp.send('Page.getLayoutMetrics', {}, this.stage);
    const v = m.cssVisualViewport || m.visualViewport || {};
    if (v.clientWidth > 0 && v.clientHeight > 0) this.size = { w: v.clientWidth, h: v.clientHeight };
  }

  // Where the page is and what it calls itself, passed on when either has changed.
  async look() {
    if (this.over || !this.stage) return;
    const r = await this.cdp.send('Runtime.evaluate', { expression: 'JSON.stringify([location.href, document.title])', returnByValue: true }, this.stage);
    let at;
    try {
      at = JSON.parse(r.result.value);
    } catch {
      return;
    }
    const [url, title] = at;
    if (!/^https?:/i.test(url) || url.startsWith(HOME)) return;
    if (url === this.shown.url && title === this.shown.title) return;
    this.shown = { url, title };
    tell({ t: 'page', id: this.id, url: String(url).slice(0, 2000), title: String(title || '').slice(0, 200) });
  }

  // Resolves the next time the browser reports `method` about the tab `sessionId`.
  once(method, sessionId) {
    return new Promise((resolve) => {
      const on = (params, sid) => {
        if (sid !== sessionId) return;
        this.cdp.off(method, on);
        resolve(params);
      };
      this.cdp.on(method, on);
    });
  }

  listen(cdp) {
    cdp.on('gone', () => this.fail('The browser stopped.'));
    const ours = (url) => !url || url === 'about:blank' || url.startsWith(HOME);

    const moved = (info) => {
      // The page's own tab: it has a new name or address, so see what it calls itself now.
      if (info.targetId === this.stageTarget) return void this.look().catch(() => {});
      // A page that opens another window gets it in the same tab instead:
      // there is one picture, and it is of this tab.
      if (info.type !== 'page' || info.targetId === this.capTarget || ours(info.url)) return;
      if (!this.stage || this.over) return;
      cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
      if (/^https?:/i.test(info.url)) this.go(info.url).catch(() => {});
    };
    cdp.on('Target.targetCreated', (p) => moved(p.targetInfo));
    cdp.on('Target.targetInfoChanged', (p) => moved(p.targetInfo));

    // The page has gone somewhere, or finished loading: see what it calls itself now.
    const arrived = (p, sid) => {
      if (sid === this.stage && !(p && p.frame && p.frame.parentId)) this.look().catch(() => {});
    };
    cdp.on('Page.frameNavigated', arrived);
    cdp.on('Page.navigatedWithinDocument', arrived);
    cdp.on('Page.loadEventFired', arrived);
    cdp.on('Page.domContentEventFired', arrived);
    // Its size changed (a video was made to fill the screen, say).
    cdp.on('Page.frameResized', (p, sid) => {
      if (sid === this.stage) this.measure().catch(() => {});
    });

    // "Leave this page?", an alert, a confirm: nobody is there to press OK.
    cdp.on('Page.javascriptDialogOpening', (p, sid) => {
      if (sid === this.stage) cdp.send('Page.handleJavaScriptDialog', { accept: true }, sid).catch(() => {});
    });

    // The phone's live view: a small picture of the page, a few times a second at most.
    cdp.on('Page.screencastFrame', (p, sid) => {
      if (sid !== this.stage) return;
      cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid).catch(() => {});
      const meta = p.metadata || {};
      if (meta.deviceWidth > 0 && meta.deviceHeight > 0) this.size = { w: meta.deviceWidth, h: meta.deviceHeight };
      if (!this.viewing) return;
      // No more often than the phone needs, but always ending on the newest:
      // a picture that came too soon after the last waits its turn, and is
      // replaced by any that comes while it waits.
      this.viewNext = p.data;
      if (this.viewTimer) return;
      const send = () => {
        this.viewTimer = null;
        if (this.over || !this.viewing || !this.viewNext) return;
        this.viewAt = Date.now();
        hand(2, Buffer.from(this.viewNext, 'base64'));
        this.viewNext = null;
      };
      const wait = VIEW.everyMs - (Date.now() - this.viewAt);
      if (wait <= 0) send();
      else this.viewTimer = setTimeout(send, wait);
    });
  }

  // The recording tab has connected back: it sends the recording up this socket.
  capturePage(ws) {
    if (this.capSocket) this.capSocket.close();
    this.capSocket = ws;
    this.capArrived();
    ws.on('message', (data, isBinary) => {
      if (this.over || this.capSocket !== ws) return;
      if (isBinary) return hand(1, data);
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.recording) tell({ t: 'rec', id: this.id, type: String(msg.type || '') });
      else if (msg.ended) this.fail('The page stopped being captured.');
      else if (msg.error) this.fail(String(msg.error).slice(0, 200));
    });
    ws.on('close', () => {
      // When the whole browser goes down its tabs go first: give it a moment
      // to be the one that says what happened.
      setTimeout(() => {
        if (this.capSocket === ws && !this.over) this.fail('The recording tab went away.');
      }, 700);
    });
  }

  async go(url) {
    if (this.over || !this.stage) return;
    const r = await this.cdp.send('Page.navigate', { url: String(url) }, this.stage);
    // The browser shows its own "can't reach this page", which the car and the phone both see.
    if (r.errorText && r.errorText !== 'net::ERR_ABORTED') log(`couldn't open ${safeHost(url)}: ${r.errorText}`);
  }

  async input(msg) {
    if (this.over || !this.stage) return;
    const send = (method, params) => this.cdp.send(method, params, this.stage);
    const at = (v, size) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * size);
    const x = at(msg.x, this.size.w);
    const y = at(msg.y, this.size.h);
    if (msg.kind === 'tap') {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    } else if (msg.kind === 'scroll') {
      const dy = Math.min(3, Math.max(-3, Number(msg.dy) || 0)) * this.size.h;
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: Math.round(dy) });
    } else if (msg.kind === 'text') {
      const text = String(msg.text || '').slice(0, 500);
      if (text) await send('Input.insertText', { text });
    } else if (msg.kind === 'key' && Object.hasOwn(KEYS, msg.key)) {
      const k = KEYS[msg.key];
      await send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...k, nativeVirtualKeyCode: k.windowsVirtualKeyCode });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, nativeVirtualKeyCode: k.windowsVirtualKeyCode });
    }
  }

  async nav(what) {
    if (this.over || !this.stage) return;
    if (what === 'reload') return this.cdp.send('Page.reload', {}, this.stage);
    const h = await this.cdp.send('Page.getNavigationHistory', {}, this.stage);
    const to = h.entries[h.currentIndex + (what === 'forward' ? 1 : -1)];
    // (The first entries are this browser's own blank and "Opening" pages: there is no going back to those.)
    if (!to || !/^https?:/i.test(to.url) || to.url.startsWith(HOME)) return tell({ t: 'said', id: this.id, what, result: 'none' });
    await this.cdp.send('Page.navigateToHistoryEntry', { entryId: to.id }, this.stage);
  }

  async fill(on) {
    if (this.over || !this.stage) return;
    const r = await this.cdp.send('Runtime.evaluate', { expression: on ? FILL : UNFILL, awaitPromise: true, returnByValue: true, userGesture: true }, this.stage);
    tell({ t: 'said', id: this.id, what: on ? 'fill' : 'unfill', result: r.exceptionDetails ? 'refused' : String(r.result.value) });
  }

  async view(on) {
    // A phone can ask before the page's tab is there: it is remembered and done once it is.
    this.wantView = !!on;
    if (this.over || !this.stage || !this.up || this.viewing === !!on) return;
    this.viewing = !!on;
    if (!on) return void (await this.cdp.send('Page.stopScreencast', {}, this.stage).catch(() => {}));
    this.viewAt = 0;
    // The browser turns this down while the tab is between two pages, so it is asked until it takes.
    for (let i = 0; i < 20 && !this.over && this.viewing; i++) {
      try {
        await this.cdp.send('Page.bringToFront', {}, this.stage).catch(() => {});
        await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: VIEW.quality, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 }, this.stage);
        return;
      } catch (err) {
        if (i === 19) {
          this.viewing = false;
          throw err;
        }
        await sleep(500);
      }
    }
  }

  // DrivePost couldn't use the recording: start a new one of the same capture.
  async again() {
    if (this.over || !this.cap) return;
    await this.cdp.send('Runtime.evaluate', { expression: `again(${RECORD_BPS})`, returnByValue: true }, this.cap);
  }

  fail(message) {
    if (this.over) return;
    // (The browser grumbles about things a container doesn't have; those lines say nothing about this.)
    const last = this.stderr.trim().split('\n').filter((l) => !/dbus|DBus|component_updater|gcm|registration_request/i.test(l)).pop();
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
    clearTimeout(this.viewTimer);
    if (session === this) session = null;
    this.say(phase, message ? { message } : {});
    if (this.capSocket) this.capSocket.close();
    const proc = this.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      leaving = new Promise((gone) => proc.once('exit', gone));
      // Asked to go first, so that what was signed in to is written down properly.
      const closing = this.cdp && !this.cdp.closed ? this.cdp.send('Browser.close').catch(() => {}) : Promise.resolve();
      closing.then(() => {
        setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
        }, 3000).unref();
      });
    }
  }
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'that address';
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
  else if (msg.t === 'input') s.steer(msg, (m) => s.input(m));
  else if (msg.t === 'nav') s.steer(msg, (m) => s.nav(m.what));
  else if (msg.t === 'fill') s.steer(msg, (m) => s.fill(m.on !== false));
  else if (msg.t === 'view') run(s.view(!!msg.on));
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
    tell({ t: 'hello', width: WIDTH, height: HEIGHT });
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
  if (display && display.proc) display.proc.kill();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGTERM', quit);
process.on('SIGINT', quit);

log(`ready (browser: ${chromeBin()})`);
connect();
