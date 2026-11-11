import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Auth, ORIGINAL, MAX_PROFILES, MAX_REQUESTS } from '../src/auth.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'drivepost-auth-'));
}
// 'server-pass' stands for DRIVE_PASSCODE, the server's own passcode.
function make(dir = tmp(), extra = {}) {
  return new Auth({ dataDir: dir, passcode: 'server-pass', ...extra });
}
// A data folder as a server from before profiles existed left it: one secret
// that signed its car and phones in, and its Shortcut's token.
function oldServer(dir = tmp()) {
  const sessionSecret = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ sessionSecret, shareToken: 'old-share-token' }));
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const cookie = `${exp}.${crypto.createHmac('sha256', sessionSecret).update(`v1.${exp}`).digest('base64url')}`;
  return { dir, sessionSecret, exp, cookie };
}
// Sign a device in and hand back a request carrying its cookie.
function signedIn(auth, profile) {
  let cookie = '';
  auth.issueCookie({ headers: {}, socket: {} }, { setHeader: (k, v) => (cookie = v.split(';')[0]) }, profile);
  return { headers: { cookie }, socket: {} };
}
const withCookie = (value) => ({ headers: { cookie: `dt_session=${value}` }, socket: {} });

test('a fresh server has no profiles, and the passcode from .env opens none', () => {
  const dir = tmp();
  const auth = make(dir);
  assert.deepEqual(auth.listProfiles(), []);
  assert.equal(auth.checkPasscode('server-pass'), null, "the server's passcode is not a profile's");
  assert.equal(auth.checkAdminPasscode('server-pass'), true, 'it opens Admin');
  assert.equal(auth.checkPasscode('nope'), null);
  assert.equal(auth.checkPasscode(''), null);
  assert.equal(auth.profileOf({ headers: {}, socket: {} }), null);
  assert.deepEqual(make(dir).listProfiles(), [], 'and none appears on a restart');
});

test('a server from before profiles keeps its car, phones and Shortcut as a profile called Main', () => {
  const old = oldServer();
  const auth = make(old.dir);
  assert.deepEqual(auth.listProfiles(), [{ id: ORIGINAL, name: 'Main', hasPasscode: false }]);
  assert.equal(auth.profileOf(withCookie(old.cookie)), ORIGINAL, 'the car and phones stay signed in');
  assert.equal(auth.shareTokenOf(ORIGINAL), 'old-share-token');
  assert.equal(auth.shareProfile({ headers: {} }, 'old-share-token'), ORIGINAL, 'the one-paste link still works');
  assert.equal(auth.shareProfile({ headers: { authorization: 'Bearer old-share-token' } }), ORIGINAL, 'so does a Shortcut made with the header');
  assert.equal(JSON.parse(fs.readFileSync(path.join(old.dir, 'secrets.json'), 'utf8')).shareToken, 'old-share-token', 'still where an older version would look');
  assert.equal(auth.checkPasscode('server-pass'), null, 'but the passcode from .env no longer signs anything in to it');

  // An expired or made-up old cookie is still refused.
  const past = Math.floor(Date.now() / 1000) - 10;
  const expired = `${past}.${crypto.createHmac('sha256', old.sessionSecret).update(`v1.${past}`).digest('base64url')}`;
  assert.equal(auth.profileOf(withCookie(expired)), null);
  assert.equal(auth.profileOf(withCookie(`${old.exp}.forged`)), null);

  // Signing it out everywhere ends the old sign-ins too.
  auth.rotateSessions(ORIGINAL);
  assert.equal(auth.profileOf(withCookie(old.cookie)), null);
});

test('the profile from before profiles is an ordinary one: it can get a passcode, or be removed for good', () => {
  const old = oldServer();
  const auth = make(old.dir);
  const car = signedIn(auth, ORIGINAL);
  auth.setPasscode(ORIGINAL, 'my-new-pass');
  assert.equal(auth.checkPasscode('my-new-pass'), ORIGINAL);
  assert.deepEqual(auth.listProfiles(), [{ id: ORIGINAL, name: 'Main', hasPasscode: true }]);
  assert.equal(auth.profileOf(car), ORIGINAL, 'devices already on it stay signed in');
  auth.renameProfile(ORIGINAL, 'Greg');
  assert.equal(auth.profile(ORIGINAL).name, 'Greg');

  auth.removeProfile(ORIGINAL);
  assert.deepEqual(auth.listProfiles(), []);
  assert.equal(auth.profileOf(car), null);
  assert.equal(auth.profileOf(withCookie(old.cookie)), null);
  assert.equal(auth.shareProfile({ headers: {} }, 'old-share-token'), null);
  assert.equal(auth.checkPasscode('my-new-pass'), null);
  assert.deepEqual(make(old.dir).listProfiles(), [], "it doesn't come back on a restart");
});

