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

// Have ffmpeg read the video the way a stream would; true once real data has come out.
function ffmpegReads(info) {
  return new Promise((resolve) => {
    const codec = chooseCodec('h264', info, true);
    const ff = spawn(config.ffmpegBin, ffmpegArgs(info, 0, quality, 48000, codec), { stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0;
    let err = '';
    const done = (result) => {
      clearTimeout(timer);
      ff.kill('SIGKILL');
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: bytes > 0, note: bytes > 0 ? `${codec}, slow start` : 'nothing after 25 seconds' }), 25000);
    ff.stdout.on('data', (d) => {
      bytes += d.length;
      if (bytes > 300 * 1024) done({ ok: true, note: codec === 'h264' ? 'H.264 passed through' : 'converted to MPEG-1' });
    });
    ff.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    ff.on('error', (e) => done({ ok: false, note: `could not run ffmpeg: ${e.message}` }));
    ff.on('close', (code) => done(bytes > 300 * 1024 ? { ok: true, note: codec } : { ok: false, note: failureReason(err, code).said }));
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
  const found = `found ${info.height}p ${info.vcodec || '?'} (${info.route.replace(/^\w+: /, '').replace(/ from \S+$/, '')}) in ${((Date.now() - started) / 1000).toFixed(1)}s`;
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
  console.log(`${found}\n        link answers ${answers.join(', ')}; ffmpeg ${read.ok ? `PLAYS it (${read.note})` : `FAILS: ${read.note}`}`);
  if (read.ok && !winner) winner = route.name;
}
console.log(winner ? `\nThe server will use the "${winner}" route.` : '\nNo route works right now.');
process.exit(0);
