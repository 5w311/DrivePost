import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A dropped share is waited for this long (20 seconds on a real server).
process.env.SCREEN_BACK_MS = '250';
process.env.PAGES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'drivepost-pages-'));
const mirror = await import('../src/mirror.js');
const { Store, cleanItem } = await import('../src/state.js');
const { pageRowId, isPageRowId } = await import('../src/links.js');
const { ffmpegArgs, chooseCodec } = await import('../src/stream.js');
const { PAGE_ID, ingestArgs, readList, pageItem, startShare, endShare, shareExpected, pageStream, onShare } = mirror;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// Stands in for ffmpeg: takes what it is given and does nothing with it.
function fakeFfmpeg() {
  const made = [];
  const spawnImpl = (bin, args) => {
    const ff = new EventEmitter();
    ff.args = args;
    ff.written = 0;
    ff.exitCode = null;
    ff.signalCode = null;
    ff.stdin = Object.assign(new EventEmitter(), {
      writableLength: 0,
      write: (chunk) => {
        ff.written += chunk.length;
        return true;
      },
      end: () => {
        ff.exitCode = 0;
        setImmediate(() => ff.emit('close', 0));
      },
    });
    ff.stderr = new EventEmitter();
    ff.kill = () => {};
    made.push(ff);
    return ff;
  };
  return { made, spawnImpl };
}

// What ffmpeg would have written by now: a list of `n` one-second pieces.
function writeList(share, n, ended = false) {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0'];
  for (let i = 0; i < n; i++) lines.push('#EXTINF:1.000000,', `s${String(i).padStart(6, '0')}.ts`);
  if (ended) lines.push('#EXT-X-ENDLIST');
  fs.writeFileSync(share.list, lines.join('\n') + '\n');
}

function events(profile) {
  const seen = [];
  const off = onShare((p, what, share) => {
    if (p === profile) seen.push([what, share && share.done]);
  });
  return { seen, off };
}

test('the recording is turned into one fixed picture, whatever it comes as', () => {
  const args = ingestArgs({ list: '/x/y/index.m3u8', size: '720' });
  const s = args.join(' ');
  assert.match(s, /-i pipe:0/);
  assert.match(s, /fps=30,scale=1280:720:force_original_aspect_ratio=decrease[^,]*,pad=1280:720:/, 'fitted and padded to the size asked for');
  assert.match(s, /-c:v libx264 .*-tune zerolatency/);
  assert.match(s, /-g 15 -keyint_min 15 -sc_threshold 0/, 'every half-second piece starts on a whole frame');
  assert.match(s, /-map 0:a:0\? .*-c:a aac .*-ar 48000 -ac 2/, 'sound, if the recording has any');
  assert.match(s, /-f hls -hls_time 0\.5 -hls_list_size 24 .*delete_segments/, 'half-second pieces, twelve seconds of them kept');
  assert.equal(args.at(-1), '/x/y/index.m3u8');
  assert.equal(args[args.indexOf('-hls_segment_filename') + 1], '/x/y/s%06d.ts', 'the pieces sit beside the list');
  // What is read while ffmpeg studies the start must be kept: the first frame is in it.
  assert.doesNotMatch(s, /nobuffer/);

  assert.match(ingestArgs({ list: '/x/index.m3u8', size: '1080' }).join(' '), /scale=1920:1080.*pad=1920:1080/);
  assert.match(ingestArgs({ list: '/x/index.m3u8', size: '480' }).join(' '), /scale=854:480.*pad=854:480/);
  assert.match(ingestArgs({ list: '/x/index.m3u8', size: 'huge' }).join(' '), /scale=1280:720/, 'an unknown size is 720p');

  const silent = ingestArgs({ list: '/x/index.m3u8', audio: false }).join(' ');
  assert.match(silent, / -an /);
  assert.doesNotMatch(silent, /0:a:0|aac/);

  const old = ingestArgs({ list: '/x/index.m3u8', h264: false }).join(' ');
  assert.match(old, /-c:v mpeg2video/, 'an ffmpeg without H.264 still keeps a copy');
  assert.doesNotMatch(old, /libx264/);
});

