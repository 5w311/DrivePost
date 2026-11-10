import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A stand-in for YouTube's suggestion service, answering in its format.
let hits = 0;
const upstream = http.createServer((req, res) => {
  hits++;
  const u = new URL(req.url, 'http://x');
  const q = u.searchParams.get('q');
  if (q === 'boom') {
    res.writeHead(500);
    return res.end('nope');
  }
  assert.equal(u.searchParams.get('ds'), 'yt', 'asks for YouTube suggestions');
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=UTF-8' });
  res.end(JSON.stringify([q, [`${q} bunny`, `${q} hunter`, 'café ' + q, 42, ''], [], { 'google:suggestsubtypes': [] }]));
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
process.env.SUGGEST_URL = `http://127.0.0.1:${upstream.address().port}/complete/search`;
const { suggest } = await import('../src/youtube.js');

test('suggestions come back as plain strings, cached per query', async () => {
  assert.deepEqual(await suggest('big buck'), ['big buck bunny', 'big buck hunter', 'café big buck']);
  const before = hits;
  await suggest('Big Buck ');
  assert.equal(hits, before, 'same query is answered from the cache');
});

test('too-short queries ask nothing; failures reject so the route can return an empty list', async () => {
  const before = hits;
  assert.deepEqual(await suggest('b'), []);
  assert.deepEqual(await suggest(''), []);
  assert.equal(hits, before);
  await assert.rejects(suggest('boom'));
});

test.after(() => upstream.close());
