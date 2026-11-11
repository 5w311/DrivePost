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
  s.command('fill', { on: 1 });
  assert.equal(s.publicState().settings.fullscreen, true);
  assert.equal(s.publicState().settings.fill, true);
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