test("the browser's own film of its screen is kept as it comes", () => {
  const s = ingestArgs({ list: '/x/y/index.m3u8', size: '720', copy: true }).join(' ');
  assert.match(s, /-i pipe:0 -map 0:v:0 -map 0:a:0\? -c copy -f hls -hls_time 0\.5 /, 'cut into pieces, nothing converted');
  assert.doesNotMatch(s, /libx264|scale=|-vf|aac/);
  assert.match(s, /-hls_flags delete_segments\+independent_segments\+temp_file -hls_segment_filename \/x\/y\/s%06d\.ts \/x\/y\/index\.m3u8$/);
  assert.match(ingestArgs({ list: '/x/index.m3u8', copy: true, audio: false }).join(' '), / -an -c copy /);
});

test('a list is read for how much of the stream there is', () => {
  assert.deepEqual(readList(''), { pieces: 0, ended: false });
  assert.deepEqual(readList('#EXTM3U\n#EXTINF:1.0,\na.ts\n#EXTINF:1.0,\nb.ts\n'), { pieces: 2, ended: false });
  assert.deepEqual(readList('#EXTM3U\n#EXTINF:1.0,\na.ts\n#EXT-X-ENDLIST\n'), { pieces: 1, ended: true });
});

test('what the car is asked to play is named for the page', () => {
  assert.deepEqual(pageItem({ title: 'Stand-in TV - watch', site: 'standin.tv' }), { id: PAGE_ID, title: 'Stand-in TV - watch', channel: '', duration: null, live: true, site: 'standin.tv', thumb: '' });
  assert.equal(pageItem({ title: '', site: 'standin.tv' }).title, 'standin.tv', 'a page with no name goes by its site');
  assert.equal(pageItem({}).title, 'A web page');
  assert.equal(pageItem({ title: '  two\n  lines  ', site: 'x.com' }).title, 'two lines');
  assert.equal(pageItem({ title: 'x'.repeat(500) }).title.length, 200);
});

test('a share is playable once its stream has a few pieces, and over when stopped', async () => {
  const { made, spawnImpl } = fakeFfmpeg();
  const { seen, off } = events('p1');
  assert.deepEqual(await pageStream('p1'), { over: true }, 'nothing shared: nothing to wait for');

  const share = startShare('p1', { size: '480', spawnImpl });
  let ready = false;
  share.onReady = () => (ready = true);
  assert.equal(shareExpected('p1'), true);
  share.write(Buffer.alloc(1000));
  assert.equal(made[0].written, 1000, 'the recording goes to ffmpeg');
  assert.equal(share.taken, 1000);

  // A car that asks now waits for it instead of being turned away.
  const asked = pageStream('p1', { wait: 5000 });
  writeList(share, 2);
  await wait(400);
  assert.equal(ready, false, 'two pieces are not enough to start from');
  writeList(share, 3);
  const got = await asked;
  assert.ok(got.info, 'then it is there');
  assert.equal(ready, true);
  assert.deepEqual(seen, [['live', null]]);
  // (tail: a recording that has to be converted before it is kept can't be read as it arrives.)
  assert.deepEqual(got.info.inputs, [{ url: share.list, list: true, mirror: true, tail: false, hasVideo: true, hasAudio: true }]);
  assert.equal(got.info.live, true);
  assert.equal(got.info.height, 480);

  share.finish('stopped');
  assert.equal(shareExpected('p1'), false, 'stopped is over: nothing is waited for');
  assert.deepEqual(seen, [['live', null], ['over', 'stopped']]);
  assert.deepEqual(await pageStream('p1'), { over: true });
  share.write(Buffer.alloc(10)); // late pieces are dropped quietly
  assert.equal(made[0].written, 1000);
  off();
});

test('a share that drops is waited for, then given up on', async () => {
  const { spawnImpl } = fakeFfmpeg();
  const { seen, off } = events('p2');
  const share = startShare('p2', { spawnImpl });
  writeList(share, 3);
  await wait(300);
  share.finish('dropped');
  assert.equal(shareExpected('p2'), true, 'it may be back in a moment');
  assert.deepEqual(seen, [['live', null]], 'nobody is told it is over yet');
  // A car asking meanwhile waits too, and hears that it is over when the wait runs out.
  assert.deepEqual(await pageStream('p2', { wait: 5000 }), { over: true });
  assert.equal(shareExpected('p2'), false);
  assert.deepEqual(seen, [['live', null], ['over', 'dropped']]);
  off();
});

