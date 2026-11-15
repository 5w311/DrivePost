import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isValidId, thumbFor, TEST_PATTERN_ID } from './youtube.js';
import { isLinkId, isLinkAddress, linkId, rememberLink, siteOf, isPageRowId, pageRowId } from './links.js';
import { PAGE_ID, pageItem } from './mirror.js';
import { QUALITIES } from './config.js';

const HISTORY_MAX = 40;
// A page says its name a moment after it opens, and may change it once or
// twice as it loads. After this long, a new name means the page has been
// steered somewhere else, and Recent keeps the name it opened with.
const PAGE_NAMING_MS = 20000;
const SEARCHES_MAX = 20;
const PROGRESS_MAX = 300;
const RESUME_MIN = 15; // don't bother resuming in the first 15 s
const RESUME_TAIL = 30; // or in the last 30 s

function clampStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// What someone searched for, tidied for keeping: one line, not too long. A
// pasted link isn't a search, and isn't kept.
export function cleanSearch(raw) {
  if (typeof raw !== 'string') return null;
  const q = raw.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!q || /youtu\.?be|youtube\.com|^https?:/i.test(q)) return null;
  return q;
}

// Turn whatever a client sent into a clean item, or null.
export function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const duration = Number(raw.duration);
  const row = {
    id: raw.id,
    title: clampStr(raw.title, 200) || 'Untitled',
    channel: clampStr(raw.channel, 100),
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    live: raw.live === true,
  };
  if (isPageRowId(raw.id)) {
    // A page that was opened in the server's browser, as Recent keeps it to
    // be opened again. It isn't a video: it has an address and a name.
    if (!isLinkAddress(raw.url) || pageRowId(raw.url) !== raw.id) return null;
    const site = siteOf(raw.url);
    return { id: raw.id, title: clampStr(raw.title, 200) || site, channel: '', duration: null, live: false, url: raw.url, site, thumb: '', page: true };
  }
  if (isLinkId(raw.id)) {
    // A video from another site (links.js). Its row carries its address,
    // which is what its ID is made from, and the picture the site gave for it.
    if (!isLinkAddress(raw.url) || linkId(raw.url) !== raw.id) return null;
    rememberLink(raw.url);
    const thumb = typeof raw.thumb === 'string' && raw.thumb.length <= 1000 && /^https:\/\/[^\s"'<>]+$/.test(raw.thumb) ? raw.thumb : '';
    return { ...row, url: raw.url, site: siteOf(raw.url), thumb };
  }
  if (!isValidId(raw.id)) return null;
  return { ...row, thumb: thumbFor(raw.id) };
}

// What is known of a page's own video, or null.
function cleanMedia(m) {
  if (!m || (m.status !== 'playing' && m.status !== 'paused')) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  return { status: m.status, t: num(m.t), d: num(m.d), rate: num(m.rate) || 1, seek: m.seek !== false, at: num(m.at) || Date.now() };
}

const AUTO_START = '480'; // where Auto begins on a server whose own default is Auto
const AUTO_HOLD_MS = 10 * 60 * 1000; // how long Auto stays below a quality the connection couldn't carry

