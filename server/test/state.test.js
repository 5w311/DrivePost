import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/state.js';

function makeStore(quality = '1080') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drivepost-'));
  return new Store({ dataDir, defaultQuality: quality });
}

const A = { id: 'aaaaaaaaaaa', title: 'First', duration: 300 };
const B = { id: 'bbbbbbbbbbb', title: 'Second', duration: 300 };

test('step-down lowers what plays for this video only', () => {
  const s = makeStore('1080');
  s.command('play', { item: A });
  const seq = s.now.seq;

  assert.equal(s.command('stepDown'), null);
  assert.equal(s.playQuality(), '720');
  assert.equal(s.settings.quality, '1080', 'the chosen quality is untouched');
  assert.ok(s.now.seq > seq, 'the stream reopens');
  assert.equal(s.publicState().playQuality, '720');

  s.command('stepDown');
  s.command('stepDown');
  s.command('stepDown');
  assert.equal(s.playQuality(), '360', 'stops at the lowest level');

  s.command('play', { item: B });
  assert.equal(s.playQuality(), '1080', 'a new video starts at the chosen quality again');
});

test('choosing a quality by hand clears the step-down', () => {
  const s = makeStore('1080');
  s.command('play', { item: A });
  s.command('stepDown');
  assert.equal(s.playQuality(), '720');
  s.command('quality', { q: '1080' });
  assert.equal(s.playQuality(), '1080');
  assert.equal(s.command('quality', { q: '4320' }), 'Bad quality');
});

test('Auto: the quality finds its level, and keeps it from one video to the next', () => {
  const s = makeStore('720');
  s.command('play', { item: A });
  assert.equal(s.command('stepUp'), null);
  assert.equal(s.playQuality(), '720', 'going up is only for Auto');

  let seq = s.now.seq;
  assert.equal(s.command('quality', { q: 'auto' }), null);
  assert.equal(s.settings.quality, 'auto');
  assert.equal(s.playQuality(), '720', 'Auto carries on from what was playing');
  assert.equal(s.now.seq, seq, 'so nothing starts over for it');
  assert.equal(s.publicState().playQuality, '720');
  assert.equal(s.publicState().settings.quality, 'auto');

  // The car measures room to spare: one level up, and the stream reopens at it.
  s.command('stepUp');
  assert.equal(s.playQuality(), '1080');
  assert.ok(s.now.seq > seq);
  seq = s.now.seq;
  s.command('stepUp');
  assert.equal(s.playQuality(), '1080', 'the top is the top');
  assert.equal(s.now.seq, seq);

  // The connection can't carry it after all: down, and not tried again for a while.
  s.command('stepDown', { why: 'connection' });
  assert.equal(s.playQuality(), '720');
  s.command('stepUp');
  assert.equal(s.playQuality(), '720', 'held below what it just came down from');
  s.command('play', { item: B });
  assert.equal(s.playQuality(), '720', 'the next video starts where Auto stands, not back at the top');
  s.autoHeld.until = Date.now() - 1; // ten minutes on
  s.command('stepUp');
  assert.equal(s.playQuality(), '1080', 'then it may try again');

  // The screen itself can't play it: that doesn't change down the road.
  s.command('stepDown', { why: 'screen' });
  assert.equal(s.playQuality(), '720');
  s.command('stepUp');
  assert.equal(s.playQuality(), '720');
  s.saveNow();
  const again = new Store({ dataDir: path.dirname(s.file), defaultQuality: '480' });
  assert.equal(again.settings.quality, 'auto', 'Auto, where it stood and what the screen can play all survive a restart');
  assert.equal(again.playQuality(), '720');
  again.command('play', { item: A });
  again.command('stepUp');
  assert.equal(again.playQuality(), '720');
  again.command('stepDown');
  again.command('stepDown');
  again.command('stepDown');
  assert.equal(again.playQuality(), '360', 'and the bottom is the bottom');

  // Choosing a quality by hand ends it; choosing Auto again starts it with a clean slate.
  again.command('quality', { q: '480' });
  assert.equal(again.playQuality(), '480');
  again.command('quality', { q: 'auto' });
  assert.equal(again.playQuality(), '480');
  again.command('stepUp');
  again.command('stepUp');
  assert.equal(again.playQuality(), '1080', 'what it learned last time no longer holds it back');
});

