import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { config, QUALITIES } from './config.js';
import { Auth, clientIp, ORIGINAL } from './auth.js';
import { Store } from './state.js';
import { handleStream } from './stream.js';
import { stampPage, feedbackLink } from './pages.js';
import { recommendFor } from './recommend.js';
import {
  search,
  suggest,
  videoMeta,
  extractVideoId,
  isValidId,
  startAutoUpdate,
  prewarm,
  TEST_PATTERN_ID,
  TEST_PATTERN_ITEM,
} from './youtube.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

// Changes whenever the pages or their scripts change, so an open car page
// can tell it's out of date after an update and reload itself.
function assetVersion() {
  const hash = crypto.createHash('sha1');
  for (const name of fs.readdirSync(PUBLIC_DIR).sort()) {
    if (!/\.(js|css|html|webmanifest)$/.test(name)) continue;
    hash.update(name);
    hash.update(fs.readFileSync(path.join(PUBLIC_DIR, name)));
  }
  return hash.digest('hex').slice(0, 12);
}
const VERSION = assetVersion();
const STARTED = Date.now();

if (!config.passcode) {
  console.error('DRIVE_PASSCODE is not set. Set it in your .env file and restart.');
  process.exit(1);
}

fs.mkdirSync(config.dataDir, { recursive: true });
const auth = new Auth({
  dataDir: config.dataDir,
  passcode: config.passcode,
  shareToken: config.shareToken,
});

// ---------- profiles ----------
// Each profile keeps its own now playing, Up Next, history and settings, in a
// folder of its own. The one profile a server had before profiles existed
// keeps them where they always were, in the data folder itself.
const stores = new Map();
function profileDir(id) {
  return id === ORIGINAL ? config.dataDir : path.join(config.dataDir, 'profiles', id);
}
// Delete a removed profile's Up Next, history and settings.
function deleteProfileData(id) {
  // The original profile's file sits next to everyone's sign-ins: only that file goes.
  if (id === ORIGINAL) {
    fs.rmSync(path.join(config.dataDir, 'state.json'), { force: true });
    fs.rmSync(path.join(config.dataDir, 'state.json.tmp'), { force: true });
  } else fs.rmSync(profileDir(id), { recursive: true, force: true });
}
function storeFor(id) {
  let store = stores.get(id);
  if (!store) {
    store = new Store({ dataDir: profileDir(id), defaultQuality: config.defaultQuality });
    store.on('state', (state) => {
      broadcast(id, { type: 'state', state });
      // Look up what's playing and what's next ahead of time, so they start faster.
      if (store.now) prewarm(store.now.id, store.playQuality());
      if (store.queue[0]) prewarm(store.queue[0].id, store.settings.quality);
    });
    stores.set(id, store);
  }
  return store;
}
// A name for the log and the screens. Only shown once there's more than one profile.
function profileLabel(id) {
  const p = auth.profile(id);
  return auth.profiles.length > 1 && p ? p.name : '';
}

// ---------- an update that is waiting for a video to stop ----------
// The updater on this machine (scripts/auto-update.sh) won't restart the app
// while a video is playing. While it holds an update back for that, it keeps
// a request open here saying so. The Admin page then shows the update, with
// a button to let it in anyway, and pressing that answers the updater at once.
const update = {
  waiting: null, // { commit: "abc1234 Title", since, at }: the update being held back
  forcedAt: 0, // when Admin said to install it regardless
  goingInAt: 0, // when the updater was told to go ahead
  failed: null, // { commit, at }: an update that couldn't be installed
  held: new Set(), // the updater's open requests: functions that answer them
};
const WAITING_FRESH_MS = 4 * 60 * 1000; // while it waits, the updater is back within this long
const FORCED_FOR_MS = 10 * 60 * 1000; // long enough for the updater's next run, not for ever if that never comes
const GOING_IN_FOR_MS = 20 * 60 * 1000; // a build that hasn't replaced this app by then didn't
const FAILED_SHOWN_MS = 60 * 60 * 1000; // the updater tries a failed update again after an hour
const HOLD_AT_MOST_S = 110;

