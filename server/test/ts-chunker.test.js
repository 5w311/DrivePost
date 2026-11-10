import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { TsChunker, readPts } from '../src/ts-chunker.js';
import { extractVideoId } from '../src/youtube.js';
import { ffmpegArgs } from '../src/stream.js';

function makeTs(seconds) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`,
    '-c:v', 'mpeg1video', '-b:v', '400k', '-bf', '0',
    '-c:a', 'mp2', '-b:a', '64k',
    '-f', 'mpegts', '-muxdelay', '0.001', '-muxpreload', '0', 'pipe:1',
  ], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
}

test('chunks cover every byte, in order, with rising timestamps', () => {
  const ts = makeTs(4);
  const chunks = [];
  const c = new TsChunker((pts, data) => chunks.push({ pts, data }));
  // Feed in odd-sized pieces like a pipe would.
  for (let i = 0; i < ts.length; i += 7001) c.push(ts.subarray(i, i + 7001));
  c.flush();

  const joined = Buffer.concat(chunks.map((x) => x.data));
  assert.equal(joined.length, ts.length);
  assert.ok(joined.equals(ts));

  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i].pts >= chunks[i - 1].pts, 'pts must not go backwards');
  const span = chunks[chunks.length - 1].pts - c.firstPts;
  assert.ok(span > 3.5 && span < 4.6, `span was ${span}`);
  // ~0.2 s per chunk at this bitrate
  assert.ok(chunks.length > 12, `only ${chunks.length} chunks`);
});

test('readPts ignores packets without a PES start', () => {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47;
  p[1] = 0x00;
  p[3] = 0x10;
  assert.equal(readPts(p), null);
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

test('ffmpeg arguments map video and audio from separate inputs', () => {
  const args = ffmpegArgs(
    {
      live: false,
      height: 480,
      inputs: [
        { url: 'https://v.example/video', headers: { 'User-Agent': 'x' }, hasVideo: true, hasAudio: false },
        { url: 'https://v.example/audio', headers: {}, hasVideo: false, hasAudio: true },
      ],
    },
    90,
    '480'
  );
  const s = args.join(' ');
  assert.match(s, /-ss 90 -i https:\/\/v\.example\/video/);
  assert.match(s, /-ss 90 -i https:\/\/v\.example\/audio/);
  assert.match(s, /-map 0:v:0 -map 1:a:0/);
  assert.match(s, /-c:v mpeg1video/);
  assert.match(s, /-f mpegts/);
});
