import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { config, QUALITIES } from './config.js';
import { Auth, clientIp, OWNER } from './auth.js';
import { Store } from './state.js';
import { handleStream } from './stream.js';
import { stampPage, feedbackLink } from './pages.js';
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
// Each profile keeps its own now playing, Up Next, history and settings. The
// main profile's live where they always did; the others get a folder each.
const stores = new Map();
function profileDir(id) {
  return id === OWNER ? config.dataDir : path.join(config.dataDir, 'profiles', id);
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

  if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

  // For the update script on this machine: is a video playing right now?
  // Only answered from inside the container itself, never through the tunnel.
  if (req.method === 'GET' && p === '/internal/busy') {
    const from = req.socket.remoteAddress || '';
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(from);
    if (!local || req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']) return send(res, 404, { error: 'Not found' });
    // Busy if any profile's car is playing.
    return send(res, 200, { busy: [...stores.values()].some((st) => !!st.now && !st.paused && st.carOnline) });
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
    // The passcode decides which profile this device joins.
    const matched = auth.checkPasscode(body.passcode);
    if (!matched) return send(res, 401, { error: 'Wrong passcode' });
    auth.issueCookie(req, res, matched);
    return send(res, 200, { ok: true });
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

    if (req.method === 'GET' && p === '/api/search') {
      try {
        const results = await search(url.searchParams.get('q'));
        return send(res, 200, { results });
      } catch (err) {
        return send(res, 502, { error: `Search failed: ${err.message}` });
      }
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
        // Who this device is signed in as. The main profile also sees the
        // others, so it can add and remove them.
        profile: { id: profile, name: auth.profile(profile).name, owner: profile === OWNER },
        profiles: profile === OWNER ? auth.listProfiles() : undefined,
      });
    }
    if (req.method === 'POST' && p === '/api/share-token') {
      return send(res, 200, { shareToken: auth.rotateShareToken(profile) });
    }

    // Adding, renaming and removing profiles: the main profile only.
    if (req.method === 'POST' && p === '/api/profiles') {
      if (profile !== OWNER) return send(res, 403, { error: 'Only the main profile can change profiles.' });
      const body = await readJson(req);
      const id = String(body.id || '');
      try {
        if (body.action === 'add') auth.addProfile(body.name, body.passcode);
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
          // Its Up Next, history and settings go with it.
          fs.rmSync(profileDir(id), { recursive: true, force: true });
        } else return send(res, 400, { error: 'Unknown action' });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      tellProfileNames();
      return send(res, 200, { profiles: auth.listProfiles() });
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
      broadcast(profile, { type: 'toast', message });
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

storeFor(OWNER); // the main profile is always there
startAutoUpdate();
server.listen(config.port, () => {
  console.log(`DrivePost listening on :${config.port}`);
});
