import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/state.js';

function makeStore(quality = '1080') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drivetest-'));
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
