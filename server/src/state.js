import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isValidId, thumbFor, TEST_PATTERN_ID } from './youtube.js';
import { isLinkId, isLinkAddress, linkId, rememberLink, siteOf } from './links.js';
import { PAGE_ID, pageItem } from './mirror.js';
import { QUALITIES } from './config.js';

const HISTORY_MAX = 40;
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
    if (!QUALITIES.includes(this.settings.quality)) this.settings.quality = defaultQuality;
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
  // this video because it or the connection couldn't keep up.
  playQuality() {
    const chosen = this.settings.quality;
    if (this.autoCap && QUALITIES.indexOf(this.autoCap) < QUALITIES.indexOf(chosen)) return this.autoCap;
    return chosen;
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
      since: before.since,
    };
    // The car's row for it keeps up with where the page has gone.
    if (this.now && this.now.id === PAGE_ID) {
      const row = pageItem(this.page);
      if (row.title !== this.now.title || row.site !== this.now.site) this.now = { ...this.now, title: row.title, site: row.site };
    }
    this.changed();
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
        if (this.now && this.paused) this.pageMedia('play');
        this.backToNow();
        if (this.now) this.paused = false;
        break;
      case 'toggle':
        if (this.now) this.pageMedia(this.paused ? 'play' : 'pause');
        this.backToNow();
        if (this.now) this.paused = !this.paused;
        break;
      case 'seek':
        this.seekTo(Number(data.to) || 0);
        break;
      case 'skip':
        if (this.now && this.now.id === PAGE_ID) this.pageMedia('seek', Number(data.by) || 0);
        else this.seekTo(this.currentTime() + (Number(data.by) || 0));
        break;
      case 'restart':
        this.seekTo(0);
        break;
      case 'quality':
        if (!QUALITIES.includes(String(data.q))) return 'Bad quality';
        this.settings = { ...this.settings, quality: String(data.q) };
        this.autoCap = null;
        this.restartStream();
        break;
      case 'stepDown': {
        // From the car: drop one level for the rest of this video.
        const i = QUALITIES.indexOf(this.playQuality());
        if (i <= 0 || !this.now) return null;
        this.autoCap = QUALITIES[i - 1];
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
      case 'fill':
        // In fullscreen: zoom the picture to cover the window instead of fitting it.
        this.settings = { ...this.settings, fill: !!data.on };
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
