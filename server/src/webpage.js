/*
 * Pages: a link that can't be turned into a video is opened as a web page,
 * and the car is shown the page.
 *
 * The page is opened in a browser of the server's own, which runs in a
 * container beside this one (the browser/ folder). A small program there
 * (agent.js) connects in to this server, proves itself with a key the two
 * share, and from then on does what it is told: open this address, tap
 * here, go back, close. It sends back two things. One is a recording of the
 * page, picture and sound, made as it goes: mirror.js turns that into the
 * live video the car plays. The other is a small picture of the page a few
 * times a second, for the phone that steers it.
 *
 * One page at a time for the whole server: a browser playing video is the
 * heaviest thing this machine does. A page nobody is watching or steering is
 * closed after a few minutes.
 *
 * The browser has no way out to the internet except through this server
 * (guard.js), which refuses addresses on the home network.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.js';
import { addressAllowed, linkIn, siteOf } from './links.js';
import { startShare } from './mirror.js';

const OPEN_WITHIN_MS = 45 * 1000; // a page whose picture hasn't come up by then isn't going to
const FRESH_STARTS = 2; // times in a row a recording may be started afresh before giving up
const STALLED_MS = 12 * 1000; // a recording that stops arriving for this long has stalled

let agent = null; // the browser's program, once it has connected: { ws, address }
let page = null; // the page that is open, if one is
let h264 = true; // whether this ffmpeg can make H.264 for the copy it keeps (server.js says)

// What the rest of the server does for this module (server.js fills these in).
const hooks = {
  shown: () => false, // (profile): is the page what that profile's car is playing?
  changed: () => {}, // (profile, info | null): the page is opening, has changed, or is closed
  toast: () => {}, // (profile, message)
  availability: () => {}, // pages became possible, or stopped being
};
export function usePages(given) {
  Object.assign(hooks, given);
}
export function pagesEncodeH264(can) {
  h264 = !!can;
}

// ---------- the key the two programs share ----------
let key = null;
export function browserKey() {
  if (key !== null) return key;
  if (config.pages.key) return (key = config.pages.key);
  const file = config.pages.keyFile;
  try {
    key = fs.readFileSync(file, 'utf8').trim();
    if (key) return key;
  } catch {}
  try {
    // (Only where the folder for it exists, which is the volume the two
    // containers share. Run any other way, there is no browser to share it with.)
    const made = crypto.randomBytes(32).toString('hex');
    // Readable by the browser's program, which runs as another user's process in another container.
    fs.writeFileSync(file, `${made}\n`, { mode: 0o644 });
    key = made;
  } catch {
    key = ''; // nowhere to share one: no browser can sign in, and pages stay off
  }
  return key;
}

export function isAgent(req) {
  const mine = browserKey();
  const theirs = String(req.headers['x-drivepost-browser'] || '');
  if (!mine || !config.pages.on || theirs.length !== mine.length) return false;
  return crypto.timingSafeEqual(Buffer.from(theirs), Buffer.from(mine));
}

const plain = (address) => String(address || '').replace(/^::ffff:/, '');
// For guard.js: is this the machine the browser runs on?
export const guardAllows = (address) => !!agent && plain(address) === agent.address;
// Can a page be opened right now?
export const pagesReady = () => config.pages.on && !!agent;
export const pageOf = (profile) => (page && page.profile === profile ? page : null);

function toAgent(msg) {
  if (agent && agent.ws.readyState === 1) agent.ws.send(JSON.stringify(msg));
}

// ---------- the browser's program ----------
export function attachAgent(ws, req) {
  if (agent) agent.ws.close(4000, 'replaced');
  const mine = (agent = { ws, address: plain(req.socket.remoteAddress) });
  console.log(`[page] the browser is connected (${mine.address})`);
  hooks.availability();

  ws.on('message', (data, isBinary) => {
    if (agent !== mine) return;
    if (isBinary) {
      if (!page || data.length < 2) return;
      if (data[0] === 1) {
        if (page.share && !page.share.done) page.share.write(data.subarray(1));
      } else if (data[0] === 2) {
        for (const v of page.viewers) {
          // A phone on a slow connection gets the newest picture, not a queue of old ones.
          if (v.readyState === 1 && v.bufferedAmount < 256 * 1024) v.send(data.subarray(1), { binary: true });
        }
      }
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!page || msg.id !== page.id) return;
    if (msg.t === 'rec') newRecording();
    else if (msg.t === 'page') moved(msg);
    else if (msg.t === 'state') {
      if (msg.phase === 'capturing') page.sound = msg.sound !== false;
      else if (msg.phase === 'failed') endPage(String(msg.message || 'The page stopped.').slice(0, 300));
      else if (msg.phase === 'closed') endPage();
    } else if (msg.t === 'said') said(msg);
  });
  ws.on('close', () => {
    if (agent !== mine) return;
    agent = null;
    console.log('[page] the browser has disconnected');
    if (page) endPage("The server's browser stopped.");
    hooks.availability();
  });
}

// The browser has started a recording (its first of this page, or a fresh one).
function newRecording() {
  const mine = page;
  let share;
  try {
    share = startShare(mine.profile, { size: '720', audio: true, again: mine.recordings > 0, h264 });
  } catch (err) {
    console.error(`[page] could not take the recording in: ${err.message}`);
    return endPage("This server couldn't take the page's picture in.");
  }
  mine.recordings++;
  mine.share = share;
  share.onReady = () => {
    if (page !== mine || mine.share !== share) return;
    mine.phase = 'live';
    mine.liveAt = Date.now();
    clearTimeout(mine.openTimer);
  };
  share.onFail = (message, wasPlaying) => {
    if (page !== mine || mine.share !== share) return;
    // One that was playing may only have tripped over something in the
    // recording: the browser is asked for a fresh one, a couple of times.
    if (Date.now() - mine.liveAt > 60 * 1000) mine.fails = 0;
    if (wasPlaying && mine.fails < FRESH_STARTS) {
      mine.fails++;
      return toAgent({ t: 'again', id: mine.id });
    }
    endPage(message);
  };
}

// The page has gone somewhere, or changed what it calls itself.
function moved(msg) {
  const url = String(msg.url || '');
  if (!/^https?:/i.test(url)) return;
  page.url = url.slice(0, 2000);
  page.site = siteOf(url);
  page.title = String(msg.title || '').slice(0, 200);
  hooks.changed(page.profile, view(page));
}

function said(msg) {
  if (msg.what === 'fill' && msg.result === 'none') hooks.toast(page.profile, 'No video was found on the page to fill the screen with.');
  else if (msg.what === 'fill' && msg.result !== 'ok') hooks.toast(page.profile, "The page wouldn't let its video fill the screen.");
  else if ((msg.what === 'back' || msg.what === 'forward') && msg.result === 'none') hooks.toast(page.profile, msg.what === 'back' ? 'This is the first page.' : 'There is no page after this one.');
}

// What the screens are told about it.
const view = (p) => ({ url: p.url, title: p.title, site: p.site, phase: p.phase });

// ---------- opening and closing ----------

/*
 * Open an address as a page for a profile. `text` is what was pasted or
 * typed. Returns { ok: true } or { error } in words for the phone.
 */
