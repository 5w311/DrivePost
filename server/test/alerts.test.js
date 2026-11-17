import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Alerts, cleanAddress, newTopic, post } from '../src/alerts.js';

const quiet = { log() {}, warn() {} };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drivepost-alerts-')), 'alerts.json');

// A server with one thing to keep an eye on (`ok` says how it is doing), a clock that is moved by hand, and a phone that keeps what it is sent.
function world({ after = 2, every = 300000, recheck, checks } = {}) {
  const w = { t: 1_000_000, ok: true, words: 'It broke.', sent: [], fetched: [], sendFails: false };
  w.alerts = new Alerts({
    file: tmp(),
    now: () => w.t,
    log: quiet,
    allowed: async () => {},
    send: async (to, words, opts) => {
      if (w.sendFails) throw new Error('the address answered 500');
      w.sent.push({ to, words, ...opts });
    },
    fetchImpl: async (url) => {
      w.fetched.push(url);
      return { ok: true, status: 200 };
    },
    checks: checks || { thing: { label: 'the thing', every, recheck, after, look: async () => (w.ok === null ? null : w.ok ? { ok: true } : { ok: false, words: w.words }) } },
  });
  w.alerts.set({ to: 'https://ntfy.example/topic' });
  w.pass = async (ms) => {
    w.t += ms;
    await w.alerts.tick();
  };
  return w;
}

test('where alerts go has to be an address a message can be sent to', () => {
  assert.equal(cleanAddress(' https://ntfy.sh/my-topic '), 'https://ntfy.sh/my-topic');
  assert.equal(cleanAddress('http://ntfy.lan:8080/car'), 'http://ntfy.lan:8080/car');
  assert.equal(cleanAddress(''), '');
  assert.equal(cleanAddress(undefined), '');
  for (const bad of ['ntfy.sh/topic', 'ftp://example.com/x', 'javascript:alert(1)', 'https://user:pw@example.com/x', 'https://' + 'a'.repeat(400) + '.com/']) {
    assert.throws(() => cleanAddress(bad), /address/, bad);
  }
  const topic = newTopic();
  assert.match(topic, /^https:\/\/ntfy\.sh\/drivepost-[a-z0-9]{16}$/);
  assert.notEqual(topic, newTopic(), 'a name nobody would guess, new each time');
});

test('a message is a line of text posted to the address, with what the ntfy app shows it by', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, ...opts });
    return { ok: true, status: 200 };
  };
  await post('https://ntfy.example/topic', "The tunnel may be down.", { urgent: true }, { fetch: fetchImpl, allowed: async () => {} });
  assert.equal(calls[0].url, 'https://ntfy.example/topic');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, 'The tunnel may be down.');
  assert.equal(calls[0].headers.Title, 'DrivePost');
  assert.equal(calls[0].headers.Priority, 'high');
  assert.equal(calls[0].redirect, 'error', 'it goes where it was sent, or nowhere');
  await post('https://ntfy.example/topic', 'Back to normal.', { good: true }, { fetch: fetchImpl, allowed: async () => {} });
  assert.equal(calls[1].headers.Priority, 'default');
  assert.equal(calls[1].headers.Tags, 'white_check_mark');
  // An address on the server's own network is refused like any other link to one (links.js), before anything is sent.
  let sent = 0;
  await assert.rejects(post('http://192.168.1.1/x', 'hello', {}, { fetch: async () => { sent++; }, allowed: async () => { throw new Error('That address is on this server\'s own network.'); } }), /own network/);
  assert.equal(sent, 0);
  await assert.rejects(post('https://ntfy.example/topic', 'x', {}, { fetch: async () => ({ ok: false, status: 404 }), allowed: async () => {} }), /answered 404/);
  await assert.rejects(post('https://ntfy.example/topic', 'x', {}, { fetch: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }, allowed: async () => {} }), /couldn't be sent \(ENOTFOUND\)/);
});

