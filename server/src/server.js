import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { config, QUALITIES } from './config.js';
import { Auth, clientIp } from './auth.js';
import { Store } from './state.js';
import { handleStream } from './stream.js';
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
  publicUrl: config.publicUrl,
});
const store = new Store({ dataDir: config.dataDir, defaultQuality: config.defaultQuality });

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

function serveFile(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
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

// Add a shared link to the car: play it if nothing is on, otherwise queue it.
async function shareText(text) {
  const raw = String(text || '');
  const id = extractVideoId(raw) || (raw.trim() === TEST_PATTERN_ID ? TEST_PATTERN_ID : null);
  if (!id) return { ok: false, message: "That doesn't look like a YouTube link." };
  const meta = await videoMeta(id).catch(() => ({ id, title: 'YouTube video', channel: '' }));
  const wasIdle = !store.now;
  store.command('enqueue', { item: meta });
  return { ok: true, title: meta.title, message: wasIdle ? `Playing: ${meta.title}` : `Added to Up Next: ${meta.title}` };
}

const PAGES = { '/': 'car.html', '/remote': 'remote.html', '/setup': 'setup.html' };

// The ready-made iPhone Shortcut, if this copy of DriveTest ships one. iPhones
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
  const authed = auth.isAuthed(req);

  if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

  // For the update script on this machine: is a video playing right now?
  // Only answered from inside the container itself, never through the tunnel.
  if (req.method === 'GET' && p === '/internal/busy') {
    const from = req.socket.remoteAddress || '';
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(from);
    if (!local || req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']) return send(res, 404, { error: 'Not found' });
    return send(res, 200, { busy: !!store.now && !store.paused && store.carOnline });
  }

  if (req.method === 'GET' && PAGES[p]) {
    if (!authed) return redirect(res, `/login?next=${encodeURIComponent(p + url.search)}`);
    return serveFile(res, PAGES[p]);
  }
  if (req.method === 'GET' && p === '/login') return serveFile(res, 'login.html');
  if (req.method === 'GET' && p === '/sw.js') return serveFile(res, 'sw.js');
  if (req.method === 'GET' && p === '/manifest.webmanifest') return serveFile(res, 'manifest.webmanifest');
  if (req.method === 'GET' && p.startsWith('/static/')) return serveFile(res, p.slice('/static/'.length));

  // Phone pairing link from the car's QR code.
  if (req.method === 'GET' && p.startsWith('/p/')) {
    const code = p.slice(3);
    if (auth.claimPairCode(code)) {
      auth.issueCookie(req, res);
      // Tell the car, so it can put the QR code away by itself.
      broadcast({ type: 'paired', code });
      return redirect(res, '/remote');
    }
    return redirect(res, '/login?expired=1&next=/remote');
  }

  // Android share target (installed web app).
  if (req.method === 'GET' && p === '/share') {
    if (!authed) return redirect(res, `/login?next=${encodeURIComponent(p + url.search)}`);
    const text = [url.searchParams.get('url'), url.searchParams.get('text'), url.searchParams.get('title')].join(' ');
    const result = await shareText(text);
    return redirect(res, `/remote?msg=${encodeURIComponent(result.message)}`);
  }

  if (req.method === 'POST' && p === '/api/login') {
    if (!auth.allowAttempt(clientIp(req))) return send(res, 429, { error: 'Too many tries. Wait a few minutes.' });
    const body = await readJson(req);
    if (!auth.checkPasscode(body.passcode)) return send(res, 401, { error: 'Wrong passcode' });
    auth.issueCookie(req, res);
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
    if (!authed && !auth.hasShareToken(req, url.searchParams.get('key'))) {
      return send(res, 401, 'Wrong or old DriveTest link. Copy a fresh one from Setup & sharing.', 'text/plain; charset=utf-8');
    }
    const body = await readJson(req);
    const result = await shareText(body.url || body.text || body.input || '');
    return send(res, result.ok ? 200 : 400, result.message, 'text/plain; charset=utf-8');
  }

  if (p.startsWith('/api/')) {
    if (!authed) return send(res, 401, { error: 'Sign in first' });

    if (req.method === 'POST' && p === '/api/logout') {
      auth.clearCookie(res);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/logout-all') {
      auth.rotateSessions();
      auth.clearCookie(res);
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
      const link = `${baseUrl(req)}/p/${auth.newPairCode()}`;
      const svg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      return send(res, 200, { link, svg });
    }

    if (req.method === 'GET' && p === '/api/setup') {
      return send(res, 200, {
        shareUrl: `${baseUrl(req)}/api/share`,
        shareToken: auth.shareToken,
        // One address with the token in it: all the iPhone Shortcut needs.
        shareLink: `${baseUrl(req)}/api/share?key=${encodeURIComponent(auth.shareToken)}`,
        // Where to get the ready-made Shortcut, when this copy of DriveTest has one.
        shortcutUrl: signedShortcut() ? `/shortcut/${encodeURIComponent(SHORTCUT_NAME)}.shortcut` : null,
        testItem: TEST_PATTERN_ITEM,
      });
    }
    if (req.method === 'POST' && p === '/api/share-token') {
      return send(res, 200, { shareToken: auth.rotateShareToken() });
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

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of controlClients) if (c.ws.readyState === 1) c.ws.send(data);
}

store.on('state', (state) => {
  broadcast({ type: 'state', state });
  // Look up what's playing and what's next ahead of time, so they start faster.
  if (store.now) prewarm(store.now.id, store.playQuality());
  if (store.queue[0]) prewarm(store.queue[0].id, store.settings.quality);
});

function refreshCarOnline() {
  store.setCarOnline([...controlClients].some((c) => c.role === 'car'));
}

function handleControl(ws) {
  const client = { ws, role: 'remote' };
  controlClients.add(client);
  ws.send(JSON.stringify({ type: 'version', version: VERSION }));
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
      refreshCarOnline();
    } else if (msg.type === 'cmd') {
      const error = store.command(String(msg.action), msg);
      if (error) ws.send(JSON.stringify({ type: 'toast', message: error }));
    } else if (msg.type === 'pos' && client.role === 'car') {
      const changed = store.carPosition(msg);
      if (changed) store.changed();
      else broadcast({ type: 'pos', position: store.position });
    } else if (msg.type === 'ended' && client.role === 'car') {
      store.carEnded(msg.seq);
    } else if ((msg.type === 'carError' || msg.type === 'carNote') && client.role === 'car') {
      // Show the car's errors and notices on every screen, phones included.
      broadcast({ type: 'toast', message: String(msg.message || 'Playback error').slice(0, 300) });
    }
  });

  ws.on('close', () => {
    controlClients.delete(client);
    refreshCarOnline();
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
  if (!auth.isAuthed(req) || !['/ws/control', '/ws/stream'].includes(url.pathname)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    if (url.pathname === '/ws/control') return handleControl(ws);
    const id = url.searchParams.get('id');
    if (!isValidId(id)) return ws.close(4400, 'bad id');
    const startAt = Math.max(0, Math.floor(Number(url.searchParams.get('t')) || 0));
    const quality = QUALITIES.includes(url.searchParams.get('q')) ? url.searchParams.get('q') : store.playQuality();
    const audioRate = parseInt(url.searchParams.get('ar'), 10) || 48000;
    handleStream(ws, { id, startAt, quality, audioRate }).catch((err) => {
      console.error(err);
      ws.close();
    });
  });
});

function shutdown() {
  store.saveNow();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startAutoUpdate();
server.listen(config.port, () => {
  console.log(`DriveTest listening on :${config.port}`);
});
