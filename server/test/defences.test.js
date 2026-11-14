// The server's defences, tried against the server itself: it is started as
// its own program, the way it runs, and sent what an outsider could send it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Auth, networkOf, parseCookies } from '../src/auth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drivepost-defences-'));
const ADMIN = 'the-servers-own-passcode';
const PASS = 'a-profile-passcode';
let server;
let port;
let base;
let log = '';
let cookie = '';

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const up = async () => (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) && server.exitCode === null;

// A request written out by hand, as a browser never would: returns what came back.
function raw(text) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(Buffer.from(text, 'latin1')));
    let got = '';
    s.on('data', (d) => (got += d.toString('latin1')));
    s.on('close', () => resolve(got));
    s.on('error', () => resolve(got));
    setTimeout(() => s.destroy(), 700);
  });
}
const SOCKET = 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n';
const post = (where, body, headers = {}) =>
  fetch(base + where, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });
const state = () => fetch(`${base}/api/state`, { headers: { cookie } }).then((r) => r.json());

before(async () => {
  new Auth({ dataDir, passcode: ADMIN }).addProfile('Tester', PASS);
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(HERE, '..'),
    env: { ...process.env, DRIVE_PASSCODE: ADMIN, DATA_DIR: dataDir, PORT: String(port), GUARD_PORT: String(await freePort()), BROWSER_KEY: 'k'.repeat(64),
      YTDLP_BIN: 'false', YTDLP_UPDATE_CMD: '', WRONG_PASSCODES_AN_HOUR: '14', PUBLIC_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 80 && !(await up()); i++) await sleep(100);
  assert.ok(await up(), `the server started: ${log.slice(-300)}`);
  const signIn = await post('/api/login', { passcode: PASS });
  assert.equal(signIn.status, 200);
  cookie = signIn.headers.get('set-cookie').split(';')[0];
});
after(() => server && server.kill());

test('no request, however it is written, stops the server', async () => {
  const tries = [
    `GET /ws/control HTTP/1.1\r\nHost: x\r\n${SOCKET}Cookie: dt_session=%\r\n\r\n`,
    `GET /ws/browser HTTP/1.1\r\nHost: x\r\n${SOCKET}x-drivepost-browser: ${'é'.repeat(64)}\r\n\r\n`,
    `GET //[ HTTP/1.1\r\nHost: x\r\n${SOCKET}\r\n`,
    `GET http://[::1 HTTP/1.1\r\nHost: x\r\n${SOCKET}\r\n`,
    `GET //[ HTTP/1.1\r\nHost: x\r\n\r\n`,
    `POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 4\r\n\r\nnull`,
  ];
  for (const request of tries) {
    const answer = await raw(request);
    assert.ok(await up(), `still up after: ${request.split('\r\n')[0]} with ${request.split('\r\n').slice(-3)[0].slice(0, 40)}`);
    assert.doesNotMatch(answer.split('\r\n')[0], / 101 /, 'and nothing was let in by it');
  }
  // A cookie that can't be read is no cookie: the page asks for a sign-in, as for anyone.
  const page = await raw('GET /remote HTTP/1.1\r\nHost: x\r\nCookie: dt_session=%\r\n\r\n');
  assert.match(page.split('\r\n')[0], / 302 /);
  assert.doesNotMatch(log, /carried on after/, 'none of them got as far as the last line of defence');
});

