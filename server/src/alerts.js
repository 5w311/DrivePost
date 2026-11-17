/*
 * A message to the owner's phone when something this server needs has
 * stopped working, and another when it works again.
 *
 * The server looks at itself every few minutes (the checks are given to it
 * by server.js: can it be reached at its public address, is YouTube handing
 * it videos, is the browser container there, did an update fail to install,
 * is the disk nearly full). One bad look is not news: a check has to come
 * back bad several times running before anything is sent, and then it is
 * said once, again a day later if it still stands, and once more when it
 * has passed.
 *
 * Messages go where Admin says: an address that a line of text can be
 * POSTed to. That is how ntfy works (https://ntfy.sh, or a copy of it run at
 * home): the address is a "topic", a name only its owner knows, and the ntfy
 * app on a phone that follows the same topic shows what is posted there.
 * Title, urgency and a tag ride along as ntfy's headers; anything else that
 * takes a POST gets the words.
 *
 * What none of this can say is that the machine is off, or the house has no
 * internet: a dead server sends nothing. For that there is the heartbeat, an
 * address fetched every few minutes for as long as all is well. A service
 * that watches for the fetches to stop (healthchecks.io is one) raises the
 * alarm from outside.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { addressAllowed } from './links.js';

const AGAIN_AFTER_MS = 24 * 60 * 60 * 1000; // a trouble that still stands is said again this long after
const ADDRESS_MAX = 300;

// An address messages can be sent to (or fetched as a heartbeat): https, or http where the server is let onto its own network.
export function cleanAddress(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (text.length > ADDRESS_MAX) throw new Error('That address is too long.');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("That isn't an address: it should start with https://");
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("That isn't an address this server can send to: it should start with https://");
  }
  return url.href;
}

// A topic of one's own on the public ntfy server: nobody else knows its name.
export function newTopic() {
  return `https://ntfy.sh/drivepost-${crypto.randomBytes(12).toString('base64url').replace(/[-_]/g, 'x').toLowerCase()}`;
}

/*
 * Post `words` to `address`. `opts`: { title, urgent, good } for the app
 * that shows it. Throws in words when it didn't go.
 */
export async function post(address, words, opts = {}, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  await (deps.allowed || addressAllowed)(address);
  let res;
  try {
    res = await fetchImpl(address, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        Title: opts.title || 'DrivePost',
        Priority: opts.urgent ? 'high' : 'default',
        Tags: opts.good ? 'white_check_mark' : opts.urgent ? 'warning' : 'car',
      },
      body: String(words).slice(0, 1500),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    throw new Error(`the message couldn't be sent (${String(err.cause?.code || err.name || err.message).slice(0, 60)})`);
  }
  if (!res.ok) throw new Error(`the address answered ${res.status}`);
}

/*
 * The checks, and what has been said about each. `checks`:
 *   { name: { label, every (ms), after (bad looks in a row before it is said), look: async () => ({ ok, words }) | { skip } | null } }
 * (`look` returning null: nothing to check, as when no public address is set. `{ skip: why }`: no way to tell from here.)
 */