export async function openPage(profile, text) {
  if (!config.pages.on) return { error: 'Opening pages is switched off on this server.' };
  const url = linkIn(text);
  if (!url) return { error: "That isn't a web address." };
  try {
    await addressAllowed(url);
  } catch (err) {
    return { error: err.message };
  }
  if (!agent) return { error: "The server's browser isn't running, so pages can't be opened right now." };
  if (page && page.profile !== profile) {
    if (hooks.shown(page.profile)) return { error: "The server's browser is showing a page in another car right now." };
    endPage('Someone else opened a page, and the browser shows one at a time.');
  }
  const site = siteOf(url);
  if (page) {
    // The same browser, sent somewhere new: what it is signed in to and the picture both carry on.
    page.url = url;
    page.site = site;
    page.title = '';
    page.idleSince = 0;
    toAgent({ t: 'go', id: page.id, url });
    console.log(`[page] on to ${site}`);
    hooks.changed(profile, view(page));
    return { ok: true, going: true };
  }
  const mine = (page = {
    id: crypto.randomBytes(8).toString('hex'),
    profile,
    url,
    site,
    title: '',
    phase: 'opening',
    sound: true,
    share: null,
    recordings: 0,
    fails: 0,
    liveAt: 0,
    viewers: new Set(),
    idleSince: 0,
    askedAgainAt: 0,
    openTimer: null,
  });
  mine.openTimer = setTimeout(() => {
    if (page === mine && mine.phase !== 'live') endPage("The page didn't come up in the server's browser.");
  }, OPEN_WITHIN_MS);
  mine.openTimer.unref();
  console.log(`[page] opening ${site}`);
  toAgent({ t: 'open', id: mine.id, url, profile, guardPort: config.pages.guardPort });
  hooks.changed(profile, view(mine));
  return { ok: true };
}

