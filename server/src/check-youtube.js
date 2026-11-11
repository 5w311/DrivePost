/*
 * Which ways of getting a video from YouTube work from this machine, right now?
 *
 *   docker compose exec -T drivepost node src/check-youtube.js [video-id] [quality]
 *
 * Tries every route the server knows (see ROUTES in youtube.js) the same way
 * the server does: looks the video up, asks for the first bytes of what it is
 * given, and has ffmpeg read a few seconds of it. Prints one short block per
 * route and no links, so the output is safe to share.
 */
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { ROUTES, streamInfo, linkStatus } from './youtube.js';
import { ffmpegArgs, chooseCodec, failureReason, refusalReason } from './stream.js';

const id = process.argv[2] || '9Yz3TdftSPs';
const quality = process.argv[3] || '1080';

// Have ffmpeg read the video the way a stream would, for a few seconds, and
// say how fast it comes in compared with how fast it plays.
function ffmpegReads(info) {
  return new Promise((resolve) => {
    const codec = chooseCodec('h264', info, true);
    const args = ['-progress', 'pipe:2', '-nostats', ...ffmpegArgs(info, 0, quality, 48000, codec)];
    const ff = spawn(config.ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const began = Date.now();
    let bytes = 0;
    let err = '';
    let mediaSeconds = 0;
    let finished = false;
    const done = (failure) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ff.kill('SIGKILL');
      const wall = (Date.now() - began) / 1000;
      if (failure || bytes < 100 * 1024) return resolve({ ok: false, note: failure || 'nothing came through in 14 seconds' });
      const x = mediaSeconds / wall;
      const how = codec === 'h264' ? 'H.264 passed through' : 'converted to MPEG-1';
      const pace = x >= 1.5 ? 'fast enough' : x >= 1.05 ? 'only just fast enough' : 'TOO SLOW to play without stopping';
      resolve({ ok: x >= 1.05, note: `${how}, ${mediaSeconds.toFixed(0)}s of video in ${wall.toFixed(0)}s = ${x.toFixed(1)}x, ${pace}` });
    };
    const timer = setTimeout(() => done(), 14000);
    ff.stdout.on('data', (d) => (bytes += d.length));
    ff.stderr.on('data', (d) => {
      const text = String(d);
      const m = [...text.matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
      if (m) mediaSeconds = Number(m[1]) / 1e6;
      err = (err + text.replace(/^[a-z_0-9]+=.*$/gm, '')).slice(-2000);
    });
    ff.on('error', (e) => done(`could not run ffmpeg: ${e.message}`));
    ff.on('close', (code) => done(bytes < 100 * 1024 ? failureReason(err, code).said : ''));
  });
}

console.log(`Checking video ${id} at ${quality}p from this machine\n`);
let winner = null;
for (const route of ROUTES) {
  const started = Date.now();
  process.stdout.write(`${route.name.padEnd(7)} `);
  let info;
  try {
    info = await streamInfo(id, quality, route.name);
  } catch (e) {
    console.log(`lookup failed: ${String(e.message).slice(0, 110)}`);
    continue;
  }
  let found = `found ${info.height}p ${info.vcodec || '?'} (${info.route.replace(/^\w+: /, '').replace(/ from \S+$/, '')}) in ${((Date.now() - started) / 1000).toFixed(1)}s`;
  // YouTube holds some files back for the length of an ad. Wait it out, as the server would.
  const wait = (info.readyAt || 0) - Date.now();
  if (wait > 0) {
    found += `, usable after a ${Math.ceil(wait / 1000)}s wait`;
    if (wait > 90000) {
      console.log(`${found}\n        too long a wait: the server would not use this`);
      continue;
    }
    await new Promise((done) => setTimeout(done, wait + 300));
  }
  let answers;
  try {
    answers = await Promise.all(info.inputs.filter((i) => i.url).map((i) => linkStatus(i)));
  } catch (e) {
    console.log(`${found}\n        link check failed: ${String(e.cause?.message || e.message).slice(0, 90)}`);
    continue;
  }
  const bad = answers.find((a) => a !== 200 && a !== 206);
  if (bad !== undefined) {
    console.log(`${found}\n        REFUSED: ${refusalReason(bad)}`);
    continue;
  }
  const read = await ffmpegReads(info);
  console.log(`${found}\n        link answers ${answers.join(', ')}; ffmpeg ${read.ok ? 'PLAYS it' : 'FAILS'}: ${read.note}`);
  if (read.ok && !winner) winner = route.name;
}
console.log(winner ? `\nThe server takes the first route in this list that is ready and plays: "${winner}".` : '\nNo route works right now.');
process.exit(0);
