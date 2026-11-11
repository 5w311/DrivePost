import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, routeOrder, routeWorked, routeRefused, forgetRoutes, linkStatus, routeNotice, whatEachHas } from '../src/youtube.js';
import { findPlayable, ffmpegArgs } from '../src/stream.js';

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

// The routes by rank, whatever they are called: the tests below are about
// first, second and last choice, not about which kind of file each one is.
const [A, B, C] = ROUTES.map((r) => r.name);

test('routes are tried best first; refused ones go to the back and get another go later', () => {
  forgetRoutes();
  // The stream comes first: no ad break in front of it, and YouTube sends it far faster.
  assert.deepEqual([A, B, C], ['hls', 'direct', 'basic']);
  assert.deepEqual(routeOrder(), [A, B, C]);
  quiet(() => routeRefused(A, 'YouTube refused to send it (403 Forbidden)'));
  assert.deepEqual(routeOrder(), [B, C, A], 'a refused route is still there as a last resort');
  quiet(() => routeWorked(B));
  assert.deepEqual(routeOrder(), [B, C, A]);
  quiet(() => routeRefused(B));
  assert.deepEqual(routeOrder(), [C, A, B]);
  quiet(() => routeWorked(C));

  // The stopgap is not where it stays: half an hour on, the better routes are tried first again.
  const min = 60 * 1000;
  assert.deepEqual(routeOrder(Date.now() + 29 * min), [C, A, B]);
  assert.deepEqual(routeOrder(Date.now() + 31 * min), [A, B, C]);

  // Refused again: the wait doubles each time, up to six hours, so a long block costs little.
  quiet(() => routeRefused(A));
  assert.deepEqual(routeOrder(Date.now() + 31 * min).slice(-1), [A]);
  assert.equal(routeOrder(Date.now() + 61 * min)[0], A);
  for (let i = 0; i < 10; i++) quiet(() => routeRefused(A));
  assert.deepEqual(routeOrder(Date.now() + 5.9 * 60 * min).slice(-1), [A]);
  assert.equal(routeOrder(Date.now() + 6.1 * 60 * min)[0], A);

  // Working again wipes the slate.
  quiet(() => routeWorked(A));
  quiet(() => routeWorked(B));
  assert.deepEqual(routeOrder(), [A, B, C]);
  assert.equal(routeNotice('hls'), '');
  assert.equal(routeNotice('direct'), '');
  assert.match(routeNotice('basic'), /basic 360p/);
  forgetRoutes();
});

