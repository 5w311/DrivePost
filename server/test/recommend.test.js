import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { relatedFrom, recommendFor } from '../src/recommend.js';
import { Store, cleanSearch } from '../src/state.js';
import os from 'node:os';
import path from 'node:path';

// YouTube's answer for one video, in its real shape, with what it is about replaced.
const answer = () => JSON.parse(fs.readFileSync(new URL('./fixtures/related.json', import.meta.url), 'utf8'));

test('the videos YouTube lists beside a video are read out of its answer', () => {
  const list = relatedFrom(answer());
  assert.deepEqual(list.map((v) => v.id), ['vid0001AAAA', 'vid0002AAAA', 'vid0004AAAA', 'vid0005AAAA', 'vid0006AAAA']);
  assert.deepEqual(list[0], { id: 'vid0001AAAA', title: 'Video number 1', channel: 'Channel 1', duration: 30 * 60 + 41, live: false, thumb: 'https://i.ytimg.com/vi/vid0001AAAA/mqdefault.jpg' });
  assert.equal(list[2].duration, 1 * 3600 + 5 * 60 + 56, 'an hour-long one');
  assert.deepEqual([list[3].live, list[3].duration], [true, null], 'a live stream has no length');
  assert.equal(list[4].duration, 8 * 3600 + 9 * 60, 'a finished stream is an ordinary video');
});

test('what the server could not play is left out', () => {
  const ids = relatedFrom(answer()).map((v) => v.id);
  // A playlist, a course, a members-only video, one that isn't out yet, and one with no length (a Short).
  for (const id of ['vid0008AAAA', 'vid0009AAAA', 'vid0010AAAA']) assert.ok(!ids.includes(id), id);
  assert.ok(!ids.some((id) => id.startsWith('PL')));
});

test('if the list beside the video is gone, the suggestions for when it ends are used', () => {
  const json = answer();
  delete json.contents.twoColumnWatchNextResults.secondaryResults;
  assert.deepEqual(
    relatedFrom(json).map((v) => [v.id, v.title, v.channel, v.duration]),
    [
      ['end0001AAAA', 'End screen one', 'Channel E1', 754],
      ['end0002AAAA', 'End screen two', 'Channel E2', 3723],
    ]
  );
});

test("the shape YouTube used before is still understood, wherever it sits", () => {
  const old = {
    contents: {
      somewhereNew: {
        items: [
          { compactVideoRenderer: { videoId: 'old0001AAAA', title: { simpleText: 'Old one' }, longBylineText: { runs: [{ text: 'Old channel' }] }, lengthText: { simpleText: '4:05' } } },
          { compactVideoRenderer: { videoId: 'old0002AAAA', title: { runs: [{ text: 'Old live' }] }, shortBylineText: { runs: [{ text: 'Live channel' }] }, badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }] } },
          { compactVideoRenderer: { videoId: 'old0001AAAA', title: { simpleText: 'Old one again' }, lengthSeconds: '245' } },
          { compactVideoRenderer: { videoId: 'not an id', title: { simpleText: 'Bad' }, lengthSeconds: '10' } },
        ],
      },
    },
  };
  assert.deepEqual(
    relatedFrom(old).map((v) => [v.id, v.title, v.channel, v.duration, v.live]),
    [
      ['old0001AAAA', 'Old one', 'Old channel', 245, false],
      ['old0002AAAA', 'Old live', 'Live channel', null, true],
    ]
  );
  assert.deepEqual(relatedFrom({}), []);
  assert.deepEqual(relatedFrom(null), []);
  assert.deepEqual(relatedFrom({ contents: 'nothing here' }), []);
});

// ---- one list for a profile ----

const vid = (name) => ({ id: (name + 'AAAAAAAAAAA').slice(0, 11), title: name });
const listFor = (lists) => async (id) => {
  if (!(id in lists)) throw new Error('related videos returned 500');
  return lists[id].map(vid);
};

test('each recent video gets a turn, newest first, and nothing watched or lined up is suggested', async () => {
  const now = vid('now');
  const history = [now, vid('second'), vid('third')];
  const asked = [];
  const rec = await recommendFor({ now, history, queue: [vid('queued')] }, async (id) => {
    asked.push(id);
    return listFor({
      [now.id]: ['a1', 'a2', 'second', 'a3'],
      [vid('second').id]: ['b1', 'a1', 'b2'],
      [vid('third').id]: ['c1', 'queued', 'c2'],
    })(id);
  });
  assert.deepEqual(asked, [now.id, vid('second').id, vid('third').id], 'what is playing is asked about once, not again as history');
  assert.deepEqual(rec.items.map((v) => v.title), ['a1', 'b1', 'c1', 'a2', 'b2', 'c2', 'a3']);
  assert.equal(rec.from, 3);
  assert.equal(rec.failed, undefined);
});

