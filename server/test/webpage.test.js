import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';

process.env.BROWSER_KEY = 'k'.repeat(40);
const { whereTo } = await import('../src/links.js');
const { startGuard } = await import('../src/guard.js');
const { isAgent, openPage, pagesReady, guardAllows, browserKey } = await import('../src/webpage.js');

// Names as a home network's own lookup would answer them.
const lookup = async (host) => {
  const book = {
    'example.com': [{ address: '2606:2800:220:1::1', family: 6 }, { address: '93.184.216.34', family: 4 }],
    'six.example.com': [{ address: '2606:2800:220:1::2', family: 6 }],
    'nas.example.com': [{ address: '192.168.1.20', family: 4 }],
    'mixed.example.com': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }],
  };
  if (!book[host]) throw new Error('ENOTFOUND');
  return book[host];
};
const refused = /inside this server's own network/;

test('a name is followed to one address, checked, for the connection to go to', async () => {
  assert.deepEqual(await whereTo('example.com', lookup, false), { address: '93.184.216.34', family: 4 }, 'the IPv4 one, where there is one');
  assert.deepEqual(await whereTo('six.example.com', lookup, false), { address: '2606:2800:220:1::2', family: 6 });
  assert.deepEqual(await whereTo('93.184.216.34', lookup, false), { address: '93.184.216.34', family: 4 });
  assert.deepEqual(await whereTo('[2606:2800:220:1::1]', lookup, false), { address: '2606:2800:220:1::1', family: 6 });
  for (const inside of ['127.0.0.1', '10.1.2.3', '192.168.70.70', '169.254.169.254', '::1', '[::ffff:127.0.0.1]', 'localhost', 'drivepost', 'router.lan', 'nas.example.com', 'mixed.example.com']) {
    await assert.rejects(whereTo(inside, lookup, false), refused, `${inside} leads inside`);
  }
  await assert.rejects(whereTo('nowhere.example.com', lookup, false), /Couldn't find nowhere\.example\.com/);
  await assert.rejects(whereTo('', lookup, false), /isn't a web address/);
  // With addresses on the home network allowed (OTHER_SITES_LOCAL=on), they are followed like any other.
  assert.deepEqual(await whereTo('nas.example.com', lookup, true), { address: '192.168.1.20', family: 4 });
  assert.deepEqual(await whereTo('127.0.0.1', lookup, true), { address: '127.0.0.1', family: 4 });
});

function ask(port, text) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let got = '';
    s.on('data', (d) => {
      got += d;
      if (got.includes('\r\n\r\n')) {
        s.destroy();
        resolve(got);
      }
    });
    s.on('error', reject);
    s.on('close', () => resolve(got));
  });
}

