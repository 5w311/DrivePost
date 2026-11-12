/*
 * Which ways of getting a video from YouTube work from this machine, right now?
 *
 *   docker compose exec -T drivepost node src/check-youtube.js [video-id] [quality] [--details]
 *
 * Tries every route the server knows (see ROUTES in youtube.js) the same way
 * the server does: looks the video up, asks for the first bytes of what it is
 * given, has ffmpeg read some of it from the top, and then starts it partway
 * through the way a skip would. Prints one short block per route and no
 * links, so the output is safe to share.
 *
 * With --details it also says what each stream is made of and tries the skip
 * in several ways, for working out why one misbehaves. Still no links.
 *
 * Given a link to another site instead of a YouTube video, it checks that
 * link the same way (see links.js):
 *
 *   docker compose exec -T drivepost node src/check-link.js "https://x.com/..." [quality] [--details]
 */
import { spawn, spawnSync } from 'node:child_process';
import { config } from './config.js';
import { ROUTES, streamInfo, linkStatus, extractVideoId } from './youtube.js';
import { linkIn, linkItem, linkStreamInfo, guardedFetch, siteOf } from './links.js';
import { ffmpegArgs, chooseCodec, failureReason, refusalReason, cutLists } from './stream.js';
import { TsSplitter, KIND_VIDEO } from './ts-chunker.js';

const words = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const details = process.argv.includes('--details');
const asked = words[0] || '9Yz3TdftSPs';
// A link to somewhere other than YouTube, or a YouTube video (as its ID or its link).
const link = extractVideoId(asked) ? null : linkIn(asked);
const id = extractVideoId(asked) || asked;
const quality = words[1] || '1080';

// ffmpeg's own words with every link taken out, the last few different lines of them.
function said(stderr) {
  const lines = String(stderr || '')
    .split(/[\r\n]+/)
    .map((l) => l.replace(/https?:\/\/\S+/g, '<link>').replace(/\[[^\]@]* @ 0x[0-9a-f]+\]\s*/gi, '').trim())
    .filter((l) => l && !/^[a-z_0-9]+=/.test(l) && !/thread_queue_size/.test(l));
  return [...new Set(lines)].slice(-5).map((l) => l.slice(0, 150));
}

/*
 * Have ffmpeg read the video the way a stream would, for up to `forMs`, from
 * `startAt` seconds in. Reports how fast it comes in compared with how fast
 * it plays, and where its picture and its sound begin. `change` may alter
 * the arguments first (for trying things out).
 */
function ffmpegReads(info, { startAt = 0, cuts = null, forMs = 14000, change = null } = {}) {
  return new Promise((resolve) => {
    const codec = chooseCodec('h264', info, true);
    let args = ffmpegArgs(info, startAt, quality, 48000, codec, cuts);
    if (details) args = args.map((a, i) => (args[i - 1] === '-loglevel' ? 'warning' : a));
    if (change) args = change(args);
    const ff = spawn(config.ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const began = Date.now();
    let bytes = 0;
    let err = '';
    let finished = false;
    let firstPicture = null; // stream time of the first picture and of the first sound
    let lastPicture = null;
    let firstSound = null;
    let soundPieces = 0;
    let pictureAfterMs = null;
    const splitter = new TsSplitter((kind, pts) => {
      if (kind === KIND_VIDEO) {
        if (firstPicture === null) pictureAfterMs = Date.now() - began;
        firstPicture = firstPicture === null ? pts : Math.min(firstPicture, pts);
        lastPicture = lastPicture === null ? pts : Math.max(lastPicture, pts);
      } else {
        if (firstSound === null) firstSound = pts;
        soundPieces++;
      }
    });
    const done = (failure) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ff.kill('SIGKILL');
      const wall = (Date.now() - began) / 1000;
      const facts = { firstPicture, lastPicture, firstSound, soundPieces, pictureAfterMs, said: said(err) };
      if (failure || bytes < 100 * 1024) return resolve({ ok: false, note: failure || `nothing came through in ${Math.round(forMs / 1000)} seconds`, ...facts });
      // How much video came through, by its own timestamps (a stream that keeps its own clock doesn't start at zero).
      const mediaSeconds = firstPicture !== null ? lastPicture - firstPicture : 0;
      const x = mediaSeconds / wall;
      const how = codec === 'h264' ? 'H.264 passed through' : 'converted to MPEG-1';
      const pace = x >= 1.5 ? 'fast enough' : x >= 1.05 ? 'only just fast enough' : 'TOO SLOW to play without stopping';
      resolve({ ok: x >= 1.05, note: `${how}, ${mediaSeconds.toFixed(0)}s of video in ${wall.toFixed(0)}s = ${x.toFixed(1)}x, ${pace}`, ...facts });
    };
    const timer = setTimeout(() => done(), forMs);
    ff.stdout.on('data', (d) => {
      bytes += d.length;
      splitter.push(d);
    });
    ff.stderr.on('data', (d) => {
      err = (err + d).slice(-6000);
    });
    ff.on('error', (e) => done(`could not run ffmpeg: ${e.message}`));
    ff.on('close', (code) => done(bytes < 100 * 1024 ? failureReason(err, code).said : ''));
  });
}