test('each profile has its own passcode, which decides who signs in where', () => {
  const dir = tmp();
  const auth = make(dir);
  const maria = auth.addProfile('  Maria  ', 'maria-1234');
  const kid = auth.addProfile('Model Y', 'y-car-99');
  assert.deepEqual(auth.listProfiles().map((p) => p.name), ['Maria', 'Model Y']);
  assert.equal(auth.checkPasscode('maria-1234'), maria);
  assert.equal(auth.checkPasscode('y-car-99'), kid);
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
  assert.throws(() => auth.addProfile('B', 'server-pass'), /can't be used for a profile/, "the server's own passcode is for Admin only");
  assert.throws(() => auth.addProfile('B', 'abc'), /at least 4/);
  assert.throws(() => auth.addProfile('   ', 'bbbb-1'), /name/);
  const b = auth.addProfile('B', 'bbbb-1');
  assert.throws(() => auth.setPasscode(b, 'aaaa-1'), /already uses/);
  assert.throws(() => auth.setPasscode(b, 'server-pass'), /can't be used for a profile/);
  auth.setPasscode(b, 'bbbb-1'); // its own passcode again is fine
  auth.setPasscode(b, 'bbbb-2');
  assert.equal(auth.checkPasscode('bbbb-1'), null);
  assert.equal(auth.checkPasscode('bbbb-2'), b);
  auth.renameProfile(a, 'A long name that goes on and on and on');
  assert.equal(auth.profile(a).name.length, 24);
  for (let i = auth.profiles.length; i < MAX_PROFILES; i++) auth.addProfile(`P${i}`, `pass-${i}`);
  assert.throws(() => auth.addProfile('One more', 'one-more-1'), /most profiles/);
});

test('sign-ins belong to one profile and are ended one profile at a time', () => {
  const auth = make();
  const greg = auth.addProfile('Greg', 'greg-1234');
  const maria = auth.addProfile('Maria', 'maria-1234');
  const car = signedIn(auth, greg);
  const mariaCar = signedIn(auth, maria);
  const mariaPhone = signedIn(auth, maria);
  assert.equal(auth.profileOf(car), greg);
  assert.equal(auth.profileOf(mariaCar), maria);

  // A cookie can't be edited into another profile.
  const stolen = mariaCar.headers.cookie.replace(`p.${maria}.`, `p.${greg}.`);
  assert.equal(auth.profileOf({ headers: { cookie: stolen }, socket: {} }), null);

  auth.rotateSessions(maria);
  assert.equal(auth.profileOf(mariaCar), null);
  assert.equal(auth.profileOf(mariaPhone), null);
  assert.equal(auth.profileOf(car), greg, 'other profiles stay signed in');
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
  assert.throws(() => auth.removeProfile(maria), /No such profile/);
});

test("a phone pairs into the profile of the car that showed the code, once", () => {
  const auth = make();
  const greg = auth.addProfile('Greg', 'greg-1234');
  const maria = auth.addProfile('Maria', 'maria-1234');
  const mine = auth.newPairCode(greg);
  const hers = auth.newPairCode(maria);
  assert.equal(auth.claimPairCode(hers), maria);
  assert.equal(auth.claimPairCode(hers), null, 'a code works once');
  assert.equal(auth.claimPairCode(mine), greg);
  assert.equal(auth.claimPairCode('made-up'), null);
});

test('each profile has its own Send to Car link', () => {
  const old = oldServer();
  const auth = make(old.dir, { shareToken: 'env-token' });
  const maria = auth.addProfile('Maria', 'maria-1234');
  assert.equal(auth.shareTokenOf(ORIGINAL), 'env-token', "SHARE_TOKEN from .env is the original profile's, as before");
  const hers = auth.shareTokenOf(maria);
  assert.notEqual(hers, 'env-token');
  assert.equal(auth.shareProfile({ headers: {} }, hers), maria);
  assert.equal(auth.shareProfile({ headers: {} }, 'env-token'), ORIGINAL);
  assert.equal(auth.shareProfile({ headers: {} }, ''), null);
  assert.equal(auth.shareProfile({ headers: {} }, 'wrong'), null);
  const fresh = auth.rotateShareToken(maria);
  assert.equal(auth.shareProfile({ headers: {} }, hers), null, 'the old link stops working');
  assert.equal(auth.shareProfile({ headers: {} }, fresh), maria);
  assert.equal(auth.shareProfile({ headers: {} }, 'env-token'), ORIGINAL, "the other profile's link is untouched");

  // A server set up since profiles has no original profile for SHARE_TOKEN to go to.
  assert.deepEqual(make(tmp(), { shareToken: 'env-token' }).listProfiles(), []);
});

test('SHARE_TOKEN from .env is only carried over once, so a new share token sticks', () => {
  const old = oldServer();
  const first = make(old.dir, { shareToken: 'env-token' });
  assert.equal(first.shareTokenOf(ORIGINAL), 'env-token');
  const fresh = first.rotateShareToken(ORIGINAL);
  assert.notEqual(fresh, 'env-token');

  // After a restart with the same .env, the new token is still the one that works.
  const again = make(old.dir, { shareToken: 'env-token' });
  assert.equal(again.shareTokenOf(ORIGINAL), fresh);
  assert.equal(again.shareProfile({ headers: {} }, 'env-token'), null, 'the replaced token stays dead');
  assert.equal(again.shareProfile({ headers: {} }, fresh), ORIGINAL);

  // Changing or removing the line later makes no difference either.
  assert.equal(make(old.dir, { shareToken: 'something-else' }).shareTokenOf(ORIGINAL), fresh);
  assert.equal(make(old.dir).shareTokenOf(ORIGINAL), fresh);
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
  assert.deepEqual(auth.listProfiles(), []);
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
  assert.deepEqual(auth.listProfiles(), []);
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
  assert.throws(() => auth.askForProfile('X', 'server-pass'), /can't be used for a profile/, "nobody gets a profile with the server's own passcode");
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
  const first = make(oldServer(dir).dir);
  first.addProfile('Maria', 'maria-1234');
  // What the previous version wrote: profiles only.
  fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify({ profiles: first.profiles }));
  const auth = make(dir);
  assert.deepEqual(auth.listRequests(), []);
  assert.equal(auth.canAsk(), true);
  assert.deepEqual(auth.listProfiles().map((p) => p.name), ['Main', 'Maria']);
});

// ---- the Admin page ----

// Type the server's passcode on a device and hand back a request carrying what it was given.
function adminSignedIn(auth, also = '') {
  let cookie = '';
  auth.issueAdminCookie({ headers: {}, socket: {} }, { setHeader: (k, v) => (cookie = v.split(';')[0]) });
  return { headers: { cookie: [cookie, also].filter(Boolean).join('; ') }, socket: {} };
}

test('Admin takes the passcode from .env, and a profile sign-in is not enough', () => {
  const dir = oldServer().dir;
  const auth = make(dir);
  const maria = auth.addProfile('Maria', 'maria-1234');
  assert.equal(auth.checkAdminPasscode('server-pass'), true);
  assert.equal(auth.checkAdminPasscode('maria-1234'), false, "another profile's passcode doesn't open Admin");
  assert.equal(auth.checkAdminPasscode(''), false);
  assert.equal(auth.checkAdminPasscode(undefined), false);

  // Signed in to a profile, even the one from before profiles, is not signed in to Admin.
  const car = signedIn(auth, ORIGINAL);
  assert.equal(auth.profileOf(car), ORIGINAL);
  assert.equal(auth.isAdmin(car), false);
  assert.equal(auth.isAdmin(signedIn(auth, maria)), false);
  assert.equal(auth.isAdmin({ headers: {}, socket: {} }), false);

  // Admin works from any device, whatever profile it's on, and doesn't change that profile.
  const laptop = adminSignedIn(auth);
  assert.equal(auth.isAdmin(laptop), true);
  assert.equal(auth.profileOf(laptop), null, 'Admin alone opens no profile');
  const mariasPhone = adminSignedIn(auth, signedIn(auth, maria).headers.cookie);
  assert.equal(auth.isAdmin(mariasPhone), true);
  assert.equal(auth.profileOf(mariasPhone), maria);

  // It can't be made up or stretched.
  const [name, value] = laptop.headers.cookie.split('=');
  const [exp, sig] = value.split('.');
  assert.equal(auth.isAdmin({ headers: { cookie: `${name}=${Number(exp) + 1000}.${sig}` }, socket: {} }), false);
  assert.equal(auth.isAdmin({ headers: { cookie: `${name}=${exp}.forged` }, socket: {} }), false);
  assert.equal(auth.isAdmin({ headers: { cookie: `${name}=1.${auth.adminSig(1)}` }, socket: {} }), false, 'run out');

  // Survives a restart; changing DRIVE_PASSCODE signs every device out of Admin.
  assert.equal(make(dir).isAdmin(laptop), true);
  const changed = new Auth({ dataDir: dir, passcode: 'a-new-passcode' });
  assert.equal(changed.isAdmin(laptop), false);
  assert.equal(changed.profileOf(car), ORIGINAL, 'profile sign-ins are not affected');
});

test('signing in to a profile and to Admin in one answer keeps both', () => {
  const auth = make();
  const greg = auth.addProfile('Greg', 'greg-1234');
  const headers = {};
  const res = { getHeader: (k) => headers[k], setHeader: (k, v) => (headers[k] = v) };
  auth.issueCookie({ headers: {}, socket: {} }, res, greg);
  auth.issueAdminCookie({ headers: {}, socket: {} }, res);
  assert.equal(headers['Set-Cookie'].length, 2);
  const cookie = headers['Set-Cookie'].map((c) => c.split(';')[0]).join('; ');
  const req = { headers: { cookie }, socket: {} };
  assert.equal(auth.profileOf(req), greg);
  assert.equal(auth.isAdmin(req), true);
});