const updateForced = () => !!update.forcedAt && Date.now() - update.forcedAt < FORCED_FOR_MS;
const updateGoingIn = () => !!update.goingInAt && Date.now() - update.goingInAt < GOING_IN_FOR_MS;
// The update being held back, for as long as the updater keeps saying so
// (or is on the line, or is busy installing it).
function waitingUpdate() {
  const w = update.waiting;
  if (!w) return null;
  if (update.held.size || updateGoingIn() || Date.now() - w.at <= WAITING_FRESH_MS) return w;
  return null;
}
// Is a video playing on any profile's car?
const someonePlaying = () => [...stores.values()].some((st) => !!st.now && !st.paused && st.carOnline);

// What the updater is told when it asks whether it may restart the app.
// "Not busy" is its go-ahead: it starts installing straight away.
function updateAnswer() {
  const forced = updateForced();
  const busy = someonePlaying() && !forced;
  if (!busy) update.goingInAt = Date.now();
  return { busy, forced };
}
// For the Admin page: the update that is waiting (or that failed), and how far along it is.
function updateView() {
  const w = waitingUpdate();
  if (w) {
    const state = updateGoingIn() ? 'installing' : updateForced() ? 'forced' : someonePlaying() ? 'waiting' : 'next';
    return { commit: w.commit, since: w.since, state };
  }
  const f = update.failed;
  if (f && Date.now() - f.at < FAILED_SHOWN_MS) return { commit: f.commit, since: f.at, state: 'failed' };
  return null;
}
// Only this machine itself may ask (the updater does, from inside the
// container): never anything that came in through the tunnel.
function fromThisMachine(req) {
  const from = req.socket.remoteAddress || '';
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(from);
  return local && !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'];
}

// Where the list of updates is, to compare the running one against: the
// repo the Feedback button points at (so a fork points at itself).
function commitsUrl() {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/new/.exec(config.feedbackUrl || '');
  return `https://github.com/${m ? m[1] : '5w311/DrivePost'}/commits`;
}

// Everything the Admin page shows: the profiles and whether their cars are
// on, who is waiting for a profile, and which build is running.
function adminView() {
  return {
    profiles: auth.listProfiles().map((p) => {
      const st = stores.get(p.id);
      const carOnline = !!(st && st.carOnline);
      return { ...p, carOnline, playing: carOnline && !!st.now && !st.paused };
    }),
    requests: auth.listRequests(),
    allowRequests: auth.allowRequests,
    server: { version: VERSION, commit: config.commit, commits: commitsUrl(), startedAt: STARTED, update: updateView() },
  };
}

// ---------- helpers ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' && typeof body !== 'string' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function serveFile(res, file, { versioned = false } = {}) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    const isPage = path.extname(full) === '.html';
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream',
      // Pages are never kept, so they are always fetched fresh. A file asked
      // for by its version never changes, so it can be kept for good.
      'Cache-Control': isPage ? 'no-store' : versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(isPage ? stampPage(data.toString('utf8'), VERSION) : data);
  });
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { text };
  }
}

function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

// Add a shared link to a profile's car: play it if nothing is on, otherwise queue it.
async function shareText(store, text) {
  const raw = String(text || '');
  const id = extractVideoId(raw) || (raw.trim() === TEST_PATTERN_ID ? TEST_PATTERN_ID : null);
  if (!id) return { ok: false, message: "That doesn't look like a YouTube link." };
  const meta = await videoMeta(id).catch(() => ({ id, title: 'YouTube video', channel: '' }));
  const wasIdle = !store.now;
  store.command('enqueue', { item: meta });
  return { ok: true, title: meta.title, message: wasIdle ? `Playing: ${meta.title}` : `Added to Up Next: ${meta.title}` };
}

const PAGES = { '/': 'car.html', '/remote': 'remote.html', '/setup': 'setup.html' };

