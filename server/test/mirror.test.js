import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A dropped share is waited for this long (20 seconds on a real server).
process.env.SCREEN_BACK_MS = '250';
process.env.SCREEN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'drivepost-screens-'));
const mirror = await import('../src/mirror.js');
const { Store } = await import('../src/state.js');
const { ffmpegArgs, chooseCodec } = await import('../src/stream.js');
const { SCREEN_ID, ingestArgs, readList, screenItem, startShare, endShare, shareExpected, sharedScreen, onShare } = mirror;

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
  assert.match(s, /-g 30 -keyint_min 30 -sc_threshold 0/, 'every one-second piece starts on a whole frame');
  assert.match(s, /-map 0:a:0\? .*-c:a aac .*-ar 48000 -ac 2/, 'sound, if the recording has any');
  assert.match(s, /-f hls -hls_time 1 .*delete_segments/);
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

  // A picture that arrives on its side is turned before anything else is done to it.
  assert.match(ingestArgs({ list: '/x/index.m3u8', turn: 90 }).join(' '), /-vf transpose=1,fps=30,scale=1280:720/);
  assert.match(ingestArgs({ list: '/x/index.m3u8', turn: 270 }).join(' '), /-vf transpose=2,fps=30/);
  assert.match(ingestArgs({ list: '/x/index.m3u8', turn: 180 }).join(' '), /-vf hflip,vflip,fps=30/);
  assert.match(ingestArgs({ list: '/x/index.m3u8', turn: '45; rm -rf /' }).join(' '), /-vf fps=30/, 'anything else is no turn at all');

  const old = ingestArgs({ list: '/x/index.m3u8', h264: false }).join(' ');
  assert.match(old, /-c:v mpeg2video/, 'an ffmpeg without H.264 still keeps a copy');
  assert.doesNotMatch(old, /libx264/);
});

test('a list is read for how much of the stream there is', () => {
  assert.deepEqual(readList(''), { pieces: 0, ended: false });
  assert.deepEqual(readList('#EXTM3U\n#EXTINF:1.0,\na.ts\n#EXTINF:1.0,\nb.ts\n'), { pieces: 2, ended: false });
  assert.deepEqual(readList('#EXTM3U\n#EXTINF:1.0,\na.ts\n#EXT-X-ENDLIST\n'), { pieces: 1, ended: true });
});

test('what the car is asked to play says what is shared', () => {
  assert.deepEqual(screenItem('browser'), { id: SCREEN_ID, title: 'Shared tab', channel: '', duration: null, live: true, site: 'Screen share', thumb: '' });
  assert.equal(screenItem('window').title, 'Shared window');
  assert.equal(screenItem('monitor').title, 'Shared screen');
  assert.equal(screenItem('<script>').title, 'Shared screen', 'anything else a page claims is a screen');
});

