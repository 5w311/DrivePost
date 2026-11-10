import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isValidId, thumbFor, TEST_PATTERN_ID } from './youtube.js';

const HISTORY_MAX = 40;
const PROGRESS_MAX = 300;
const RESUME_MIN = 15; // don't bother resuming in the first 15 s
const RESUME_TAIL = 30; // or in the last 30 s

function clampStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// Turn whatever a client sent into a clean item, or null.
export function cleanItem(raw) {
  if (!raw || typeof raw !== 'object' || !isValidId(raw.id)) return null;
  const duration = Number(raw.duration);
  return {
    id: raw.id,
    title: clampStr(raw.title, 200) || 'Untitled',
    channel: clampStr(raw.channel, 100),
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    live: raw.live === true,
    thumb: thumbFor(raw.id),
  };
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
    this.progress = saved.progress && typeof saved.progress === 'object' ? saved.progress : {};
    this.settings = { quality: defaultQuality, ...(saved.settings || {}) };
    this.seq = saved.seq || 0;
    // Bring back what was playing, but paused so it waits for a tap in the car.
    const now = saved.now ? cleanItem(saved.now) : null;
    this.now = now ? { ...this.keyed(now), seq: ++this.seq, startAt: this.resumePoint(now) } : null;
    this.paused = !!this.now;
    this.position = null; // last report from the car: { seq, t, state, at }
    this.carOnline = false;
    this.saveTimer = null;
  }

  keyed(item) {
    return item ? { ...item, key: item.key || crypto.randomBytes(6).toString('base64url') } : null;
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
      progress,
      settings: this.settings,
      carOnline: this.carOnline,
      position: this.position,
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

  // ---- playback ----

  setNow(item, { startAt } = {}) {
    if (!item) {
      this.now = null;
      this.paused = false;
      this.position = null;
      return;
    }
    const start = startAt ?? this.resumePoint(item);
    this.now = { ...this.keyed(item), seq: ++this.seq, startAt: start };
    this.paused = false;
    this.position = { seq: this.now.seq, t: start, state: 'loading', at: Date.now() };
    if (item.id !== TEST_PATTERN_ID) {
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

  advance() {
    const next = this.queue.shift();
    this.setNow(next ? next : null);
  }

  // Apply a command from the car or a phone. Returns an error string or null.
  command(action, data = {}) {
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
      case 'pause':
        if (this.now) this.paused = true;
        break;
      case 'resume':
        if (this.now) this.paused = false;
        break;
      case 'toggle':
        if (this.now) this.paused = !this.paused;
        break;
      case 'seek':
        this.seekTo(Number(data.to) || 0);
        break;
      case 'skip':
        this.seekTo(this.currentTime() + (Number(data.by) || 0));
        break;
      case 'restart':
        this.seekTo(0);
        break;
      case 'quality':
        if (!['360', '480', '720'].includes(String(data.q))) return 'Bad quality';
        this.settings = { ...this.settings, quality: String(data.q) };
        if (this.now && !this.now.live) this.seekTo(this.currentTime());
        else if (this.now) this.now = { ...this.now, seq: ++this.seq };
        break;
      case 'clearHistory':
        this.history = [];
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
      this.now = { ...this.now, duration: Math.round(duration) };
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
