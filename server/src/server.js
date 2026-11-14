import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { config, QUALITIES } from './config.js';
import { Auth, clientIp, isHttps, ORIGINAL } from './auth.js';
import { Store } from './state.js';
import { handleStream, canEncodeH264 } from './stream.js';
import { PAGE_ID, isPageId, onShare, clearOldShares } from './mirror.js';
import { usePages, pagesEncodeH264, pagesReady, isAgent, attachAgent, guardAllows, browserKey, openPage, closePage, pageOf, pageMedia, watchPage, dropWatchers, adRefused, adsStopped, adBlocker, pageAds, blockerSaid, blockerIs } from './webpage.js';
import { adListed, adList, useAdList } from './adblock.js';
import { startGuard } from './guard.js';
import { stampPage, feedbackLink } from './pages.js';
import { recommendFor } from './recommend.js';
import {
  search,
  suggest,
  videoMeta,
  extractVideoId,
  startAutoUpdate,
  prewarm,
  TEST_PATTERN_ID,
  TEST_PATTERN_ITEM,
} from './youtube.js';
import { isLinkId, isPlayableId, linkIn, linkItem, prewarmLink } from './links.js';

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

// This server is on the internet, where anyone can send it anything. A
// request nobody thought of must cost that request and nothing else: not the
// video every car is in the middle of. So an error that got past everything
// is written down and the server carries on.
process.on('uncaughtException', (err) => console.error('[error] carried on after:', err));
process.on('unhandledRejection', (err) => console.error('[error] carried on after:', err));

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
      const warm = (id, quality) => {
        if (isPageId(id)) return; // a page's picture is already on this machine
        if (isLinkId(id)) prewarmLink(id, quality);
        else prewarm(id, quality);
      };
      if (store.now) warm(store.now.id, store.playQuality());
      if (store.queue[0]) warm(store.queue[0].id, store.settings.quality);
    });
    store.on('pageMedia', (what, by) => pageMedia(id, what, by));
    // A page kept under Recent was asked for again.
    store.on('openPage', (url) => {
      openFor(id, url).then((done) => {
        if (done.error) broadcast(id, { type: 'toast', message: done.error });
      });
    });
    stores.set(id, store);
  }
  return store;
}
// Open an address as a page for a profile: what a phone pasted, or a page
// kept under Recent. Returns what openPage does ({ ok } or { error }).
async function openFor(profile, text) {
  const done = await openPage(profile, text);
  if (done.error) return done;
  // Already open and sent somewhere new: back on in the car, if something else was.
  const store = storeFor(profile);
  if (done.going && !(store.now && isPageId(store.now.id))) store.command('play', { item: { id: PAGE_ID } });
  return done;
}
// A name for the log and the screens. Only shown once there's more than one profile.
function profileLabel(id) {
  const p = auth.profile(id);
  return auth.profiles.length > 1 && p ? p.name : '';
}

