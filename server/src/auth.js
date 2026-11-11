import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/*
 * Sign-in and profiles.
 *
 * A profile is one person's (or one car's) own copy of everything: what's
 * playing, Up Next, history, settings, paired phones and Send to Car link.
 * Which profile a device is in is decided by the passcode it signed in with.
 *
 * The first profile, "main", belongs to whoever runs the server. Its passcode
 * is DRIVE_PASSCODE from .env, as it always was. It can add profiles for
 * other people, each with a passcode of its own.
 */

const COOKIE = 'dt_session';
const SESSION_DAYS = 400;
const PAIR_TTL_MS = 10 * 60 * 1000;
export const OWNER = 'main';
export const MAX_PROFILES = 12;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Passcodes of added profiles are kept scrambled, not as typed.
function scramble(passcode, salt) {
  return crypto.scryptSync(String(passcode), Buffer.from(salt, 'base64url'), 32).toString('base64url');
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
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

// Only mark the cookie https-only when this request really came over https
// (through the tunnel). Testing on the home network over http keeps working.
function isHttps(req) {
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
    try {
      const data = JSON.parse(fs.readFileSync(this.profilesFile, 'utf8'));
      if (Array.isArray(data.profiles)) profiles = data.profiles.filter((p) => p && typeof p.id === 'string');
    } catch {}
    let owner = profiles.find((p) => p.id === OWNER);
    if (!owner) {
      // First start with profiles: the one profile there always was becomes
      // "main", and keeps its share token so its Shortcut carries on working.
      owner = { id: OWNER, name: 'Main', epoch: 0, shareToken: saved.shareToken || b64url(crypto.randomBytes(24)) };
      profiles.unshift(owner);
    }
    if (shareToken) owner.shareToken = shareToken; // SHARE_TOKEN in .env wins, as before
    this.profiles = profiles;
    this.persist();
  }

  persist() {
    // The main profile's share token is also kept where older versions look for it.
    const owner = this.profiles.find((p) => p.id === OWNER);
    this.secrets.shareToken = owner.shareToken;
    fs.writeFileSync(this.file, JSON.stringify(this.secrets, null, 2), { mode: 0o600 });
    fs.writeFileSync(this.profilesFile, JSON.stringify({ profiles: this.profiles }, null, 2), { mode: 0o600 });
  }

  // ---- profiles ----

  profile(id) {
    return this.profiles.find((p) => p.id === id) || null;
  }

  // What may be shown on screen: no passcodes, no tokens.
  listProfiles() {
    return this.profiles.map((p) => ({ id: p.id, name: p.name, owner: p.id === OWNER }));
  }

  cleanName(name) {
    const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!n) throw new Error('Give the profile a name.');
    return n;
  }

  // Which profile, if any, has this passcode.
  checkPasscode(input) {
    const typed = String(input || '');
    if (!typed) return null;
    if (this.passcode && safeEqual(typed, this.passcode)) return OWNER;
    for (const p of this.profiles) {
      if (p.pass && safeEqual(scramble(typed, p.pass.salt), p.pass.hash)) return p.id;
    }
    return null;
  }

  checkNewPasscode(passcode, exceptId) {
    const typed = String(passcode || '');
    if (typed.length < 4) throw new Error('Use a passcode of at least 4 characters.');
    if (typed.length > 100) throw new Error('That passcode is too long.');
    // The passcode is what tells profiles apart, so no two can share one.
    const taken = this.checkPasscode(typed);
    if (taken && taken !== exceptId) throw new Error('Another profile already uses that passcode. Pick a different one.');
    return typed;
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
    if (id === OWNER) throw new Error("The main profile's passcode is DRIVE_PASSCODE in the .env file.");
    const typed = this.checkNewPasscode(passcode, id);
    const salt = b64url(crypto.randomBytes(16));
    p.pass = { salt, hash: scramble(typed, salt) };
    this.persist();
  }

  removeProfile(id) {
    if (id === OWNER) throw new Error("The main profile can't be removed.");
    const i = this.profiles.findIndex((p) => p.id === id);
    if (i < 0) throw new Error('No such profile.');
    this.profiles.splice(i, 1);
    for (const [code, entry] of this.pairCodes) if (entry.profile === id) this.pairCodes.delete(code);
    this.persist();
  }

  // ---- sessions ----

  sign(text) {
    return crypto.createHmac('sha256', this.secrets.sessionSecret).update(text).digest('base64url');
  }

  issueCookie(req, res, profileId = OWNER) {
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
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  clearCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
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
    // A sign-in from before profiles existed belongs to the main profile,
    // until that profile signs out everywhere.
    if (parts.length === 2) {
      const [expStr, sig] = parts;
      const exp = parseInt(expStr, 10);
      const owner = this.profile(OWNER);
      if (!exp || exp < now || !owner || owner.epoch !== 0) return null;
      return safeEqual(sig, this.sign(`v1.${exp}`)) ? OWNER : null;
    }
    return null;
  }

  // Signing out everywhere: every existing sign-in to this profile stops working.
  rotateSessions(profileId = OWNER) {
    const p = this.profile(profileId);
    if (!p) return;
    p.epoch = (p.epoch || 0) + 1;
    this.persist();
  }

  // ---- share tokens (the iPhone Shortcut) ----

  shareTokenOf(profileId = OWNER) {
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

  rotateShareToken(profileId = OWNER) {
    const p = this.profile(profileId);
    if (!p) throw new Error('No such profile.');
    p.shareToken = b64url(crypto.randomBytes(24));
    this.persist();
    return p.shareToken;
  }

  // ---- sign-in attempts and phone pairing ----

  // Returns true if the attempt is allowed (8 tries per 10 minutes per IP).
  allowAttempt(ip) {
    const now = Date.now();
    const recent = (this.attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
    recent.push(now);
    this.attempts.set(ip, recent);
    return recent.length <= 8;
  }

  // A one-time code from a car's QR: the phone that scans it joins that car's profile.
  newPairCode(profileId = OWNER) {
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