test('a share that drops and comes back carries on', async () => {
  const { spawnImpl } = fakeFfmpeg();
  const { seen, off } = events('p3');
  const first = startShare('p3', { spawnImpl });
  writeList(first, 3);
  await wait(300);
  first.finish('dropped');
  const back = startShare('p3', { again: true, spawnImpl });
  assert.equal(back.again, true);
  const asked = pageStream('p3', { wait: 5000 });
  writeList(back, 3);
  assert.equal((await asked).info.inputs[0].url, back.list, 'the car is given the new stream');
  await wait(400); // past the time the first one was waited for
  assert.equal(shareExpected('p3'), true);
  assert.deepEqual(seen.map((e) => e[0]), ['live', 'live'], 'and is never told it was over');
  back.finish('stopped');
  off();
});

test('a new share takes the place of the one before it', async () => {
  const { spawnImpl } = fakeFfmpeg();
  const { seen, off } = events('p4');
  const first = startShare('p4', { spawnImpl });
  let replaced = false;
  first.onReplaced = () => (replaced = true);
  const second = startShare('p4', { spawnImpl });
  assert.equal(replaced, true, 'whoever was sharing is told');
  assert.equal(first.done, 'replaced');
  assert.equal(mirror.shareOf('p4'), second);
  assert.deepEqual(seen, [], 'for the car nothing is over');
  let stopped = false;
  second.onStopped = () => (stopped = true);
  endShare('p4');
  assert.equal(stopped, true, 'stopped from elsewhere, the one sharing is told');
  assert.deepEqual(seen, [['over', 'stopped']]);
  endShare('p4'); // nothing left to stop
  off();
});

test('a recording that never becomes video fails in words', async () => {
  const { made, spawnImpl } = fakeFfmpeg();
  const share = startShare('p5', { spawnImpl });
  let said = '';
  share.onFail = (message) => (said = message);
  share.write(Buffer.alloc(500));
  made[0].stderr.emit('data', Buffer.from('pipe:0: Invalid data found when processing input\n'));
  made[0].emit('close', 1);
  assert.match(said, /couldn't be turned into video/);
  assert.equal(share.done, 'failed');
  assert.equal(shareExpected('p5'), false);
});

test('the car reads a page as live video from this machine', () => {
  const info = { inputs: [{ url: '/dev/shm/x/index.m3u8', list: true, mirror: true, hasVideo: true, hasAudio: true }], live: true, mirror: true, height: 720, fps: 30, duration: null };
  assert.equal(chooseCodec('mpeg1', info), 'mpeg1', 'the built-in player is sent MPEG-1');
  assert.equal(chooseCodec('h264', info), 'h264', 'a car that can play H.264 is sent that: about half the data');
  assert.equal(chooseCodec('h264', info, false), 'mpeg1', 'unless this machine has nothing to make it with');
  const h = ffmpegArgs(info, 0, '720', 48000, 'h264').join(' ');
  assert.match(h, /-c:v libx264 -preset superfast -tune zerolatency .*-maxrate 1600k -bufsize 3200k/, 'made here, at a rate a car on mobile data can take');
  assert.match(h, /scale=-2:'min\(720,ih\)':flags=bicubic,fps=30,format=yuv420p/);
  assert.doesNotMatch(h, /-c:v copy|mpeg1video/);
  assert.match(ffmpegArgs(info, 0, '360', 48000, 'h264').join(' '), /-maxrate 450k/, 'and less at a lower quality');
  assert.match(ffmpegArgs(info, 0, '1080', 48000, 'mpeg1').join(' '), /min\(720,ih\).* -b:v 2600k /, 'asked for at 1080p, a page filmed at 720p is sent as 720p is');
  const args = ffmpegArgs(info, 0, '480', 48000, 'mpeg1');
  const s = args.join(' ');
  assert.match(s, /-live_start_index -3 -max_reload 24 -m3u8_hold_counters 24 -i \/dev\/shm\/x\/index\.m3u8/);
  assert.match(s, /-probesize 400000 -analyzeduration 400000 -fflags \+nobuffer -live_start_index/, "this machine's own stream isn't studied for seconds before it is played");
  assert.doesNotMatch(s, /-reconnect|-ss |-copyts|protocol_whitelist/);
  assert.match(s, /-map 0:v:0 -map 0:a:0 /);
  assert.match(s, /scale=-2:'min\(480,ih\)'/, 'at the size the car asked for');

  const silent = ffmpegArgs({ ...info, inputs: [{ ...info.inputs[0], hasAudio: false }] }, 0, '720', 48000, 'mpeg1').join(' ');
  assert.match(silent, / -an /);
});

// ---------- what is playing ----------

function makeStore() {
  return new Store({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'drivepost-')), defaultQuality: '720' });
}
const A = { id: 'aaaaaaaaaaa', title: 'First', duration: 300 };
const B = { id: 'bbbbbbbbbbb', title: 'Second', duration: 300 };
const TV = { url: 'https://standin.tv/watch', title: 'Stand-in TV', site: 'standin.tv' };