test('Auto goes up two levels in one step when there is room for it, and never past its ceiling', () => {
  const s = makeStore('360');
  s.command('quality', { q: 'auto' });
  s.command('play', { item: A });
  s.command('stepUp', { x: 4 });
  assert.equal(s.playQuality(), '480', 'four times the room: one level');
  s.command('stepUp', { x: 12 });
  assert.equal(s.playQuality(), '1080', 'twelve times: two');
  s.command('stepDown', { why: 'screen' });
  s.command('stepDown', { why: 'screen' });
  assert.equal(s.playQuality(), '480');
  s.command('stepUp', { x: 20 });
  assert.equal(s.playQuality(), '480', "the screen couldn't play 720p: no amount of room takes it back there");
});

test('a server can be set to start every profile on Auto', () => {
  const s = makeStore('auto');
  assert.equal(s.settings.quality, 'auto');
  assert.equal(s.playQuality(), '480', 'which begins in the lower middle and goes up from there');
});

test('queue advances and keeps resume points', () => {
  const s = makeStore('480');
  s.command('play', { item: A });
  s.command('enqueue', { item: B });
  assert.equal(s.queue.length, 1);
  s.carPosition({ seq: s.now.seq, t: 120, state: 'playing' });
  s.command('next');
  assert.equal(s.now.id, B.id);
  assert.equal(s.queue.length, 0);
  s.command('play', { item: A });
  assert.equal(s.now.startAt, 120, 'resumes where it left off');
  s.command('play', { item: A, fromStart: true });
  assert.equal(s.now.startAt, 0);
});

test('screen settings are shared and saved', () => {
  const s = makeStore('480');
  assert.equal(!!s.publicState().settings.fullscreen, false);
  s.command('fullscreen', { on: true });
  // (There was a Fill button once. A page left open since then may still ask: it is heard out, and nothing comes of it.)
  assert.equal(s.command('fill', { on: 1 }), null);
  assert.equal(s.publicState().settings.fullscreen, true);
  assert.equal('fill' in s.publicState().settings, false);
  assert.equal(s.settings.quality, '480', 'other settings are kept');
  s.saveNow();
  const again = new Store({ dataDir: path.dirname(s.file), defaultQuality: '480' });
  assert.equal(again.settings.fullscreen, true, 'survives a restart');
  s.command('fullscreen', { on: false });
  assert.equal(s.settings.fullscreen, false);
});

test('the video format is a shared setting and changing it restarts the stream', () => {
  const s = makeStore('720');
  assert.equal(s.publicState().settings.format, 'auto', 'H.264 when possible, by default');
  s.command('play', { item: A });
  s.carPosition({ seq: s.now.seq, t: 42, state: 'playing' });
  const seq = s.now.seq;

  assert.equal(s.command('format', { v: 'mpeg1' }), null);
  assert.equal(s.settings.format, 'mpeg1');
  assert.ok(s.now.seq > seq, 'the car reopens the stream');
  assert.ok(Math.abs(s.now.startAt - 42) <= 1, 'at the same spot');
  assert.equal(s.settings.quality, '720', 'other settings are kept');

  assert.equal(s.command('format', { v: 'vp9' }), 'Bad format');
  assert.equal(s.settings.format, 'mpeg1');

  s.saveNow();
  const again = new Store({ dataDir: path.dirname(s.file), defaultQuality: '720' });
  assert.equal(again.settings.format, 'mpeg1', 'survives a restart');
});

test('a saved format this version does not know falls back to automatic', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drivepost-'));
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { quality: '480', format: 'theora' } }));
  const s = new Store({ dataDir, defaultQuality: '480' });
  assert.equal(s.settings.format, 'auto');
});

test('sponsor breaks and captions are choices each profile keeps, and neither starts the video over', () => {
  const s = makeStore('480');
  assert.equal(s.settings.sponsors, 'off', 'sponsored parts play, until someone says otherwise');
  assert.equal(s.settings.captions, false);
  s.command('play', { item: A });
  const seq = s.now.seq;
  assert.equal(s.command('sponsors', { v: 'skip' }), null);
  assert.equal(s.command('captions', { on: true }), null);
  assert.equal(s.settings.sponsors, 'skip');
  assert.equal(s.settings.captions, true);
  assert.equal(s.now.seq, seq, 'what is playing carries on');
  assert.equal(s.command('sponsors', { v: 'always' }), 'Bad choice');
  assert.equal(s.settings.sponsors, 'skip');
  s.saveNow();
  const again = new Store({ dataDir: path.dirname(s.file), defaultQuality: '480' });
  assert.equal(again.settings.sponsors, 'skip');
  assert.equal(again.settings.captions, true);
  // A setting that was saved as something else altogether is put right.
  fs.writeFileSync(s.file, JSON.stringify({ settings: { sponsors: 'yes', captions: 'yes' } }));
  const odd = new Store({ dataDir: path.dirname(s.file), defaultQuality: '480' });
  assert.equal(odd.settings.sponsors, 'off');
  assert.equal(odd.settings.captions, false);
});