const hasSound = (info) => info.inputs.some((i) => i.hasAudio);
const spotOf = (to) => `${Math.floor(to / 60)}:${String(to % 60).padStart(2, '0')}`;
const skipTo = (info) => Math.max(10, Math.min(60, Math.floor((info.duration || 120) / 2)));

// Start partway through, as a skip does, and say how that lands.
async function skipLands(info, lists) {
  const to = skipTo(info);
  const handedOver = [];
  const segmented = info.inputs.some((i) => i.list);
  const cuts = await cutLists(info, to, lists, handedOver);
  const read = await ffmpegReads(info, { startAt: to, cuts, forMs: 8000 });
  handedOver.forEach((list) => list.done());
  const spot = spotOf(to);
  if (read.firstPicture === null) return `a skip to ${spot} FAILS: ${read.note}`;
  const how = segmented ? (cuts ? 'the server cuts the list' : "ffmpeg's own seeking, which can leave picture and sound out of step") : 'ffmpeg seeks in the file';
  const after = `${(read.pictureAfterMs / 1000).toFixed(1)}s`;
  if (read.firstSound === null) return `a skip to ${spot} starts in ${after} (${how})${hasSound(info) ? ', BUT NO SOUND CAME THROUGH' : ''}`;
  // The sound begins on the spot; the picture begins on an earlier whole frame, which the car decodes without showing.
  const lead = read.firstSound - read.firstPicture;
  const where = lead >= -0.05 ? `picture ready ${Math.max(0, lead).toFixed(1)}s before the spot` : `PICTURE BEGINS ${(-lead).toFixed(1)}s AFTER THE SOUND`;
  return `a skip to ${spot} starts in ${after}, ${where} (${how})`;
}

// ---- --details: what a stream is made of, and the skip tried several ways ----

// A segment list in a line: how many segments, how long, which tags, what kind of files. No addresses.
function listShape(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lengths = lines.filter((l) => l.startsWith('#EXTINF:')).map((l) => parseFloat(l.slice(8)));
  if (!lengths.length) return `not a list of segments (${lines.length} lines, begins "${(lines[0] || '').slice(0, 30)}")`;
  const total = lengths.reduce((a, b) => a + b, 0);
  const tags = [...new Set(lines.filter((l) => l.startsWith('#EXT-X-')).map((l) => l.slice(1).split(':')[0].replace(/^EXT-X-/, '')))];
  const kinds = [...new Set(lines.filter((l) => !l.startsWith('#')).map((l) => {
    const path = l.split('?')[0];
    const dot = path.lastIndexOf('.');
    return dot > path.lastIndexOf('/') ? path.slice(dot).slice(0, 6) : '(no ending)';
  }))];
  const absolute = lines.some((l) => /^https?:/.test(l));
  return `${lengths.length} segments, ${Math.min(...lengths).toFixed(2)} to ${Math.max(...lengths).toFixed(2)}s each, ${total.toFixed(1)}s in all; first lengths ${lengths.slice(0, 4).join(' ')}; tags ${tags.join(' ') || 'none'}; files end in ${kinds.join(' ')}; ${absolute ? 'full' : 'relative'} addresses`;
}

const at = (pts) => (pts === null ? 'none' : pts.toFixed(2));
const outcome = (r) => `picture from ${at(r.firstPicture)}, sound from ${at(r.firstSound)} (${r.soundPieces} pieces)${r.said.length ? `; ffmpeg said: ${r.said.join(' | ')}` : ''}`;

async function moreAbout(info, lists) {
  const pad = '        ';
  for (const input of info.inputs) {
    console.log(`${pad}${input.hasVideo ? (input.hasAudio ? 'both:   ' : 'picture:') : 'sound:  '} ${input.what || '?'}`);
    if (input.list) console.log(`${pad}  its list: ${lists.has(input) ? listShape(lists.get(input)) : 'not fetched'}`);
  }
  const top = await ffmpegReads(info, { forMs: 6000 });
  console.log(`${pad}from the top: ${outcome(top)}`);
  if (!info.inputs.some((i) => i.list)) return;
  const to = skipTo(info);
  const handedOver = [];
  const cuts = await cutLists(info, to, lists, handedOver);
  if (cuts) {
    console.log(`${pad}skip to ${spotOf(to)}: lists cut to begin at ${info.inputs.filter((i) => i.list).map((i) => cuts.get(i).begins.toFixed(2)).join(' and ')}`);
    const without = (name, takesValue) => (args) => args.filter((a, i) => a !== name && !(takesValue && args[i - 1] === name));
    console.log(`${pad}  as the server does it:   ${outcome(await ffmpegReads(info, { startAt: to, cuts, forMs: 6000 }))}`);
    console.log(`${pad}  sound not cut to the spot: ${outcome(await ffmpegReads(info, { startAt: to, cuts, forMs: 6000, change: without('-af', true) }))}`);
    console.log(`${pad}  clocks restarted at zero:  ${outcome(await ffmpegReads(info, { startAt: to, cuts, forMs: 6000, change: without('-copyts', false) }))}`);
  } else {
    console.log(`${pad}skip to ${spotOf(to)}: the lists could not be cut`);
  }
  handedOver.forEach((list) => list.done());
  console.log(`${pad}  ffmpeg's own seeking:      ${outcome(await ffmpegReads(info, { startAt: to, cuts: null, forMs: 6000 }))}`);
}