test('the page plays only once its picture is there, and only this server says what it is', () => {
  const s = makeStore();
  assert.equal(s.command('play', { item: { id: PAGE_ID } }), 'No page is open right now.');
  assert.equal(s.now, null);

  s.setPage(TV);
  assert.equal(s.publicState().page.phase, 'opening');
  assert.equal(s.command('play', { item: { id: PAGE_ID } }), 'The page is still opening.');
  assert.equal(s.now, null);

  s.setPage({ phase: 'live' });
  assert.deepEqual({ ...s.publicState().page, since: 0 }, { ...TV, phase: 'live', blocker: '', media: null, waiting: false, lag: 0, since: 0 }, 'what is new is added to what was known');
  // Whether the browser's ad blocker was at work when the page opened: 'up', 'late', or not known.
  s.setPage({ blocker: 'late' });
  assert.equal(s.publicState().page.blocker, 'late');
  s.setPage({ title: 'Stand-in TV' });
  assert.equal(s.publicState().page.blocker, 'late', 'kept until something else is said of it');
  s.setPage({ blocker: 'anything else' });
  assert.equal(s.publicState().page.blocker, '');
  assert.equal(s.command('play', { item: { id: PAGE_ID, title: 'Free money', url: 'https://example.com/x', duration: 99 } }), null);
  assert.equal(s.now.title, 'Stand-in TV', 'whatever a phone sends with it is ignored');
  assert.equal(s.now.site, 'standin.tv');
  assert.equal(s.now.live, true);
  assert.equal(s.now.duration, null);
  assert.equal(s.now.url, undefined);
  assert.deepEqual(s.history, [{ id: pageRowId(TV.url), title: 'Stand-in TV', channel: '', duration: null, live: false, url: TV.url, site: 'standin.tv', thumb: '', page: true }],
    'Recent keeps the page, to open again by its address, and not the picture of it that the car plays');

  for (const action of ['enqueue', 'playNext']) {
    assert.match(s.command(action, { item: { id: PAGE_ID } }), /not lined up/);
  }
  assert.deepEqual(s.queue, []);
});

test('the row in the car keeps up with where the page goes', () => {
  const s = makeStore();
  s.setPage({ ...TV, phase: 'live' });
  s.command('play', { item: { id: PAGE_ID } });
  const { seq, key } = s.now;
  s.setPage({ url: 'https://standin.tv/news', title: 'Stand-in News' });
  assert.equal(s.now.title, 'Stand-in News');
  assert.equal(s.now.seq, seq, 'without the stream starting over');
  assert.equal(s.now.key, key);
  assert.equal(s.page.phase, 'live', 'and it stays live');
  assert.equal(s.page.url, 'https://standin.tv/news');
});

test('pausing a page and playing it again starts a fresh stream', () => {
  const s = makeStore();
  s.setPage({ ...TV, phase: 'live' });
  s.command('play', { item: { id: PAGE_ID } });
  const seq = s.now.seq;
  s.command('pause');
  assert.equal(s.now.seq, seq);
  s.command('resume');
  assert.ok(s.now.seq > seq, 'play shows the page as it is now');
  assert.equal(s.paused, false);

  const again = s.now.seq;
  s.command('toggle'); // pause
  assert.equal(s.now.seq, again);
  s.command('toggle'); // play
  assert.ok(s.now.seq > again);

  // Any other video picks up where it was.
  s.command('play', { item: A });
  const other = s.now.seq;
  s.command('pause');
  s.command('resume');
  assert.equal(s.now.seq, other);
});

test("the car's own buttons pause, play and skip in a page's video", () => {
  const s = makeStore();
  const asked = [];
  s.on('pageMedia', (what, by) => asked.push(`${what} ${by}`));
  s.setPage({ ...TV, phase: 'live' });
  s.command('play', { item: { id: PAGE_ID } });
  assert.deepEqual(asked.splice(0), ['show 0'], 'put on: a video that was paused from here plays on');
  s.command('pause');
  s.command('pause');
  assert.deepEqual(asked.splice(0), ['pause 0'], 'paused once, however often it is pressed');
  s.command('resume');
  assert.deepEqual(asked.splice(0), ['play 0']);
  s.command('toggle');
  s.command('toggle');
  assert.deepEqual(asked.splice(0), ['pause 0', 'play 0']);
  const seq = s.now.seq;
  s.command('skip', { by: -10 });
  s.command('skip', { by: 10 });
  assert.deepEqual(asked.splice(0), ['seek -10', 'seek 10'], 'ten seconds back and on are asked of the page');
  assert.equal(s.now.seq, seq, 'and the car keeps the stream it has');
  s.command('seek', { to: 50 });
  assert.deepEqual(asked, [], 'a page has no place of its own to go to');

  // Any other video is this server's to pause and skip in.
  s.command('play', { item: A });
  s.command('pause');
  s.command('resume');
  s.command('skip', { by: 10 });
  assert.deepEqual(asked, []);
});