test("a video's row keeps whose it is, when that is a channel's real ID", () => {
  const s = makeStore('480');
  const channelId = 'UC' + 'c'.repeat(22);
  s.command('play', { item: { ...A, channel: 'Someone', channelId } });
  assert.equal(s.now.channelId, channelId);
  assert.equal(s.history[0].channelId, channelId);
  s.command('enqueue', { item: { ...B, channelId: 'javascript:alert(1)' } });
  assert.equal('channelId' in s.queue[0], false);
});

test('a playlist is played from its first video with the rest behind it, or added to Up Next, each video once', () => {
  const s = makeStore('480');
  const list = ['ccccccccccc', 'ddddddddddd', 'eeeeeeeeeee'].map((id, i) => ({ id, title: `List ${i + 1}`, duration: 100 }));
  // Nothing on: "add to Up Next" plays the first and lines up the rest.
  assert.equal(s.command('enqueueMany', { items: list, how: 'queue' }), null);
  assert.equal(s.now.id, 'ccccccccccc');
  assert.deepEqual(s.queue.map((q) => q.id), ['ddddddddddd', 'eeeeeeeeeee']);
  assert.ok(s.queue.every((q) => q.key), 'each has its own place in the line');
  // Added again while it plays: nothing is lined up twice, and what is on isn't lined up behind itself.
  s.command('enqueueMany', { items: [...list, B], how: 'queue' });
  assert.deepEqual(s.queue.map((q) => q.id), ['ddddddddddd', 'eeeeeeeeeee', 'bbbbbbbbbbb']);
  // "Play all" of another list: it goes first, in its order, and what was lined up stays behind it.
  const other = [A, { id: 'eeeeeeeeeee', title: 'List 3', duration: 100 }, { id: 'fffffffffff', title: 'New', duration: 50 }];
  s.command('enqueueMany', { items: other, how: 'play' });
  assert.equal(s.now.id, 'aaaaaaaaaaa');
  assert.deepEqual(s.queue.map((q) => q.id), ['eeeeeeeeeee', 'fffffffffff', 'ddddddddddd', 'bbbbbbbbbbb']);
  // Rubbish in a list is left out; a list of nothing but rubbish is refused.
  assert.equal(s.command('enqueueMany', { items: [{ id: 'nope' }, null, 'x'], how: 'queue' }), 'Nothing to play in that list');
  assert.equal(s.command('enqueueMany', { items: 'everything', how: 'play' }), 'Nothing to play in that list');
  // Up Next has an end.
  const many = Array.from({ length: 300 }, (_, i) => ({ id: `v${String(i).padStart(10, '0')}`, title: `Video ${i}` }));
  s.command('enqueueMany', { items: many, how: 'queue' });
  s.command('enqueueMany', { items: many.map((m) => ({ ...m, id: 'w' + m.id.slice(1) })), how: 'queue' });
  assert.equal(s.queue.length, 500);
});

test("a video put on by a link that says where to start begins there, this once", () => {
  const s = makeStore('480');
  // Played before, and left at four minutes in.
  s.command('play', { item: A });
  s.carPosition({ seq: s.now.seq, t: 240, state: 'playing' });
  s.command('stop');
  // The link's time comes before where it was left.
  s.command('play', { item: { ...A, at: 96 } });
  assert.equal(s.now.startAt, 96);
  assert.equal('at' in s.now, false, 'it is where this playing starts, not something the video keeps');
  assert.equal('at' in s.history[0], false);
  // "Play from start" still means the start.
  s.command('play', { item: { ...A, at: 96 }, fromStart: true });
  assert.equal(s.now.startAt, 0);
  // Lined up, it starts there when its turn comes.
  s.command('enqueue', { item: { ...B, at: 30 } });
  assert.equal(s.queue[0].at, 30);
  s.command('next');
  assert.equal(s.now.id, B.id);
  assert.equal(s.now.startAt, 30);
  // A time past the end of the video, or no time at all, is no time.
  s.command('play', { item: { ...A, at: 5000 } });
  assert.equal(s.now.startAt, 240, 'back to where it was left');
  s.command('play', { item: { ...A, at: 'soon' } });
  assert.equal(s.now.startAt, 240);
});