test('what a signed-in device sends down a socket can not stop the server either', async () => {
  const open = (where) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${where}`, { headers: { cookie } });
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  for (const message of ['null', '7', '[]', '"words"', '{"type":"cmd"}', '{"type":"cmd","action":"play","item":{"id":{}}}', '{"type":"pos","t":"x"}', 'x'.repeat(70000)]) {
    const ws = await open('/ws/control');
    ws.on('error', () => {});
    ws.send(message);
    await sleep(120);
    ws.terminate();
    assert.ok(await up(), `still up after ${message.slice(0, 40)}`);
  }
});

test('a body with nothing to read in it is answered, not tripped over', async () => {
  for (const body of ['null', '7', '"word"', '[]', '{', '']) {
    const res = await fetch(`${base}/api/share`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body });
    assert.equal(res.status, 400, `${body || 'nothing'}: there is no link in it, and it says so`);
  }
  assert.ok(await up());
});

test("another site's page can not act with a device's sign-in", async () => {
  // (This server is reached as 127.0.0.1 here, so that is the address of its own pages.)
  const own = `http://127.0.0.1:${port}`;
  // Something that changes things: closing the page that is open.
  const from = async (headers) => (await post('/api/page/close', {}, { cookie, ...headers })).status;
  assert.equal(await from({ origin: 'https://elsewhere.example' }), 403, 'a page on another site');
  assert.equal(await from({ origin: `http://sister.127.0.0.1:${port}` }), 403);
  assert.equal(await from({ origin: `http://127.0.0.1:${port + 1}` }), 403, 'another program on the same machine');
  assert.equal(await from({ 'sec-fetch-site': 'same-site', origin: `http://sister.127.0.0.1:${port}` }), 403, 'a page on a sister address, as a current browser marks it');
  assert.equal(await from({ 'sec-fetch-site': 'cross-site' }), 403);
  assert.equal(await from({ 'sec-fetch-site': 'cross-site', origin: 'https://elsewhere.example' }), 403);
  assert.equal(await from({ origin: 'null' }), 403, 'a page with no address of its own');
  assert.equal(await from({ origin: own, 'x-forwarded-proto': 'https' }), 403, 'a page fetched without https, on a server reached with it');
  assert.equal(await from({ origin: own }), 200, "this server's own page");
  assert.equal(await from({ origin: own.replace('http:', 'https:') }), 200);
  assert.equal(await from({ 'sec-fetch-site': 'same-origin' }), 200);
  assert.equal(await from({ 'sec-fetch-site': 'same-origin', origin: 'null' }), 200, 'the browser vouches for it');
  assert.equal(await from({ 'sec-fetch-site': 'same-origin', origin: 'https://public.example' }), 200, 'its own page, behind something that changes its name on the way in');
  // The address settles it where a browser's "same site" is off the mark.
  assert.equal(await from({ 'sec-fetch-site': 'cross-site', origin: own }), 200);
  assert.equal(await from({ origin: 'https://public.example', 'x-forwarded-host': 'public.example' }), 200, 'its own page, behind something that passes its public name along');
  assert.equal(await from({}), 200, 'no page at all: the iPhone Shortcut, the updater');
  assert.match(log, /\[security\] turned away a request made by a page on https:\/\/elsewhere\.example/);

  // Sockets. (A browser doesn't say "same site" for these, only where the page is.)
  const socket = (origin) => raw(`GET /ws/control HTTP/1.1\r\nHost: drivepost.example\r\n${origin ? `Origin: ${origin}\r\n` : ''}${SOCKET}Cookie: ${cookie}\r\n\r\n`).then((a) => a.split(' ')[1]);
  assert.equal(await socket('https://elsewhere.example'), '403');
  assert.equal(await socket('https://app.drivepost.example'), '403');
  assert.equal(await socket('null'), '403');
  assert.equal(await socket('https://drivepost.example'), '101');
  assert.equal(await socket('https://drivepost.example:443'), '101');
  assert.equal(await socket(''), '101');
  // Some browsers do say "same site" for a socket, and count a page on https and its socket on wss
  // as two sites. The address of the page is what counts.
  const marked = (origin, site) => raw(`GET /ws/control HTTP/1.1\r\nHost: drivepost.example\r\nOrigin: ${origin}\r\nSec-Fetch-Site: ${site}\r\n${SOCKET}Cookie: ${cookie}\r\n\r\n`).then((a) => a.split(' ')[1]);
  assert.equal(await marked('https://drivepost.example', 'cross-site'), '101');
  assert.equal(await marked('https://elsewhere.example', 'same-origin'), '403');
});

test('a link on another site puts nothing on in the car', async () => {
  const visit = (headers) => fetch(`${base}/share?url=https://www.youtube.com/watch?v=aqz-KE-bpKQ`, { headers: { cookie, ...headers }, redirect: 'manual' }).then((r) => r.headers.get('location'));
  const box = '/remote?link=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Daqz-KE-bpKQ';
  assert.equal(await visit({ 'sec-fetch-site': 'cross-site' }), box, 'it lands in the box on the remote instead');
  assert.equal(await visit({ 'sec-fetch-site': 'same-site' }), box);
  assert.equal(await visit({}), box, 'so does one from a browser that says nothing of where a visit comes from');
  assert.equal((await state()).now, null);
  // The phone's own share sheet (or the address typed in): a visit the person made.
  assert.match(await visit({ 'sec-fetch-site': 'none' }), /^\/remote\?msg=Playing/);
  assert.equal((await state()).now.id, 'aqz-KE-bpKQ');
});