// The ready-made iPhone Shortcut, if this copy of DrivePost ships one. iPhones
// only open Shortcut files signed through Apple, which start with "AEA1".
const SHORTCUT_NAME = 'Send to Car';
let shortcutFile;
function signedShortcut() {
  if (shortcutFile === undefined) {
    try {
      const data = fs.readFileSync(path.join(PUBLIC_DIR, 'send-to-car.shortcut'));
      shortcutFile = data.subarray(0, 4).toString('latin1') === 'AEA1' ? data : null;
    } catch {
      shortcutFile = null;
    }
  }
  return shortcutFile;
}

// ---------- routes ----------

async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const profile = auth.profileOf(req); // which profile this device is signed in to, if any
  const authed = !!profile;
  const admin = auth.isAdmin(req); // has this device typed the server's own passcode?

  if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

  // For the update script on this machine: is a video playing right now?
  // Only answered from inside the container itself, never through the tunnel.
  if (req.method === 'GET' && p === '/internal/busy') {
    if (!fromThisMachine(req)) return send(res, 404, { error: 'Not found' });
    // Busy if any profile's car is playing, unless Admin said to update anyway.
    return send(res, 200, updateAnswer());
  }
  // From the same script, about an update it has: either that it is holding
  // it back because a video is playing, or that it couldn't install it.
  if (req.method === 'POST' && p === '/internal/update') {
    if (!fromThisMachine(req)) return send(res, 404, { error: 'Not found' });
    const body = await readJson(req);
    const commit = String(body.commit || '').replace(/\s+/g, ' ').trim().slice(0, 160) || 'An update';
    const now = Date.now();
    if (body.failed) {
      Object.assign(update, { waiting: null, forcedAt: 0, goingInAt: 0, failed: { commit, at: now } });
      return send(res, 200, { ok: true });
    }
    const since = update.waiting && update.waiting.commit === commit ? update.waiting.since : now;
    // (An updater that says it is waiting isn't installing anything, whatever it was told before.)
    Object.assign(update, { waiting: { commit, since, at: now }, failed: null, goingInAt: 0 });
    // It can ask to be kept waiting for the answer: then it hears the moment
    // Admin says to go ahead, and otherwise how things stand when the time is up.
    const hold = Math.min(Math.max(Number(body.hold) || 0, 0), HOLD_AT_MOST_S);
    if (hold && someonePlaying() && !updateForced()) {
      let gone = false; // the updater hung up
      await new Promise((resolve) => {
        const answer = () => {
          clearTimeout(timer);
          update.held.delete(answer);
          res.off('close', hungUp);
          resolve();
        };
        const hungUp = () => {
          gone = true;
          answer();
        };
        const timer = setTimeout(answer, hold * 1000);
        update.held.add(answer);
        res.on('close', hungUp);
      });
      if (gone) return undefined;
      if (update.waiting) update.waiting.at = Date.now();
    }
    return send(res, 200, updateAnswer());
  }

  // Admin is opened by typing the server's own passcode (DRIVE_PASSCODE).
  // Being signed in to a profile isn't enough.
  if (req.method === 'GET' && p === '/admin') {
    if (!admin) return redirect(res, '/login?admin=1');
    return serveFile(res, 'admin.html');
  }
  if (req.method === 'GET' && PAGES[p]) {
    if (!authed) return redirect(res, `/login?next=${encodeURIComponent(p + url.search)}`);
    return serveFile(res, PAGES[p]);
  }
  if (req.method === 'GET' && p === '/login') return serveFile(res, 'login.html');
  if (req.method === 'GET' && p === '/sw.js') return serveFile(res, 'sw.js');
  if (req.method === 'GET' && p === '/manifest.webmanifest') return serveFile(res, 'manifest.webmanifest');
  if (req.method === 'GET' && p.startsWith('/static/')) {
    return serveFile(res, p.slice('/static/'.length), { versioned: url.searchParams.get('v') === VERSION });
  }

  // Phone pairing link from the car's QR code.
  if (req.method === 'GET' && p.startsWith('/p/')) {
    const code = p.slice(3);
    // The phone joins the profile of the car that showed the code.
    const joined = auth.claimPairCode(code);
    if (joined) {
      auth.issueCookie(req, res, joined);
      // Tell the car, so it can put the QR code away by itself.
      broadcast(joined, { type: 'paired', code });
      return redirect(res, '/remote');
    }
    return redirect(res, '/login?expired=1&next=/remote');
  }

  // Android share target (installed web app).
  if (req.method === 'GET' && p === '/share') {
    if (!authed) return redirect(res, `/login?next=${encodeURIComponent(p + url.search)}`);
    const text = [url.searchParams.get('url'), url.searchParams.get('text'), url.searchParams.get('title')].join(' ');
    const result = await shareText(storeFor(profile), text);
    return redirect(res, `/remote?msg=${encodeURIComponent(result.message)}`);
  }

  if (req.method === 'POST' && p === '/api/login') {
    if (!auth.allowAttempt(clientIp(req))) return send(res, 429, { error: 'Too many tries. Wait a few minutes.' });
    const body = await readJson(req);
    // The server's own passcode opens Admin, and only Admin.
    if (auth.checkAdminPasscode(body.passcode)) {
      auth.issueAdminCookie(req, res);
      return send(res, 200, { ok: true, admin: true });
    }
    // Any other passcode decides which profile this device joins.
    const matched = auth.checkPasscode(body.passcode);
    if (!matched) {
      // The passcode of someone who asked for a profile and is still waiting.
      const waiting = auth.requestFor(body.passcode);
      if (waiting) return send(res, 202, { waiting: auth.showRequest(waiting) });
      // canAsk: the sign-in page may offer asking for a profile with it.
      return send(res, 401, { error: 'Wrong passcode', canAsk: auth.canAsk() });
    }
    auth.issueCookie(req, res, matched);
    return send(res, 200, { ok: true });
  }

  // ---- Admin: opened by the server's own passcode, apart from any profile ----
  if (req.method === 'POST' && p === '/api/admin/login') {
    if (!auth.allowAttempt(clientIp(req))) return send(res, 429, { error: 'Too many tries. Wait a few minutes.' });
    const body = await readJson(req);
    if (!auth.checkAdminPasscode(body.passcode)) return send(res, 401, { error: 'Wrong passcode' });
    auth.issueAdminCookie(req, res);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/admin/logout') {
    auth.clearAdminCookie(res);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && p === '/api/admin') {
    if (!admin) return send(res, 403, { error: 'Sign in to Admin first.' });
    return send(res, 200, adminView());
  }
  // Let a waiting update in although a video is playing, or take that back
  // while the updater hasn't heard yet.
  if (req.method === 'POST' && p === '/api/admin/update') {
    if (!admin) return send(res, 403, { error: 'Sign in to Admin first.' });
    const body = await readJson(req);
    const w = waitingUpdate();
    if (!w) return send(res, 409, { error: 'No update is waiting right now.' });
    if (!body.force) {
      if (updateGoingIn()) return send(res, 409, { error: 'It is already being installed.' });
      update.forcedAt = 0;
    } else if (!updateForced()) {
      update.forcedAt = Date.now();
      console.log(`[admin] told the updater to install ${w.commit} now${someonePlaying() ? ', although a video is playing' : ''}`);
      // Every screen is told, and the ones it will interrupt are told what happens to their video.
      for (const [id, st] of stores) {
        const playing = !!st.now && !st.paused && st.carOnline;
        broadcast(id, {
          type: 'toast',
          message: playing
            ? 'DrivePost is updating. The video will stop when the server restarts, then wait for a tap.'
            : 'DrivePost is updating. It will be back in a moment.',
        });
      }
      // If the updater is waiting on the line, it hears now.
      if (update.held.size) update.goingInAt = Date.now();
      for (const answer of [...update.held]) answer();
    }
    return send(res, 200, adminView());
  }
  // Adding, renaming and removing profiles, and answering people who asked for one.
  if (req.method === 'POST' && p === '/api/profiles') {
    if (!admin) return send(res, 403, { error: 'Sign in to Admin first.' });
    const body = await readJson(req);
    const id = String(body.id || '');
    try {
      if (body.action === 'add') auth.addProfile(body.name, body.passcode);
      else if (body.action === 'approve') {
        const made = auth.approveRequest(id);
        console.log(`[profiles] ${auth.profile(made).name} was allowed a profile`);
      } else if (body.action === 'decline') {
        const gone = auth.dropRequest(id);
        if (gone) console.log(`[profiles] ${gone.name}'s request was declined`);
      } else if (body.action === 'asking') auth.setAllowRequests(body.on === true);
      else if (body.action === 'rename') auth.renameProfile(id, body.name);
      else if (body.action === 'passcode') auth.setPasscode(id, body.passcode);
      else if (body.action === 'signout') {
        if (!auth.profile(id)) throw new Error('No such profile.');
        auth.rotateSessions(id);
        dropScreens(id);
      } else if (body.action === 'remove') {
        auth.removeProfile(id);
        dropScreens(id);
        const gone = stores.get(id);
        if (gone) {
          clearTimeout(gone.saveTimer);
          stores.delete(id);
        }
        deleteProfileData(id);
      } else return send(res, 400, { error: 'Unknown action' });
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
    tellProfileNames();
    return send(res, 200, adminView());
  }

  // Asking for a profile, from the sign-in page. None of this needs a
  // sign-in, and none of it opens anything: a request only becomes a profile
  // when it is allowed in Admin.
  if (p === '/api/join') {
    if (req.method === 'GET') return send(res, 200, { open: auth.canAsk() });
    if (req.method === 'POST') {
      if (!auth.allowAttempt(clientIp(req))) return send(res, 429, { error: 'Too many tries. Wait a few minutes.' });
      const body = await readJson(req);
      try {
        const before = auth.requests.length;
        const waiting = auth.askForProfile(body.name, body.passcode);
        if (auth.requests.length > before) console.log(`[profiles] ${waiting.name} asked for a profile (number ${waiting.code})`);
        return send(res, 200, { waiting });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
  }
  // The waiting page asks whether its request is still open, and can cancel
  // it. The id is long and random, and only the device that asked has it.
  if (p.startsWith('/api/join/')) {
    const id = p.slice('/api/join/'.length);
    if (req.method === 'GET') return send(res, 200, { waiting: !!auth.requestById(id) });
    if (req.method === 'DELETE') {
      const gone = auth.dropRequest(id);
      if (gone) console.log(`[profiles] ${gone.name} cancelled their request`);
      return send(res, 200, { ok: true });
    }
  }

  // The ready-made iPhone Shortcut. It's the same file for everyone and holds
  // no address or token (the phone asks for the personal link when adding
  // it), so it needs no sign-in: Safari's downloader can just fetch it.
  if (req.method === 'GET' && p.startsWith('/shortcut/') && p.endsWith('.shortcut')) {
    const file = signedShortcut();
    if (!file) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${SHORTCUT_NAME}.shortcut"`,
      'Content-Length': file.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(file);
  }

  // iPhone Shortcut (share token) or a signed-in browser.
  if (req.method === 'POST' && p === '/api/share') {
    // A share link belongs to one profile; a signed-in browser shares to its own.
    const target = auth.shareProfile(req, url.searchParams.get('key')) || profile;
    if (!target) {
      return send(res, 401, 'Wrong or old DrivePost link. Copy a fresh one from Setup & sharing.', 'text/plain; charset=utf-8');
    }
    const body = await readJson(req);
    const result = await shareText(storeFor(target), body.url || body.text || body.input || '');
    return send(res, result.ok ? 200 : 400, result.message, 'text/plain; charset=utf-8');
  }

  if (p.startsWith('/api/')) {
    if (!authed) return send(res, 401, { error: 'Sign in first' });
    const store = storeFor(profile);

    if (req.method === 'POST' && p === '/api/logout') {
      auth.clearCookie(res);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/logout-all') {
      // Signs out this profile's car and phones; other profiles aren't touched.
      auth.rotateSessions(profile);
      auth.clearCookie(res);
      dropScreens(profile);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, store.publicState());

    // The car's page sends this as it is being closed, when its usual channel
    // may already be gone.
    if (req.method === 'POST' && p === '/api/pause') {
      store.command('pause');
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/search') {
      try {
        const q = url.searchParams.get('q');
        const results = await search(q);
        // Worth remembering if it found something.
        if (results.length) store.noteSearch(q);
        return send(res, 200, { results });
      } catch (err) {
        return send(res, 502, { error: `Search failed: ${err.message}` });
      }
    }

    // Videos like the ones this profile has been watching.
    if (req.method === 'GET' && p === '/api/recommended') {
      return send(res, 200, await recommendFor({ now: store.now, history: store.history, queue: store.queue }));
    }

    if (req.method === 'GET' && p === '/api/suggest') {
      const suggestions = await suggest(url.searchParams.get('q')).catch(() => []);
      return send(res, 200, { suggestions });
    }

    if (req.method === 'POST' && p === '/api/resolve') {
      const body = await readJson(req);
      const text = String(body.text || '');
      const id = extractVideoId(text) || (text.trim() === TEST_PATTERN_ID ? TEST_PATTERN_ID : null);
      if (!id) return send(res, 400, { error: "That doesn't look like a YouTube link." });
      try {
        return send(res, 200, { item: await videoMeta(id) });
      } catch (err) {
        return send(res, 502, { error: `Couldn't look that up: ${err.message}` });
      }
    }

    if (req.method === 'GET' && p === '/api/pair') {
      const link = `${baseUrl(req)}/p/${auth.newPairCode(profile)}`;
      const svg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      return send(res, 200, { link, svg });
    }

    // The car's Feedback button: a QR code for a pre-filled GitHub issue.
    if (req.method === 'POST' && p === '/api/feedback') {
      if (!config.feedbackUrl) return send(res, 404, { error: 'Feedback is switched off on this server.' });
      const body = await readJson(req);
      const link = feedbackLink(config.feedbackUrl, body.details, VERSION);
      const svg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'L' });
      return send(res, 200, { link, svg });
    }

    if (req.method === 'GET' && p === '/api/setup') {
      const token = auth.shareTokenOf(profile);
      return send(res, 200, {
        shareUrl: `${baseUrl(req)}/api/share`,
        shareToken: token,
        // One address with the token in it: all the iPhone Shortcut needs.
        shareLink: `${baseUrl(req)}/api/share?key=${encodeURIComponent(token)}`,
        // Where to get the ready-made Shortcut, when this copy of DrivePost has one.
        shortcutUrl: signedShortcut() ? `/shortcut/${encodeURIComponent(SHORTCUT_NAME)}.shortcut` : null,
        testItem: TEST_PATTERN_ITEM,
        // Which profile this device is signed in to.
        profile: { id: profile, name: auth.profile(profile).name },
      });
    }
    if (req.method === 'POST' && p === '/api/share-token') {
      return send(res, 200, { shareToken: auth.rotateShareToken(profile) });
    }
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Server error' });
  });
});