// ---------- updates: what the updater on this machine is doing ----------
// scripts/auto-update.sh installs updates, and won't restart the app while a
// video is playing. Started by its timer it stays on the line to the app: it
// keeps a request open here saying what it is doing (nothing, or holding an
// update back for a video), and the app answers when there is something to
// say. That is how "Force update" on the Admin page reaches it at once.
const update = {
  waiting: null, // { commit: "abc1234 Title", at }: an update held back by a video
  installing: null, // { commit, at }: the update it said it is installing
  failed: null, // { commit, at }: an update that couldn't be installed
  forcedAt: 0, // when "Force update" was tapped, until the updater has acted on it
  askedLive: false, // ...and whether the updater was on the line to hear it at once
  goingInAt: 0, // when the updater was told it may restart the app
  checkedAt: 0, // when it last looked because it was asked to, and found nothing new
  heardAt: 0, // when it was last in touch
  lookedAt: 0, // when it last came back from a look at GitHub
  lookNow: false, // it is being told to look again now, because an Admin page is open
  held: new Set(), // its open requests: functions that answer them
  idling: new Set(), // ...the ones among them that have nothing to install
};
const WAITING_FRESH_MS = 4 * 60 * 1000; // while it waits, the updater is back within this long
const FORCED_FOR_MS = 10 * 60 * 1000; // long enough for the updater's next run, not for ever if that never comes
const GOING_IN_FOR_MS = 20 * 60 * 1000; // a build that hasn't replaced this app by then didn't
const FAILED_SHOWN_MS = 60 * 60 * 1000; // the updater tries a failed update again after an hour
const CHECKING_FOR_MS = 30 * 1000; // a look at GitHub that takes longer than this isn't happening
const CHECKED_SHOWN_MS = 2 * 60 * 1000; // how long "nothing new" stays on the Admin page
const SILENT_MS = Number(process.env.UPDATER_SILENT_MS) || 6 * 60 * 1000; // an updater that is running is in touch well within this
const HOLD_AT_MOST_S = 110;
// While an Admin page is open the updater looks at GitHub this often, so the
// page can say what is new as it happens: eagerly at first, then at a pace
// that a page left open all day can keep up without being a nuisance.
const LOOK_EVERY_MS = Number(process.env.ADMIN_LOOK_MS) || 10 * 1000;
const LOOK_EVERY_LATER_MS = Number(process.env.ADMIN_LOOK_LATER_MS) || 30 * 1000;
const EAGER_FOR_MS = 5 * 60 * 1000;
const LOOK_ON_OPENING_MS = 3 * 1000; // an Admin page being opened has it look at once, unless it just did

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
const playingOn = (st) => !!st.now && !st.paused && st.carOnline;
const someonePlaying = () => [...stores.values()].some(playingOn);

// What the updater is told when it asks whether it may restart the app.
// "Not busy" is its go-ahead: it starts installing straight away.
function updateAnswer() {
  const forced = updateForced();
  const busy = someonePlaying() && !forced;
  if (!busy) update.goingInAt = Date.now();
  return { busy, forced };
}
// Keep the updater waiting for its answer: until "Force update" is tapped,
// or `seconds` have gone by. Resolves to false if it hung up meanwhile.
// `idle` says it has nothing to install: then it can also be told to look
// again, when an Admin page is open (askForLook).
function keepOnTheLine(res, seconds, idle = false) {
  return new Promise((resolve) => {
    const answer = (there = true) => {
      clearTimeout(timer);
      update.held.delete(answer);
      update.idling.delete(answer);
      res.off('close', hungUp);
      resolve(there);
      adminChanged(); // whether it is on the line is something the Admin page shows
    };
    const hungUp = () => answer(false);
    const timer = setTimeout(answer, seconds * 1000);
    update.held.add(answer);
    if (idle) update.idling.add(answer);
    res.on('close', hungUp);
  });
}
// For the Admin page: where things stand with updates.
function updateView() {
  const now = Date.now();
  // `lookedAgo`: how long ago the updater last looked at GitHub, in ms (null: not since this app started).
  const view = (state, commit = '') => ({ state, commit, playing: someonePlaying(), lookedAgo: update.lookedAt ? now - update.lookedAt : null });
  const w = waitingUpdate();
  if (update.installing && now - update.installing.at < GOING_IN_FOR_MS) return view('installing', update.installing.commit);
  if (w && updateGoingIn()) return view('installing', w.commit);
  // An update is held back by a video: waiting for it, or told to go in at the updater's next look.
  if (w) return view(updateForced() ? 'forced' : someonePlaying() ? 'waiting' : 'next', w.commit);
  // "Force update" with nothing known to be waiting: the updater is looking, or will at its next look.
  if (updateForced()) return view(update.askedLive && now - update.forcedAt < CHECKING_FOR_MS ? 'checking' : 'asked');
  const f = update.failed;
  if (f && now - f.at < FAILED_SHOWN_MS) return view('failed', f.commit);
  if (update.checkedAt && now - update.checkedAt < CHECKED_SHOWN_MS) return view('uptodate');
  // No sign of the updater for a while: it isn't set up here, or can't reach GitHub.
  if (!update.held.size && now - Math.max(update.heardAt, STARTED) > SILENT_MS) return view('off');
  return view('idle');
}
// Only this machine itself may ask (the updater does, from inside the
// container): never anything that came in through the tunnel.
function fromThisMachine(req) {
  const from = req.socket.remoteAddress || '';
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(from);
  // (Nor anything the page browser's guard passed on: that says "via" of itself.)
  return local && !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'] && !req.headers.via;
}

