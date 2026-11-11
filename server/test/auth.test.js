import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Auth, OWNER, MAX_PROFILES, MAX_REQUESTS } from '../src/auth.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'drivepost-auth-'));
}
function make(dir = tmp(), extra = {}) {
  return new Auth({ dataDir: dir, passcode: 'owner-pass', ...extra });
}
// Sign a device in and hand back a request carrying its cookie.
function signedIn(auth, profile) {
  let cookie = '';
  auth.issueCookie({ headers: {}, socket: {} }, { setHeader: (k, v) => (cookie = v.split(';')[0]) }, profile);
  return { headers: { cookie }, socket: {} };
}
const withCookie = (value) => ({ headers: { cookie: `dt_session=${value}` }, socket: {} });

test('a fresh server has one profile, opened by the passcode from .env', () => {
  const auth = make();
  assert.deepEqual(auth.listProfiles(), [{ id: 'main', name: 'Main', owner: true }]);
  assert.equal(auth.checkPasscode('owner-pass'), OWNER);
  assert.equal(auth.checkPasscode('nope'), null);
  assert.equal(auth.checkPasscode(''), null);
  assert.equal(auth.profileOf(signedIn(auth, OWNER)), OWNER);
  assert.equal(auth.profileOf({ headers: {}, socket: {} }), null);
});

test('updating a server from before profiles keeps its sign-ins and its Shortcut', () => {
  const dir = tmp();
  // What an older version left behind, and a cookie it handed out.
  const sessionSecret = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ sessionSecret, shareToken: 'old-share-token' }));
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const oldCookie = `${exp}.${crypto.createHmac('sha256', sessionSecret).update(`v1.${exp}`).digest('base64url')}`;

  const auth = make(dir);
  assert.equal(auth.profileOf(withCookie(oldCookie)), OWNER, 'the car and phones stay signed in, as the main profile');
  assert.equal(auth.shareTokenOf(OWNER), 'old-share-token');
  assert.equal(auth.shareProfile({ headers: {} }, 'old-share-token'), OWNER, 'the one-paste link still works');
  assert.equal(auth.shareProfile({ headers: { authorization: 'Bearer old-share-token' } }), OWNER, 'so does a Shortcut made with the header');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).shareToken, 'old-share-token', 'still where an older version would look');

  // An expired or made-up old cookie is still refused.
  const past = Math.floor(Date.now() / 1000) - 10;
  const expired = `${past}.${crypto.createHmac('sha256', sessionSecret).update(`v1.${past}`).digest('base64url')}`;
  assert.equal(auth.profileOf(withCookie(expired)), null);
  assert.equal(auth.profileOf(withCookie(`${exp}.forged`)), null);

  // Signing the main profile out everywhere ends the old sign-ins too.
  auth.rotateSessions(OWNER);
  assert.equal(auth.profileOf(withCookie(oldCookie)), null);
});

test('each added profile has its own passcode, which decides who signs in where', () => {
  const dir = tmp();
  const auth = make(dir);
  const maria = auth.addProfile('  Maria  ', 'maria-1234');
  const kid = auth.addProfile('Model Y', 'y-car-99');
  assert.deepEqual(auth.listProfiles().map((p) => p.name), ['Main', 'Maria', 'Model Y']);
  assert.equal(auth.checkPasscode('maria-1234'), maria);
  assert.equal(auth.checkPasscode('y-car-99'), kid);
  assert.equal(auth.checkPasscode('owner-pass'), OWNER);
  assert.equal(auth.checkPasscode('Maria-1234'), null, 'passcodes are exact');

  // Passcodes are not kept as typed.
  const saved = fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8');
  assert.ok(!saved.includes('maria-1234') && !saved.includes('y-car-99'));

  // Survives a restart.
  const again = make(dir);
  assert.equal(again.checkPasscode('maria-1234'), maria);
  assert.equal(again.profile(maria).name, 'Maria');
});

