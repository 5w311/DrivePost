import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { cleanChapters, cleanSkips, sponsorSkips, pickCaptions, noteLookup, notedFor, forgetNoted, isChannelId } from '../src/extras.js';

test('chapters come as yt-dlp gives them, tidied, and one chapter is no chapters', () => {
  const raw = [
    { start_time: 0, end_time: 62, title: 'Intro' },
    { start_time: 62.4, end_time: 300, title: '  The   climb ' },
    { start_time: 300, end_time: 900, title: 'Summit' },
  ];
  assert.deepEqual(cleanChapters(raw), [
    { t: 0, title: 'Intro' },
    { t: 62.4, title: 'The climb' },
    { t: 300, title: 'Summit' },
  ]);
  assert.deepEqual(cleanChapters([raw[0]]), [], 'a video in one piece has nothing to mark');
  assert.deepEqual(cleanChapters(null), []);
  assert.deepEqual(cleanChapters('nonsense'), []);
  // Out of order, with rubbish among them, and one that starts after the video ends.
  const messy = [{ start_time: 500, title: 'Late' }, { title: 'No time' }, { start_time: 'x', title: 'Bad' }, { start_time: 10, title: '' }, { start_time: 0, title: 'First' }, { start_time: 2000, title: 'Beyond' }];
  assert.deepEqual(cleanChapters(messy, 900), [{ t: 0, title: 'First' }, { t: 500, title: 'Late' }]);
  // Two that start at the same moment: one mark, the later name.
  assert.deepEqual(cleanChapters([{ start_time: 0, title: 'A' }, { start_time: 60, title: 'B' }, { start_time: 60.2, title: 'B, properly' }]), [{ t: 0, title: 'A' }, { t: 60.2, title: 'B, properly' }]);
});

test("a lookup's answer is noted: chapters, whose the video is, and the captions it has", () => {
  forgetNoted();
  assert.equal(notedFor('aaaaaaaaaaa'), null);
  noteLookup('aaaaaaaaaaa', {
    duration: 600,
    channel: 'A Channel',
    channel_id: 'UC' + 'x'.repeat(22),
    chapters: [{ start_time: 0, title: 'One' }, { start_time: 200, title: 'Two' }],
    subtitles: { en: [{ ext: 'vtt', url: 'https://example.com/a' }], 'pt-BR': [{ ext: 'vtt' }], live_chat: [{ ext: 'json' }], es: [] },
    automatic_captions: { en: [{ ext: 'json3' }], 'en-orig': [{ ext: 'json3' }], de: [{ ext: 'json3' }] },
  });
  const got = notedFor('aaaaaaaaaaa');
  assert.deepEqual(got.chapters, [{ t: 0, title: 'One' }, { t: 200, title: 'Two' }]);
  assert.deepEqual(got.channel, { id: 'UC' + 'x'.repeat(22), name: 'A Channel' });
  assert.deepEqual(got.subs, ['en', 'pt-BR'], 'the chat of a broadcast is not captions, and an empty track is no track');
  assert.deepEqual(got.auto, ['en', 'en-orig', 'de']);
  // A video with none of it.
  noteLookup('bbbbbbbbbbb', { uploader: 'Someone', channel_id: 'not one' });
  assert.deepEqual(notedFor('bbbbbbbbbbb'), { chapters: [], channel: { id: '', name: 'Someone' }, subs: [], auto: [] });
  assert.equal(isChannelId('UC' + 'x'.repeat(22)), true);
  assert.equal(isChannelId('UCshort'), false);
  assert.equal(isChannelId(null), false);
});

test('captions: a track people wrote before one made from the sound, in the language asked for or not at all', () => {
  assert.deepEqual(pickCaptions({ subs: ['es', 'en'], auto: ['en'] }, 'en'), { lang: 'en', auto: false });
  assert.deepEqual(pickCaptions({ subs: ['es'], auto: ['en-orig', 'en', 'de'] }, 'en'), { lang: 'en', auto: true });
  assert.deepEqual(pickCaptions({ subs: ['en-US'], auto: [] }, 'en'), { lang: 'en-US', auto: false }, 'American English is English');
  assert.deepEqual(pickCaptions({ subs: [], auto: ['en-orig'] }, 'en'), { lang: 'en-orig', auto: true });
  assert.equal(pickCaptions({ subs: ['es'], auto: ['de'] }, 'en'), null);
  assert.deepEqual(pickCaptions({ subs: ['es'], auto: ['de'] }, 'es'), { lang: 'es', auto: false });
  assert.equal(pickCaptions(null, 'en'), null);
  assert.equal(pickCaptions({ subs: ['eng'], auto: [] }, 'en'), null, 'a longer code that only starts the same is another language');
});