// Where the list of updates is, to compare the running one against: the
// repo the Feedback button points at (so a fork points at itself).
function commitsUrl() {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/new/.exec(config.feedbackUrl || '');
  return `https://github.com/${m ? m[1] : '5w311/DrivePost'}/commits`;
}

// Everything the Admin page shows: the profiles and whether their cars are
// on, who is waiting for a profile, and which build is running. `etag` names
// this state of things: a page that says which one it has is only answered
// when there is another (watchAdmin).
function adminView() {
  const view = {
    profiles: auth.listProfiles().map((p) => {
      const st = stores.get(p.id);
      const carOnline = !!(st && st.carOnline);
      return { ...p, carOnline, playing: carOnline && !!st.now && !st.paused };
    }),
    requests: auth.listRequests(),
    allowRequests: auth.allowRequests,
    server: { version: VERSION, commit: config.commit, commits: commitsUrl(), startedAt: STARTED, update: updateView() },
  };
  // Time going by since the last look isn't news; a new look is.
  const what = JSON.stringify({ ...view, server: { ...view.server, update: { ...view.server.update, lookedAgo: update.lookedAt } } });
  return { ...view, etag: crypto.createHash('sha1').update(what).digest('base64url').slice(0, 16) };
}

// ---------- the Admin page, kept up to date ----------
// An open Admin page keeps a request waiting here (GET /api/admin/watch) and
// is answered the moment anything it shows changes: an update arriving, being
// installed or failing, someone asking for a profile, a car coming or going.
// While one is open, the updater is also kept looking at GitHub every few
// seconds instead of every couple of minutes, so "an update arriving" means
// seconds after it was pushed.
const watchers = new Set(); // waiting Admin pages: functions that answer them if there is news
let watchedAt = 0; // when a page was last waiting here
let watchedSince = 0; // when the page that is open now was opened
const WATCH_FOR_MS = 25 * 1000; // a waiting page is answered at least this often, news or not
const WATCH_GAP_MS = 6 * 1000; // a page that asked this recently is still open: it is between two requests

const adminWatched = (now = Date.now()) => watchers.size > 0 || now - watchedAt < WATCH_GAP_MS;

// Something the Admin page shows has changed (or may have): tell the pages that are waiting.
function adminChanged() {
  for (const look of [...watchers]) look();
}

// Have the updater look at GitHub now, if it is on the line with nothing to
// do and it is time: at once when an Admin page is opened, then at the pace
// above for as long as one stays open.
function askForLook(opening = false) {
  const now = Date.now();
  if (!update.idling.size || updateForced() || !adminWatched(now)) return;
  const every = opening ? LOOK_ON_OPENING_MS : now - watchedSince < EAGER_FOR_MS ? LOOK_EVERY_MS : LOOK_EVERY_LATER_MS;
  if (now - update.lookedAt < every) return;
  update.lookNow = true;
  for (const answer of [...update.idling]) answer();
}

function watchAdmin(res, seen) {
  const now = Date.now();
  const opening = !adminWatched(now);
  if (opening) watchedSince = now;
  watchedAt = now;
  const first = adminView();
  if (first.etag !== seen) {
    send(res, 200, first);
    if (opening) askForLook(true);
    return;
  }
  const done = () => {
    clearTimeout(timer);
    watchers.delete(look);
    res.off('close', done);
    watchedAt = Date.now();
  };
  const look = (anyway = false) => {
    const view = adminView();
    if (!anyway && view.etag === seen) return;
    done();
    send(res, 200, view);
  };
  const timer = setTimeout(() => look(true), WATCH_FOR_MS);
  watchers.add(look);
  res.on('close', done);
  if (opening) askForLook(true);
}

// What changes without anything here being told (a car going offline, a
// video being paused, a wait running out) is noticed by looking once a second
// while a page is waiting.
setInterval(() => {
  if (!watchers.size) return;
  adminChanged();
  askForLook();
}, 1000).unref();

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