// ---------- WebSockets ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const controlClients = new Set();

// Send to every screen (car and phones) of one profile.
function broadcast(profile, msg) {
  const data = JSON.stringify(msg);
  for (const c of controlClients) if (c.profile === profile && c.ws.readyState === 1) c.ws.send(data);
}

// Close a profile's open screens, after it was signed out or removed. They
// try to come back, find they're signed out, and show the sign-in page.
function dropScreens(profile) {
  for (const c of controlClients) if (c.profile === profile) c.ws.close(4401, 'signed out');
}

function hello(profile) {
  return { type: 'version', version: VERSION, feedback: !!config.feedbackUrl, profile: profileLabel(profile) };
}

// Profiles were added, renamed or removed: screens show whose they are once there's more than one.
function tellProfileNames() {
  for (const c of controlClients) if (c.ws.readyState === 1) c.ws.send(JSON.stringify(hello(c.profile)));
}

function refreshCarOnline(profile) {
  storeFor(profile).setCarOnline([...controlClients].some((c) => c.profile === profile && c.role === 'car'));
}

function handleControl(ws, profile) {
  const client = { ws, role: 'remote', profile };
  const store = storeFor(profile);
  controlClients.add(client);
  ws.send(JSON.stringify(hello(profile)));
  ws.send(JSON.stringify({ type: 'state', state: store.publicState() }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      client.role = msg.role === 'car' ? 'car' : 'remote';
      refreshCarOnline(profile);
    } else if (msg.type === 'cmd') {
      // Choosing a format is also a request to try it again, so tell the car
      // before the stream restarts.
      if (msg.action === 'format' && (msg.v === 'auto' || msg.v === 'mpeg1')) broadcast(profile, { type: 'format', v: msg.v });
      const error = store.command(String(msg.action), msg);
      if (error) ws.send(JSON.stringify({ type: 'toast', message: error }));
    } else if (msg.type === 'pos' && client.role === 'car') {
      const changed = store.carPosition(msg);
      if (changed) store.changed();
      else broadcast(profile, { type: 'pos', position: store.position });
    } else if (msg.type === 'ended' && client.role === 'car') {
      store.carEnded(msg.seq);
    } else if ((msg.type === 'carError' || msg.type === 'carNote') && client.role === 'car') {
      // Show the car's errors and notices on every screen, phones included,
      // and keep them in the log for troubleshooting.
      const message = String(msg.message || 'Playback error').slice(0, 300);
      const who = profileLabel(profile);
      console.log(`[car${who ? ` ${who}` : ''}] ${message}`);
      // The car that hit an error already shows it in full, so only the
      // other screens get it as a notice. A note is shown on the car too.
      const data = JSON.stringify({ type: 'toast', message });
      for (const c of controlClients) {
        if (c.profile === profile && c.ws.readyState === 1 && !(msg.type === 'carError' && c === client)) c.ws.send(data);
      }
    }
  });

  ws.on('close', () => {
    controlClients.delete(client);
    // A removed profile has nothing left to update.
    if (auth.profile(profile)) refreshCarOnline(profile);
  });
}