// Close a profile's page (from its phone, its being signed out, or nobody watching).
export function closePage(profile) {
  if (!page || page.profile !== profile) return false;
  endPage();
  return true;
}

// The page is over, by whatever road. `message` is said to the profile's screens when it wasn't asked for.
function endPage(message) {
  const mine = page;
  if (!mine) return;
  page = null;
  clearTimeout(mine.openTimer);
  console.log(`[page] closed${message ? `: ${message}` : ''}`);
  toAgent({ t: 'close', id: mine.id });
  for (const v of mine.viewers) v.close(1000, 'closed');
  mine.viewers.clear();
  if (message) hooks.toast(mine.profile, message);
  // With a picture playing, its ending tells the car (see server.js). Without one, say so here.
  if (mine.share && !mine.share.done) mine.share.finish('stopped');
  else hooks.changed(mine.profile, null);
}

// ---------- steering it from a phone ----------

const KINDS = new Set(['tap', 'scroll', 'text', 'key']);
const NAVS = new Set(['back', 'forward', 'reload']);

/*
 * A phone has the Page card open: it gets the live view down this socket and
 * sends its taps and typing up it.
 */
export function watchPage(ws, profile) {
  const mine = pageOf(profile);
  if (!mine) return ws.close(4404, 'no page');
  mine.viewers.add(ws);
  mine.idleSince = 0;
  if (mine.viewers.size === 1) toAgent({ t: 'view', id: mine.id, on: true });
  let sent = 0;
  let since = Date.now();
  ws.on('message', (data, isBinary) => {
    if (isBinary || page !== mine) return;
    // A person steering, not a flood: a couple of dozen things a second at the very most.
    const now = Date.now();
    if (now - since > 1000) {
      since = now;
      sent = 0;
    }
    if (++sent > 40) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    mine.idleSince = 0;
    if (msg.t === 'input' && KINDS.has(msg.kind)) {
      toAgent({ t: 'input', id: mine.id, kind: msg.kind, x: Number(msg.x) || 0, y: Number(msg.y) || 0, dy: Number(msg.dy) || 0, text: String(msg.text || '').slice(0, 500), key: String(msg.key || '').slice(0, 20) });
    } else if (msg.t === 'nav' && NAVS.has(msg.what)) toAgent({ t: 'nav', id: mine.id, what: msg.what });
    else if (msg.t === 'fill') toAgent({ t: 'fill', id: mine.id, on: msg.on !== false });
  });
  ws.on('close', () => {
    mine.viewers.delete(ws);
    if (page === mine && !mine.viewers.size) toAgent({ t: 'view', id: mine.id, on: false });
  });
}

// A profile's phones were signed out: they stop steering.
export function dropWatchers(profile) {
  const mine = pageOf(profile);
  if (mine) for (const v of mine.viewers) v.close(4401, 'signed out');
}

// ---------- nobody watching ----------
// Looked at every few seconds: a page that no car is playing and no phone is
// steering is closed once that has gone on long enough.
export function checkIdle(now = Date.now()) {
  if (!page || page.phase !== 'live') return;
  // Its recording has stopped arriving (the recording tab has hung, say): a
  // fresh one is asked for, and if that doesn't come either the page is closed.
  if (page.share && !page.share.done && now - page.share.lastDataAt > STALLED_MS) {
    if (now - page.askedAgainAt < 2 * STALLED_MS) return;
    if (page.askedAgainAt && now - page.askedAgainAt < 5 * STALLED_MS) return endPage('The page stopped sending its picture.');
    page.askedAgainAt = now;
    console.log('[page] its picture has stopped arriving: asking the browser for a fresh recording');
    return toAgent({ t: 'again', id: page.id });
  }
  if (page.viewers.size || hooks.shown(page.profile)) {
    page.idleSince = 0;
    return;
  }
  if (!page.idleSince) page.idleSince = now;
  else if (now - page.idleSince > config.pages.idleMs) {
    console.log('[page] nobody is watching it');
    endPage('The page was closed: nobody was watching it.');
  }
}
const idleTimer = setInterval(checkIdle, 5000);
idleTimer.unref();
