import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, routeOrder, routeWorked, routeRefused, forgetRoutes, linkStatus, routeNotice } from '../src/youtube.js';
import { findPlayable } from '../src/stream.js';

const quiet = (fn) => {
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
};
const quietly = async (fn) => {
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
};

test('routes are tried best first; refused ones go to the back and get another go later', () => {
  forgetRoutes();
  assert.deepEqual(ROUTES.map((r) => r.name), ['direct', 'hls', 'basic']);
  assert.deepEqual(routeOrder(), ['direct', 'hls', 'basic']);
  quiet(() => routeRefused('direct', 'YouTube refused to send it (403 Forbidden)'));
  assert.deepEqual(routeOrder(), ['hls', 'basic', 'direct'], 'a refused route is still there as a last resort');
  quiet(() => routeWorked('hls'));
  assert.deepEqual(routeOrder(), ['hls', 'basic', 'direct']);
  quiet(() => routeRefused('hls'));
  assert.deepEqual(routeOrder(), ['basic', 'direct', 'hls']);
  quiet(() => routeWorked('basic'));

  // The stopgap is not where it stays: half an hour on, the better routes are tried first again.
  const min = 60 * 1000;
  assert.deepEqual(routeOrder(Date.now() + 29 * min), ['basic', 'direct', 'hls']);
  assert.deepEqual(routeOrder(Date.now() + 31 * min), ['direct', 'hls', 'basic']);

  // Refused again: the wait doubles each time, up to six hours, so a long block costs little.
  quiet(() => routeRefused('direct'));
  assert.deepEqual(routeOrder(Date.now() + 31 * min).slice(-1), ['direct']);
  assert.equal(routeOrder(Date.now() + 61 * min)[0], 'direct');
  for (let i = 0; i < 10; i++) quiet(() => routeRefused('direct'));
  assert.deepEqual(routeOrder(Date.now() + 5.9 * 60 * min).slice(-1), ['direct']);
  assert.equal(routeOrder(Date.now() + 6.1 * 60 * min)[0], 'direct');

  // Working again wipes the slate.
  quiet(() => routeWorked('direct'));
  quiet(() => routeWorked('hls'));
  assert.deepEqual(routeOrder(), ['direct', 'hls', 'basic']);
  assert.equal(routeNotice('direct'), '');
  assert.match(routeNotice('basic'), /basic 360p/);
  forgetRoutes();
});