test('each route asks yt-dlp for a different kind of file', () => {
  const { direct, hls, basic } = Object.fromEntries(ROUTES.map((r) => [r.name, r]));
  assert.match(direct.format(1080), /^bv\*\[height<=1080\]\[vcodec\^=avc1\]\[protocol\^=http\]\+ba/);
  assert.ok(!/m3u8/.test(direct.format(720).split('/')[0]));
  assert.ok(hls.format(720).split('/').every((f) => /protocol\^=m3u8/.test(f)), 'only segmented streams');
  assert.match(hls.format(1080), /^bv\*\[height<=1080\]\[vcodec\^=avc1\]\[protocol\^=m3u8\]\+ba/, 'H.264 first, so it can be passed through');
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
      linkStatus: async (input) => (input.url.includes(`/${A}/`) ? 403 : 206),
    })
  );
  assert.equal(r.info.routeName, B);
  assert.deepEqual(looked, [A, B]);
  assert.deepEqual(routeOrder(), [B, C, A], 'the next video starts with a route that is not refused');

  // And the next video doesn't waste time on the refused route.
  looked.length = 0;
  const again = await quietly(() =>
    findPlayable('abcdefghijk', '1080', { streamInfo: async (id, q, name) => (looked.push(name), found(name)), linkStatus: async () => 200 })
  );
  assert.equal(again.info.routeName, B);
  assert.deepEqual(looked, [B]);
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
      linkStatus: async (input) => (input.url === `https://example.test/${A}/audio` ? 403 : 200),
    })
  );
  assert.equal(r.info.routeName, B);
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
  assert.equal(r.info.routeName, A);
  assert.equal(r.info.stale, undefined);
  assert.equal(lookups, 2);
  assert.deepEqual(routeOrder(), [A, B, C], 'the route is not marked as refused');
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
  assert.deepEqual(looked, [A]);
  assert.match(r.message, /^Couldn't load this video: .*Private video/);

  // A route that simply has no such file for this video is skipped quietly.
  looked.length = 0;
  const other = await quietly(() =>
    findPlayable('abcdefghijk', '720', {
      streamInfo: async (id, q, name) => {
        looked.push(name);
        if (name !== C) throw new Error('[youtube] abcdefghijk: Requested format is not available. Use --list-formats');
        return found(name);
      },
      linkStatus: async () => 200,
    })
  );
  assert.deepEqual(looked, [A, B, C]);
  assert.equal(other.info.routeName, C);
  assert.deepEqual(routeOrder(), [A, B, C], 'that says nothing about the routes themselves');

  // What is wrong with the video is what gets reported, not what an earlier route lacked.
  looked.length = 0;
  const gone = await quietly(() =>
    findPlayable('abcdefghijk', '720', {
      streamInfo: async (id, q, name) => {
        looked.push(name);
        throw new Error(name === A ? '[youtube] abcdefghijk: Requested format is not available' : '[youtube] abcdefghijk: Video unavailable. This video has been removed');
      },
      linkStatus: async () => 200,
    })
  );
  assert.deepEqual(looked, [A, B]);
  assert.match(gone.message, /^Couldn't load this video: .*has been removed/);

  // And when no route has anything, that is said in words.
  const none = await quietly(() =>
    findPlayable('abcdefghijk', '720', {
      streamInfo: async () => {
        throw new Error('[youtube] abcdefghijk: Requested format is not available. Use --list-formats');
      },
      linkStatus: async () => 200,
    })
  );
  assert.equal(none.message, "Couldn't load this video: YouTube has no version of it that this server can play");
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

// ---- the wait YouTube puts in front of a video (the length of an ad) ----

// A clock the test moves, and a sleep that moves it.
function clock(start = 1_000_000) {
  const c = { t: start, slept: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => {
    c.slept.push(Math.round(ms));
    c.t += ms;
  };
  return c;
}

test('links that are not ready yet are waited for, not asked for early', async () => {
  forgetRoutes();
  const c = clock();
  const asked = [];
  const waits = [];
  const r = await quietly(() =>
    findPlayable('abcdefghijk', '1080', {
      now: c.now,
      sleep: c.sleep,
      onWait: (s) => waits.push(s),
      streamInfo: async (id, q, name) => ({ ...found(name), at: c.t, readyAt: name === A ? c.t + 6000 : 0 }),
      // Asked before its time, YouTube says 403. That must never happen.
      linkStatus: async (input) => (asked.push([input.url, c.t]), c.t >= 1_006_000 || !input.url.includes(`/${A}/`) ? 206 : 403),
    })
  );
  assert.equal(r.info.routeName, A, 'six seconds is worth waiting for the better route');
  assert.deepEqual(waits, [6]);
  assert.deepEqual(c.slept, [6300]);
  assert.ok(asked.every(([, t]) => t >= 1_006_000), 'nothing was asked for early');
  assert.deepEqual(routeOrder(), [A, B, C], 'a wait is not a refusal');
  forgetRoutes();
});

test('behind a long wait, a route that is ready now is used instead', async () => {
  forgetRoutes();
  const c = clock();
  const looked = [];
  const r = await quietly(() =>
    findPlayable('abcdefghijk', '1080', {
      now: c.now,
      sleep: c.sleep,
      streamInfo: async (id, q, name) => (looked.push(name), { ...found(name), at: c.t, readyAt: name === A ? c.t + 30000 : 0 }),
      linkStatus: async () => 200,
    })
  );
  assert.equal(r.info.routeName, B);
  assert.deepEqual(looked, [A, B]);
  assert.deepEqual(c.slept, [], 'no waiting at all');
  forgetRoutes();
});

test('when nothing else works, even a long wait is sat out, and the car is told how long', async () => {
  forgetRoutes();
  const c = clock();
  const waits = [];
  const r = await quietly(() =>
    findPlayable('abcdefghijk', '1080', {
      now: c.now,
      sleep: c.sleep,
      onWait: (s) => waits.push(s),
      streamInfo: async (id, q, name) => {
        if (name === B) throw new Error('[youtube] abcdefghijk: Requested format is not available');
        return { ...found(name), at: c.t, readyAt: c.t + 30000 };
      },
      linkStatus: async () => 206,
    })
  );
  assert.equal(r.info.routeName, A, 'the better of the two that need the same wait');
  assert.deepEqual(waits, [30]);

  // An absurd wait is treated as a refusal rather than leaving the car hanging.
  const c2 = clock();
  const never = await quietly(() =>
    findPlayable('abcdefghijk', '1080', {
      now: c2.now,
      sleep: c2.sleep,
      streamInfo: async (id, q, name) => ({ ...found(name), at: c2.t, readyAt: c2.t + 10 * 60 * 1000 }),
      linkStatus: async () => 206,
    })
  );
  assert.equal(never.message, "Couldn't play this video: YouTube refused to send it (403 Forbidden)");
  assert.deepEqual(c2.slept, []);
  forgetRoutes();
});

test('a video looked up ahead of time has usually sat out its wait already', async () => {
  forgetRoutes();
  const c = clock();
  const r = await quietly(() =>
    findPlayable('abcdefghijk', '1080', {
      now: c.now,
      sleep: c.sleep,
      // Looked up 40 seconds ago for the queue; its wait ended long since.
      streamInfo: async (id, q, name) => ({ ...found(name), at: c.t - 40000, readyAt: c.t - 34000 }),
      linkStatus: async () => 206,
    })
  );
  assert.equal(r.info.routeName, A);
  assert.deepEqual(c.slept, []);
  forgetRoutes();
});

// ---- as measured from a home connection: the stream is ready at once, the files sit behind an ad's wait ----

const asMeasured = (c, name) => ({ ...found(name), at: c.t, readyAt: name === 'hls' ? 0 : c.t + (name === 'direct' ? 4000 : 5000) });

test('the usual case: the stream is ready at once, so nothing waits and nothing else is looked up', async () => {
  forgetRoutes();
  const c = clock();
  const looked = [];
  const waits = [];
  const r = await quietly(() =>
    findPlayable('abcdefghijk', '1080', {
      now: c.now,
      sleep: c.sleep,
      onWait: (s) => waits.push(s),
      streamInfo: async (id, q, name) => (looked.push(name), asMeasured(c, name)),
      linkStatus: async () => 200,
    })
  );
  assert.equal(r.info.routeName, 'hls');
  assert.deepEqual(looked, ['hls']);
  assert.deepEqual(c.slept, []);
  assert.deepEqual(waits, []);
  forgetRoutes();
});

test('a video with no stream (one that cannot be embedded) plays from the files after their short wait', async () => {
  forgetRoutes();
  const c = clock();
  const looked = [];
  const waits = [];
  const r = await quietly(() =>
    findPlayable('abcdefghijk', '1080', {
      now: c.now,
      sleep: c.sleep,
      onWait: (s) => waits.push(s),
      streamInfo: async (id, q, name) => {
        looked.push(name);
        if (name === 'hls') throw new Error('[youtube] abcdefghijk: Requested format is not available. Use --list-formats');
        return asMeasured(c, name);
      },
      linkStatus: async () => 206,
    })
  );
  assert.equal(r.info.routeName, 'direct');
  assert.deepEqual(looked, ['hls', 'direct'], 'not settling for 360p when 1080p is four seconds away');
  assert.deepEqual(waits, [4]);
  assert.deepEqual(routeOrder(), ['hls', 'direct', 'basic'], 'and the stream is still first choice for the next video');
  forgetRoutes();
});

test('ffmpeg reconnects to a dropped file, but is not told to for a segmented stream', () => {
  const file = { url: 'https://v.test/video.mp4', headers: {}, hasVideo: true, hasAudio: true, vcodec: 'avc1.640028' };
  const fileArgs = ffmpegArgs({ inputs: [file], height: 720, fps: 30, live: false }, 0, '720', 48000, 'h264').join(' ');
  assert.match(fileArgs, /-reconnect 1 -reconnect_streamed 1/);
  const list = { ...file, url: 'https://m.test/list.m3u8', list: true };
  const listArgs = ffmpegArgs({ inputs: [list], height: 720, fps: 30, live: false }, 0, '720', 48000, 'h264').join(' ');
  assert.ok(!/-reconnect/.test(listArgs), 'or it would pause at the end of every segment');
  assert.match(listArgs, /-i https:\/\/m\.test\/list\.m3u8/);
});

// ---- which format carries the picture and which the sound ----

test('a sound stream whose codec YouTube does not name still counts as the sound', () => {
  // What yt-dlp really gives for the segmented stream: the picture names its
  // codec and says it has no sound; the sound says it has no picture and
  // names no codec at all.
  assert.deepEqual(
    whatEachHas([
      { format_id: '312', vcodec: 'avc1.64002A', acodec: 'none' },
      { format_id: '234', vcodec: 'none', acodec: null },
    ]),
    [
      { hasVideo: true, hasAudio: false },
      { hasVideo: false, hasAudio: true },
    ]
  );
  assert.deepEqual(whatEachHas([{ vcodec: 'avc1.64002A', acodec: 'none' }, { vcodec: 'none' }])[1], { hasVideo: false, hasAudio: true }, 'missing altogether is the same as not known');
  // The separate files name everything.
  assert.deepEqual(
    whatEachHas([
      { vcodec: 'avc1.640028', acodec: 'none' },
      { vcodec: 'none', acodec: 'mp4a.40.2' },
    ]),
    [
      { hasVideo: true, hasAudio: false },
      { hasVideo: false, hasAudio: true },
    ]
  );
});

test('not knowing is settled by what the other formats say', () => {
  // One file with picture and sound together.
  assert.deepEqual(whatEachHas([{ vcodec: 'avc1.42001E', acodec: 'mp4a.40.2' }]), [{ hasVideo: true, hasAudio: true }]);
  // One format that names neither: it has to be both.
  assert.deepEqual(whatEachHas([{}]), [{ hasVideo: true, hasAudio: true }]);
  assert.deepEqual(whatEachHas([{ vcodec: 'avc1.42001E' }]), [{ hasVideo: true, hasAudio: true }]);
  // A picture with nothing said about sound, next to a format that is sound for certain: the sound is the other one.
  assert.deepEqual(
    whatEachHas([{ vcodec: 'avc1.640028' }, { vcodec: 'none', acodec: 'mp4a.40.2' }]),
    [
      { hasVideo: true, hasAudio: false },
      { hasVideo: false, hasAudio: true },
    ]
  );
  // Neither says anything about sound: the one that isn't the picture has it.
  assert.deepEqual(
    whatEachHas([{ vcodec: 'avc1.640028' }, { vcodec: 'none' }]),
    [
      { hasVideo: true, hasAudio: false },
      { hasVideo: false, hasAudio: true },
    ]
  );
  // A video with no sound at all stays that way.
  assert.deepEqual(whatEachHas([{ vcodec: 'avc1.640028', acodec: 'none' }]), [{ hasVideo: true, hasAudio: false }]);
});