// What a browser is told about anything this server sends that isn't a page:
// it is data, to be read by the pages that asked for it and shown as nothing.
const CSP_DATA = "default-src 'none'; frame-ancestors 'none'";
/*
 * And about the pages: they run this server's own scripts and no others, so
 * text that came from somewhere else (a video's title, a page's name) can't
 * turn into a script even if a mistake here ever put it on a page as markup.
 * Pictures come from anywhere (video thumbnails); nothing may frame a page.
 * The car's page also needs leave for its MPEG-1 decoder, which is compiled
 * (WebAssembly) as it loads.
 */
const CSP_PAGE =
  "default-src 'self'; img-src 'self' data: blob: https: http:; media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const cspFor = (file) => `${CSP_PAGE}; script-src 'self'${file === 'car.html' ? " 'wasm-unsafe-eval' 'unsafe-eval'" : ''}`;

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' && typeof body !== 'string' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP_DATA });
  res.end(data);
}

// On everything this server sends.
function guardHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  // Reached over https (through the tunnel), it is only ever to be reached that way.
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

/*
 * Did this request come from one of this server's own pages (or from no page
 * at all: the iPhone Shortcut, the updater, a script)? A device stays signed
 * in for months, and its browser sends that sign-in along with requests that
 * other sites' pages make here. Browsers hold most of those back by
 * themselves, but not from a page on a sister address (another name under
 * the same domain), and not when a socket is opened. So anything that changes
 * something, and every socket, is only taken from this server's own pages.
 *
 * A browser says where a request comes from in two ways. The address of the
 * page that made it ("Origin") comes with every socket and with everything
 * that changes something, in every browser, so that is gone by first: it is
 * compared with the address this server was reached at. PUBLIC_URL counts as
 * its address too, for a server behind something that changes the name on the
 * way in. The other is whether it is the same site ("Sec-Fetch-Site"), which a
 * page can't set either; it vouches for a request when the names don't match
 * up, and decides when there is no address. Browsers don't agree on it for
 * sockets (a page on https and its socket on wss count as two sites to some),
 * so a socket goes by the address alone.
 *
 * With neither, it isn't a page asking: the iPhone Shortcut, a script, the
 * browser container. Those bring no sign-in of somebody else's along.
 */
const refusedFrom = new Map(); // which other sites' pages were turned away, and when that was last written down
const bareHost = (h) => String(h || '').split(',')[0].trim().toLowerCase().replace(/:(80|443)$/, '');
function fromOwnPage(req, { socket = false } = {}) {
  const origin = req.headers.origin;
  const site = socket ? '' : req.headers['sec-fetch-site'];
  if (!origin && !site) return true;
  if (site === 'same-origin' || site === 'none') return true;
  let theirs = null;
  try {
    theirs = new URL(origin);
  } catch {}
  if (!theirs || !theirs.host) return false; // "null": a page with no address of its own, such as a sandboxed frame
  // A page fetched without https has no say over a server reached with it.
  if (theirs.protocol === 'http:' && isHttps(req)) return false;
  const mine = [req.headers.host, req.headers['x-forwarded-host']].map(bareHost);
  try {
    if (config.publicUrl) mine.push(bareHost(new URL(config.publicUrl).host));
  } catch {}
  return mine.includes(bareHost(theirs.host));
}
function refuseOtherPage(req) {
  const from = String(req.headers.origin || req.headers['sec-fetch-site'] || 'another site').replace(/[^\x21-\x7e]/g, '').slice(0, 100);
  const now = Date.now();
  if (now - (refusedFrom.get(from) || 0) > 60 * 60 * 1000) {
    if (refusedFrom.size > 50) refusedFrom.clear();
    refusedFrom.set(from, now);
    console.log(`[security] turned away a request made by a page on ${from} (this server was reached as ${String(req.headers.host || '?').replace(/[^\x21-\x7e]/g, '').slice(0, 100)}). If that is this server's own address, set PUBLIC_URL to it in .env.`);
  }
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
      ...(isPage ? { 'Content-Security-Policy': cspFor(file) } : {}),
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
    const said = text ? JSON.parse(text) : {};
    // (A body that is a bare word, number or "null" has no fields to read: it is taken as text.)
    return said && typeof said === 'object' ? said : { text };
  } catch {
    return { text };
  }
}

function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

