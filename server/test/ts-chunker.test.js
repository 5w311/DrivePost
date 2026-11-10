import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { TsSplitter, readPes, readPts, KIND_VIDEO, KIND_AUDIO } from '../src/ts-chunker.js';
import { extractVideoId } from '../src/youtube.js';
import { ffmpegArgs, outputRate } from '../src/stream.js';

function makeTs(seconds, { fps = 30, ar = 48000 } = {}) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${fps}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-c:v', 'mpeg1video', '-b:v', '400k', '-bf', '0', '-g', String(fps * 2),
    '-c:a', 'mp2', '-b:a', '128k', '-ar', String(ar), '-ac', '2',
    '-f', 'mpegts', '-muxdelay', '0.001', '-muxpreload', '0', 'pipe:1',
  ], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
}

function split(ts, opts) {
  const chunks = [];
  const s = new TsSplitter((kind, pts, data) => chunks.push({ kind, pts, data }), opts);
  // Feed in odd-sized pieces like a pipe would.
  for (let i = 0; i < ts.length; i += 7001) s.push(ts.subarray(i, i + 7001));
  s.flush();
  return { chunks, s };
}

function pesStarts(buf, from = 0) {
  let n = 0;
  for (let o = from; o + 188 <= buf.length; o += 188) if (readPes(buf.subarray(o, o + 188))) n++;
  return n;
}

test('every video chunk is exactly one frame, in order, with rising timestamps', () => {
  const ts = makeTs(4, { fps: 30 });
  const { chunks, s } = split(ts);
  const video = chunks.filter((c) => c.kind === KIND_VIDEO);

  assert.equal(video.length, 120, 'one chunk per frame');
  assert.equal(s.videoFrames, 120);
  for (const c of video) {
    assert.equal(c.data.length % 188, 0);
    assert.equal(pesStarts(c.data), 1, 'one frame start per chunk');
    assert.equal(readPts(c.data.subarray(0, 188)), c.pts, 'tagged with its own timestamp');
  }
  for (let i = 1; i < video.length; i++) {
    const step = video[i].pts - video[i - 1].pts;
    assert.ok(Math.abs(step - 1 / 30) < 0.002, `frame step was ${step}`);
  }
  assert.equal(s.firstVideoPts, video[0].pts);
});

test('audio chunks hold whole frames, about a tenth of a second each, back to back', () => {
  const ts = makeTs(4, { ar: 48000 });
  const { chunks } = split(ts);
  const audio = chunks.filter((c) => c.kind === KIND_AUDIO);
  const frame = 1152 / 48000;

  assert.ok(audio.length >= 30 && audio.length <= 45, `${audio.length} audio chunks`);
  let frames = 0;
  for (let i = 0; i < audio.length; i++) {
    const n = pesStarts(audio[i].data);
    frames += n;
    assert.ok(n >= 1 && n <= 6, `${n} audio frames in one chunk`);
    assert.equal(readPts(audio[i].data.subarray(0, 188)), audio[i].pts);
    // ffmpeg must write one audio frame per packet, or timestamps get coarse
    if (i > 0) assert.ok(Math.abs(audio[i].pts - audio[i - 1].pts - pesStarts(audio[i - 1].data) * frame) < 0.002, 'chunks are contiguous');
  }
  assert.ok(Math.abs(frames * frame - 4) < 0.1, `audio covers ${frames * frame}s`);
});

test('nothing but program tables is dropped, and the prefix is reserved', () => {
  const ts = makeTs(2);
  const { chunks } = split(ts, { prefix: 9 });
  let av = 0;
  for (let o = 0; o + 188 <= ts.length; o += 188) {
    const pid = ((ts[o + 1] & 0x1f) << 8) | ts[o + 2];
    if (pid !== 0 && pid !== 0x11 && pid !== 0x1000 && pid !== 0x1fff) av++;
  }
  const sent = chunks.reduce((n, c) => n + (c.data.length - 9) / 188, 0);
  assert.equal(sent, av, 'every audio and video packet is passed on');
  for (const c of chunks) assert.equal(c.data[9], 0x47, 'payload starts after the reserved header');
});

test('readPes ignores packets without a PES start', () => {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47;
  p[1] = 0x00;
  p[3] = 0x10;
  assert.equal(readPes(p), null);
});

test('extracts YouTube IDs from shared links and text', () => {
  const id = 'dQw4w9WgXcQ';
  for (const s of [
    id,
    `https://www.youtube.com/watch?v=${id}`,
    `https://m.youtube.com/watch?feature=share&v=${id}&t=30`,
    `https://youtu.be/${id}?si=abc123`,
    `https://youtube.com/shorts/${id}?feature=share`,
    `https://www.youtube.com/live/${id}`,
    `Check this out https://youtu.be/${id} lol`,
    `https://music.youtube.com/watch?v=${id}&list=RD`,
  ]) assert.equal(extractVideoId(s), id, s);
  assert.equal(extractVideoId('https://example.com/watch?v=nope'), null);
  assert.equal(extractVideoId(''), null);
});

test('frame rate stays native when MPEG-1 allows it', () => {
  assert.equal(outputRate(24).expr, '24');
  assert.equal(outputRate(23.976).expr, '24000/1001');
  assert.equal(outputRate(25).expr, '25');
  assert.equal(outputRate(29.97).expr, '30000/1001');
  assert.equal(outputRate(30).expr, '30');
  assert.equal(outputRate(50).expr, '25');
  assert.equal(outputRate(59.94).expr, '30000/1001');
  assert.equal(outputRate(60).expr, '30');
  assert.equal(outputRate(120).expr, '30');
  assert.equal(outputRate(15).expr, '30');
  assert.equal(outputRate(12).expr, '24');
  assert.equal(outputRate(null).expr, '30');
});

test('ffmpeg arguments map video and audio from separate inputs', () => {
  const info = {
    live: false,
    height: 1080,
    fps: 24,
    inputs: [
      { url: 'https://v.example/video', headers: { 'User-Agent': 'x' }, hasVideo: true, hasAudio: false },
      { url: 'https://v.example/audio', headers: {}, hasVideo: false, hasAudio: true },
    ],
  };
  const s = ffmpegArgs(info, 90, '1080', 44100).join(' ');
  assert.match(s, /-ss 90 -i https:\/\/v\.example\/video/);
  assert.match(s, /-ss 90 -i https:\/\/v\.example\/audio/);
  assert.match(s, /-map 0:v:0 -map 1:a:0/);
  assert.match(s, /min\(1080,ih\)/);
  assert.match(s, /fps=24,/);
  assert.match(s, /-b:v 5000k/);
  assert.match(s, /-g 48 /);
  assert.match(s, /-b:a 192k -ar 44100 /);
  assert.match(ffmpegArgs(info, 0, '480', 48000).join(' '), /-b:a 128k -ar 48000 /);
  assert.match(s, /-c:v mpeg1video/);
  assert.match(s, /-f mpegts/);
});