test('when the page is closed the car moves on', () => {
  const s = makeStore();
  s.setPage({ ...TV, phase: 'live' });
  s.command('play', { item: A });
  s.command('enqueue', { item: B });
  s.command('play', { item: { id: PAGE_ID } });
  s.pageOver();
  assert.equal(s.page, null);
  assert.equal(s.now.id, B.id, 'on to Up Next');

  // Left paused on it: nothing starts playing by itself.
  s.setPage({ ...TV, phase: 'live' });
  s.command('enqueue', { item: A });
  s.command('play', { item: { id: PAGE_ID } });
  s.command('pause');
  s.pageOver();
  assert.equal(s.now, null);
  assert.equal(s.queue.length, 1, 'Up Next is still there');

  // Something else was on: it is left alone.
  s.setPage({ ...TV, phase: 'live' });
  s.command('play', { item: B });
  s.pageOver();
  assert.equal(s.now.id, B.id);
  assert.equal(s.publicState().page, null);
});

test('a page is not brought back by a restart', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drivepost-'));
  const s = new Store({ dataDir, defaultQuality: '720' });
  s.command('play', { item: A });
  s.setPage({ ...TV, phase: 'live' });
  s.command('play', { item: { id: PAGE_ID } });
  s.saveNow();
  clearTimeout(s.saveTimer);
  const after = new Store({ dataDir, defaultQuality: '720' });
  assert.equal(after.now, null, 'no page is open after a restart');
  assert.equal(after.page, null);
  assert.deepEqual(after.history.map((h) => h.id), [pageRowId(TV.url), A.id], 'but Recent still has it, to open again');
  assert.equal(after.history[0].page, true);
  assert.equal(after.history[0].url, TV.url);
});

test('a page that was opened is kept under Recent, to be opened again', () => {
  const s = makeStore();
  s.command('play', { item: A });
  const id = pageRowId(TV.url);
  assert.ok(isPageRowId(id) && id !== pageRowId('https://standin.tv/other'));

  // As it opens it has no name yet: the site's stands in.
  s.setPage({ url: TV.url, site: TV.site, title: '', phase: 'opening' });
  assert.deepEqual(s.history.map((h) => h.id), [id, A.id]);
  assert.equal(s.history[0].title, 'standin.tv');
  // Then it says its name, perhaps twice as it loads.
  s.setPage({ title: 'Loading' });
  s.setPage({ title: 'Stand-in TV: the news at ten', phase: 'live' });
  assert.equal(s.history[0].title, 'Stand-in TV: the news at ten');
  assert.equal(s.history.length, 2, 'one row for it, however often it changes');
  // Later it is steered somewhere else on the site. Recent keeps what it opened as.
  s.pageUrlAt = Date.now() - 60000;
  s.setPage({ title: 'Stand-in TV: something else entirely' });
  assert.equal(s.history[0].title, 'Stand-in TV: the news at ten');
  assert.equal(s.history[0].url, TV.url);

  // Something else is played, and the page is closed.
  s.command('play', { item: B });
  s.setPage(null);
  assert.deepEqual(s.history.map((h) => h.id), [B.id, id, A.id]);

  // Asked for from Recent, it is opened again (server.js does that), not played as a video.
  const asked = [];
  s.on('openPage', (url) => asked.push(url));
  const row = s.publicState().history[1];
  assert.equal(s.command('play', { item: row }), null);
  assert.deepEqual(asked, [TV.url]);
  assert.equal(s.now.id, B.id, 'what the car is playing is left alone until the page is there');
  for (const action of ['enqueue', 'playNext']) assert.match(s.command(action, { item: row }), /not lined up/);
  assert.equal(s.queue.length, 0);
  // Opening again puts it back on top, under the name it had.
  s.setPage({ url: TV.url, site: TV.site, title: '', phase: 'opening' });
  assert.deepEqual(s.history.map((h) => h.id), [id, B.id, A.id]);
  assert.equal(s.history[0].title, 'Stand-in TV: the news at ten');
  // Sent on to another address in the same browser: that is another row.
  s.setPage({ url: 'https://other.example/live', site: 'other.example', title: '' });
  assert.deepEqual(s.history.map((h) => h.site || h.id), ['other.example', 'standin.tv', B.id, A.id]);

  // A row is only what this server made it: an address, and the ID that goes with that address.
  assert.equal(cleanItem({ ...row, url: 'https://evil.example/' }), null);
  assert.equal(cleanItem({ ...row, url: 'javascript:alert(1)' }), null);
  assert.equal(cleanItem({ id: pageRowId('http://192.168.1.1/'), url: 'http://192.168.1.1/', title: 'x' }).site, '192.168.1.1', "(whether an address may be opened is the guard's to say, when it is asked for)");
  const kept = cleanItem({ ...row, title: 'x'.repeat(500), duration: 99, live: true, thumb: 'https://evil.example/p.png', channel: 'someone' });
  assert.deepEqual({ ...kept, title: '' }, { id, title: '', channel: '', duration: null, live: false, url: TV.url, site: 'standin.tv', thumb: '', page: true });
  assert.equal(kept.title.length, 200);
});