export class Store extends EventEmitter {
  constructor({ dataDir, defaultQuality }) {
    super();
    this.file = path.join(dataDir, 'state.json');
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {}
    this.queue = Array.isArray(saved.queue) ? saved.queue.map((i) => this.keyed(cleanItem(i))).filter(Boolean) : [];
    this.history = Array.isArray(saved.history) ? saved.history.map(cleanItem).filter(Boolean) : [];
    // What this profile searched for lately, newest first.
    this.searches = Array.isArray(saved.searches) ? saved.searches.map(cleanSearch).filter(Boolean).slice(0, SEARCHES_MAX) : [];
    this.progress = saved.progress && typeof saved.progress === 'object' ? saved.progress : {};
    this.settings = { quality: defaultQuality, ...(saved.settings || {}) };
    if (!QUALITIES.includes(this.settings.quality) && this.settings.quality !== 'auto') this.settings.quality = defaultQuality;
    // Auto: where it stands (it starts in the middle and finds its level), and the most this car's screen has shown it can play.
    if (!QUALITIES.includes(this.settings.autoLevel)) this.settings.autoLevel = QUALITIES.includes(defaultQuality) ? defaultQuality : AUTO_START;
    if (!QUALITIES.includes(this.settings.autoMax)) delete this.settings.autoMax;
    delete this.settings.fill; // (a setting that is no more)
    this.autoHeld = null; // Auto came down from a quality the connection couldn't carry: { at: that quality, until } (not tried again before then)
    if (!['auto', 'mpeg1'].includes(this.settings.format)) this.settings.format = 'auto';
    this.seq = saved.seq || 0;
    // Bring back what was playing, but paused so it waits for a tap in the car.
    const now = saved.now ? cleanItem(saved.now) : null;
    this.now = now ? { ...this.keyed(now), seq: ++this.seq, startAt: this.resumePoint(now) } : null;
    this.paused = !!this.now;
    this.autoCap = null; // lower quality the car fell back to for this video
    // A page open for this profile in the server's own browser right now
    // (webpage.js): { url, title, site, phase, since }. `phase` is 'opening'
    // until its picture can be played, then 'live'. Never saved: after a
    // restart no page is open.
    this.page = null;
    this.position = null; // last report from the car: { seq, t, state, at }
    this.carOnline = false;
    this.saveTimer = null;
  }

  keyed(item) {
    return item ? { ...item, key: item.key || crypto.randomBytes(6).toString('base64url') } : null;
  }

  // What actually plays: the chosen quality, unless the car stepped down for
  // this video because it or the connection couldn't keep up. With Auto
  // chosen, the level Auto stands at: it comes down when the car can't keep
  // up and goes up when the car has measured room to spare (stepDown and
  // stepUp, below), and stays where it got to from one video to the next.
  playQuality() {
    if (this.settings.quality === 'auto') return this.settings.autoLevel;
    const chosen = this.settings.quality;
    if (this.autoCap && QUALITIES.indexOf(this.autoCap) < QUALITIES.indexOf(chosen)) return this.autoCap;
    return chosen;
  }

  // The highest quality Auto may go up to just now.
  autoCeiling(now = Date.now()) {
    let top = QUALITIES.length - 1;
    if (this.settings.autoMax) top = Math.min(top, QUALITIES.indexOf(this.settings.autoMax));
    if (this.autoHeld && now < this.autoHeld.until) top = Math.min(top, QUALITIES.indexOf(this.autoHeld.at) - 1);
    return Math.max(0, top);
  }

  resumePoint(item) {
    if (!item || item.live) return 0;
    const p = this.progress[item.id];
    if (!(p > RESUME_MIN)) return 0;
    if (item.duration && p > item.duration - RESUME_TAIL) return 0;
    return Math.floor(p);
  }

  publicState() {
    const ids = new Set([...this.queue, ...this.history.slice(0, 20)].map((i) => i.id));
    if (this.now) ids.add(this.now.id);
    const progress = {};
    for (const id of ids) if (this.progress[id]) progress[id] = Math.floor(this.progress[id]);
    return {
      now: this.now,
      paused: this.paused,
      queue: this.queue,
      history: this.history.slice(0, 20),
      searches: this.searches,
      progress,
      settings: this.settings,
      playQuality: this.playQuality(),
      carOnline: this.carOnline,
      position: this.position,
      page: this.page,
      // This machine's clock as this is sent: a page's video is said to be at a spot "at" a moment on it.
      clock: Date.now(),
    };
  }

