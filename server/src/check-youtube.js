/*
 * Which ways of getting a video from YouTube work from this machine, right now?
 *
 *   docker compose exec -T drivepost node src/check-youtube.js [video-id] [quality]
 *
 * Tries every route the server knows (see ROUTES in youtube.js) the same way
 * the server does: looks the video up, asks for the first bytes of what it is
 * given, has ffmpeg read some of it from the top, and then starts it partway
 * through the way a skip would. Prints one short block per route and no
 * links, so the output is safe to share.
 */
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { ROUTES, streamInfo, linkStatus } from './youtube.js';
import { ffmpegArgs, chooseCodec, failureReason, refusalReason, cutLists } from './stream.js';
import { TsSplitter, KIND_VIDEO } from './ts-chunker.js';

const id = process.argv[2] || '9Yz3TdftSPs';
const quality = process.argv[3] || '1080';

/*
 * Have ffmpeg read the video the way a stream would, for up to `forMs`, from
 * `startAt` seconds in. Reports how fast it comes in compared with how fast
 * it plays, and where its picture and its sound begin.
 */
function ffmpegReads(info, { startAt = 0, cuts = null, forMs = 14000 } = {}) {
  return new Promise((resolve) => {
    const codec = chooseCodec('h264', info, true);
    const args = ['-progress', 'pipe:2', '-nostats', ...ffmpegArgs(info, startAt, quality, 48000, codec, cuts)];
    const ff = spawn(config.ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const began = Date.now();
    let bytes = 0;
    let err = '';
    let mediaSeconds = 0;
    let finished = false;
    let firstPicture = null; // stream time of the first picture and of the first sound
    let lastPicture = null;
    let firstSound = null;
    let pictureAfterMs = null;
    const splitter = new TsSplitter((kind, pts) => {
      if (kind === KIND_VIDEO) {
        if (firstPicture === null) pictureAfterMs = Date.now() - began;
        firstPicture = firstPicture === null ? pts : Math.min(firstPicture, pts);
        lastPicture = lastPicture === null ? pts : Math.max(lastPicture, pts);
      } else if (firstSound === null) firstSound = pts;
    });
    const done = (failure) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ff.kill('SIGKILL');
      const wall = (Date.now() - began) / 1000;
      if (failure || bytes < 100 * 1024) return resolve({ ok: false, note: failure || `nothing came through in ${Math.round(forMs / 1000)} seconds` });
      // How much video came through, by its own timestamps (ffmpeg's progress
      // count can't be used: a stream that keeps its own clock doesn't start at zero).
      if (firstPicture !== null) mediaSeconds = lastPicture - firstPicture;
      const x = mediaSeconds / wall;
      const how = codec === 'h264' ? 'H.264 passed through' : 'converted to MPEG-1';
      const pace = x >= 1.5 ? 'fast enough' : x >= 1.05 ? 'only just fast enough' : 'TOO SLOW to play without stopping';
      resolve({
        ok: x >= 1.05,
        note: `${how}, ${mediaSeconds.toFixed(0)}s of video in ${wall.toFixed(0)}s = ${x.toFixed(1)}x, ${pace}`,
        firstPicture,
        firstSound,
        pictureAfterMs,
      });
    };
    const timer = setTimeout(() => done(), forMs);
    ff.stdout.on('data', (d) => {
      bytes += d.length;
      splitter.push(d);
    });
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

// Start partway through, as a skip does, and say how that lands.
async function skipLands(info, lists) {
  const to = Math.max(10, Math.min(60, Math.floor((info.duration || 120) / 2)));
  const handedOver = [];
  const segmented = info.inputs.some((i) => i.list);
  const cuts = await cutLists(info, to, lists, handedOver);
  const read = await ffmpegReads(info, { startAt: to, cuts, forMs: 8000 });
  handedOver.forEach((list) => list.done());
  const spot = `${Math.floor(to / 60)}:${String(to % 60).padStart(2, '0')}`;
  if (read.firstPicture === null) return `a skip to ${spot} FAILS: ${read.note}`;
  const how = segmented ? (cuts ? 'the server cuts the list' : "ffmpeg's own seeking, which can leave picture and sound out of step") : 'ffmpeg seeks in the file';
  const after = `${(read.pictureAfterMs / 1000).toFixed(1)}s`;
  if (read.firstSound === null) return `a skip to ${spot} starts in ${after} (${how}); no sound came through`;
  // The sound begins on the spot; the picture begins on an earlier whole frame, which the car decodes without showing.
  const lead = read.firstSound - read.firstPicture;
  const where = lead >= -0.05 ? `picture ready ${Math.max(0, lead).toFixed(1)}s before the spot` : `PICTURE BEGINS ${(-lead).toFixed(1)}s AFTER THE SOUND`;
  return `a skip to ${spot} starts in ${after}, ${where} (${how})`;
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
  const lists = new Map();
  let answers;
  try {
    answers = await Promise.all(info.inputs.filter((i) => i.url).map((i) => linkStatus(i, fetch, lists)));
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
  // From the top, picture and sound begin together, give or take a few frames.
  const apart = read.firstPicture !== null && read.firstSound !== null ? Math.abs(read.firstSound - read.firstPicture) : 0;
  const together = apart > 1 ? `; BUT PICTURE AND SOUND BEGIN ${apart.toFixed(1)}s APART` : '';
  console.log(`${found}\n        link answers ${answers.join(', ')}; ffmpeg ${read.ok ? 'PLAYS it' : 'FAILS'}: ${read.note}${together}`);
  if (read.ok) {
    console.log(`        ${await skipLands(info, lists)}`);
    if (!winner) winner = route.name;
  }
}
console.log(winner ? `\nThe server takes the first route in this list that is ready and plays: "${winner}".` : '\nNo route works right now.');
process.exit(0);