test('passcodes must be different, names are required, and there is a limit', () => {
  const auth = make();
  const a = auth.addProfile('A', 'aaaa-1');
  assert.throws(() => auth.addProfile('B', 'aaaa-1'), /already uses that passcode/);
  assert.throws(() => auth.addProfile('B', 'owner-pass'), /already uses that passcode/, "not the main profile's either");
  assert.throws(() => auth.addProfile('B', 'abc'), /at least 4/);
  assert.throws(() => auth.addProfile('   ', 'bbbb-1'), /name/);
  const b = auth.addProfile('B', 'bbbb-1');
  assert.throws(() => auth.setPasscode(b, 'aaaa-1'), /already uses/);
  auth.setPasscode(b, 'bbbb-1'); // its own passcode again is fine
  auth.setPasscode(b, 'bbbb-2');
  assert.equal(auth.checkPasscode('bbbb-1'), null);
  assert.equal(auth.checkPasscode('bbbb-2'), b);
  assert.throws(() => auth.setPasscode(OWNER, 'whatever'), /\.env/);
  assert.throws(() => auth.removeProfile(OWNER), /can't be removed/);
  auth.renameProfile(a, 'A long name that goes on and on and on');
  assert.equal(auth.profile(a).name.length, 24);
  for (let i = auth.profiles.length; i < MAX_PROFILES; i++) auth.addProfile(`P${i}`, `pass-${i}`);
  assert.throws(() => auth.addProfile('One more', 'one-more-1'), /most profiles/);
});

test('sign-ins belong to one profile and are ended one profile at a time', () => {
  const auth = make();
  const maria = auth.addProfile('Maria', 'maria-1234');
  const car = signedIn(auth, OWNER);
  const mariaCar = signedIn(auth, maria);
  const mariaPhone = signedIn(auth, maria);
  assert.equal(auth.profileOf(car), OWNER);
  assert.equal(auth.profileOf(mariaCar), maria);

  // A cookie can't be edited into another profile.
  const stolen = mariaCar.headers.cookie.replace(`p.${maria}.`, `p.${OWNER}.`);
  assert.equal(auth.profileOf({ headers: { cookie: stolen }, socket: {} }), null);

  auth.rotateSessions(maria);
  assert.equal(auth.profileOf(mariaCar), null);
  assert.equal(auth.profileOf(mariaPhone), null);
  assert.equal(auth.profileOf(car), OWNER, 'other profiles stay signed in');
  assert.equal(auth.profileOf(signedIn(auth, maria)), maria, 'and the profile can sign in again');
});

test('removing a profile ends everything that belonged to it', () => {
  const auth = make();
  const maria = auth.addProfile('Maria', 'maria-1234');
  const device = signedIn(auth, maria);
  const token = auth.shareTokenOf(maria);
  const code = auth.newPairCode(maria);
  auth.removeProfile(maria);
  assert.equal(auth.profileOf(device), null);
  assert.equal(auth.shareProfile({ headers: {} }, token), null);
  assert.equal(auth.claimPairCode(code), null);
  assert.equal(auth.checkPasscode('maria-1234'), null);
  assert.throws(() => auth.issueCookie({ headers: {}, socket: {} }, { setHeader() {} }, maria));
});

test("a phone pairs into the profile of the car that showed the code, once", () => {
  const auth = make();
  const maria = auth.addProfile('Maria', 'maria-1234');
  const mine = auth.newPairCode(OWNER);
  const hers = auth.newPairCode(maria);
  assert.equal(auth.claimPairCode(hers), maria);
  assert.equal(auth.claimPairCode(hers), null, 'a code works once');
  assert.equal(auth.claimPairCode(mine), OWNER);
  assert.equal(auth.claimPairCode('made-up'), null);
});

test('each profile has its own Send to Car link', () => {
  const auth = make(tmp(), { shareToken: 'env-token' });
  const maria = auth.addProfile('Maria', 'maria-1234');
  assert.equal(auth.shareTokenOf(OWNER), 'env-token', 'SHARE_TOKEN from .env is the main profile\'s');
  const hers = auth.shareTokenOf(maria);
  assert.notEqual(hers, 'env-token');
  assert.equal(auth.shareProfile({ headers: {} }, hers), maria);
  assert.equal(auth.shareProfile({ headers: {} }, 'env-token'), OWNER);
  assert.equal(auth.shareProfile({ headers: {} }, ''), null);
  assert.equal(auth.shareProfile({ headers: {} }, 'wrong'), null);
  const fresh = auth.rotateShareToken(maria);
  assert.equal(auth.shareProfile({ headers: {} }, hers), null, 'the old link stops working');
  assert.equal(auth.shareProfile({ headers: {} }, fresh), maria);
  assert.equal(auth.shareProfile({ headers: {} }, 'env-token'), OWNER, 'the other profile\'s link is untouched');
});

// ---- asking for a profile from the sign-in page ----

test('a new passcode opens nothing until the main profile allows it', () => {
  const dir = tmp();
  const auth = make(dir);
  assert.equal(auth.canAsk(), true);
  const asked = auth.askForProfile('  Maria ', 'maria-1234');
  assert.equal(asked.name, 'Maria');
  assert.match(asked.code, /^[1-9]\d\d$/, 'a three-digit number to compare on both screens');
  assert.deepEqual(Object.keys(asked).sort(), ['at', 'code', 'id', 'name'], 'nothing about the passcode leaves the server');
  assert.equal(auth.checkPasscode('maria-1234'), null, 'waiting is not signed in');
  assert.deepEqual(auth.listProfiles().map((p) => p.name), ['Main']);
  assert.equal(auth.requestFor('maria-1234').id, asked.id);
  assert.equal(auth.requestFor('maria-12345'), null);
  assert.deepEqual(auth.listRequests(), [asked]);

  // Kept across a restart, and never as typed.
  assert.ok(!fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8').includes('maria-1234'));
  const again = make(dir);
  assert.deepEqual(again.listRequests(), [asked]);

  const id = again.approveRequest(asked.id);
  assert.equal(again.checkPasscode('maria-1234'), id, 'the passcode they chose now signs them in');
  assert.equal(again.profile(id).name, 'Maria');
  assert.ok(again.shareTokenOf(id), 'with a Send to Car link of their own');
  assert.deepEqual(again.listRequests(), []);
  assert.equal(again.requestById(asked.id), null);
  assert.throws(() => again.approveRequest(asked.id), /gone/, 'a request is answered once');
});

test('declined and cancelled requests leave nothing behind', () => {
  const auth = make();
  const asked = auth.askForProfile('Stranger', 'let-me-in');
  assert.equal(auth.dropRequest(asked.id).name, 'Stranger');
  assert.equal(auth.dropRequest(asked.id), null);
  assert.equal(auth.requestFor('let-me-in'), null);
  assert.equal(auth.checkPasscode('let-me-in'), null);
  assert.throws(() => auth.approveRequest(asked.id), /gone/);
  assert.deepEqual(auth.listProfiles().map((p) => p.name), ['Main']);
});

test('asking again with the same passcode is the same request', () => {
  const auth = make();
  const first = auth.askForProfile('Maria', 'maria-1234');
  const second = auth.askForProfile('Maria again', 'maria-1234');
  assert.deepEqual(second, first);
  assert.equal(auth.listRequests().length, 1);
});

test('requests are checked and limited', () => {
  const auth = make();
  const taken = auth.addProfile('Kid', 'kid-pass-1');
  assert.throws(() => auth.askForProfile('X', 'owner-pass'), /already opens a profile/);
  assert.throws(() => auth.askForProfile('X', 'kid-pass-1'), /already opens a profile/);
  assert.throws(() => auth.askForProfile('X', 'abc'), /at least 4/);
  assert.throws(() => auth.askForProfile('X', 'x'.repeat(101)), /too long/);
  assert.throws(() => auth.askForProfile('   ', 'fine-pass'), /name/);
  assert.equal(auth.askForProfile('Line\nbreak\u0007 and a very long name indeed', 'fine-pass').name, 'Line break and a very lo', 'names are plain, short text');

  // The owner can't hand out a passcode someone is waiting with.
  assert.throws(() => auth.addProfile('Other', 'fine-pass'), /waiting for your OK/);
  assert.throws(() => auth.setPasscode(taken, 'fine-pass'), /waiting for your OK/);

  for (let i = auth.listRequests().length; i < MAX_REQUESTS; i++) auth.askForProfile(`P${i}`, `pass-${i}`);
  assert.equal(new Set(auth.listRequests().map((r) => r.code)).size, MAX_REQUESTS, 'every waiting request has its own number');
  assert.throws(() => auth.askForProfile('One more', 'one-more-1'), /already waiting/);
  assert.equal(auth.askForProfile('P1 back', 'pass-1').name, 'P1', 'someone already waiting can still look theirs up');
});

test('asking can be switched off, and stays off', () => {
  const dir = tmp();
  const auth = make(dir);
  const waiting = auth.askForProfile('Early', 'early-1234');
  auth.setAllowRequests(false);
  assert.equal(auth.canAsk(), false);
  assert.throws(() => auth.askForProfile('Late', 'late-1234'), /isn't taking requests/);
  const again = make(dir);
  assert.equal(again.canAsk(), false);
  assert.equal(again.approveRequest(waiting.id).length, 10, 'someone who asked before can still be allowed');
  again.setAllowRequests(true);
  assert.equal(make(dir).canAsk(), true);
});

test('a full server takes no requests, and old requests run out', () => {
  const auth = make();
  const early = auth.askForProfile('Early', 'early-1234');
  for (let i = auth.profiles.length; i < MAX_PROFILES; i++) auth.addProfile(`P${i}`, `pass-${i}`);
  assert.equal(auth.canAsk(), false);
  assert.throws(() => auth.askForProfile('Late', 'late-1234'), /no room/);
  assert.throws(() => auth.approveRequest(early.id), /most profiles/);
  assert.equal(auth.listRequests().length, 1, 'the request waits for room');

  // After a week without an answer, a request is dropped.
  auth.requests[0].at = Date.now() - 8 * 24 * 60 * 60 * 1000;
  assert.deepEqual(auth.listRequests(), []);
  assert.equal(auth.requestFor('early-1234'), null);
  assert.throws(() => auth.approveRequest(early.id), /gone/);
});

test('a server from before requests existed starts with none and takes them', () => {
  const dir = tmp();
  const first = make(dir);
  first.addProfile('Maria', 'maria-1234');
  // What the previous version wrote: profiles only.
  fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify({ profiles: first.profiles }));
  const auth = make(dir);
  assert.deepEqual(auth.listRequests(), []);
  assert.equal(auth.canAsk(), true);
  assert.equal(auth.listProfiles().length, 2);
});