  changed() {
    this.emit('state', this.publicState());
    this.scheduleSave();
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 2000);
  }

  saveNow() {
    const ids = Object.keys(this.progress);
    if (ids.length > PROGRESS_MAX) for (const id of ids.slice(0, ids.length - PROGRESS_MAX)) delete this.progress[id];
    const data = {
      now: this.now,
      queue: this.queue,
      history: this.history,
      searches: this.searches,
      progress: this.progress,
      settings: this.settings,
      seq: this.seq,
    };
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Could not save state:', err.message);
    }
  }

  // ---- searches ----

  // A search was run: put it at the top of the recent ones. The same words
  // again, however they are capitalised, move up instead of being listed twice.
  noteSearch(raw) {
    const q = cleanSearch(raw);
    if (!q) return;
    const same = (other) => other.toLowerCase() === q.toLowerCase();
    if (this.searches.length && same(this.searches[0])) return;
    this.searches = [q, ...this.searches.filter((other) => !same(other))].slice(0, SEARCHES_MAX);
    this.changed();
  }

  // ---- playback ----

  setNow(item, { startAt } = {}) {
    if (!item) {
      this.now = null;
      this.paused = false;
      this.position = null;
      this.autoCap = null;
      return;
    }
    const start = startAt ?? this.resumePoint(item);
    if (!this.now || this.now.id !== item.id) this.autoCap = null;
    this.now = { ...this.keyed(item), seq: ++this.seq, startAt: start };
    this.paused = false;
    this.position = { seq: this.now.seq, t: start, state: 'loading', at: Date.now() };
    // A page open in the server's browser isn't a video to find again under Recent.
    if (item.id !== TEST_PATTERN_ID && item.id !== PAGE_ID) {
      const { key, ...rest } = item;
      this.history = [rest, ...this.history.filter((h) => h.id !== item.id)].slice(0, HISTORY_MAX);
    }
  }

  currentTime() {
    if (!this.now) return 0;
    const p = this.position;
    if (p && p.seq === this.now.seq) {
      const drift = p.state === 'playing' ? (Date.now() - p.at) / 1000 : 0;
      return p.t + drift;
    }
    return this.now.startAt || 0;
  }

  seekTo(t) {
    if (!this.now || this.now.live) return;
    const max = this.now.duration ? Math.max(0, this.now.duration - 1) : Infinity;
    const to = Math.max(0, Math.min(max, t));
    this.now = { ...this.now, seq: ++this.seq, startAt: Math.floor(to) };
    this.position = { seq: this.now.seq, t: to, state: 'loading', at: Date.now() };
  }

  // Reopen the stream at the same spot (after a quality change).
  restartStream() {
    if (!this.now) return;
    if (!this.now.live) this.seekTo(this.currentTime());
    else this.now = { ...this.now, seq: ++this.seq };
  }

  advance() {
    const next = this.queue.shift();
    this.setNow(next ? next : null);
  }

  // ---- a page in the server's browser ----

  // A page is being opened (`info`: { url, title, site, phase }), has changed
  // (the same, with what is new), or has been closed (null).
  setPage(info) {
    if (!info) {
      if (!this.page) return;
      this.page = null;
      return this.changed();
    }
    const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const before = this.page || { since: Date.now() };
    this.page = {
      url: clean(info.url ?? before.url, 2000),
      title: clean(info.title ?? before.title, 200),
      site: clean(info.site ?? before.site, 80),
      phase: info.phase === 'live' || (info.phase === undefined && before.phase === 'live') ? 'live' : 'opening',
      // The browser's own ad blocker, for this page: at work when it opened ('up'), not yet ('late'), or not known ('').
      blocker: ['up', 'late'].includes(info.blocker ?? before.blocker) ? info.blocker ?? before.blocker : '',
      // The page's own video, as the browser's media controls have it: playing or paused, where (`t`, at the moment `at`) and how long.
      media: cleanMedia(info.media !== undefined ? info.media : before.media),
      // That video is being held for a car that isn't keeping up (page-keeper.js).
      waiting: !!(info.waiting ?? before.waiting),
      // About how far behind the browser's screen the car's picture is, in seconds.
      lag: Number.isFinite(info.lag ?? before.lag) ? Math.max(0, Math.min(60, info.lag ?? before.lag)) : 0,
      since: before.since,
    };
    this.keepPage(before);
    // The car's row for it keeps up with where the page has gone.
    if (this.now && this.now.id === PAGE_ID) {
      const row = pageItem(this.page);
      if (row.title !== this.now.title || row.site !== this.now.site) this.now = { ...this.now, title: row.title, site: row.site };
    }
    this.changed();
  }

  /*
   * A page that is opened is kept under Recent, to be opened again: by the
   * address it was opened at (where it is steered to afterwards isn't known
   * here), under the name the page gave itself as it opened. `before` is what
   * was known of the page until now.
   */
  keepPage(before) {
    const p = this.page;
    if (!isLinkAddress(p.url)) return;
    const id = pageRowId(p.url);
    const fresh = before.url !== p.url; // newly opened, or sent to a new address
    if (fresh) this.pageUrlAt = Date.now();
    const had = this.history.find((h) => h.id === id);
    const site = siteOf(p.url);
    const unnamed = !had || had.title === had.site;
    const naming = Date.now() - (this.pageUrlAt || 0) < PAGE_NAMING_MS;
    const title = ((naming || unnamed) && p.title) || (had && had.title) || site;
    const row = { id, title, channel: '', duration: null, live: false, url: p.url, site, thumb: '', page: true };
    if (!had || fresh) this.history = [row, ...this.history.filter((h) => h.id !== id)].slice(0, HISTORY_MAX);
    else if (had.title !== title) this.history = this.history.map((h) => (h.id === id ? row : h));
  }

  // The page is what the car plays, from this moment of it.
  showPage() {
    if (!this.page) return 'No page is open right now.';
    if (this.page.phase !== 'live') return 'The page is still opening.';
    this.setNow(pageItem(this.page), { startAt: 0 });
    // Put back on after it was paused from here: its video carries on too.
    this.emit('pageMedia', 'show', 0);
    return null;
  }

  // The page has been closed: the car moves on, unless it was left paused on it.
  pageOver() {
    this.page = null;
    if (this.now && this.now.id === PAGE_ID) {
      if (this.paused) this.setNow(null);
      else this.advance();
    }
    this.changed();
  }

  // A page can't be picked up where it was left: playing it again after a
  // pause shows it as it is now, in a new stream.
  backToNow() {
    if (!this.now || this.now.id !== PAGE_ID || !this.paused) return;
    this.now = { ...this.now, seq: ++this.seq };
    this.position = { seq: this.now.seq, t: 0, state: 'loading', at: Date.now() };
  }

  // The car is showing the page, and the page's own video has been paused
  // from inside the page (not from the car's or a phone's own button, and
  // not held for a car that is stuck). The screens show it as paused, and
  // their play buttons play it.
  pausedInPage() {
    const p = this.page;
    return !!(this.now && this.now.id === PAGE_ID && !this.paused && p && p.media && p.media.status === 'paused' && !p.waiting);
  }

  // Where the page's own video is at this moment (seconds), or null if the browser knows of none.
  pageMediaTime(now = Date.now()) {
    const m = this.page && this.page.media;
    if (!m || m.t === null) return null;
    const t = m.t + (m.status === 'playing' ? ((now - m.at) / 1000) * m.rate : 0);
    return m.d !== null ? Math.min(t, m.d) : t;
  }

  // The page is what is on: its video is asked to pause, play or skip (server.js passes it to the browser).
  pageMedia(what, by = 0) {
    if (this.now && this.now.id === PAGE_ID) this.emit('pageMedia', what, by);
  }

  // Apply a command from the car or a phone. Returns an error string or null.
  command(action, data = {}) {
    // The page in the server's browser is played or it isn't: it has no
    // place in Up Next, and only this server says what it is.
    if (data.item && data.item.id === PAGE_ID) {
      if (action !== 'play') return 'A page can be played, not lined up.';
      const error = this.showPage();
      if (!error) this.changed();
      return error;
    }
    const item = data.item ? cleanItem(data.item) : null;
    // A page kept under Recent is opened again, in the server's browser
    // (server.js hears this). It isn't a video to play here, or to line up.
    if (item && item.page) {
      if (action !== 'play') return 'A page can be opened again, not lined up.';
      this.emit('openPage', item.url);
      return null;
    }
    switch (action) {
      case 'play':
        if (!item) return 'Bad video';
        this.setNow(item, { startAt: data.fromStart ? 0 : undefined });
        break;
      case 'enqueue':
        if (!item) return 'Bad video';
        if (!this.now) this.setNow(item);
        else this.queue.push(this.keyed(item));
        break;
      case 'playNext':
        if (!item) return 'Bad video';
        if (!this.now) this.setNow(item);
        else this.queue.unshift(this.keyed(item));
        break;
      case 'playFromQueue': {
        const i = this.queue.findIndex((q) => q.key === data.key);
        if (i < 0) return 'Not in queue';
        const [picked] = this.queue.splice(i, 1);
        this.setNow(picked);
        break;
      }
      case 'remove':
        this.queue = this.queue.filter((q) => q.key !== data.key);
        break;
      case 'move': {
        const i = this.queue.findIndex((q) => q.key === data.key);
        const j = i + (data.dir < 0 ? -1 : 1);
        if (i < 0 || j < 0 || j >= this.queue.length) return null;
        [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
        break;
      }
      case 'clearQueue':
        this.queue = [];
        break;
      case 'next':
        this.advance();
        break;
      case 'stop':
        this.setNow(null);
        break;
      // (A page's video is in the server's browser, not here: pausing,
      // playing and skipping are also passed on to it. See pageMedia.)
      case 'pause':
        if (this.now && !this.paused) this.pageMedia('pause');
        if (this.now) this.paused = true;
        break;
      case 'resume':
        // (A page's video that was paused in the page itself: the car is showing the page all along, and only the video is played.)
        if (this.pausedInPage()) {
          this.pageMedia('play');
          break;
        }
        if (this.now && this.paused) this.pageMedia('play');
        this.backToNow();
        if (this.now) this.paused = false;
        break;
      case 'toggle':
        if (this.pausedInPage()) {
          this.pageMedia('play');
          break;
        }
        if (this.now) this.pageMedia(this.paused ? 'play' : 'pause');
        this.backToNow();
        if (this.now) this.paused = !this.paused;
        break;
      case 'seek': {
        // On a page, the time bar is the page's own video's: that video is taken to the place asked for.
        if (this.now && this.now.id === PAGE_ID) {
          if (this.pageMediaTime() !== null) this.pageMedia('seekto', Math.max(0, Number(data.to) || 0));
        } else this.seekTo(Number(data.to) || 0);
        break;
      }
      case 'skip':
        if (this.now && this.now.id === PAGE_ID) this.pageMedia('seek', Number(data.by) || 0);
        else this.seekTo(this.currentTime() + (Number(data.by) || 0));
        break;
      case 'restart':
        if (this.now && this.now.id === PAGE_ID) {
          if (this.pageMediaTime() !== null) this.pageMedia('seekto', 0);
        } else this.seekTo(0);
        break;
      case 'quality': {
        const q = String(data.q);
        if (!QUALITIES.includes(q) && q !== 'auto') return 'Bad quality';
        const was = this.playQuality();
        const settings = { ...this.settings, quality: q };
        if (q === 'auto' && this.settings.quality !== 'auto') {
          // Auto carries on from what was playing, with a clean slate: nothing it learned last time holds it back.
          settings.autoLevel = was;
          delete settings.autoMax;
          this.autoHeld = null;
        }
        this.settings = settings;
        this.autoCap = null;
        // (Nothing to start over for when what plays stays the same.)
        if (this.playQuality() !== was) this.restartStream();
        break;
      }
      case 'stepDown': {
        // From the car: it can't keep up. One level down: for the rest of
        // this video, or, with Auto, until the car measures room to go up again.
        const i = QUALITIES.indexOf(this.playQuality());
        if (i <= 0 || !this.now) return null;
        if (this.settings.quality === 'auto') {
          const settings = { ...this.settings, autoLevel: QUALITIES[i - 1] };
          // The screen itself can't play that quality: Auto doesn't go back up to it. The connection (or
          // this server) couldn't carry it: that may be different a few miles on, so it is tried again later.
          if (data.why === 'screen') settings.autoMax = QUALITIES[i - 1];
          else this.autoHeld = { at: QUALITIES[i], until: Date.now() + AUTO_HOLD_MS };
          this.settings = settings;
        } else this.autoCap = QUALITIES[i - 1];
        this.restartStream();
        break;
      }
      case 'stepUp': {
        // From the car, with Auto chosen: what it is being sent arrives several times faster than it plays, so there is room for the next quality up.
        // (`x`: how many times faster. A level up is about twice the data; with eight times the room, two levels go in one step, and the picture starts over once instead of twice.)
        if (this.settings.quality !== 'auto' || !this.now) return null;
        const i = QUALITIES.indexOf(this.playQuality());
        const to = Math.min(i + (Number(data.x) >= 8 ? 2 : 1), this.autoCeiling());
        if (i < 0 || to <= i) return null;
        this.settings = { ...this.settings, autoLevel: QUALITIES[to] };
        this.restartStream();
        break;
      }
      case 'fullscreen':
        // Whether the car shows the video across its whole window.
        this.settings = { ...this.settings, fullscreen: !!data.on };
        break;
      case 'format':
        // 'auto' = H.264 when the car can play it; 'mpeg1' = always the compatible player.
        if (!['auto', 'mpeg1'].includes(data.v)) return 'Bad format';
        this.settings = { ...this.settings, format: data.v };
        this.restartStream();
        break;
      case 'blockAds':
        // In pages opened in the server's browser: refuse what they ask of ad and tracker machines (adblock.js).
        this.settings = { ...this.settings, blockAds: !!data.on };
        break;
      case 'fill':
        // (There was a Fill button once. A page that was open since before it went may still ask: nothing to do.)
        break;
      case 'clearHistory':
        this.history = [];
        break;
      case 'forgetSearch': {
        const q = String(data.q || '').toLowerCase();
        this.searches = this.searches.filter((other) => other.toLowerCase() !== q);
        break;
      }
      case 'clearSearches':
        this.searches = [];
        break;
      default:
        return 'Unknown command';
    }
    this.changed();
    return null;
  }

  // Reports from the car.
  carPosition({ seq, t, state, duration }) {
    if (!this.now || seq !== this.now.seq || !Number.isFinite(t)) return false;
    this.position = { seq, t, state: String(state || 'playing'), at: Date.now() };
    if (!this.now.live && this.now.id !== TEST_PATTERN_ID) this.progress[this.now.id] = Math.floor(t);
    let changed = false;
    if (Number.isFinite(duration) && duration > 0 && !this.now.duration) {
      // A shared link often comes without its length. Now that the car knows it, the lists can show it too.
      const length = Math.round(duration);
      this.now = { ...this.now, duration: length };
      this.history = this.history.map((h) => (h.id === this.now.id && !h.duration ? { ...h, duration: length } : h));
      changed = true;
    }
    this.scheduleSave();
    return changed;
  }

  carEnded(seq) {
    if (!this.now || seq !== this.now.seq) return;
    delete this.progress[this.now.id];
    this.advance();
    this.changed();
  }

  setCarOnline(online) {
    if (this.carOnline === online) return;
    // Stop the clock while the car is away, so it resumes where it left off.
    if (!online && this.position) {
      this.position = { ...this.position, t: this.currentTime(), state: 'away', at: Date.now() };
    }
    this.carOnline = online;
    this.changed();
  }
}