test('every answer says how a browser is to treat it', async () => {
  const page = await fetch(`${base}/login`);
  const html = await page.text();
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'$/, "pages run this server's own scripts and no others");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  assert.equal(page.headers.get('strict-transport-security'), null, 'reached over plain http, it makes no promise about https');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, 'no page has script written into it');
  for (const name of fs.readdirSync(path.join(HERE, '../public')).filter((n) => n.endsWith('.html'))) {
    const text = fs.readFileSync(path.join(HERE, '../public', name), 'utf8');
    assert.doesNotMatch(text, /<script(?![^>]*\bsrc=)|\son[a-z]+="|javascript:/i, `${name} has no script of its own in it`);
  }
  const car = await fetch(`${base}/`, { headers: { cookie } });
  assert.match(car.headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'$/, "the car's page may also compile its decoder");
  const data = await fetch(`${base}/api/state`, { headers: { cookie } });
  assert.equal(data.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(data.headers.get('x-content-type-options'), 'nosniff');
  const secure = await fetch(`${base}/login`, { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(secure.headers.get('strict-transport-security'), 'max-age=31536000');
});

test("the updater's line is for this machine only", async () => {
  const ask = (headers) => fetch(`${base}/internal/busy`, { headers }).then((r) => r.status);
  assert.equal(await ask({}), 200);
  assert.equal(await ask({ 'x-forwarded-for': '203.0.113.9' }), 404);
  assert.equal(await ask({ 'cf-connecting-ip': '203.0.113.9' }), 404);
  assert.equal(await ask({ via: '1.1 drivepost' }), 404, "not what the page browser's guard passed on");
});

test('passcodes can not be guessed at any speed worth having', async () => {
  // (Last: it ends with sign-in closed for an hour. This server allows 14 wrong passcodes an hour, not 40.)
  const guess = (n, from) => post('/api/login', { passcode: `guess-${n}` }, from ? { 'cf-connecting-ip': from } : {}).then((r) => r.status);
  const one = [];
  for (let i = 0; i < 10; i++) one.push(await guess(i, '2001:db8:7:7::' + (i + 1).toString(16)));
  assert.deepEqual(one, [401, 401, 401, 401, 401, 401, 401, 401, 429, 429], 'eight tries for one network, however many addresses it comes from');
  // Other addresses get their own eight, but all of them together don't get many.
  const many = [];
  for (let i = 0; i < 12; i++) many.push(await guess(100 + i, `198.51.100.${i + 1}`));
  // (Five more, not six: the body that was just the word "null", further up, was a wrong passcode too.)
  assert.equal(many.filter((s) => s === 401).length, 5, 'fourteen wrong passcodes in all, from wherever');
  assert.deepEqual(many.slice(5), [429, 429, 429, 429, 429, 429, 429]);
  assert.match(log, /\[security\] 14 wrong passcodes within an hour/, 'and the log says when sign-in closed');
  const closed = await post('/api/login', { passcode: PASS }, { 'cf-connecting-ip': '192.0.2.50' });
  assert.equal(closed.status, 429, 'until then the right passcode waits too');
  assert.match((await closed.json()).error, /sign-in is closed for a while/);
  assert.equal((await post('/api/admin/login', { passcode: ADMIN }, { 'cf-connecting-ip': '192.0.2.51' })).status, 429);
  assert.equal((await post('/api/join', { name: 'Someone', passcode: 'whatever-1' }, { 'cf-connecting-ip': '192.0.2.52' })).status, 429, 'and asking for a profile, which says whether a passcode is taken');
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, 200, 'a device that is signed in carries on');
});

test('addresses and cookies are read without trusting them', () => {
  assert.equal(networkOf('203.0.113.7'), '203.0.113.7');
  assert.equal(networkOf('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(networkOf('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), networkOf('2001:db8:1:2::1'), 'one IPv6 network is one address');
  assert.notEqual(networkOf('2001:db8:1:2::1'), networkOf('2001:db8:1:3::1'));
  assert.equal(networkOf(''), 'unknown');
  assert.deepEqual(parseCookies('a=1; bad=%; b=%41'), { a: '1', bad: '%', b: 'A' });
});