test("a sponsor's stretches: the ones worth skipping, in order, joined where they overlap", () => {
  const seg = (from, to, category = 'sponsor', actionType = 'skip') => ({ segment: [from, to], category, actionType, UUID: 'x' });
  assert.deepEqual(cleanSkips([seg(300, 362.44), seg(30.04, 61)]), [
    { from: 30, to: 61, kind: 'sponsor' },
    { from: 300, to: 362.4, kind: 'sponsor' },
  ]);
  // Marked twice by two people, and a plug that runs on from it: one stretch.
  assert.deepEqual(cleanSkips([seg(100, 130), seg(101, 128), seg(130.2, 150, 'selfpromo')]), [{ from: 100, to: 150, kind: 'sponsor' }]);
  // Not ours to skip: other kinds, a mute, a second or less, rubbish.
  assert.deepEqual(cleanSkips([seg(0, 20, 'intro'), seg(40, 60, 'sponsor', 'mute'), seg(70, 71), { segment: ['a', 'b'], category: 'sponsor' }, null, seg(-5, 10)]), []);
  // One that runs past the end of the video stops at the end.
  assert.deepEqual(cleanSkips([seg(580, 640)], 600), [{ from: 580, to: 600, kind: 'sponsor' }]);
  assert.deepEqual(cleanSkips('nonsense'), []);
});

test('the sponsor list is asked by the first characters of a fingerprint, not by the video, and only its own answer is kept', async () => {
  forgetNoted();
  const id = 'dQw4w9WgXcQ';
  const prefix = crypto.createHash('sha256').update(id).digest('hex').slice(0, 4);
  const asked = [];
  const answer = [
    { videoID: 'someoneElse', segments: [{ segment: [1, 99], category: 'sponsor', actionType: 'skip' }] },
    { videoID: id, segments: [{ segment: [12, 45.5], category: 'sponsor', actionType: 'skip' }] },
  ];
  const fetchImpl = async (url) => {
    asked.push(url);
    return { status: 200, ok: true, json: async () => answer };
  };
  const got = await sponsorSkips(id, { fetchImpl, base: 'https://list.example' });
  assert.deepEqual(got, [{ from: 12, to: 45.5, kind: 'sponsor' }]);
  assert.equal(asked.length, 1);
  assert.ok(asked[0].startsWith(`https://list.example/api/skipSegments/${prefix}?`), asked[0]);
  assert.ok(!asked[0].includes(id), 'the video is not named');
  assert.ok(decodeURIComponent(asked[0]).includes('["sponsor","selfpromo"]'));
  // Asked again a moment later: the same answer, without asking.
  assert.deepEqual(await sponsorSkips(id, { fetchImpl, base: 'https://list.example' }), got);
  assert.equal(asked.length, 1);
  // Nothing under that fingerprint (404) is an answer too: nothing to skip.
  const none = await sponsorSkips('aaaaaaaaaaa', { fetchImpl: async () => ({ status: 404, ok: false }), base: 'https://list.example' });
  assert.deepEqual(none, []);
  // The list is down: that is said, and the next asking tries again.
  let tries = 0;
  const down = async () => {
    tries++;
    return { status: 502, ok: false };
  };
  await assert.rejects(sponsorSkips('bbbbbbbbbbb', { fetchImpl: down, base: 'https://list.example' }), /502/);
  await assert.rejects(sponsorSkips('bbbbbbbbbbb', { fetchImpl: down, base: 'https://list.example' }), /502/);
  assert.equal(tries, 2);
  // Not a YouTube video, or no list set: nothing is asked.
  let touched = false;
  const never = async () => {
    touched = true;
    return { status: 200, ok: true, json: async () => [] };
  };
  assert.deepEqual(await sponsorSkips('link-0123456789abcdef', { fetchImpl: never, base: 'https://list.example' }), []);
  assert.deepEqual(await sponsorSkips(id + 'x', { fetchImpl: never, base: 'https://list.example' }), []);
  assert.deepEqual(await sponsorSkips('ccccccccccc', { fetchImpl: never, base: '' }), []);
  assert.equal(touched, false);
});