test("a page's own video: the screens are told of it, and their own buttons act on it", () => {
  const s = makeStore();
  s.setPage(TV);
  s.setPage({ phase: 'live' });
  assert.equal(s.command('play', { item: { id: PAGE_ID } }), null);
  const asked = [];
  s.on('pageMedia', (what, by) => asked.push([what, Math.round(by)]));
  assert.equal(s.pageMediaTime(), null, 'no video known of yet');
  assert.equal(typeof s.publicState().clock, 'number', "this machine's time goes with it, for screens whose clocks differ");

  const at = Date.now() - 4000;
  s.setPage({ media: { status: 'playing', t: 60, d: 600, rate: 1, seek: true, at } });
  assert.deepEqual(s.publicState().page.media, { status: 'playing', t: 60, d: 600, rate: 1, seek: true, at });
  assert.ok(Math.abs(s.pageMediaTime() - 64) < 0.3, 'four seconds on from where it was said to be');
  assert.equal(s.pausedInPage(), false);
  // The time bar is the video's own: a spot on it is a skip by the difference, made in the browser.
  const seq = s.now.seq;
  s.command('seek', { to: 100 });
  assert.deepEqual(asked.pop(), ['seek', 36]);
  s.command('restart');
  assert.deepEqual(asked.pop(), ['seek', -64]);
  assert.equal(s.now.seq, seq, 'the car goes on showing the page: no new stream for it');

  // Paused in the page itself (from the phone's view of it): the car shows the page all the same, and Play plays the video.
  s.setPage({ media: { status: 'paused', t: 70, d: 600, rate: 1, seek: true, at: Date.now() } });
  assert.equal(s.pausedInPage(), true);
  assert.ok(Math.abs(s.pageMediaTime() - 70) < 0.01, 'a paused video stays where it is');
  s.command('toggle');
  assert.deepEqual(asked.pop(), ['play', 0]);
  assert.equal(s.paused, false);
  assert.equal(s.now.seq, seq);
  s.command('resume');
  assert.deepEqual(asked.pop(), ['play', 0]);

  // Held for a car that isn't keeping up: that isn't a pause anyone made. The pause button then pauses, as ever.
  s.setPage({ waiting: true });
  assert.equal(s.pausedInPage(), false);
  s.command('toggle');
  assert.deepEqual(asked.pop(), ['pause', 0]);
  assert.equal(s.paused, true);
  assert.equal(s.pausedInPage(), false, 'paused from here is paused, not "paused in the page"');
  s.command('resume');
  assert.equal(s.paused, false);
  assert.ok(s.now.seq > seq, 'played again from here: the car starts a new stream of the page');

  // A broadcast has no length; and a page can stop having a video at all.
  s.setPage({ waiting: false, media: { status: 'playing', t: 5, d: null, at: Date.now() } });
  assert.equal(s.publicState().page.media.d, null);
  s.setPage({ media: { status: 'nonsense', t: 'x' } });
  assert.equal(s.publicState().page.media, null);
  s.setPage({ media: null, lag: 3.5 });
  assert.equal(s.publicState().page.media, null);
  assert.equal(s.publicState().page.lag, 3.5);
  s.command('seek', { to: 30 });
  assert.equal(asked.filter((a) => a[0] === 'seek').length, 0, 'nothing to skip in');
});