test('one bad look is not news: trouble is said once it has lasted, once, and again when it is over', async () => {
  const w = world();
  await w.pass(300000);
  assert.deepEqual(w.sent, []);
  assert.equal(w.alerts.view().checks[0].state, 'ok');
  w.ok = false;
  await w.pass(300000);
  assert.deepEqual(w.sent, [], 'a first bad look is looked at again before anything is said');
  assert.equal(w.alerts.view().checks[0].state, 'unsure');
  await w.pass(300000);
  assert.equal(w.sent.length, 1);
  assert.deepEqual(w.sent[0], { to: 'https://ntfy.example/topic', words: 'It broke.', urgent: true });
  assert.equal(w.alerts.view().checks[0].state, 'bad');
  assert.equal(w.alerts.view().checks[0].words, 'It broke.');
  // It stays broken for hours: nothing more is said...
  for (let i = 0; i < 40; i++) await w.pass(300000);
  assert.equal(w.sent.length, 1);
  // ...until a day has gone by.
  for (let i = 0; i < 260; i++) await w.pass(300000);
  assert.equal(w.sent.length, 2);
  assert.equal(w.sent[1].words, 'Still so: It broke.');
  // Mended.
  w.ok = true;
  await w.pass(300000);
  assert.equal(w.sent.length, 3);
  assert.deepEqual(w.sent[2], { to: 'https://ntfy.example/topic', words: 'Back to normal: the thing.', good: true });
  await w.pass(300000);
  assert.equal(w.sent.length, 3);
  // A hiccup that is gone by the second look is never mentioned, either way.
  w.ok = false;
  await w.pass(300000);
  w.ok = true;
  await w.pass(300000);
  assert.equal(w.sent.length, 3);
});

test('a check that came back bad is looked at again sooner, and each check keeps its own time', async () => {
  let looks = 0;
  const w = world({ checks: null });
  const slow = new Alerts({
    file: tmp(), now: () => w.t, log: quiet, send: async (to, words) => w.sent.push(words),
    checks: { youtube: { label: 'getting videos from YouTube', every: 3 * 3600000, recheck: 900000, after: 2, look: async () => { looks++; return w.ok ? { ok: true } : { ok: false, words: 'No videos.' }; } } },
  });
  slow.set({ to: 'https://ntfy.example/t' });
  w.sent.length = 0;
  const pass = async (ms) => { w.t += ms; await slow.tick(); };
  await pass(60000);
  assert.equal(looks, 1, 'looked at when the server starts');
  await pass(3600000);
  assert.equal(looks, 1, 'and not again for three hours');
  w.ok = false;
  await pass(2 * 3600000);
  assert.equal(looks, 2);
  assert.deepEqual(w.sent, []);
  await pass(600000);
  assert.equal(looks, 2, 'ten minutes on: not yet');
  await pass(300000);
  assert.equal(looks, 3, 'a quarter of an hour on: looked at again');
  assert.deepEqual(w.sent, ['No videos.']);
  await pass(900000);
  assert.equal(looks, 3, 'known to be broken, it goes back to its usual round');
});

test('something that is not set up is neither working nor broken, and a check that fails to run says so', async () => {
  const w = world({ after: 1 });
  w.ok = null;
  await w.pass(300000);
  assert.equal(w.alerts.view().checks[0].state, 'unset');
  assert.deepEqual(w.sent, []);
  // Nor is something there is no way to tell about from here; Admin says why.
  const gated = new Alerts({
    file: tmp(), now: () => w.t, log: quiet, send: async (to, words) => w.sent.push(words),
    checks: { outside: { label: 'reaching it', unset: 'Not set.', every: 1000, after: 1, look: async () => ({ skip: 'It answers 302.' }) } },
  });
  gated.set({ to: 'https://ntfy.example/t' });
  w.t += 5000;
  await gated.tick();
  assert.deepEqual(gated.view().checks[0], { name: 'outside', label: 'reaching it', state: 'unset', words: 'It answers 302.', since: 0 });
  assert.deepEqual(w.sent, []);
  const broken = new Alerts({
    file: tmp(), now: () => w.t, log: quiet, send: async (to, words) => w.sent.push(words),
    checks: { disk: { label: 'room on the disk', every: 1000, after: 1, look: async () => { throw new Error('ENOENT: no such file'); } } },
  });
  broken.set({ to: 'https://ntfy.example/t' });
  w.t += 5000;
  await broken.tick();
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0], /room on the disk: the check itself failed \(ENOENT/);
});

