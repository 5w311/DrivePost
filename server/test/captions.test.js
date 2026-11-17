import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cuesFromJson3, cuesFromVtt, tidyCues, captionsFor, forgetCaptions } from '../src/captions.js';
import { noteLookup, forgetNoted } from '../src/extras.js';

test("YouTube's own captions: each line once, with when it comes up and how long it stays", () => {
  const written = JSON.stringify({
    wireMagic: 'pb3',
    events: [
      { tStartMs: 1200, dDurationMs: 2500, segs: [{ utf8: 'Hello there.\nGeneral Kenobi!' }] },
      { tStartMs: 4000, dDurationMs: 1500, segs: [{ utf8: '&amp; so <i>it</i>   begins' }] },
      { tStartMs: 9000, dDurationMs: 0, segs: [{ utf8: 'no length given' }] },
    ],
  });
  assert.deepEqual(cuesFromJson3(written), [
    { s: 1.2, e: 3.7, text: 'Hello there.\nGeneral Kenobi!' },
    { s: 4, e: 5.5, text: '& so it begins' },
    { s: 9, e: 12, text: 'no length given' },
  ]);
  // Made from the sound: words come in pieces, a line stays up while the next is said, and a lone line break is not a line.
  const rolled = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 5000, id: 1, wpWinPosId: 1 },
      { tStartMs: 320, dDurationMs: 4160, wWinId: 1, segs: [{ utf8: 'so', acAsrConf: 0 }, { utf8: ' today', tOffsetMs: 300 }, { utf8: " we're", tOffsetMs: 640 }] },
      { tStartMs: 2470, dDurationMs: 2010, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
      { tStartMs: 2480, dDurationMs: 4400, wWinId: 1, segs: [{ utf8: 'looking' }, { utf8: ' at', tOffsetMs: 200 }] },
    ],
  });
  assert.deepEqual(cuesFromJson3(rolled), [
    { s: 0.32, e: 4.48, text: "so today we're" },
    { s: 2.48, e: 6.88, text: 'looking at' },
  ]);
  assert.deepEqual(cuesFromJson3('not json'), []);
  assert.deepEqual(cuesFromJson3('{"events":"no"}'), []);
});

test('WebVTT and SubRip: blocks of times and words, whatever else is around them', () => {
  const vtt = `WEBVTT
Kind: captions

NOTE a remark

1
00:00:01.000 --> 00:00:03.500 align:start position:0%
First <c.yellow>line</c>
second line

00:01:02.250 --> 00:01:04.000
Later &gt; on

bad block without times
`;
  assert.deepEqual(cuesFromVtt(vtt), [
    { s: 1, e: 3.5, text: 'First line\nsecond line' },
    { s: 62.25, e: 64, text: 'Later > on' },
  ]);
  const srt = '1\r\n00:00:05,000 --> 00:00:06,500\r\nComma for the fraction\r\n\r\n2\r\n01:00:00,000 --> 01:00:02,000\r\nAn hour in\r\n';
  assert.deepEqual(cuesFromVtt(srt), [
    { s: 5, e: 6.5, text: 'Comma for the fraction' },
    { s: 3600, e: 3602, text: 'An hour in' },
  ]);
  assert.deepEqual(cuesFromVtt(''), []);
});

test('lines are put in order, repeats running into each other are one line, and a line is never up for minutes', () => {
  const got = tidyCues([
    { s: 10, e: 12, text: 'second' },
    { s: 1, e: 3, text: 'first' },
    { s: 3, e: 5, text: 'first' },
    { s: 20, e: 400, text: 'stuck' },
    { s: 30, e: 30.01, text: 'a blink' },
    { s: NaN, e: 2, text: 'nowhere' },
    { s: 40, e: 41, text: '' },
  ]);
  assert.deepEqual(got, [
    { s: 1, e: 5, text: 'first' },
    { s: 10, e: 12, text: 'second' },
    { s: 20, e: 40, text: 'stuck' },
  ]);
});

test("a video's captions are fetched once: the written track in the language asked for, else the one made from the sound", async () => {
  forgetNoted();
  forgetCaptions();
  const calls = [];
  // Stands in for yt-dlp: writes the track where it was told to, as yt-dlp names it.
  const ytdlp = async (args) => {
    calls.push(args);
    const out = args[args.indexOf('-o') + 1];
    const lang = args[args.indexOf('--sub-langs') + 1];
    fs.writeFileSync(out.replace('%(ext)s', `${lang}.json3`), JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hi' }] }] }));
    return '';
  };
  noteLookup('aaaaaaaaaaa', { subtitles: { en: [{ ext: 'json3' }] }, automatic_captions: { en: [{ ext: 'json3' }] } });
  const got = await captionsFor('aaaaaaaaaaa', { ytdlp, lang: 'en' });
  assert.deepEqual(got, { lang: 'en', auto: false, cues: [[1, 3, 'Hi']] });
  assert.ok(calls[0].includes('--write-subs') && !calls[0].includes('--write-auto-subs'));
  assert.ok(calls[0].includes('--skip-download'), 'the video itself is not fetched for this');
  assert.equal(calls[0][calls[0].length - 1], 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
  // Its folder is gone again.
  const dir = path.dirname(calls[0][calls[0].indexOf('-o') + 1]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(dir), false);
  // Asked again: the same, without another fetch.
  assert.deepEqual(await captionsFor('aaaaaaaaaaa', { ytdlp, lang: 'en' }), got);
  assert.equal(calls.length, 1);

  // Only what the site made from the sound.
  noteLookup('bbbbbbbbbbb', { automatic_captions: { 'en-orig': [{ ext: 'json3' }], de: [{ ext: 'json3' }] } });
  const auto = await captionsFor('bbbbbbbbbbb', { ytdlp, lang: 'en' });
  assert.equal(auto.auto, true);
  assert.equal(auto.lang, 'en-orig');
  assert.ok(calls[1].includes('--write-auto-subs'));

  // None in that language, none at all, a video never looked up, and the test pattern: said, and nothing is fetched.
  noteLookup('ccccccccccc', { subtitles: { es: [{ ext: 'vtt' }] } });
  assert.deepEqual(await captionsFor('ccccccccccc', { ytdlp, lang: 'en' }), { none: 'This video has no captions.' });
  assert.deepEqual(await captionsFor('ddddddddddd', { ytdlp, lang: 'en' }), { none: 'This video has no captions.' });
  assert.ok((await captionsFor('test-pattern', { ytdlp })).none);
  assert.ok((await captionsFor('../../etc', { ytdlp })).none);
  assert.equal(calls.length, 2);

  // yt-dlp fails: said as "not just now", and tried again the next time.
  noteLookup('eeeeeeeeeee', { subtitles: { en: [{ ext: 'vtt' }] } });
  let fails = 0;
  const broken = async () => {
    fails++;
    throw new Error('HTTP Error 429: Too Many Requests');
  };
  await assert.rejects(captionsFor('eeeeeeeeeee', { ytdlp: broken, lang: 'en' }), /couldn't be fetched just now/);
  await assert.rejects(captionsFor('eeeeeeeeeee', { ytdlp: broken, lang: 'en' }), /couldn't be fetched just now/);
  assert.equal(fails, 2);
  // It wrote nothing (the site had no such track after all).
  noteLookup('fffffffffff', { subtitles: { en: [{ ext: 'vtt' }] } });
  assert.match((await captionsFor('fffffffffff', { ytdlp: async () => '', lang: 'en' })).none, /couldn't be fetched/);
});
