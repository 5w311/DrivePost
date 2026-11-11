import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { TsSplitter, readPes, KIND_VIDEO, KIND_AUDIO } from '../src/ts-chunker.js';
import { chooseCodec, ffmpegArgs } from '../src/stream.js';

const youtube = (vcodec) => ({
  live: false,
  height: 1080,
  fps: 24,
  vcodec,
  inputs: [
    { url: 'https://v.example/video', headers: {}, hasVideo: true, hasAudio: false, vcodec },
    { url: 'https://v.example/audio', headers: {}, hasVideo: false, hasAudio: true },
  ],
});
const pattern = {
  live: false,
  height: 480,
  fps: 30,
  vcodec: 'generated',
  inputs: [
    { lavfi: 'testsrc2=size=854x480:rate=30:duration=600', hasVideo: true, hasAudio: false },
    { lavfi: 'sine=frequency=440:sample_rate=48000:duration=600', hasVideo: false, hasAudio: true },
  ],
};

test('H.264 is passed through only when the car asks for it and YouTube has it', () => {
  assert.equal(chooseCodec('h264', youtube('avc1.640028')), 'h264');
  assert.equal(chooseCodec('h264', youtube('AVC1.4d401f')), 'h264');
  assert.equal(chooseCodec('mpeg1', youtube('avc1.640028')), 'mpeg1', 'the car did not ask');
  assert.equal(chooseCodec(undefined, youtube('avc1.640028')), 'mpeg1', 'older car pages never ask');
  assert.equal(chooseCodec('h264', youtube('vp09.00.40.08')), 'mpeg1', 'VP9 has to be converted');
  assert.equal(chooseCodec('h264', youtube('av01.0.08M.08')), 'mpeg1');
  assert.equal(chooseCodec('h264', youtube('')), 'mpeg1', 'unknown is treated as not H.264');
  assert.equal(chooseCodec('h264', { ...youtube('avc1.640028'), live: true }), 'mpeg1', 'live streams are converted');
  // The test pattern is made here, so it is H.264 whenever this ffmpeg can encode it.
  assert.equal(chooseCodec('h264', pattern, true), 'h264');
  assert.equal(chooseCodec('h264', pattern, false), 'mpeg1');
  assert.equal(chooseCodec('mpeg1', pattern, true), 'mpeg1');
});

test('passing H.264 through copies the picture and still converts the sound', () => {
  const s = ffmpegArgs(youtube('avc1.640028'), 90, '1080', 44100, 'h264').join(' ');
  assert.match(s, /-ss 90 -i https:\/\/v\.example\/video/);
  assert.match(s, /-ss 90 -i https:\/\/v\.example\/audio/);
  assert.match(s, /-map 0:v:0 -map 1:a:0/);
  assert.match(s, /-c:v copy -bsf:v h264_mp4toannexb /);
  assert.doesNotMatch(s, /mpeg1video|-vf |scale=|-b:v /, 'the picture is not touched');
  assert.match(s, /-c:a mp2 -b:a 192k -ar 44100 -ac 2/);
  assert.match(s, /-f mpegts/);
  // Leaving the format out keeps the old behaviour.
  assert.match(ffmpegArgs(youtube('avc1.640028'), 90, '1080', 44100).join(' '), /-c:v mpeg1video/);
});

test('the test pattern is encoded as H.264 with B-frames, like YouTube files', () => {
  const s = ffmpegArgs(pattern, 0, '480', 48000, 'h264').join(' ');
  assert.match(s, /-c:v libx264 /);
  assert.match(s, /-bf 2 /);
  assert.doesNotMatch(s, /-c:v copy|mpeg1video/);
  assert.match(ffmpegArgs(pattern, 0, '480', 48000, 'mpeg1').join(' '), /-c:v mpeg1video/);
});

// ---- splitting a real H.264 stream ----

function hasX264() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-h', 'encoder=libx264']);
  return r.status === 0 && /Encoder libx264/.test(String(r.stdout));
}

function makeH264Ts(seconds, fps) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${fps}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-g', String(fps * 2),
    '-c:a', 'mp2', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-f', 'mpegts', '-muxdelay', '0.001', '-muxpreload', '0', 'pipe:1',
  ], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
}

// The bytes a decoder gets from one chunk: its TS packets with the TS and PES
// headers taken off.
function payload(chunk) {
  const parts = [];
  for (let o = 0; o + 188 <= chunk.length; o += 188) {
    const p = chunk.subarray(o, o + 188);
    const adaptation = (p[3] >> 4) & 3;
    let at = 4;
    if (adaptation & 2) at += 1 + p[4];
    if (!(adaptation & 1) || at >= 188) continue;
    if (p[1] & 0x40) at += 9 + p[at + 8]; // PES header at the start of the frame
    parts.push(p.subarray(at));
  }
  return Buffer.concat(parts);
}

function nalTypes(bytes) {
  const types = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) types.push(bytes[i + 3] & 0x1f);
  }
  return types;
}

test('an H.264 stream with B-frames is split into one frame per chunk', { skip: !hasX264() && 'this ffmpeg has no libx264' }, () => {
  const fps = 30;
  const ts = makeH264Ts(4, fps);
  const chunks = [];
  const s = new TsSplitter((kind, pts, data) => chunks.push({ kind, pts, data: Buffer.from(data) }));
  for (let i = 0; i < ts.length; i += 7001) s.push(ts.subarray(i, i + 7001));
  s.flush();

  const video = chunks.filter((c) => c.kind === KIND_VIDEO);
  assert.equal(video.length, 4 * fps, 'one chunk per frame');
  for (const c of video) {
    assert.equal(c.data.length % 188, 0);
    let starts = 0;
    for (let o = 0; o + 188 <= c.data.length; o += 188) if (readPes(c.data.subarray(o, o + 188))) starts++;
    assert.equal(starts, 1, 'one frame start per chunk');
  }

  // B-frames mean frames are sent in decoding order, not display order...
  const sent = video.map((c) => c.pts);
  const shown = [...sent].sort((a, b) => a - b);
  assert.notDeepEqual(sent, shown, 'expected out-of-order timestamps');
  // ...but every display time is there exactly once, evenly spaced.
  for (let i = 1; i < shown.length; i++) {
    assert.ok(Math.abs(shown[i] - shown[i - 1] - 1 / fps) < 0.002, `step was ${shown[i] - shown[i - 1]}`);
  }

  // The first frame is a keyframe that carries the stream settings, which is
  // what the car's decoder needs to start; the rest hold exactly one picture.
  const first = nalTypes(payload(video[0].data));
  assert.ok(first.includes(7) && first.includes(8) && first.includes(5), `first frame had NAL types ${first}`);
  let keyframes = 0;
  for (const c of video) {
    const types = nalTypes(payload(c.data));
    const pictures = types.filter((t) => t === 1 || t === 5).length;
    assert.ok(pictures >= 1, 'every chunk has picture data');
    if (types.includes(5)) {
      keyframes++;
      assert.ok(types.includes(7), 'keyframes repeat the stream settings');
    }
  }
  assert.equal(keyframes, 2, 'a keyframe every two seconds');
  assert.ok(chunks.some((c) => c.kind === KIND_AUDIO));
});