// ---- the recording, read as it arrives ----
// A transport-stream packet: `pid`, whether it starts something, whether it is marked as a place to start from,
// and (for the start of picture or sound) which of the two it carries.
function packet(pid, { start = false, key = false, stream = 0, fill = 0, pts = null } = {}) {
  const p = Buffer.alloc(188, fill);
  p[0] = 0x47;
  p[1] = (start ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  let body = 4;
  if (key) {
    p[3] = 0x30; // a note ahead of the contents
    p[4] = 7;
    p[5] = 0x50; // "a place to start from", and a clock reading
    body = 12;
  } else p[3] = 0x10;
  if (stream) p.set([0, 0, 1, stream], body);
  if (stream && pts !== null) {
    // ...stamped with the time it was taken at (seconds), in ninety-thousandths.
    const n = Math.round(pts * 90000);
    const part = (shift, mask) => Math.floor(n / 2 ** shift) & mask;
    p.set([0, 0, 0x80, 0x80, 5, 0x21 | (part(30, 7) << 1), part(22, 0xff), (part(15, 0x7f) << 1) | 1, part(7, 0xff), (part(0, 0x7f) << 1) | 1], body + 4);
  }
  return p;
}
function pat(pmtPid) {
  const p = packet(0, { start: true });
  // (no pointer to skip, the table's own eight bytes of heading, then: programme 1 is described at pmtPid)
  p.set([0, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xe0 | (pmtPid >> 8), pmtPid & 0xff], 4);
  return p;
}
const { Tail } = await import('../src/mirror.js');

test('a recording is read as it arrives: from a whole frame a little way back, then frame by frame', () => {
  const t = new Tail();
  const P = pat(0x1000);
  const M = packet(0x1000, { start: true, fill: 0x22 });
  const key = (n) => packet(0x100, { start: true, key: true, stream: 0xe0, fill: n });
  const more = (n) => packet(0x100, { fill: n });
  const sound = (n) => packet(0x101, { start: true, key: true, stream: 0xc0, fill: n });
  assert.equal(t.ready, false);
  assert.equal(t.join(800, () => {}), null, 'nothing to start on yet');
  t.push(Buffer.concat([P, M, more(1), sound(2)]), 1000);
  assert.equal(t.ready, false, 'sound is marked as a place to start at every turn: it is a whole frame of picture that counts');
  // Whole frames at 1500, 2000 and 2500, with the rest of each and some sound between; and packets split across deliveries.
  const a = Buffer.concat([key(10), more(11), sound(12)]);
  t.push(a.subarray(0, 300), 1500);
  t.push(a.subarray(300), 1510);
  t.push(Buffer.concat([more(13), key(20), more(21)]), 2000);
  t.push(Buffer.concat([P, M, key(30), more(31)]), 2500);
  t.push(more(32), 2600);
  assert.equal(t.ready, true);

  const got = [];
  const j = t.join(800, (d) => got.push(d), 2900);
  // The newest whole frame that is at least 0.8 s old is the one from 2000 (the one from 2500 is only 0.4 s old).
  assert.equal(j.startedAt, 2000);
  assert.equal(j.first.length % 188, 0);
  const fills = (buf) => { const out = []; for (let o = 0; o < buf.length; o += 188) out.push(buf[o + 187]); return out; };
  assert.deepEqual(fills(j.first), [fills(P)[0], 0x22, 20, 21, fills(P)[0], 0x22, 30, 31, 32], 'what the stream is, then everything from that frame on');
  assert.ok(j.first.subarray(0, 188).equals(P) && j.first.subarray(188, 376).equals(M));
  t.push(more(33), 2950);
  assert.deepEqual(got.map(fills), [[33]], 'and after that, what arrives as it arrives');

  // Asked for further back than there is: the oldest whole frame there is.
  assert.equal(t.join(60000, () => {}, 2900).startedAt, 1500);
  // Asked for none of it back: the newest.
  assert.equal(t.join(0, () => {}, 2900).startedAt, 2500);

  j.leave();
  t.push(more(34), 3000);
  assert.equal(got.length, 1, 'a reader that has left hears no more');
  // Only the last few seconds are kept.
  t.push(more(40), 9000);
  assert.equal(t.ready, false, 'the whole frames have aged out, and none has come since');
  t.push(key(50), 9100);
  const ended = [];
  t.join(0, (d) => ended.push(d), 9200);
  t.end();
  assert.deepEqual(ended, [null], 'the end of the recording is said');
  assert.equal(t.join(0, () => {}), null);
});

test('the recording says when each frame was taken, so it is known how late it is arriving', () => {
  const t = new Tail();
  const frame = (pts, key = false) => packet(0x100, { start: true, key, stream: 0xe0, pts });
  t.push(Buffer.concat([pat(0x1000), packet(0x1000, { start: true })]), 99_000);
  assert.equal(t.late(99_000), 0, 'nothing to go by yet');
  // A busy start: the frames taken in the first two seconds get here late, the first of them by two seconds.
  // (The recorder's clock and this one needn't agree: here the stamps are 97 seconds behind it.)
  t.push(frame(3.0, true), 102_000);
  t.push(frame(3.5, true), 102_300);
  const j = t.join(0, () => {}, 102_300);
  assert.equal(j.startedAt, 102_300);
  assert.equal(j.taken(), 102_300, 'as far as is known so far, it got here as soon as it was taken');
  // Then the recorder catches up: what it had waiting arrives at once, and from there each frame as it is taken.
  t.push(frame(4.0, true), 102_400);
  t.push(frame(4.5, true), 102_450);
  t.push(frame(5.0, true), 102_050 + 500);
  for (let i = 0; i < 6; i++) t.push(frame(5.5 + i / 2, true), 102_550 + i * 500);
  // The soonest any frame has got here is 97.05 s after its stamp. The one the reader started on was taken at 3.5: at 100.55, not 102.3.
  assert.ok(Math.abs(j.taken() - 100_550) < 2, String(j.taken()));
  assert.ok(t.late(105_050) < 2, 'and the recording is arriving on time now');
  // A reader who joins now starts on a frame that got here as it was taken.
  const k = t.join(0, () => {}, 105_100);
  assert.ok(Math.abs(k.startedAt - k.taken()) < 2);

  // Later the machine is busy again: frames come half a second late, then stop coming at all.
  for (let i = 0; i < 8; i++) t.push(frame(8.5 + i / 2, true), 105_550 + 500 + i * 500);
  assert.ok(Math.abs(t.late(109_600) - 500) < 2, String(t.late(109_600)));
  assert.ok(Math.abs(t.late(112_550) - 2500) < 2, 'nothing for three seconds: that late at least');
  // Another recording, stamped from its own start: the old sums don't carry over to it, and a reader of the old one keeps its own.
  const was = j.taken();
  t.push(frame(3.0, true), 120_000);
  t.push(frame(3.5, true), 120_500);
  assert.equal(t.late(120_500), 0);
  assert.equal(j.taken(), was);
  // Frames with no stamp at all (which a recording here never has): nothing is known, and nothing is claimed.
  const bare = new Tail();
  bare.push(Buffer.concat([pat(0x1000), packet(0x1000, { start: true }), packet(0x100, { start: true, key: true, stream: 0xe0 })]), 500);
  assert.equal(bare.late(600), 0);
  assert.equal(bare.join(0, () => {}, 600).taken(), 500);
});

test('out of step with the packets, the reader finds its feet again', () => {
  const t = new Tail();
  const junk = Buffer.from([1, 2, 3, 4, 5]);
  t.push(Buffer.concat([junk, pat(0x1000), packet(0x1000, { start: true }), packet(0x100, { start: true, key: true, stream: 0xe0, fill: 7 })]), 100);
  assert.equal(t.ready, true);
  assert.equal(t.join(0, () => {}, 200).first.length, 3 * 188);
});

test("a page's stream is handed to ffmpeg as it arrives where it can be, and read from its pieces where it can't", () => {
  const info = (over) => ({ inputs: [{ url: '/dev/shm/x/index.m3u8', list: true, mirror: true, hasVideo: true, hasAudio: true, ...over }], live: true, mirror: true, height: 720, fps: 30, duration: null });
  const piped = ffmpegArgs(info({ piped: true }), 0, '720', 48000, 'h264').join(' ');
  assert.match(piped, /-probesize 400000 -analyzeduration 400000 -fflags \+nobuffer -f mpegts -i pipe:0 /);
  assert.doesNotMatch(piped, /m3u8|live_start_index/);
  const listed = ffmpegArgs(info({}), 0, '720', 48000, 'h264').join(' ');
  assert.match(listed, /-live_start_index -3 .*-i \/dev\/shm\/x\/index\.m3u8/);
  assert.doesNotMatch(listed, /pipe:0/);
});