test('a share is playable once its stream has a few pieces, and over when stopped', async () => {
  const { made, spawnImpl } = fakeFfmpeg();
  const { seen, off } = events('p1');
  assert.deepEqual(await sharedScreen('p1'), { over: true }, 'nothing shared: nothing to wait for');

  const share = startShare('p1', { size: '480', surface: 'browser', spawnImpl });
  let ready = false;
  share.onReady = () => (ready = true);
  assert.equal(shareExpected('p1'), true);
  share.write(Buffer.alloc(1000));
  assert.equal(made[0].written, 1000, 'the recording goes to ffmpeg');
  assert.equal(share.taken, 1000);

  // A car that asks now waits for it instead of being turned away.
  const asked = sharedScreen('p1', { wait: 5000 });
  writeList(share, 2);
  await wait(400);
  assert.equal(ready, false, 'two pieces are not enough to start from');
  writeList(share, 3);
  const got = await asked;
  assert.ok(got.info, 'then it is there');
  assert.equal(ready, true);
  assert.deepEqual(seen, [['live', null]]);
  assert.deepEqual(got.info.inputs, [{ url: share.list, list: true, mirror: true, hasVideo: true, hasAudio: true }]);
  assert.equal(got.info.live, true);
  assert.equal(got.info.height, 480);

  share.finish('stopped');
  assert.equal(shareExpected('p1'), false, 'stopped is over: nothing is waited for');
  assert.deepEqual(seen, [['live', null], ['over', 'stopped']]);
  assert.deepEqual(await sharedScreen('p1'), { over: true });
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
  assert.deepEqual(await sharedScreen('p2', { wait: 5000 }), { over: true });
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
  const asked = sharedScreen('p3', { wait: 5000 });
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

test('the car reads a shared screen as live video from this machine', () => {
  const info = { inputs: [{ url: '/dev/shm/x/index.m3u8', list: true, mirror: true, hasVideo: true, hasAudio: true }], live: true, mirror: true, height: 720, fps: 30, duration: null };
  assert.equal(chooseCodec('h264', info), 'mpeg1', 'converted, as live video is');
  const args = ffmpegArgs(info, 0, '480', 48000, 'mpeg1');
  const s = args.join(' ');
  assert.match(s, /-live_start_index -3 -max_reload 24 -m3u8_hold_counters 24 -i \/dev\/shm\/x\/index\.m3u8/);
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

test('the shared screen plays only while one is shared, and only this server says what it is', () => {
  const s = makeStore();
  assert.equal(s.command('play', { item: { id: SCREEN_ID } }), 'Nothing is being shared right now.');
  assert.equal(s.now, null);

  s.setScreen({ surface: 'browser' });
  assert.equal(s.publicState().screen.surface, 'browser');
  assert.equal(s.command('play', { item: { id: SCREEN_ID, title: 'Free money', url: 'https://example.com/x', duration: 99 } }), null);
  assert.equal(s.now.title, 'Shared tab', 'whatever a page sends with it is ignored');
  assert.equal(s.now.live, true);
  assert.equal(s.now.duration, null);
  assert.equal(s.now.url, undefined);
  assert.deepEqual(s.history, [], 'it is not kept under Recent');

  for (const action of ['enqueue', 'playNext']) {
    assert.match(s.command(action, { item: { id: SCREEN_ID } }), /not lined up/);
  }
  assert.deepEqual(s.queue, []);
});

test('pausing a shared screen and playing it again starts a fresh stream', () => {
  const s = makeStore();
  s.setScreen({ surface: 'monitor' });
  s.command('play', { item: { id: SCREEN_ID } });
  const seq = s.now.seq;
  s.command('pause');
  assert.equal(s.now.seq, seq);
  s.command('resume');
  assert.ok(s.now.seq > seq, 'play shows the screen as it is now');
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

test('when sharing is over the car moves on', () => {
  const s = makeStore();
  s.setScreen({ surface: 'window' });
  s.command('play', { item: A });
  s.command('enqueue', { item: B });
  s.command('play', { item: { id: SCREEN_ID } });
  s.screenOver();
  assert.equal(s.screen, null);
  assert.equal(s.now.id, B.id, 'on to Up Next');

  // Left paused on it: nothing starts playing by itself.
  s.setScreen({ surface: 'window' });
  s.command('enqueue', { item: A });
  s.command('play', { item: { id: SCREEN_ID } });
  s.command('pause');
  s.screenOver();
  assert.equal(s.now, null);
  assert.equal(s.queue.length, 1, 'Up Next is still there');

  // Something else was on: it is left alone.
  s.setScreen({ surface: 'window' });
  s.command('play', { item: B });
  s.screenOver();
  assert.equal(s.now.id, B.id);
  assert.equal(s.publicState().screen, null);
});

test('a shared screen is not brought back by a restart', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drivepost-'));
  const s = new Store({ dataDir, defaultQuality: '720' });
  s.command('play', { item: A });
  s.setScreen({ surface: 'browser' });
  s.command('play', { item: { id: SCREEN_ID } });
  s.saveNow();
  clearTimeout(s.saveTimer);
  const after = new Store({ dataDir, defaultQuality: '720' });
  assert.equal(after.now, null, 'there is no share after a restart');
  assert.equal(after.screen, null);
  assert.deepEqual(after.history.map((h) => h.id), [A.id]);
});