test("the browser's way out serves its machine only, and connects to the address it checked", async () => {
  let who = false;
  const asked = [];
  const connect = (to) => {
    asked.push(to);
    const up = new EventEmitter();
    Object.assign(up, { write() {}, end() {}, pipe() {}, destroy() {}, unpipe() {} });
    setImmediate(() => up.emit('connect'));
    return up;
  };
  const guard = startGuard({ port: 0, host: '127.0.0.1', allowed: () => who, lookup, allowLocal: false, connect });
  await new Promise((done) => guard.once('listening', done));
  const port = guard.address().port;
  const line = (r) => r.split('\r\n')[0];

  assert.match(line(await ask(port, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n')), / 403 /, 'nobody has signed in as the browser');
  assert.equal(asked.length, 0);

  who = true;
  assert.match(line(await ask(port, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n')), / 200 Connection Established/);
  assert.deepEqual(asked, [{ host: '93.184.216.34', port: 443, family: 4 }], 'to the address that was looked at, not to the name');

  for (const inside of ['nas.example.com:80', 'mixed.example.com:443', '127.0.0.1:8080', 'localhost:8080', '[::1]:8080', 'drivepost:8080', '169.254.169.254:80']) {
    assert.match(line(await ask(port, `CONNECT ${inside} HTTP/1.1\r\nHost: x\r\n\r\n`)), / 403 /, `${inside} is refused`);
  }
  assert.equal(asked.length, 1, 'and nothing was connected to for any of them');
  assert.match(line(await ask(port, 'CONNECT example.com:0 HTTP/1.1\r\nHost: x\r\n\r\n')), / 400 /);
  assert.match(line(await ask(port, 'CONNECT example.com HTTP/1.1\r\nHost: x\r\n\r\n')), / 400 /);
  const plain = await ask(port, 'GET http://nas.example.com/ HTTP/1.1\r\nHost: nas.example.com\r\n\r\n');
  assert.match(line(plain), / 403 /);
  assert.match(await ask(port, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n'), / 400 /, 'it is not a website');
  guard.close();
});

test("only a program with the key is the browser, and nothing opens without one", async () => {
  const key = browserKey();
  assert.equal(key, 'k'.repeat(40));
  assert.equal(isAgent({ headers: { 'x-drivepost-browser': key } }), true);
  assert.equal(isAgent({ headers: { 'x-drivepost-browser': 'x'.repeat(40) } }), false);
  assert.equal(isAgent({ headers: { 'x-drivepost-browser': key.slice(1) } }), false);
  assert.equal(isAgent({ headers: {} }), false);

  assert.equal(pagesReady(), false);
  assert.equal(guardAllows('127.0.0.1'), false, 'the way out is shut until a browser has signed in');
  assert.match((await openPage('main', 'not a link')).error, /isn't a web address/);
  assert.match((await openPage('main', 'http://192.168.1.1/')).error, refused);
  assert.match((await openPage('main', 'http://localhost:8080/admin')).error, refused);
  assert.match((await openPage('main', 'https://93.184.216.34/')).error, /browser isn't running/);
});

// ---------- blocking ads ----------

test('a block list is read from a hosts file, and only names of other machines count', async () => {
  const { parseList } = await import('../src/adblock.js');
  const list = parseList([
    '# Title: a list',
    '127.0.0.1 localhost',
    '127.0.0.1 localhost.localdomain',
    '255.255.255.255 broadcasthost',
    '::1 ip6-localhost',
    'fe80::1%lo0 localhost',
    '0.0.0.0 0.0.0.0',
    '',
    '0.0.0.0 ads.example.com',
    '0.0.0.0 Tracker.Example.NET   # with a note',
    '127.0.0.1 pixel.example.org',
    'plain.example.io',
    '||rule.example.com^',
    '0.0.0.0 not a name',
    '0.0.0.0 -bad-.example.com',
    'just words here',
  ].join('\n'));
  assert.deepEqual([...list].sort(), ['ads.example.com', 'pixel.example.org', 'plain.example.io', 'rule.example.com', 'tracker.example.net']);
  assert.equal(parseList('').size, 0);
});

test('the guard refuses what is on the block list, and only that', async () => {
  const asked = [];
  const guard = startGuard({
    port: 0, host: '127.0.0.1', allowed: () => true, allowLocal: true,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    blocked: (name) => { asked.push(name); return name === 'ads.example.com'; },
    connect: () => { const s = new net.Socket(); setImmediate(() => s.emit('error', new Error('nowhere'))); return s; },
  });
  await new Promise((done) => guard.once('listening', done));
  const port = guard.address().port;
  const ask = (request) => new Promise((done) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(request));
    let got = '';
    s.on('data', (d) => (got += d));
    s.on('close', () => done(got));
    s.on('error', () => done(got));
  });
  const line = await ask('CONNECT ads.example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n');
  assert.match(line, /^HTTP\/1\.1 403 /);
  assert.match(line, /ad block list/);
  const page = await ask('GET http://ads.example.com/banner.js HTTP/1.1\r\nHost: ads.example.com\r\nConnection: close\r\n\r\n');
  assert.match(page, /^HTTP\/1\.1 403 /);
  assert.match(page, /ad block list/);
  const other = await ask('CONNECT video.example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n');
  assert.match(other, /^HTTP\/1\.1 502 /, 'a name that is not on the list is passed on (here, to nowhere)');
  assert.deepEqual(asked, ['ads.example.com', 'ads.example.com', 'video.example.com']);
  guard.close();
});

test('ads are only refused for a profile that asked, and never the site it opened', async () => {
  const { adRefused } = await import('../src/webpage.js');
  // (No page is open in these tests: nothing is refused for nobody.)
  assert.equal(adRefused('ads.example.com', () => true, () => true), false);
});

// ---------- the browser's own ad blocker ----------

test('the guard serves the waiting page a browser with an ad blocker starts on', async () => {
  const { READY_HOST, WAITING } = await import('../src/guard.js');
  const asked = [];
  const heard = [];
  const guard = startGuard({
    port: 0, host: '127.0.0.1', allowed: () => true,
    lookup: async () => { throw new Error('ENOTFOUND'); },
    blocked: (name) => { asked.push(name); return true; },
    waited: (up) => heard.push(up),
  });
  await new Promise((done) => guard.once('listening', done));
  const port = guard.address().port;
  const get = (path) => new Promise((done) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET http://${READY_HOST}${path} HTTP/1.1\r\nHost: ${READY_HOST}\r\nConnection: close\r\n\r\n`));
    let got = '';
    s.on('data', (d) => (got += d));
    s.on('close', () => done(got));
  });
  const page = await get('/');
  assert.match(page, /^HTTP\/1\.1 200 /);
  assert.match(page, /content-type: text\/html/i);
  assert.ok(page.includes(`<title>${WAITING}</title>`));
  assert.ok(page.includes('location.replace(to)') && page.includes("to.indexOf('https://') === 0"), 'it goes on to a web address, and to nothing else');
  assert.ok(!page.includes('undefined'));
  const box = await get('/box?4');
  assert.match(box, /^HTTP\/1\.1 200 /);
  assert.ok(box.includes('id="ad_banner"'), 'a box with an ad\'s name on it, for the blocker to hide');
  const script = await get('/prebid.js?7');
  assert.match(script, /^HTTP\/1\.1 200 /);
  assert.match(script, /content-type: text\/javascript/i);
  assert.match(script, /content-length: 0/i, 'the scripts it asks for are given, with nothing in them');
  assert.deepEqual(asked, [], 'and the block list is not asked about the waiting place');
  assert.ok(page.includes("fetch(up ? '/up' : '/late'"), 'on its way out it says whether the blocker came up');
  assert.deepEqual(heard, []);
  assert.match(await get('/up'), /^HTTP\/1\.1 200 /);
  assert.match(await get('/late'), /^HTTP\/1\.1 200 /);
  assert.deepEqual(heard, [true, false], 'which the guard passes on');
  guard.close();
});

test('a browser with uBlock Origin Lite is told which profiles want it, and reopens a page when that changes', async () => {
  const { attachAgent, usePages, adBlocker, pageAds, closePage, pageOf, blockerSaid, blockerIs } = await import('../src/webpage.js');
  const sent = [];
  const told = [];
  const ws = Object.assign(new EventEmitter(), { readyState: 1, send: (m) => sent.push(JSON.parse(m)), close: () => {} });
  const wants = { main: true, other: false };
  usePages({ blocksAds: (profile) => !!wants[profile], changed: (profile, info) => told.push(info && info.blocker) });
  blockerSaid(true); // (with no page open, nobody is told anything)
  assert.deepEqual(told, []);
  attachAgent(ws, { socket: { remoteAddress: '172.30.0.3' } });
  try {
    assert.equal(adBlocker(), '', 'a browser that has said nothing of a blocker has none');
    assert.equal(pageAds('main', true), false);
    ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', width: 1280, height: 720, ublock: '2026.1110.1816' })), false);
    assert.equal(adBlocker(), 'uBlock Origin Lite 2026.1110.1816');
    assert.equal(pageAds('main', false), false, 'with no page open there is nothing to reopen');

    assert.deepEqual(await openPage('main', 'https://93.184.216.34/watch'), { ok: true });
    const open = sent.find((m) => m.t === 'open');
    assert.equal(open.blockAds, true, 'the browser is told as the page is opened');
    assert.equal(open.profile, 'main');
    assert.equal(blockerIs('main'), '', "until the waiting page has said, it isn't known whether the blocker came up");
    blockerSaid(false);
    assert.equal(blockerIs('main'), 'late');
    blockerSaid(true);
    assert.equal(blockerIs('main'), 'up');
    assert.equal(told[told.length - 1], 'up', 'and the phones are told with the rest of what they know of the page');
    assert.equal(blockerIs('other'), '');
    assert.equal(pageAds('other', true), false, "another profile's switch doesn't touch this page");
    assert.equal(pageAds('main', false), true);
    assert.deepEqual(sent[sent.length - 1], { t: 'ads', id: open.id, on: false });
    assert.equal(blockerIs('main'), '', 'opened again, that is not known again');
    assert.equal(pageOf('main').url, 'https://93.184.216.34/watch', 'it is opened again where it was first opened');
    closePage('main');
  } finally {
    ws.emit('close');
    usePages({ blocksAds: () => false, changed: () => {} });
  }
  assert.equal(pagesReady(), false);
  assert.equal(adBlocker(), '');
});
