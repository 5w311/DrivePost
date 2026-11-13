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