export class Alerts {
  constructor({ file, checks = {}, now = Date.now, send = post, fetchImpl = fetch, allowed = addressAllowed, log = console } = {}) {
    this.file = file;
    this.checks = checks;
    this.now = now;
    this.send = send;
    this.fetchImpl = fetchImpl;
    this.allowed = allowed;
    this.log = log;
    this.to = '';
    this.beat = '';
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.to = cleanAddress(saved.to);
      this.beat = cleanAddress(saved.beat);
    } catch {}
    this.state = {}; // name -> { bad, fails, since, saidAt, words, lookedAt, known }
    for (const name of Object.keys(checks)) this.state[name] = { bad: false, fails: 0, since: 0, saidAt: 0, words: '', lookedAt: 0, known: false };
    this.sent = null; // the last message: { at, ok, words, error }
    this.beatAt = 0;
    this.beatError = '';
    this.looking = new Set();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ to: this.to, beat: this.beat }));
    } catch (err) {
      this.log.warn(`[alerts] couldn't save where to send them: ${err.message}`);
    }
  }

  // Admin sets where messages go and the heartbeat ('' for neither). Throws in words for an address that won't do.
  set({ to, beat }) {
    if (to !== undefined) this.to = cleanAddress(to);
    if (beat !== undefined) this.beat = cleanAddress(beat);
    this.save();
  }

  async say(words, opts = {}) {
    if (!this.to) return false;
    try {
      await this.send(this.to, words, opts);
      this.sent = { at: this.now(), ok: true, words, error: '' };
      return true;
    } catch (err) {
      this.sent = { at: this.now(), ok: false, words, error: err.message };
      this.log.warn(`[alerts] ${err.message}`);
      return false;
    }
  }

  // What a check found. Says what is news, to the log always and to the phone if one is set.
  async report(name, found) {
    const s = this.state[name];
    const check = this.checks[name];
    if (!s || !check) return;
    const now = this.now();
    s.lookedAt = now;
    if (!found || found.skip) {
      // Nothing to check (not set up), or no way to tell from here (`skip` says why): not good, not bad.
      Object.assign(s, { known: false, bad: false, fails: 0, since: 0, saidAt: 0, words: '', why: (found && found.skip) || '' });
      return;
    }
    s.known = true;
    if (found.ok) {
      const was = s.bad && s.saidAt;
      Object.assign(s, { bad: false, fails: 0, since: 0, words: '' });
      if (was) {
        s.saidAt = 0;
        this.log.log(`[alerts] back to normal: ${check.label}`);
        await this.say(`Back to normal: ${check.label}.`, { good: true });
      }
      return;
    }
    s.fails++;
    s.words = String(found.words || check.label);
    if (!s.since) s.since = now;
    if (s.fails < (check.after || 2)) return;
    s.bad = true;
    if (s.saidAt && now - s.saidAt < AGAIN_AFTER_MS) return;
    const again = !!s.saidAt;
    s.saidAt = now;
    this.log.warn(`[alerts] ${s.words}`);
    await this.say(again ? `Still so: ${s.words}` : s.words, { urgent: true });
  }

  /*
   * Called every minute or so: runs the checks that are due, and fetches the
   * heartbeat if all that can be seen from outside is well. A check that
   * came back bad is looked at again sooner than its usual round.
   */
  async tick() {
    const now = this.now();
    const due = Object.entries(this.checks).filter(([name, c]) => {
      const s = this.state[name];
      const every = s.fails && !s.bad ? Math.min(c.every, c.recheck || c.every) : c.every;
      // (Never looked at: now.)
      return !this.looking.has(name) && (!s.lookedAt || now - s.lookedAt >= every);
    });
    await Promise.all(
      due.map(async ([name, c]) => {
        this.looking.add(name);
        try {
          let found;
          try {
            found = await c.look();
          } catch (err) {
            found = { ok: false, words: `${c.label}: the check itself failed (${String(err.message).slice(0, 120)})` };
          }
          await this.report(name, found);
        } finally {
          this.looking.delete(name);
        }
      })
    );
    await this.heartbeat();
  }

  // All is well as far as this server can tell: say so to whoever is listening for it.
  async heartbeat(every = 5 * 60 * 1000) {
    if (!this.beat) return;
    const now = this.now();
    if (now - this.beatAt < every) return;
    // (Not while it can't be reached from outside, or the listener would think all is well.)
    const outside = this.state.outside;
    if (outside && (outside.bad || outside.fails)) return;
    this.beatAt = now;
    try {
      await this.allowed(this.beat);
      const res = await this.fetchImpl(this.beat, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      this.beatError = res.ok ? '' : `answered ${res.status}`;
    } catch (err) {
      this.beatError = String(err.cause?.code || err.name || err.message).slice(0, 80);
    }
  }

  // For the Admin page.
  view() {
    return {
      to: this.to,
      beat: this.beat,
      beatAt: this.beatAt,
      beatError: this.beatError,
      sent: this.sent ? { at: this.sent.at, ok: this.sent.ok, error: this.sent.error } : null,
      checks: Object.entries(this.checks).map(([name, c]) => {
        const s = this.state[name];
        return {
          name,
          label: c.label,
          // 'ok', 'bad' (and said), 'unsure' (a bad look or two, not yet counted as trouble), 'unset' (nothing to check), 'waiting' (not looked at yet)
          state: !s.lookedAt ? 'waiting' : !s.known ? 'unset' : s.bad ? 'bad' : s.fails ? 'unsure' : 'ok',
          words: s.bad || s.fails ? s.words : !s.known && s.lookedAt ? s.why || c.unset || '' : '',
          since: s.since,
        };
      }),
    };
  }
}