// Keep sockets alive through proxies and drop dead ones.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://local');
  const profile = auth.profileOf(req);
  if (!profile || !['/ws/control', '/ws/stream'].includes(url.pathname)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    if (url.pathname === '/ws/control') return handleControl(ws, profile);
    const id = url.searchParams.get('id');
    if (!isValidId(id)) return ws.close(4400, 'bad id');
    const startAt = Math.max(0, Math.floor(Number(url.searchParams.get('t')) || 0));
    const quality = QUALITIES.includes(url.searchParams.get('q')) ? url.searchParams.get('q') : storeFor(profile).playQuality();
    const audioRate = parseInt(url.searchParams.get('ar'), 10) || 48000;
    const want = url.searchParams.get('v') === 'h264' ? 'h264' : 'mpeg1';
    handleStream(ws, { id, startAt, quality, audioRate, want, group: profile }).catch((err) => {
      console.error(err);
      ws.close();
    });
  });
});

function shutdown() {
  for (const st of stores.values()) st.saveNow();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (auth.profile(ORIGINAL)) storeFor(ORIGINAL); // a server from before profiles: its one car, ready as before
startAutoUpdate();
server.listen(config.port, () => {
  console.log(`DrivePost listening on :${config.port}${config.commit ? ` (${config.commit})` : ''}`);
});
