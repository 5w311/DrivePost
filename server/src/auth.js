import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const COOKIE = 'dt_session';
const SESSION_DAYS = 400;
const PAIR_TTL_MS = 10 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
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

function isHttps(req, publicUrl) {
  if ((req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
  return publicUrl.startsWith('https://');
}

export class Auth {
  constructor({ dataDir, passcode, shareToken, publicUrl }) {
    this.file = path.join(dataDir, 'secrets.json');
    this.passcode = passcode;
    this.publicUrl = publicUrl;
    this.pairCodes = new Map();
    this.attempts = new Map();

    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {}
    this.secrets = {
      sessionSecret: saved.sessionSecret || b64url(crypto.randomBytes(32)),
      shareToken: shareToken || saved.shareToken || b64url(crypto.randomBytes(24)),
    };
    this.persist();
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.secrets, null, 2), { mode: 0o600 });
  }

  get shareToken() {
    return this.secrets.shareToken;
  }

  sign(exp) {
    return crypto.createHmac('sha256', this.secrets.sessionSecret).update(`v1.${exp}`).digest('base64url');
  }

  issueCookie(req, res) {
    const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
    const value = `${exp}.${this.sign(exp)}`;
    const parts = [
      `${COOKIE}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${SESSION_DAYS * 86400}`,
    ];
    if (isHttps(req, this.publicUrl)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  clearCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  isAuthed(req) {
    const value = parseCookies(req.headers.cookie)[COOKIE];
    if (!value) return false;
    const [expStr, sig] = value.split('.');
    const exp = parseInt(expStr, 10);
    if (!exp || !sig || exp < Date.now() / 1000) return false;
    return safeEqual(sig, this.sign(exp));
  }

  hasShareToken(req) {
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    return !!m && safeEqual(m[1].trim(), this.secrets.shareToken);
  }

  // Signing out everywhere: every existing cookie stops verifying.
  rotateSessions() {
    this.secrets.sessionSecret = b64url(crypto.randomBytes(32));
    this.persist();
  }

  rotateShareToken() {
    this.secrets.shareToken = b64url(crypto.randomBytes(24));
    this.persist();
    return this.secrets.shareToken;
  }

  // Returns true if the attempt is allowed (8 tries per 10 minutes per IP).
  allowAttempt(ip) {
    const now = Date.now();
    const recent = (this.attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
    recent.push(now);
    this.attempts.set(ip, recent);
    return recent.length <= 8;
  }

  checkPasscode(input) {
    return !!this.passcode && safeEqual(String(input || ''), this.passcode);
  }

  newPairCode() {
    const now = Date.now();
    for (const [code, exp] of this.pairCodes) if (exp < now) this.pairCodes.delete(code);
    const code = b64url(crypto.randomBytes(12));
    this.pairCodes.set(code, now + PAIR_TTL_MS);
    return code;
  }

  claimPairCode(code) {
    const exp = this.pairCodes.get(code);
    this.pairCodes.delete(code);
    return !!exp && exp > Date.now();
  }
}
