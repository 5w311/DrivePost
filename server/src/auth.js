import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/*
 * Sign-in, profiles and Admin.
 *
 * A profile is one person's (or one car's) own copy of everything: what's
 * playing, Up Next, history, settings, paired phones and Send to Car link.
 * Which profile a device is in is decided by the passcode it signed in with.
 *
 * Someone gets a profile by asking for one on the sign-in page, with a name
 * and a passcode of their choice. The request waits until it is allowed on
 * the Admin page; until then the passcode opens nothing.
 *
 * DRIVE_PASSCODE from .env is the server's own passcode. It opens the Admin
 * page and nothing else: it is not a profile's passcode, and being signed in
 * to a profile doesn't open Admin.
 */

const COOKIE = 'dt_session';
const SESSION_DAYS = 400;
const ADMIN_COOKIE = 'dt_admin';
const ADMIN_DAYS = 30;
const PAIR_TTL_MS = 10 * 60 * 1000;
// The one profile a server had before profiles existed, if it still has it.
// Its history lives in the data folder itself, and it has no passcode until
// it is given one in Admin: DRIVE_PASSCODE used to open it and no longer does.
// A server set up since then has no such profile.
export const ORIGINAL = 'main';
export const MAX_PROFILES = 12;
export const MAX_REQUESTS = 5; // people waiting for the main profile's OK at one time
const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Wrong passcodes, from everywhere together, before sign-in is closed for a while (see allowAttempt).
const WRONG_MOST = Number(process.env.WRONG_PASSCODES_AN_HOUR) || 40;
const WRONG_WINDOW_MS = 60 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Passcodes of added profiles are kept scrambled, not as typed.
// A new passcode has to be at least this long. Ones from before the rule keep
// working: only their scrambled form is kept, so there is nothing to measure.
export const PASSCODE_MIN = 8;

// What .env.example has for DRIVE_PASSCODE. Anyone can read that file, so a
// server that still has it has no Admin passcode worth the name: Admin stays
// closed until its owner sets one. (The profiles carry on.)
export const EXAMPLE_PASSCODE = 'change-me';
export const ADMIN_CLOSED = "Admin is closed: DRIVE_PASSCODE in this server's .env file is still the example's. Set your own there and restart.";

// The limits on wrong passcodes leave a guesser a few hundred tries a day, so
// length alone isn't enough: these are the ones tried in the first hour.
const FIRST_GUESSES = new Set([
  'password', 'passcode', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  'iloveyou', 'letmein1', 'letmein123', 'welcome1', 'welcome123', 'changeme', 'whatever', 'trustno1',
  'admin123', 'admin1234', 'abc12345', 'abcd1234', 'a1b2c3d4', 'q1w2e3r4', '1q2w3e4r', '1q2w3e4r5t',
  'qwerty12', 'qwerty123', 'zxcvbnm1', 'sunshine', 'princess', 'football', 'baseball', 'superman',
  'starwars', 'computer', 'internet', 'drivepost', 'drivetest', 'tesla123', 'tesla1234', 'teslamodel3',
  EXAMPLE_PASSCODE,
]);
// Straight along the digits, the alphabet or the keyboard, in either direction.
const ROWS = ['01234567890123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm', '1qaz2wsx3edc4rfv5tgb6yhn7ujm'];
export function easyToGuess(passcode) {
  const t = String(passcode || '').toLowerCase();
  if (FIRST_GUESSES.has(t)) return true;
  if (new Set(t).size <= 2) return true; // "aaaaaaaa", "12121212"
  if (ROWS.some((row) => row.includes(t) || [...row].reverse().join('').includes(t))) return true; // "12345678", "qwertyui"
  // The same few characters over and over: "12341234", "abcabcabc".
  for (let n = 1; n <= t.length / 2; n++) {
    if (t.length % n === 0 && t.slice(0, n).repeat(t.length / n) === t) return true;
  }
  return false;
}
const TOO_SHORT = `Use a passcode of at least ${PASSCODE_MIN} characters.`;
const TOO_EASY = "That passcode is one of the first anyone would try. Pick one that's harder to guess.";

function scramble(passcode, salt) {
  return crypto.scryptSync(String(passcode), Buffer.from(salt, 'base64url'), 32).toString('base64url');
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    const raw = part.slice(i + 1).trim();
    // Anyone can send any cookie. One that isn't written the way cookies are
    // isn't one of ours: taken as it stands, it matches nothing.
    try {
      out[k] = decodeURIComponent(raw);
    } catch {
      out[k] = raw;
    }
  }
  return out;
}

