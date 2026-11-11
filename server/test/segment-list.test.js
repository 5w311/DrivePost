import test from 'node:test';
import assert from 'node:assert/strict';
import { trimList, offerList } from '../src/segment-list.js';
import { ffmpegArgs, cutLists } from '../src/stream.js';

const LIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXTINF:5.005,',
  'seg0.ts?sig=a',
  '#EXTINF:5.005,',
  'seg1.ts?sig=b',
  '#EXTINF:5.338667,',
  'https://other.example/seg2.ts',
  '#EXTINF:4.0,',
  'seg3.ts',
  '#EXT-X-ENDLIST',
].join('\n');
const URL0 = 'https://media.example/videoplayback/id/abc/playlist/index.m3u8';

const addresses = (text) => text.split('\n').filter((l) => l && !l.startsWith('#'));

test('a list is cut to begin with the segment that holds the spot', () => {
  // 0-5.005, 5.005-10.01, 10.01-15.348667, 15.348667-19.348667
  const cut = trimList(LIST, URL0, 12);
  assert.equal(cut.begins.toFixed(3), '10.010');
  assert.deepEqual(addresses(cut.text), ['https://other.example/seg2.ts', 'https://media.example/videoplayback/id/abc/playlist/seg3.ts']);
  // Still a complete list ffmpeg will take: the opening tags, the right running number, and an end.
  const lines = cut.text.split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.ok(lines.includes('#EXT-X-VERSION:3') && lines.includes('#EXT-X-TARGETDURATION:6') && lines.includes('#EXT-X-PLAYLIST-TYPE:VOD'));
  assert.ok(lines.includes('#EXT-X-MEDIA-SEQUENCE:2'));
  assert.equal(lines.filter((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE')).length, 1);
  assert.equal(lines.filter(Boolean).pop(), '#EXT-X-ENDLIST');
  assert.ok(lines.includes('#EXTINF:5.338667,') && lines.includes('#EXTINF:4.0,'));
  assert.ok(!cut.text.includes('#EXTINF:5.005,'), 'the segments before it are gone');
});

test('the spot decides the segment: its start counts, the end of the stream gets the last one', () => {
  assert.equal(trimList(LIST, URL0, 0.5).begins, 0);
  assert.equal(addresses(trimList(LIST, URL0, 0.5).text).length, 4);
  assert.equal(addresses(trimList(LIST, URL0, 0.5).text)[0], 'https://media.example/videoplayback/id/abc/playlist/seg0.ts?sig=a', 'addresses are made absolute, query and all');
  assert.equal(trimList(LIST, URL0, 5.005).begins, 5.005, 'a spot right on a segment start begins there');
  assert.equal(trimList(LIST, URL0, 5.004).begins, 0);
  assert.equal(trimList(LIST, URL0, 9999).begins.toFixed(3), '15.349');
  assert.equal(addresses(trimList(LIST, URL0, 9999).text).length, 1);
});

test('what a segment needs from earlier in the list comes along: its start-up section and its key', () => {
  const list = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:5',
    '#EXT-X-MEDIA-SEQUENCE:10',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-KEY:METHOD=AES-128,URI="key1.bin",IV=0x01',
    '#EXTINF:5,',
    'a.m4s',
    '#EXTINF:5,',
    '#EXT-X-BYTERANGE:1000@2000',
    'b.m4s',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/key2.bin"',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:5,',
    'c.m4s',
    '#EXTINF:5,',
    'd.m4s',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const cut = trimList(list, 'https://m.example/x/list.m3u8', 7);
  const lines = cut.text.split('\n').filter(Boolean);
  assert.equal(cut.begins, 5);
  assert.ok(lines.includes('#EXT-X-MEDIA-SEQUENCE:11'), 'numbered on from the original, which the keys can depend on');
  const b = lines.indexOf('https://m.example/x/b.m4s');
  assert.ok(lines.indexOf('#EXT-X-MAP:URI="https://m.example/x/init.mp4"') < b, 'the start-up section, with its address made absolute');
  assert.ok(lines.indexOf('#EXT-X-KEY:METHOD=AES-128,URI="https://m.example/x/key1.bin",IV=0x01') < b, 'the key in force at that point');
  assert.equal(lines[b - 1], '#EXT-X-BYTERANGE:1000@2000');
  const c = lines.indexOf('https://m.example/x/c.m4s');
  assert.ok(lines.indexOf('#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/key2.bin"') > b && lines.indexOf('#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/key2.bin"') < c, 'and the change of key later on');
  assert.ok(lines.indexOf('#EXT-X-DISCONTINUITY') > b && lines.indexOf('#EXT-X-DISCONTINUITY') < c);
  assert.equal(lines.filter((l) => l.startsWith('#EXT-X-MAP')).length, 1, 'said once, not before every segment');

  // Cut later, the first key is no longer needed and the second leads.
  const later = trimList(list, 'https://m.example/x/list.m3u8', 16).text;
  assert.ok(!later.includes('key1.bin') && later.includes('key2.bin') && later.includes('init.mp4'));
});

test('anything that cannot be cut safely is left to ffmpeg', () => {
  assert.equal(trimList('', URL0, 5), null);
  assert.equal(trimList('<html>not a list</html>', URL0, 5), null);
  // A list of lists.
  assert.equal(trimList('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlow.m3u8\n', URL0, 5), null);
  // A live list, still growing: there is no "partway through" to cut to.
  assert.equal(trimList(LIST.replace('#EXT-X-ENDLIST', ''), URL0, 5), null);
  // Segments that are stretches of one file, each carrying on from the last.
  assert.equal(trimList('#EXTM3U\n#EXTINF:5,\n#EXT-X-BYTERANGE:1000\nall.ts\n#EXTINF:5,\n#EXT-X-BYTERANGE:1000\nall.ts\n#EXT-X-ENDLIST\n', URL0, 7), null);
  assert.equal(trimList('#EXTM3U\n#EXT-X-ENDLIST\n', URL0, 5), null);
});

test('a cut list can be fetched by ffmpeg from this machine, until it is taken away', async () => {
  const list = await offerList('#EXTM3U\n#EXT-X-ENDLIST\n');
  assert.match(list.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}\.m3u8$/);
  const res = await fetch(list.url);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /mpegurl/);
  assert.equal(await res.text(), '#EXTM3U\n#EXT-X-ENDLIST\n');
  assert.equal((await fetch(list.url.replace(/[a-f0-9]{32}/, 'f'.repeat(32)))).status, 404, 'nothing to find by guessing');
  list.done();
  assert.equal((await fetch(list.url)).status, 404);
});

// ---- what ffmpeg is told ----

const picture = { url: 'https://m.test/v.m3u8', list: true, hasVideo: true, hasAudio: false, vcodec: 'avc1.640028', headers: {} };
const sound = { url: 'https://m.test/a.m3u8', list: true, hasVideo: false, hasAudio: true, headers: {} };
const stream = () => ({ inputs: [{ ...picture }, { ...sound }], height: 720, fps: 30, live: false, vcodec: 'avc1.640028' });

test('from the top, a segmented stream keeps its own clock and nothing is cut', () => {
  const info = stream();
  const args = ffmpegArgs(info, 0, '720', 48000, 'h264').join(' ');
  assert.match(args, /-copyts/);
  assert.ok(!/ -ss /.test(args) && !/atrim/.test(args));
  assert.match(args, /-i https:\/\/m\.test\/v\.m3u8 .*-i https:\/\/m\.test\/a\.m3u8/);
});

test('partway through, ffmpeg reads the cut lists from their top and the sound is cut to the spot', async () => {
  const info = stream();
  const lists = new Map([[info.inputs[0], LIST], [info.inputs[1], LIST.replace(/5\.338667/, '5.0')]]);
  const handed = [];
  const cuts = await cutLists(info, 12, lists, handed);
  assert.equal(handed.length, 2);
  assert.equal(cuts.get(info.inputs[0]).begins.toFixed(3), '10.010');
  const args = ffmpegArgs(info, 12, '720', 48000, 'h264', cuts);
  const flat = args.join(' ');
  assert.ok(!args.includes('-ss'), 'no seeking: that is what goes wrong in a segmented stream');
  assert.ok(args.includes('-copyts'), 'picture and sound stay on the clock they share');
  assert.ok(flat.includes(`-i ${cuts.get(info.inputs[0]).url}`) && flat.includes(`-i ${cuts.get(info.inputs[1]).url}`));
  assert.ok(!flat.includes('m.test'), 'not the full lists');
  // The sound's segment begins at 10.01, 1.99 s before the spot: 95520 samples at 48 kHz.
  assert.equal(args[args.indexOf('-af') + 1], 'aresample=48000,atrim=start_sample=95520');
  assert.match(flat, /-c:v copy/);
  // The lists ffmpeg will fetch are the cut ones.
  assert.ok((await (await fetch(cuts.get(info.inputs[0]).url)).text()).includes('#EXT-X-MEDIA-SEQUENCE:2'));
  handed.forEach((l) => l.done());

  // Converted picture: the frames before the spot are left out too (the passed-through kind can't be cut mid-way).
  const cuts2 = await cutLists(info, 12, lists, handed);
  const converted = ffmpegArgs(info, 12, '720', 48000, 'mpeg1', cuts2);
  assert.match(converted[converted.indexOf('-vf') + 1], /^select='gte\(t-start_t,1\.990\)',scale=/);
  handed.forEach((l) => l.done());
});

test('when a list cannot be cut, ffmpeg seeks by itself as it does in a file, for every input alike', async () => {
  const info = stream();
  // Only the picture's list is known: cutting one and seeking the other would put them on different clocks.
  assert.equal(await cutLists(info, 12, new Map([[info.inputs[0], LIST]])), null);
  assert.equal(await cutLists(info, 12, null), null);
  assert.equal(await cutLists(info, 0, new Map([[info.inputs[0], LIST], [info.inputs[1], LIST]])), null, 'nothing to cut from the top');
  assert.equal(await cutLists({ ...info, live: true }, 12, new Map([[info.inputs[0], LIST], [info.inputs[1], LIST]])), null, 'nor in a live stream');
  const args = ffmpegArgs(info, 12, '720', 48000, 'h264', null);
  assert.equal(args.filter((a) => a === '-ss').length, 2);
  assert.ok(!args.includes('-copyts') && !args.includes('-af'));
  // A half-filled set of cuts is not used either.
  const half = new Map([[info.inputs[0], { url: 'http://127.0.0.1:1/x.m3u8', begins: 10 }]]);
  const args2 = ffmpegArgs(info, 12, '720', 48000, 'h264', half);
  assert.equal(args2.filter((a) => a === '-ss').length, 2);
  assert.ok(!args2.join(' ').includes('127.0.0.1'));
});

test('plain files are untouched by all this', () => {
  const file = { url: 'https://v.test/video.mp4', headers: {}, hasVideo: true, hasAudio: true, vcodec: 'avc1.640028' };
  const args = ffmpegArgs({ inputs: [file], height: 720, fps: 30, live: false }, 30, '720', 48000, 'h264');
  assert.ok(!args.includes('-copyts') && !args.includes('-af'));
  assert.equal(args[args.indexOf('-ss') + 1], '30');
  // A live segmented stream keeps ffmpeg's own clock: its timestamps can be days long.
  const live = ffmpegArgs({ ...stream(), live: true }, 0, '720', 48000, 'mpeg1');
  assert.ok(!live.includes('-copyts'));
});