/*
 * What a pasted or shared piece of text is a link to: { id } for a YouTube
 * video (or the test pattern), { url } for anything else on the web, or
 * { error } in words when it is neither or this server doesn't take it.
 */
function linkedTo(text) {
  const raw = String(text || '');
  const id = extractVideoId(raw) || (raw.trim() === TEST_PATTERN_ID ? TEST_PATTERN_ID : null);
  if (id) return { id };
  const url = linkIn(raw);
  if (!url) return { error: "That doesn't look like a link to a video." };
  if (!config.links.on) return { error: 'This server is set to play YouTube videos only.' };
  return { url };
}

// Add a shared link to a profile's car: play it if nothing is on, otherwise queue it.
async function shareText(store, text) {
  const to = linkedTo(text);
  if (to.error) return { ok: false, message: to.error };
  let meta;
  if (to.id) meta = await videoMeta(to.id).catch(() => ({ id: to.id, title: 'YouTube video', channel: '' }));
  else {
    // Another site's video: finding out what it is also finds out whether it can be played.
    try {
      meta = await linkItem(to.url);
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }
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
  let url;
  try {
    url = new URL(req.url, 'http://local');
  } catch {
    return send(res, 400, { error: 'Bad request' });
  }
  const p = url.pathname;
  const profile = auth.profileOf(req); // which profile this device is signed in to, if any
  const authed = !!profile;
  const admin = auth.isAdmin(req); // has this device typed the server's own passcode?

  if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

  // For the update script on this machine: is a video playing right now?
  // Only answered from inside the container itself, never through the tunnel.
  if (req.method === 'GET' && p === '/internal/busy') {
    if (!fromThisMachine(req)) return send(res, 404, { error: 'Not found' });
    update.heardAt = Date.now();
    // Busy if any profile's car is playing, unless "Force update" was tapped.
    return send(res, 200, updateAnswer());
  }
  // From the same script: what it is doing about updates (see `update` above).
  if (req.method === 'POST' && p === '/internal/updater') {
    if (!fromThisMachine(req)) return send(res, 404, { error: 'Not found' });
    const body = await readJson(req);
    const about = String(body.about || '');
    const commit = String(body.commit || '').replace(/\s+/g, ' ').trim().slice(0, 160) || 'An update';
    const hold = Math.min(Math.max(Number(body.hold) || 0, 0), HOLD_AT_MOST_S);
    const now = Date.now();
    update.heardAt = now;
    update.lookedAt = now; // it says what it found on GitHub a moment ago
    update.lookNow = false;
    // Whatever it says next, an open Admin page hears of it at once.
    setImmediate(adminChanged);

    if (about === 'failed') {
      Object.assign(update, { waiting: null, installing: null, forcedAt: 0, goingInAt: 0, failed: { commit, at: now } });
      return send(res, 200, { ok: true });
    }
    if (about === 'installing') {
      Object.assign(update, { waiting: null, failed: null, forcedAt: 0, checkedAt: 0, installing: { commit, at: now } });
      console.log(`[update] installing ${commit}`);
      // Every screen is told, and the ones it will interrupt are told what happens to their video.
      for (const [id, st] of stores) {
        broadcast(id, {
          type: 'toast',
          message: playingOn(st)
            ? 'DrivePost is updating. The video will stop when the server restarts, then wait for a tap.'
            : 'DrivePost is updating. It will be back in a moment.',
        });
      }
      return send(res, 200, { ok: true });
    }
    // Nothing to install ("checked": it looked because it was asked to, and that's what it found).
    if (about === 'idle' || about === 'checked') {
      Object.assign(update, { waiting: null, installing: null, goingInAt: 0 });
      if (about === 'checked') Object.assign(update, { forcedAt: 0, checkedAt: now, failed: null });
      // It stays on the line until "Force update" is tapped. (Tapped while it was away: it hears now.)
      // With an Admin page open it is also sent off to look again every few seconds.
      if (hold && !updateForced()) {
        if (!(await keepOnTheLine(res, hold, true))) return undefined;
        update.heardAt = Date.now();
      }
      const look = update.lookNow && !updateForced();
      update.lookNow = false;
      return send(res, 200, { check: updateForced(), look });
    }
    // An update is held back because a video is playing.
    if (about === 'waiting') {
      // (An updater that says it is waiting isn't installing anything, whatever it was told before.)
      Object.assign(update, { waiting: { commit, at: now }, installing: null, failed: null, goingInAt: 0, checkedAt: 0 });
      if (hold && someonePlaying() && !updateForced()) {
        if (!(await keepOnTheLine(res, hold))) return undefined;
        update.heardAt = Date.now();
        if (update.waiting) update.waiting.at = update.heardAt;
      }
      return send(res, 200, updateAnswer());
    }
    return send(res, 400, { error: 'Unknown' });
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
    // Only a visit the person made themselves (their phone's share sheet, or
    // the address typed in) sends anything to the car. Following a link, or
    // being sent here by some other site's page, is a visit too, and a browser
    // brings the sign-in along on those: then the link is put in the remote's
    // box, where it goes nowhere until a button is tapped.
    const visit = req.headers['sec-fetch-site'];
    if (visit !== 'none' && visit !== 'same-origin') {
      const to = linkedTo(text);
      if (to.error) return redirect(res, `/remote?msg=${encodeURIComponent(to.error)}`);
      return redirect(res, `/remote?link=${encodeURIComponent(to.url || (to.id === TEST_PATTERN_ID ? to.id : `https://www.youtube.com/watch?v=${to.id}`))}`);
    }
    const result = await shareText(storeFor(profile), text);
    return redirect(res, `/remote?msg=${encodeURIComponent(result.message)}`);
  }

  if (req.method === 'POST' && p === '/api/login') {
    if (!auth.allowAttempt(clientIp(req))) return send(res, 429, { error: auth.refusal });
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
      auth.wrongAttempt();
      // canAsk: the sign-in page may offer asking for a profile with it.
      return send(res, 401, { error: 'Wrong passcode', canAsk: auth.canAsk() });
    }
    auth.issueCookie(req, res, matched);
    return send(res, 200, { ok: true });
  }

  // ---- Admin: opened by the server's own passcode, apart from any profile ----
  if (req.method === 'POST' && p === '/api/admin/login') {
    if (!auth.allowAttempt(clientIp(req))) return send(res, 429, { error: auth.refusal });
    const body = await readJson(req);
    if (!auth.checkAdminPasscode(body.passcode)) {
      auth.wrongAttempt();
      return send(res, 401, { error: 'Wrong passcode' });
    }
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
  // The same, for a page that is open: answered when it differs from what the
  // page says it has (`seen`), which may be a while. See watchAdmin.
  if (req.method === 'GET' && p === '/api/admin/watch') {
    if (!admin) return send(res, 403, { error: 'Sign in to Admin first.' });
    return watchAdmin(res, url.searchParams.get('seen') || '');
  }
  // "Force update": have the updater look at GitHub now and install what it
  // finds, video or not. Or take that back, while it hasn't heard yet.
  if (req.method === 'POST' && p === '/api/admin/update') {
    if (!admin) return send(res, 403, { error: 'Sign in to Admin first.' });
    const body = await readJson(req);
    const { state, commit } = updateView();
    if (state === 'installing') return send(res, 409, { error: 'An update is already being installed.' });
    if (!body.force) {
      update.forcedAt = 0;
    } else if (state === 'off') {
      return send(res, 409, { error: "The updater on this server isn't running, so there is nobody to ask." });
    } else if (!updateForced()) {
      const onTheLine = update.held.size > 0;
      Object.assign(update, { forcedAt: Date.now(), askedLive: onTheLine, checkedAt: 0 });
      console.log(`[admin] Force update${commit ? `: ${commit}` : ''}${someonePlaying() ? ' (a video is playing)' : ''}`);
      // Holding an update back, and on the line: it goes in now.
      if (onTheLine && waitingUpdate()) update.goingInAt = Date.now();
      for (const answer of [...update.held]) answer();
    }
    setImmediate(adminChanged); // any other Admin page that is open
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
        closePage(id);
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
      if (!auth.allowAttempt(clientIp(req))) return send(res, 429, { error: auth.refusal });
      const body = await readJson(req);
      try {
        const before = auth.requests.length;
        const waiting = auth.askForProfile(body.name, body.passcode);
        if (auth.requests.length > before) {
          console.log(`[profiles] ${waiting.name} asked for a profile (number ${waiting.code})`);
          // (Asking says whether a passcode is already someone's, so it counts as a guess at one.)
          auth.wrongAttempt();
        }
        return send(res, 200, { waiting });
      } catch (err) {
        auth.wrongAttempt();
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

    // Open an address as a page in the server's own browser, for the links
    // no video can be pulled out of. The car is shown the page.
    if (req.method === 'POST' && p === '/api/page/open') {
      const body = await readJson(req);
      const done = await openFor(profile, body.url || body.text);
      if (done.error) return send(res, 400, { error: done.error });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/page/close') {
      closePage(profile);
      return send(res, 200, { ok: true });
    }
    // Blocking ads in this profile's pages: switched on or off (POST), and how it stands (GET).
    if (p === '/api/page/ads' && (req.method === 'GET' || req.method === 'POST')) {
      const store = storeFor(profile);
      let reopened = false;
      if (req.method === 'POST') {
        const body = await readJson(req);
        const was = !!store.settings.blockAds;
        store.command('blockAds', { on: !!body.on });
        // The browser takes its ad blocker on, or leaves it off, as it starts.
        if (was !== !!store.settings.blockAds) reopened = pageAds(profile, !!store.settings.blockAds);
      }
      const on = !!store.settings.blockAds;
      if (on) useAdList();
      // `with`: the browser's own ad blocker, where it has one, and `blocker` whether it was at work when this
      // profile's page was opened ('up', 'late', or '' while that isn't known). `reopened`: the page is being opened again for the change.
      return send(res, 200, { on, with: adBlocker(), blocker: blockerIs(profile), reopened, list: adList().state, names: adList().size, stopped: adsStopped(profile) });
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
      const to = linkedTo(body.text);
      if (to.error) return send(res, 400, { error: to.error });
      try {
        return send(res, 200, { item: to.id ? await videoMeta(to.id) : await linkItem(to.url) });
      } catch (err) {
        // A link to another site fails in words of its own (links.js).
        return send(res, 502, { error: to.id ? `Couldn't look that up: ${err.message}` : err.message });
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
  guardHeaders(req, res);
  // Anything that changes something is only taken from this server's own pages (fromOwnPage).
  if (!['GET', 'HEAD'].includes(req.method) && !fromOwnPage(req)) {
    refuseOtherPage(req);
    return send(res, 403, { error: "That request was made by another site's page, so it wasn't carried out." });
  }
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
  dropWatchers(profile);
}

function hello(profile) {
  return {
    type: 'version',
    version: VERSION,
    feedback: !!config.feedbackUrl,
    otherSites: config.links.on,
    pages: pagesReady(),
    profile: profileLabel(profile),
  };
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
    if (!msg || typeof msg !== 'object') return;
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

// ---------- pages ----------
// A link with no video to fetch is opened as a page in the server's own
// browser, and the car is shown that (webpage.js). Three sockets serve it:
// the browser's program connects in on /ws/browser, a phone that steers the
// page on /ws/page, and the car plays its picture like any live video.
const agentWss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
const pageWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
const PAGE_PLAY_OUT_MS = 12 * 1000; // how long a car gets to play out the end of a page before it is moved on
canEncodeH264().then(pagesEncodeH264);
clearOldShares();

usePages({
  shown: (profile) => {
    const store = auth.profile(profile) ? storeFor(profile) : null;
    return !!store && !!store.now && isPageId(store.now.id) && store.carOnline && !store.paused;
  },
  changed: (profile, info) => {
    if (!auth.profile(profile)) return;
    const store = storeFor(profile);
    if (info) store.setPage(info);
    else store.pageOver();
  },
  toast: (profile, message) => broadcast(profile, { type: 'toast', message }),
  blocksAds: (profile) => !!(auth.profile(profile) && storeFor(profile).settings.blockAds),
  // Phones show "Open as a page" only while there is a browser to open it in.
  availability: () => {
    for (const c of controlClients) if (c.ws.readyState === 1) c.ws.send(JSON.stringify(hello(c.profile)));
  },
});

// The picture of a page can be played, or has ended (mirror.js).
onShare((profile, what, share) => {
  if (!auth.profile(profile)) return;
  const store = storeFor(profile);
  if (what === 'live') {
    if (!pageOf(profile)) return;
    store.setPage({ phase: 'live' });
    // Opening a page is asking for it to be shown. A fresh recording of one
    // that was already on leaves alone whatever was put on in the meantime.
    if (!share.again || !store.now) store.command('play', { item: { id: PAGE_ID } });
    return;
  }
  // Over. The browser is closed with it, if it is still up.
  closePage(profile);
  // Closed on purpose, a car that is showing it has a few seconds of it
  // still to play, and moves on by itself when it has. This is for when it
  // doesn't (or there is no car).
  const showing = store.now && isPageId(store.now.id) ? store.now.key : null;
  if (share && share.done === 'stopped' && showing && !store.paused && store.carOnline) {
    store.setPage(null);
    setTimeout(() => {
      if (!store.page && store.now && store.now.key === showing) store.pageOver();
    }, PAGE_PLAY_OUT_MS).unref();
  } else store.pageOver();
});

// The browser's one way out to the internet (guard.js). Only worth opening
// where a browser can sign in at all.
if (config.pages.on && browserKey()) {
  const wantsAdsBlocked = (id) => !!(auth.profile(id) && storeFor(id).settings.blockAds);
  const guard = startGuard({ port: config.pages.guardPort, allowed: guardAllows, blocked: (name) => adRefused(name, wantsAdsBlocked, adListed), waited: blockerSaid, own: [config.port] });
  guard.on('error', (err) => console.log(`[page] the browser's way out couldn't be opened on port ${config.pages.guardPort} (${err.code || err.message}): pages won't load`));
}

// Keep sockets alive through proxies and drop dead ones.
setInterval(() => {
  for (const ws of [...wss.clients, ...agentWss.clients, ...pageWss.clients]) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

// A socket that breaks (a frame cut short on a weak signal, one that is too
// big, one that isn't a frame at all) is closed. It must not be the end of
// the server: an error on a socket nobody listens to for errors would be.
function settle(ws) {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('error', () => {});
}
function turnAway(socket, code, words) {
  socket.on('error', () => {});
  socket.write(`HTTP/1.1 ${code} ${words}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  try {
    openSocket(req, socket, head);
  } catch (err) {
    // (Whatever was asked for couldn't even be read.)
    turnAway(socket, 400, 'Bad Request');
  }
});

function openSocket(req, socket, head) {
  const url = new URL(req.url, 'http://local');
  // The browser's program signs in with the key it shares with this server, not as a profile.
  if (url.pathname === '/ws/browser') {
    if (!isAgent(req)) return turnAway(socket, 401, 'Unauthorized');
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      settle(ws);
      attachAgent(ws, req);
    });
    return;
  }
  const profile = auth.profileOf(req);
  if (!profile || !['/ws/control', '/ws/stream', '/ws/page'].includes(url.pathname)) return turnAway(socket, 401, 'Unauthorized');
  // A signed-in device's sockets are opened by this server's own pages, not by another site's.
  if (!fromOwnPage(req, { socket: true })) {
    refuseOtherPage(req);
    return turnAway(socket, 403, 'Forbidden');
  }
  if (url.pathname === '/ws/page') {
    pageWss.handleUpgrade(req, socket, head, (ws) => {
      settle(ws);
      watchPage(ws, profile);
    });
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    settle(ws);
    if (url.pathname === '/ws/control') return handleControl(ws, profile);
    const id = url.searchParams.get('id');
    if (!isPlayableId(id) && !isPageId(id)) return ws.close(4400, 'bad id');
    const startAt = Math.max(0, Math.floor(Number(url.searchParams.get('t')) || 0));
    const quality = QUALITIES.includes(url.searchParams.get('q')) ? url.searchParams.get('q') : storeFor(profile).playQuality();
    const audioRate = parseInt(url.searchParams.get('ar'), 10) || 48000;
    const want = url.searchParams.get('v') === 'h264' ? 'h264' : 'mpeg1';
    handleStream(ws, { id, startAt, quality, audioRate, want, group: profile }).catch((err) => {
      console.error(err);
      ws.close();
    });
  });
}

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