test('with nowhere to send them, troubles are only kept for Admin to show; a message that does not go is remembered as such', async () => {
  const w = world({ after: 1 });
  w.alerts.set({ to: '' });
  w.ok = false;
  await w.pass(300000);
  assert.deepEqual(w.sent, []);
  assert.equal(w.alerts.view().checks[0].state, 'bad');
  assert.equal(w.alerts.view().sent, null);
  // A phone is named later: the next thing worth saying goes to it.
  w.alerts.set({ to: 'https://ntfy.example/topic' });
  w.sendFails = true;
  w.ok = true;
  await w.pass(300000);
  assert.equal(w.alerts.view().sent.ok, false);
  assert.match(w.alerts.view().sent.error, /answered 500/);
  assert.equal(await w.alerts.say('A test.'), false);
  w.sendFails = false;
  assert.equal(await w.alerts.say('A test.'), true);
  assert.equal(w.sent[w.sent.length - 1].words, 'A test.');
});

test('the heartbeat is fetched every five minutes while all is well, and not while the server cannot be reached from outside', async () => {
  const w = world({ checks: null });
  let reachable = true;
  const a = new Alerts({
    file: tmp(), now: () => w.t, log: quiet, allowed: async () => {}, send: async () => {},
    fetchImpl: async (url) => { w.fetched.push(url); return { ok: true, status: 200 }; },
    checks: { outside: { label: 'reaching DrivePost at its public address', every: 300000, after: 2, look: async () => (reachable ? { ok: true } : { ok: false, words: 'Unreachable.' }) } },
  });
  const pass = async (ms) => { w.t += ms; await a.tick(); };
  await pass(60000);
  assert.deepEqual(w.fetched, [], 'none set, none fetched');
  a.set({ beat: 'https://hc.example/ping/abc' });
  await pass(30000);
  assert.deepEqual(w.fetched, ['https://hc.example/ping/abc']);
  await pass(30000);
  await pass(30000);
  assert.equal(w.fetched.length, 1, 'not every time it looks: every five minutes');
  await pass(300000);
  assert.equal(w.fetched.length, 2);
  reachable = false;
  await pass(300000);
  await pass(300000);
  await pass(300000);
  assert.equal(w.fetched.length, 2, 'silence is the signal: whoever listens for the heartbeat raises the alarm');
  reachable = true;
  await pass(300000);
  assert.equal(w.fetched.length, 3);
  assert.ok(a.view().beatAt > 0);
});

test('where alerts go is kept between restarts, and nonsense on disk is no address', () => {
  const file = tmp();
  const a = new Alerts({ file, log: quiet, checks: {} });
  a.set({ to: 'https://ntfy.sh/drivepost-abc', beat: 'https://hc.example/ping/x' });
  assert.throws(() => a.set({ to: 'not an address' }), /address/);
  const b = new Alerts({ file, log: quiet, checks: {} });
  assert.equal(b.to, 'https://ntfy.sh/drivepost-abc');
  assert.equal(b.beat, 'https://hc.example/ping/x');
  fs.writeFileSync(file, JSON.stringify({ to: 'javascript:alert(1)', beat: 5 }));
  const c = new Alerts({ file, log: quiet, checks: {} });
  assert.equal(c.to, '');
  assert.equal(c.beat, '');
});