test('each route asks yt-dlp for a different kind of file', () => {
  const [direct, hls, basic] = ROUTES;
  assert.match(direct.format(1080), /^bv\*\[height<=1080\]\[vcodec\^=avc1\]\[protocol\^=http\]\+ba/);
  assert.ok(!/m3u8/.test(direct.format(720).split('/')[0]));
  assert.ok(hls.format(720).split('/').every((f) => /protocol\^=m3u8/.test(f)), 'only segmented streams');
  assert.ok(hls.args.join(' ').includes('web_embedded'));
  assert.match(basic.format(1080), /^18\//);
});

// A stand-in for looking a video up: every route "finds" something.
const found = (name, extra = {}) => ({ at: Date.now(), routeName: name, inputs: [{ url: `https://example.test/${name}/video` }, { url: `https://example.test/${name}/audio` }], ...extra });

test('a route whose links are refused is skipped for the next one that delivers', async () => {
  forgetRoutes();
  const looked = [];
  const r = await quietly(() =>
    findPlayable('abcdefghijk', '1080', {
      streamInfo: async (id, q, name) => (looked.push(name), found(name)),
      linkStatus: async (input) => (input.url.includes('/direct/') ? 403 : 206),
    })
  );
  assert.equal(r.info.routeName, 'hls');
  assert.deepEqual(looked, ['direct', 'hls']);
  assert.deepEqual(routeOrder(), ['hls', 'basic', 'direct'], 'the next video starts with a route that is not refused');

  // And the next video doesn't waste time on the refused route.
  looked.length = 0;
  const again = await quietly(() =>
    findPlayable('abcdefghijk', '1080', { streamInfo: async (id, q, name) => (looked.push(name), found(name)), linkStatus: async () => 200 })
  );
  assert.equal(again.info.routeName, 'hls');
  assert.deepEqual(looked, ['hls']);
  forgetRoutes();
});

test('when every route is refused, the car is told why, in words and without a link', async () => {
  forgetRoutes();
  const r = await quietly(() => findPlayable('abcdefghijk', '720', { streamInfo: async (id, q, name) => found(name), linkStatus: async () => 403 }));
  assert.equal(r.info, undefined);
  assert.equal(r.message, "Couldn't play this video: YouTube refused to send it (403 Forbidden)");
  forgetRoutes();
});

test('one refused file is enough to refuse the route (picture fine, sound refused)', async () => {
  forgetRoutes();
  const r = await quietly(() =>
    findPlayable('abcdefghijk', '720', {
      streamInfo: async (id, q, name) => found(name),
      linkStatus: async (input) => (input.url === 'https://example.test/direct/audio' ? 403 : 200),
    })
  );
  assert.equal(r.info.routeName, 'hls');
  forgetRoutes();
});

test('links kept from an earlier lookup are refreshed before the route is blamed', async () => {
  forgetRoutes();
  let lookups = 0;
  const r = await quietly(() =>
    findPlayable('abcdefghijk', '720', {
      // The first answer is two hours old and its links have died; a fresh lookup works.
      streamInfo: async (id, q, name) => (++lookups === 1 ? { ...found(name), at: Date.now() - 2 * 3600 * 1000, stale: true } : found(name)),
      linkStatus: async () => (lookups === 1 ? 403 : 206),
    })
  );
  assert.equal(r.info.routeName, 'direct');
  assert.equal(r.info.stale, undefined);
  assert.equal(lookups, 2);
  assert.deepEqual(routeOrder(), ['direct', 'hls', 'basic'], 'the route is not marked as refused');
  forgetRoutes();
});

test('a video that is gone or private is reported at once, without trying every route', async () => {
  forgetRoutes();
  const looked = [];
  const r = await quietly(() =>
    findPlayable('abcdefghijk', '720', {
      streamInfo: async (id, q, name) => {
        looked.push(name);
        throw new Error('[youtube] abcdefghijk: Private video. Sign in if you have been granted access');
      },
      linkStatus: async () => 200,
    })
  );
  assert.deepEqual(looked, ['direct']);
  assert.match(r.message, /^Couldn't load this video: .*Private video/);

  // A route that simply has no such file for this video is skipped quietly.
  looked.length = 0;
  const other = await quietly(() =>
    findPlayable('abcdefghijk', '720', {
      streamInfo: async (id, q, name) => {
        looked.push(name);
        if (name !== 'basic') throw new Error('[youtube] abcdefghijk: Requested format is not available. Use --list-formats');
        return found(name);
      },
      linkStatus: async () => 200,
    })
  );
  assert.deepEqual(looked, ['direct', 'hls', 'basic']);
  assert.equal(other.info.routeName, 'basic');
  assert.deepEqual(routeOrder(), ['direct', 'hls', 'basic'], 'that says nothing about the routes themselves');
  forgetRoutes();
});

test('a link is checked by asking for its first bytes; a segmented stream by its list and first segment', async () => {
  const asked = [];
  const fake = (answers) => async (url, opts) => {
    asked.push({ url, range: opts.headers.Range || null, ua: opts.headers['User-Agent'] });
    const a = answers[url] ?? { status: 404 };
    return { status: a.status, text: async () => a.text || '', body: { cancel: async () => {} } };
  };
  // An ordinary file.
  assert.equal(await linkStatus({ url: 'https://v.test/file', headers: { 'User-Agent': 'yt' } }, fake({ 'https://v.test/file': { status: 206 } })), 206);
  assert.deepEqual(asked.pop(), { url: 'https://v.test/file', range: 'bytes=0-1023', ua: 'yt' });
  assert.equal(await linkStatus({ url: 'https://v.test/file' }, fake({ 'https://v.test/file': { status: 403 } })), 403);

  // A segmented stream whose list loads but whose segments are refused is no use.
  asked.length = 0;
  const list = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5.0,\nhttps://seg.test/seg0.ts\n#EXTINF:5.0,\nhttps://seg.test/seg1.ts\n';
  assert.equal(await linkStatus({ url: 'https://m.test/list.m3u8', list: true }, fake({ 'https://m.test/list.m3u8': { status: 200, text: list }, 'https://seg.test/seg0.ts': { status: 403 } })), 403);
  assert.deepEqual(asked.map((a) => [a.url, a.range]), [['https://m.test/list.m3u8', null], ['https://seg.test/seg0.ts', 'bytes=0-1023']]);
  assert.equal(await linkStatus({ url: 'https://m.test/list.m3u8', list: true }, fake({ 'https://m.test/list.m3u8': { status: 200, text: list }, 'https://seg.test/seg0.ts': { status: 200 } })), 200);
  // Segment names relative to the list.
  assert.equal(await linkStatus({ url: 'https://m.test/a/list.m3u8', list: true }, fake({ 'https://m.test/a/list.m3u8': { status: 200, text: '#EXTM3U\nseg0.ts\n' }, 'https://m.test/a/seg0.ts': { status: 206 } })), 206);
  assert.equal(await linkStatus({ url: 'https://m.test/list.m3u8', list: true }, fake({ 'https://m.test/list.m3u8': { status: 403 } })), 403);
});