test('only the last few videos are gone by, and the list stops at thirty', async () => {
  const history = Array.from({ length: 12 }, (_, i) => vid('h' + String(i).padStart(2, '0')));
  const asked = [];
  const rec = await recommendFor({ now: null, history, queue: [] }, async (id) => {
    asked.push(id);
    return Array.from({ length: 20 }, (_, k) => vid(id.slice(0, 3) + 'r' + String(k).padStart(2, '0')));
  });
  assert.equal(asked.length, 6);
  assert.equal(rec.items.length, 30);
  assert.equal(new Set(rec.items.map((v) => v.id)).size, 30);
});

test('nothing watched yet: nothing to suggest, and YouTube is not asked', async () => {
  let asked = 0;
  const rec = await recommendFor({ now: null, history: [], queue: [] }, async () => (asked++, []));
  assert.deepEqual(rec, { items: [], from: 0 });
  assert.equal(asked, 0);
  // The test pattern is not a video to find more of.
  const pattern = await recommendFor({ now: { id: 'test-pattern' }, history: [], queue: [] }, async () => (asked++, []));
  assert.deepEqual(pattern, { items: [], from: 0 });
  assert.equal(asked, 0);
});

test('one failed answer costs only its share; all failed is said', async () => {
  const history = [vid('one'), vid('two')];
  const some = await recommendFor({ now: null, history, queue: [] }, listFor({ [vid('two').id]: ['x', 'y'] }));
  assert.deepEqual(some.items.map((v) => v.title), ['x', 'y']);
  assert.equal(some.failed, undefined);
  const none = await recommendFor({ now: null, history, queue: [] }, listFor({}));
  assert.deepEqual(none, { items: [], from: 2, failed: true });
});

// ---- searches made before ----

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-searches-'));
  return { s: new Store({ dataDir: dir, defaultQuality: '480' }), dir };
}

test('searches are kept newest first, each once, and links are not searches', () => {
  const { s } = store();
  s.noteSearch('  truck   reviews ');
  s.noteSearch('lofi');
  s.noteSearch('Truck Reviews');
  assert.deepEqual(s.searches, ['Truck Reviews', 'lofi'], 'the same words again move to the top');
  s.noteSearch('https://youtu.be/aqz-KE-bpKQ');
  s.noteSearch('youtube.com/watch?v=aqz-KE-bpKQ');
  s.noteSearch('');
  s.noteSearch(null);
  assert.deepEqual(s.searches, ['Truck Reviews', 'lofi']);
  assert.deepEqual(s.publicState().searches, ['Truck Reviews', 'lofi'], 'the car and the phones are told');
  assert.equal(cleanSearch('x'.repeat(300)).length, 100);
});

test('only the last twenty are kept; one can be forgotten, or all of them', () => {
  const { s } = store();
  for (let i = 1; i <= 25; i++) s.noteSearch('search ' + i);
  assert.equal(s.searches.length, 20);
  assert.equal(s.searches[0], 'search 25');
  assert.equal(s.searches[19], 'search 6');
  assert.equal(s.command('forgetSearch', { q: 'SEARCH 25' }), null);
  assert.equal(s.searches[0], 'search 24');
  assert.equal(s.searches.length, 19);
  assert.equal(s.command('clearSearches'), null);
  assert.deepEqual(s.searches, []);
});

test('searches are saved with the profile and come back after a restart', () => {
  const { s, dir } = store();
  s.noteSearch('kitchen nightmares');
  s.noteSearch('lofi');
  s.saveNow();
  const again = new Store({ dataDir: dir, defaultQuality: '480' });
  assert.deepEqual(again.searches, ['lofi', 'kitchen nightmares']);
  // A file from before this existed, or one that has been tampered with, is fine too.
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ searches: ['ok', 7, 'https://x.test/', { a: 1 }] }));
  assert.deepEqual(new Store({ dataDir: dir, defaultQuality: '480' }).searches, ['ok']);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({}));
  assert.deepEqual(new Store({ dataDir: dir, defaultQuality: '480' }).searches, []);
});