export function clientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

/*
 * Whose tries an address's are counted with. Someone on IPv6 has a whole
 * network of addresses to themselves (2^64 of them, usually) and can come
 * from a different one every time, so those all count as one.
 */
export function networkOf(ip) {
  let s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) s = mapped[1];
  if (net.isIP(s) !== 6) return s.slice(0, 64) || 'unknown';
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const dotted = tail.some((g) => g.includes('.')) ? 1 : 0; // (an IPv4 ending stands for two groups)
  const groups = halves.length > 1 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length - dotted)).fill('0'), ...tail] : head;
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}

// Add a cookie to the answer without dropping one that is already on it.
function addCookie(res, cookie) {
  const had = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
  res.setHeader('Set-Cookie', had ? [].concat(had, cookie) : cookie);
}

// Only mark the cookie https-only when this request really came over https
// (through the tunnel). Testing on the home network over http keeps working.
export function isHttps(req) {
  if ((req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
  if (/"scheme"\s*:\s*"https"/.test(req.headers['cf-visitor'] || '')) return true;
  return !!req.socket.encrypted;
}

export class Auth {
  constructor({ dataDir, passcode, shareToken }) {
    this.file = path.join(dataDir, 'secrets.json');
    this.profilesFile = path.join(dataDir, 'profiles.json');
    this.passcode = passcode;
    this.pairCodes = new Map();
    this.attempts = new Map();
    fs.mkdirSync(dataDir, { recursive: true });

    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {}
    this.secrets = { sessionSecret: saved.sessionSecret || b64url(crypto.randomBytes(32)) };

    let profiles = [];
    let hadProfiles = false;
    this.requests = [];
    this.allowRequests = true;
    try {
      const data = JSON.parse(fs.readFileSync(this.profilesFile, 'utf8'));
      hadProfiles = true;
      if (Array.isArray(data.profiles)) profiles = data.profiles.filter((p) => p && typeof p.id === 'string');
      if (Array.isArray(data.requests)) this.requests = data.requests.filter((r) => r && typeof r.id === 'string' && r.pass);
      if (data.allowRequests === false) this.allowRequests = false;
    } catch {}
    if (!hadProfiles && saved.sessionSecret) {
      // A server from before profiles existed: the car, phones and Shortcut
      // it had become a profile called "Main", so they carry on working. Its
      // Shortcut used SHARE_TOKEN from .env if that was set. This is the only
      // time that setting is read: from here on the token is kept with the
      // profile like any other, so making a new one in Setup sticks.
      profiles.unshift({ id: ORIGINAL, name: 'Main', epoch: 0, shareToken: shareToken || saved.shareToken || b64url(crypto.randomBytes(24)) });
    }
    this.profiles = profiles;
    this.persist();
  }

  persist() {
    // The original profile's share token is also kept where older versions look for it.
    const original = this.profiles.find((p) => p.id === ORIGINAL);
    if (original) this.secrets.shareToken = original.shareToken;
    fs.writeFileSync(this.file, JSON.stringify(this.secrets, null, 2), { mode: 0o600 });
    const data = { profiles: this.profiles, requests: this.requests, allowRequests: this.allowRequests };
    fs.writeFileSync(this.profilesFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  // ---- profiles ----

  profile(id) {
    return this.profiles.find((p) => p.id === id) || null;
  }

  // What may be shown on screen: no passcodes, no tokens.
  listProfiles() {
    return this.profiles.map((p) => ({ id: p.id, name: p.name, hasPasscode: !!p.pass }));
  }

  cleanName(name) {
    // Names are shown on other people's screens and in the log: plain text only.
    const n = String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!n) throw new Error('Give the profile a name.');
    return n;
  }

  // Which profile, if any, has this passcode.
  checkPasscode(input) {
    const typed = String(input || '');
    if (!typed) return null;
    for (const p of this.profiles) {
      if (p.pass && safeEqual(scramble(typed, p.pass.salt), p.pass.hash)) return p.id;
    }
    return null;
  }

  checkNewPasscode(passcode, exceptId) {
    const typed = String(passcode || '');
    if (typed.length < PASSCODE_MIN) throw new Error(TOO_SHORT);
    if (typed.length > 100) throw new Error('That passcode is too long.');
    this.notTheServers(typed);
    if (easyToGuess(typed)) throw new Error(TOO_EASY);
    // The passcode is what tells profiles apart, so no two can share one.
    const taken = this.checkPasscode(typed);
    if (taken && taken !== exceptId) throw new Error('Another profile already uses that passcode. Pick a different one.');
    if (this.requestFor(typed)) throw new Error('Someone waiting for your OK asked for that passcode. Answer them first, or pick a different one.');
    return typed;
  }

  // The server's own passcode opens Admin and can't double as a profile's.
  notTheServers(typed) {
    if (this.checkAdminPasscode(typed)) throw new Error("That passcode can't be used for a profile. Pick a different one.");
  }

  addProfile(name, passcode) {
    if (this.profiles.length >= MAX_PROFILES) throw new Error(`That's the most profiles this server keeps (${MAX_PROFILES}).`);
    const clean = this.cleanName(name);
    const typed = this.checkNewPasscode(passcode, null);
    const salt = b64url(crypto.randomBytes(16));
    const profile = {
      id: crypto.randomBytes(5).toString('hex'),
      name: clean,
      epoch: 0,
      shareToken: b64url(crypto.randomBytes(24)),
      pass: { salt, hash: scramble(typed, salt) },
    };
    this.profiles.push(profile);
    this.persist();
    return profile.id;
  }

  renameProfile(id, name) {
    const p = this.profile(id);
    if (!p) throw new Error('No such profile.');
    p.name = this.cleanName(name);
    this.persist();
  }

  setPasscode(id, passcode) {
    const p = this.profile(id);
    if (!p) throw new Error('No such profile.');
    const typed = this.checkNewPasscode(passcode, id);
    const salt = b64url(crypto.randomBytes(16));
    p.pass = { salt, hash: scramble(typed, salt) };
    this.persist();
  }

  removeProfile(id) {
    const i = this.profiles.findIndex((p) => p.id === id);
    if (i < 0) throw new Error('No such profile.');
    this.profiles.splice(i, 1);
    for (const [code, entry] of this.pairCodes) if (entry.profile === id) this.pairCodes.delete(code);
    this.persist();
  }

  // ---- asking for a profile ----
  // Requests are kept in the same file as the profiles, so one made while
  // nobody is looking at Admin is still there after the server restarts or updates.

  pruneRequests() {
    const cutoff = Date.now() - REQUEST_TTL_MS;
    const kept = this.requests.filter((r) => r.at > cutoff);
    if (kept.length !== this.requests.length) {
      this.requests = kept;
      this.persist();
    }
  }

  // What may be shown on screen about a request: no passcode.
  showRequest(r) {
    return { id: r.id, name: r.name, code: r.code, at: r.at };
  }

  listRequests() {
    this.pruneRequests();
    return this.requests.map((r) => this.showRequest(r));
  }

  // Whether the sign-in page should offer asking for a profile.
  canAsk() {
    return this.allowRequests && this.profiles.length < MAX_PROFILES;
  }

  setAllowRequests(on) {
    this.allowRequests = !!on;
    this.persist();
  }

  requestById(id) {
    this.pruneRequests();
    return this.requests.find((r) => r.id === id) || null;
  }

  // The waiting request that asked for this passcode, if any.
  requestFor(passcode) {
    const typed = String(passcode || '');
    if (!typed) return null;
    this.pruneRequests();
    return this.requests.find((r) => safeEqual(scramble(typed, r.pass.salt), r.pass.hash)) || null;
  }

  // Someone new asks for a profile of their own. Nothing opens for them until
  // it is allowed in Admin. Returns what to show while they wait.
  askForProfile(name, passcode) {
    if (!this.allowRequests) throw new Error("This DrivePost isn't taking requests for new profiles. Ask its owner for a passcode.");
    const typed = String(passcode || '');
    if (typed.length < PASSCODE_MIN) throw new Error(TOO_SHORT);
    if (typed.length > 100) throw new Error('That passcode is too long.');
    this.notTheServers(typed);
    if (this.checkPasscode(typed)) throw new Error('That passcode already opens a profile. Go back and sign in with it.');
    if (easyToGuess(typed)) throw new Error(TOO_EASY);
    const already = this.requestFor(typed);
    if (already) return this.showRequest(already); // asked before with this passcode: still waiting
    const clean = this.cleanName(name);
    if (this.profiles.length >= MAX_PROFILES) throw new Error("This DrivePost has no room for another profile.");
    if (this.requests.length >= MAX_REQUESTS) {
      throw new Error('Several people are already waiting for an OK. Ask the owner to answer them, then try again.');
    }
    // A short number shown on both screens, so whoever allows it can tell
    // whose request this really is.
    let code;
    do code = String(crypto.randomInt(100, 1000));
    while (this.requests.some((r) => r.code === code));
    const salt = b64url(crypto.randomBytes(16));
    const request = {
      id: b64url(crypto.randomBytes(16)),
      name: clean,
      code,
      at: Date.now(),
      pass: { salt, hash: scramble(typed, salt) },
    };
    this.requests.push(request);
    this.persist();
    return this.showRequest(request);
  }

  // Allowed in Admin: the request becomes a profile, opened by the
  // passcode the person chose. Returns the new profile's id.
  approveRequest(id) {
    const r = this.requestById(id);
    if (!r) throw new Error('That request is gone: it was cancelled, answered already, or ran out.');
    if (this.profiles.length >= MAX_PROFILES) throw new Error(`That's the most profiles this server keeps (${MAX_PROFILES}).`);
    this.requests.splice(this.requests.indexOf(r), 1);
    const profile = {
      id: crypto.randomBytes(5).toString('hex'),
      name: r.name,
      epoch: 0,
      shareToken: b64url(crypto.randomBytes(24)),
      pass: r.pass,
    };
    this.profiles.push(profile);
    this.persist();
    return profile.id;
  }

  // Declined in Admin, or cancelled by the person who asked.
  // Returns the request that was dropped, or null if there was none.
  dropRequest(id) {
    const i = this.requests.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const [r] = this.requests.splice(i, 1);
    this.persist();
    return this.showRequest(r);
  }

  // ---- sessions ----

  sign(text) {
    return crypto.createHmac('sha256', this.secrets.sessionSecret).update(text).digest('base64url');
  }

  issueCookie(req, res, profileId) {
    const p = this.profile(profileId);
    if (!p) throw new Error('No such profile.');
    const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
    const value = `p.${p.id}.${p.epoch}.${exp}.${this.sign(`v2.${p.id}.${p.epoch}.${exp}`)}`;
    const parts = [
      `${COOKIE}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${SESSION_DAYS * 86400}`,
    ];
    if (isHttps(req)) parts.push('Secure');
    addCookie(res, parts.join('; '));
  }

  clearCookie(res) {
    addCookie(res, `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  // The profile this request is signed in to, or null.
  profileOf(req) {
    const value = parseCookies(req.headers.cookie)[COOKIE];
    if (!value) return null;
    const now = Date.now() / 1000;
    const parts = value.split('.');
    if (parts[0] === 'p' && parts.length === 5) {
      const [, id, epochStr, expStr, sig] = parts;
      const p = this.profile(id);
      const exp = parseInt(expStr, 10);
      if (!p || !exp || exp < now || String(p.epoch) !== epochStr) return null;
      return safeEqual(sig, this.sign(`v2.${id}.${epochStr}.${exp}`)) ? id : null;
    }
    // A sign-in from before profiles existed belongs to the original
    // profile, until that profile is signed out everywhere or removed.
    if (parts.length === 2) {
      const [expStr, sig] = parts;
      const exp = parseInt(expStr, 10);
      const original = this.profile(ORIGINAL);
      if (!exp || exp < now || !original || original.epoch !== 0) return null;
      return safeEqual(sig, this.sign(`v1.${exp}`)) ? ORIGINAL : null;
    }
    return null;
  }

  // Signing out everywhere: every existing sign-in to this profile stops working.
  rotateSessions(profileId) {
    const p = this.profile(profileId);
    if (!p) return;
    p.epoch = (p.epoch || 0) + 1;
    this.persist();
  }

  // ---- admin ----
  // The Admin page (profiles, people asking for one) is opened by typing the
  // server's own passcode, DRIVE_PASSCODE. That passcode opens nothing else,
  // and no profile sign-in opens Admin: a phone paired from a car's QR code
  // is on that car's profile without ever having typed a passcode, and must
  // not get to manage the server that way.

  // Is DRIVE_PASSCODE still what the example file has?
  get adminClosed() {
    return this.passcode === EXAMPLE_PASSCODE;
  }

  checkAdminPasscode(input) {
    const typed = String(input || '');
    return !!typed && !!this.passcode && !this.adminClosed && safeEqual(typed, this.passcode);
  }

  // What to tell someone who types the example's passcode on such a server: its owner, most likely.
  adminClosedFor(input) {
    return this.adminClosed && String(input || '') === EXAMPLE_PASSCODE ? ADMIN_CLOSED : null;
  }

  // The passcode is part of what gets signed, so changing DRIVE_PASSCODE
  // signs every device out of Admin.
  adminSig(exp) {
    const pass = crypto.createHash('sha256').update(String(this.passcode)).digest('base64url');
    return this.sign(`admin.${exp}.${pass}`);
  }

  issueAdminCookie(req, res) {
    const exp = Math.floor(Date.now() / 1000) + ADMIN_DAYS * 86400;
    const parts = [
      `${ADMIN_COOKIE}=${exp}.${this.adminSig(exp)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${ADMIN_DAYS * 86400}`,
    ];
    if (isHttps(req)) parts.push('Secure');
    addCookie(res, parts.join('; '));
  }

  clearAdminCookie(res) {
    addCookie(res, `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  // Has this device typed the server's passcode on the Admin page?
  isAdmin(req) {
    const value = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    if (!value || !this.passcode || this.adminClosed) return false;
    const [expStr, sig] = value.split('.');
    const exp = parseInt(expStr, 10);
    if (!exp || !sig || exp < Date.now() / 1000) return false;
    return safeEqual(sig, this.adminSig(exp));
  }

  // ---- share tokens (the iPhone Shortcut) ----

  shareTokenOf(profileId) {
    const p = this.profile(profileId);
    return p ? p.shareToken : null;
  }

  // The share token arrives either as an "Authorization: Bearer" header or as
  // ?key= in the address (the one-paste link the iPhone Shortcut uses).
  // Returns the profile it belongs to, or null.
  shareProfile(req, key) {
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    const given = [m && m[1].trim(), typeof key === 'string' ? key : ''].filter(Boolean);
    for (const token of given) {
      for (const p of this.profiles) if (p.shareToken && safeEqual(token, p.shareToken)) return p.id;
    }
    return null;
  }

  rotateShareToken(profileId) {
    const p = this.profile(profileId);
    if (!p) throw new Error('No such profile.');
    p.shareToken = b64url(crypto.randomBytes(24));
    this.persist();
    return p.shareToken;
  }

  // ---- sign-in attempts and phone pairing ----

  /*
   * May this address try a passcode? Two limits, and both have to allow it.
   *
   * One is per address: 8 tries in 10 minutes. But an address is only what a
   * request says it is (the header a tunnel adds can be typed in by anyone
   * who reaches the server without one), and someone with many addresses has
   * as many lots of 8. So the other limit is on wrong passcodes from
   * everywhere together: after 40 in an hour, nobody gets another try until
   * some of those are an hour old. That makes guessing a passcode take
   * months instead of an afternoon. Devices that are already signed in
   * aren't affected, and a phone can still join from its car's QR code.
   */
  allowAttempt(ip, now = Date.now()) {
    this.wrong = (this.wrong || []).filter((t) => now - t < WRONG_WINDOW_MS);
    if (this.wrong.length >= WRONG_MOST) {
      // `refusal` is what to tell whoever was turned away.
      this.refusal = 'Too many wrong passcodes have been tried on this server in the last hour, so sign-in is closed for a while. A phone can still join from the QR code on its car.';
      return false;
    }
    const key = networkOf(ip);
    const recent = (this.attempts.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
    recent.push(now);
    // (Kept small whoever is asking: the oldest addresses are forgotten first.)
    this.attempts.delete(key);
    this.attempts.set(key, recent);
    if (this.attempts.size > 2000) this.attempts.delete(this.attempts.keys().next().value);
    this.refusal = 'Too many tries. Wait a few minutes.';
    return recent.length <= 8;
  }

  // A try that was allowed turned out to be wrong (or could have told a guesser something).
  wrongAttempt(now = Date.now()) {
    (this.wrong = this.wrong || []).push(now);
    if (this.wrong.length === WRONG_MOST) {
      console.log(`[security] ${WRONG_MOST} wrong passcodes within an hour, so signing in with a passcode is closed until they are an hour old. Devices that are signed in carry on, and a phone can still join from the QR code on its car.`);
    }
  }

  // A one-time code from a car's QR: the phone that scans it joins that car's profile.
  newPairCode(profileId) {
    const now = Date.now();
    for (const [code, entry] of this.pairCodes) if (entry.exp < now) this.pairCodes.delete(code);
    const code = b64url(crypto.randomBytes(12));
    this.pairCodes.set(code, { exp: now + PAIR_TTL_MS, profile: profileId });
    return code;
  }

  // Returns the profile to join, or null if the code is unknown, used or expired.
  claimPairCode(code) {
    const entry = this.pairCodes.get(code);
    this.pairCodes.delete(code);
    if (!entry || entry.exp <= Date.now() || !this.profile(entry.profile)) return null;
    return entry.profile;
  }
}