function sayVersion() {
  if (!details) return;
  const version = spawnSync(config.ffmpegBin, ['-version'], { encoding: 'utf8' }).stdout || '';
  console.log(`${version.split('\n')[0].replace(/ Copyright.*/, '')}\n`);
}

/*
 * Try out what one lookup came back with, the way the server would play it.
 * `found` is the first line about it so far, `who` is whose media it is, and
 * `fetchImpl` is what to ask for the first bytes with. True when it plays.
 */
async function tryOut(info, found, who, fetchImpl) {
  // YouTube holds some files back for the length of an ad. Wait it out, as the server would.
  const wait = (info.readyAt || 0) - Date.now();
  if (wait > 0) {
    found += `, usable after a ${Math.ceil(wait / 1000)}s wait`;
    if (wait > 90000) {
      console.log(`${found}\n        too long a wait: the server would not use this`);
      return false;
    }
    await new Promise((done) => setTimeout(done, wait + 300));
  }
  const lists = new Map();
  let answers;
  try {
    answers = await Promise.all(info.inputs.filter((i) => i.url).map((i) => linkStatus(i, fetchImpl, lists)));
  } catch (e) {
    console.log(`${found}\n        link check failed: ${String(e.cause?.message || e.message).slice(0, 90)}`);
    return false;
  }
  const bad = answers.find((a) => a !== 200 && a !== 206);
  if (bad !== undefined) {
    console.log(`${found}\n        REFUSED: ${refusalReason(bad, who)}`);
    return false;
  }
  const read = await ffmpegReads(info);
  // From the top, picture and sound begin together, give or take a few frames.
  let sound = '';
  if (read.ok && hasSound(info)) {
    if (read.firstSound === null) sound = ', BUT NO SOUND CAME THROUGH';
    else if (Math.abs(read.firstSound - read.firstPicture) > 1) sound = `, BUT PICTURE AND SOUND BEGIN ${Math.abs(read.firstSound - read.firstPicture).toFixed(1)}s APART`;
    else sound = ', with sound';
  }
  console.log(`${found}\n        link answers ${answers.join(', ')}; ffmpeg ${read.ok ? 'PLAYS it' : 'FAILS'}: ${read.note}${sound}`);
  // A skip, where there is something to skip around in: not a live stream, or a clip a few seconds long.
  if (read.ok && (who === 'YouTube' || (!info.live && (info.duration || 0) > 25))) console.log(`        ${await skipLands(info, lists)}`);
  if (details) await moreAbout(info, lists);
  return read.ok;
}

if (link) {
  // Another site's video: there is one way to get it, the site's own.
  const site = siteOf(link);
  console.log(`Checking a link to ${site} at ${quality}p from this machine\n`);
  sayVersion();
  let started = Date.now();
  let item;
  try {
    item = await linkItem(link);
  } catch (e) {
    console.log(`lookup failed: ${e.message}`);
    process.exit(0);
  }
  if (!item.url) {
    console.log(`That page shows a YouTube video (${item.id}), which plays as one. Check it with: node src/check-youtube.js ${item.id}`);
    process.exit(0);
  }
  const length = item.live ? 'live' : item.duration ? `${Math.floor(item.duration / 60)}:${String(item.duration % 60).padStart(2, '0')}` : 'length not given';
  console.log(`found a video (${length}${item.thumb ? ', with a picture for the lists' : ', no picture for the lists'}) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  started = Date.now();
  let info;
  try {
    info = await linkStreamInfo(item.id, quality);
  } catch (e) {
    console.log(`        nothing to play: ${e.message}`);
    process.exit(0);
  }
  const how = info.live ? 'plays as live, converted' : info.convert ? `converted here, because ${info.convert}` : 'H.264 that can be passed straight on';
  const found = `picked ${info.height}p ${info.vcodec || '?'} (${info.route.replace(/ from \S+$/, '').replace(/^[^:]+: /, '')}) in ${((Date.now() - started) / 1000).toFixed(1)}s: ${how}${info.seen ? '' : ' (ffprobe could not look at it, so that is going by what the site says)'}`;
  const plays = await tryOut(info, found, site, guardedFetch);
  console.log(plays ? '\nThe server can play this link.' : '\nThe server cannot play this link right now.');
  process.exit(0);
}

console.log(`Checking video ${id} at ${quality}p from this machine\n`);
sayVersion();
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
  if ((await tryOut(info, found, 'YouTube', fetch)) && !winner) winner = route.name;
}
console.log(winner ? `\nThe server takes the first route in this list that is ready and plays: "${winner}".` : '\nNo route works right now.');
process.exit(0);
