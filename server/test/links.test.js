import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  linkIn,
  linkId,
  isLinkId,
  isPlayableId,
  isLinkAddress,
  siteOf,
  rememberLink,
  urlOf,
  isPrivateAddress,
  addressAllowed,
  guardedFetch,
  plainly,
  pickFormats,
  whyConvert,
  lookup,
  linkItem,
  linkStreamInfo,
  forgetLink,
} from '../src/links.js';
import { cleanItem, Store } from '../src/state.js';
import { recommendFor } from '../src/recommend.js';
import { chooseCodec, ffmpegArgs, findPlayable, refusalReason, failureReason } from '../src/stream.js';

// ---- stand-ins ----

// Name lookups: every name leads out onto the internet unless a test says otherwise.
const outside = async () => [{ address: '93.184.216.34', family: 4 }];
const leadsTo = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

// One version of a video the way links.js keeps it, from a few words.
function version(id, o = {}) {
  return {
    id,
    url: o.url || `https://media.example/${id}${o.list ? '.m3u8' : `.${o.ext || 'mp4'}`}`,
    protocol: o.protocol ?? (o.list ? 'm3u8_native' : 'https'),
    ext: o.ext || 'mp4',
    vcodec: o.vcodec === undefined ? null : o.vcodec,
    acodec: o.acodec === undefined ? null : o.acodec,
    width: o.width || null,
    height: o.height || null,
    fps: o.fps || null,
    tbr: o.tbr || null,
    abr: o.abr || null,
    note: o.note || '',
    language: o.language || '',
    languagePreference: o.languagePreference ?? -1,
    preference: o.preference || 0,
    channels: o.channels || null,
    soundOnly: !!o.soundOnly,
    drm: !!o.drm,
    pieces: !!o.pieces,
    headers: {},
  };
}
const picked = (formats, height) => {
  const p = pickFormats(formats, height);
  return p && [p.video.id, p.audio ? p.audio.id : null];
};

// ---- finding the link in what was pasted ----

test('the link is found in whatever was pasted or shared, and tidied', () => {
  assert.equal(linkIn('https://x.com/someone/status/123'), 'https://x.com/someone/status/123');
  assert.equal(linkIn('Look at this https://www.reddit.com/r/videos/comments/abc/title/ lol'), 'https://www.reddit.com/r/videos/comments/abc/title/');
  assert.equal(linkIn('Watch (https://example.com/v/1).'), 'https://example.com/v/1', 'punctuation from the sentence is left behind');
  assert.equal(linkIn('https://en.wikipedia.org/wiki/Film_(disambiguation)'), 'https://en.wikipedia.org/wiki/Film_(disambiguation)', "a bracket that is part of the address isn't");
  assert.equal(linkIn('x.com/someone/status/123'), 'https://x.com/someone/status/123', 'typed without the https://');
  assert.equal(linkIn('  HTTPS://Example.COM/Video.mp4  '), 'https://example.com/Video.mp4');
});

test('who shared it and from where is dropped, so the same video is the same link', () => {
  assert.equal(linkIn('https://x.com/a/status/1?s=46&t=abcDEF'), 'https://x.com/a/status/1');
  assert.equal(linkIn('https://www.instagram.com/reel/Abc123/?igsh=xyz'), 'https://www.instagram.com/reel/Abc123/');
  assert.equal(linkIn('https://example.com/watch?v=9&utm_source=share&utm_medium=web&fbclid=1'), 'https://example.com/watch?v=9');
  assert.equal(linkIn('https://example.com/watch?t=90&s=1'), 'https://example.com/watch?t=90&s=1', 'only on X do s and t mean that');
  assert.equal(linkIn('https://example.com/page#comments'), 'https://example.com/page');
  assert.equal(linkIn('https://someone:secret@example.com/v'), 'https://example.com/v', "nobody's password is kept");
  assert.equal(linkId(linkIn('https://x.com/a/status/1?s=46')), linkId(linkIn('https://x.com/a/status/1?t=zzz&s=20')));
});

test("what isn't a link to somewhere on the web isn't taken for one", () => {
  for (const text of ['', '   ', 'funny cat videos', 'video.mp4', '3.14', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com/v.mp4', 'ytsearch:cats', '--exec=reboot', 'https://']) {
    assert.equal(linkIn(text), null, text);
  }
  assert.equal(linkIn(`https://example.com/${'a'.repeat(5000)}`), null, 'absurdly long');
});

test('a link gets an ID of its own that can never be mistaken for a YouTube one', () => {
  const id = linkId('https://x.com/a/status/1');
  assert.match(id, /^link-[0-9a-f]{16}$/);
  assert.ok(isLinkId(id) && isPlayableId(id));
  assert.ok(isPlayableId('aqz-KE-bpKQ') && !isLinkId('aqz-KE-bpKQ'));
  assert.ok(isPlayableId('test-pattern'));
  for (const bad of ['link-', 'link-xyz', 'link-0123456789abcdef0', 'LINK-0123456789abcdef', '', null, 42, 'https://x.com']) assert.ok(!isPlayableId(bad), String(bad));
  assert.notEqual(linkId('https://x.com/a/status/1'), linkId('https://x.com/a/status/2'));
  assert.equal(urlOf(id), null, "an ID alone doesn't say which link it was");
  assert.equal(rememberLink('https://x.com/a/status/1'), id);
  assert.equal(urlOf(id), 'https://x.com/a/status/1');
});

test('sites people share from are called by name, any other by its address', () => {
  assert.equal(siteOf('https://x.com/a/status/1'), 'X');
  assert.equal(siteOf('https://mobile.twitter.com/a/status/1'), 'X');
  assert.equal(siteOf('https://old.reddit.com/r/x/comments/1/'), 'Reddit');
  assert.equal(siteOf('https://v.redd.it/abc'), 'Reddit');
  assert.equal(siteOf('https://www.instagram.com/reel/A/'), 'Instagram');
  assert.equal(siteOf('https://www.example.com/page'), 'example.com');
  assert.equal(siteOf('https://videos.example.co.uk/page'), 'videos.example.co.uk');
  assert.equal(siteOf('not a link'), 'that site');
});

// ---- what the server won't fetch from ----

test("addresses that aren't out on the internet are known for what they are", () => {
  const inside = [
    '127.0.0.1', '127.8.9.10', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.70.70', '169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fd12:3456::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:c0a8:4646', '::192.168.1.1', '64:ff9b::a00:1', '2002:c0a8:101::1', '[::1]', 'fe80::1%eth0',
    'not an address', '', '999.1.1.1',
  ];
  for (const ip of inside) assert.equal(isPrivateAddress(ip), true, ip);
  const outsideOnes = ['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.63.0.1', '100.128.0.1', '2606:4700::6810:84e5', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'];
  for (const ip of outsideOnes) assert.equal(isPrivateAddress(ip), false, ip);
});

test('a link is only followed out onto the internet', async () => {
  await addressAllowed('https://example.com/v', outside, false);
  await addressAllowed('http://93.184.216.34:8080/v.mp4', outside, false);
  const refused = /inside this server's own network/;
  // Written as addresses, in every way a browser would understand them.
  for (const url of [
    'http://127.0.0.1:8080/internal/updater', 'http://localhost/', 'http://LOCALHOST./', 'http://192.168.70.1/', 'http://[::1]/', 'http://[::ffff:10.0.0.1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://127.1/', 'http://0/',
    'http://169.254.169.254/latest/meta-data/', 'http://router/', 'http://drivepost:8080/', 'http://nas.local/v.mp4', 'http://printer.lan/', 'http://thing.home.arpa/', 'http://app.internal/',
  ]) {
    await assert.rejects(addressAllowed(url, outside, false), refused, url);
  }
  // A name that leads inward, wherever it says it is.
  await assert.rejects(addressAllowed('https://innocent.example.com/', leadsTo('192.168.70.70'), false), refused);
  await assert.rejects(addressAllowed('https://innocent.example.com/', leadsTo('93.184.216.34', '127.0.0.1'), false), refused, 'one inward address among several is enough');
  await assert.rejects(addressAllowed('https://innocent.example.com/', leadsTo('fd00::5'), false), refused);
  await assert.rejects(addressAllowed('https://innocent.example.com/', leadsTo(), false), refused, 'a name that leads nowhere');
  // Only the web.
  for (const url of ['file:///etc/passwd', 'ftp://example.com/v', 'gopher://example.com/', 'data:text/plain,hi']) {
    await assert.rejects(addressAllowed(url, outside, false), /Only http and https/, url);
  }
  await assert.rejects(addressAllowed('nonsense', outside, false), /isn't a web address/);
  await assert.rejects(
    addressAllowed('https://no-such-site.example/', async () => { throw new Error('ENOTFOUND'); }, false),
    /Couldn't find no-such-site\.example/
  );
});

test("the server's own requests are checked again wherever they are sent on to", async () => {
  const real = globalThis.fetch;
  const asked = [];
  // An address out on the internet that answers "go here instead", pointing inward.
  globalThis.fetch = async (url, opts) => {
    asked.push([url, opts.redirect]);
    if (url === 'http://93.184.216.34/video.mp4') return { status: 302, headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }), body: null };
    if (url === 'http://93.184.216.34/moved.mp4') return { status: 301, headers: new Headers({ location: '/here.mp4' }), body: null };
    return { status: 206, headers: new Headers(), body: null };
  };
  try {
    await assert.rejects(guardedFetch('http://93.184.216.34/video.mp4'), /inside this server's own network/);
    assert.deepEqual(asked, [['http://93.184.216.34/video.mp4', 'manual']], 'the inward address was never asked');
    asked.length = 0;
    const res = await guardedFetch('http://93.184.216.34/moved.mp4', { headers: { Range: 'bytes=0-1023' } });
    assert.equal(res.status, 206);
    assert.deepEqual(asked.map((a) => a[0]), ['http://93.184.216.34/moved.mp4', 'http://93.184.216.34/here.mp4'], 'an ordinary move is followed');
    await assert.rejects(guardedFetch('http://127.0.0.1:8080/internal/updater'), /inside this server's own network/);
    assert.equal(asked.length, 2, 'and an inward address is refused before anything is sent');
  } finally {
    globalThis.fetch = real;
  }
});

test('OTHER_SITES_LOCAL=on lets a link lead to the home network, and still only by http', async () => {
  await addressAllowed('http://192.168.70.20:8096/video.mp4', outside, true);
  await addressAllowed('http://nas.local/v.mp4', outside, true);
  await assert.rejects(addressAllowed('file:///etc/passwd', outside, true), /Only http and https/);
});

// ---- picking the version to play ----

// A post on X, as yt-dlp lists it: plain files with picture and sound whose codec it doesn't name, and the same as lists of segments.
const onX = () => [
  version('hls-audio-32000', { list: true, vcodec: 'none', abr: 32 }),
  version('hls-audio-64000', { list: true, vcodec: 'none', abr: 64 }),
  version('http-320', { width: 320, height: 180, tbr: 320 }),
  version('hls-126', { list: true, vcodec: 'avc1.42C00C', acodec: 'none', width: 320, height: 180, tbr: 126 }),
  version('http-832', { width: 640, height: 360, tbr: 832 }),
  version('hls-348', { list: true, vcodec: 'avc1.42C01E', acodec: 'none', width: 640, height: 360, tbr: 348 }),
  version('http-2176', { width: 1280, height: 720, tbr: 2176 }),
  version('hls-1200', { list: true, vcodec: 'avc1.4d001f', acodec: 'none', width: 1280, height: 720, tbr: 1200 }),
];

test('X: the plain file with picture and sound together, at the quality asked for', () => {
  assert.deepEqual(picked(onX(), 1080), ['http-2176', null]);
  assert.deepEqual(picked(onX(), 720), ['http-2176', null]);
  assert.deepEqual(picked(onX(), 480), ['http-832', null], 'the biggest that fits');
  assert.deepEqual(picked(onX(), 360), ['http-832', null]);
});

test('Reddit: separate picture and sound files, never the picture that has no sound to go with it', () => {
  const formats = [
    version('fallback', { width: 1280, height: 720, vcodec: null, acodec: 'none', preference: -1 }),
    version('hls-audio', { list: true, vcodec: 'none', abr: 128 }),
    version('hls-800', { list: true, vcodec: 'avc1.4d001e', acodec: 'none', width: 640, height: 360, tbr: 800 }),
    version('hls-2400', { list: true, vcodec: 'avc1.4d001f', acodec: 'none', width: 1280, height: 720, tbr: 2400 }),
    version('dash-audio', { vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, ext: 'm4a' }),
    version('dash-360', { vcodec: 'avc1.4d001e', acodec: 'none', width: 640, height: 360, tbr: 800 }),
    version('dash-720', { vcodec: 'avc1.4d001f', acodec: 'none', width: 1280, height: 720, tbr: 2400 }),
  ];
  assert.deepEqual(picked(formats, 1080), ['dash-720', 'dash-audio'], 'files before lists, and the sound that comes the same way');
  assert.deepEqual(picked(formats, 360), ['dash-360', 'dash-audio']);
  // Only lists on offer: picture and sound from lists.
  assert.deepEqual(picked(formats.filter((f) => !/^dash|fallback/.test(f.id)), 720), ['hls-2400', 'hls-audio']);
  // A post with no sound at all still plays.
  assert.deepEqual(picked([formats[0]], 720), ['fallback', null]);
});

test('Instagram: the sharper picture with its separate sound over the smaller all-in-one file', () => {
  const formats = [
    version('dash-audio', { vcodec: 'none', acodec: 'mp4a.40.5', abr: 96, ext: 'm4a' }),
    version('dash-540', { vcodec: 'avc1.4d001f', acodec: 'none', width: 540, height: 960, tbr: 900 }),
    version('dash-1080', { vcodec: 'avc1.640028', acodec: 'none', width: 1080, height: 1920, tbr: 3200 }),
    version('progressive', { vcodec: 'avc1.64001f', acodec: 'mp4a.40.2', width: 720, height: 1280, tbr: 1500 }),
  ];
  assert.deepEqual(picked(formats, 1080), ['dash-1080', 'dash-audio'], 'held upright it is 1080 wide: that is 1080p');
  assert.deepEqual(picked(formats, 720), ['progressive', null]);
  assert.deepEqual(picked(formats, 480), ['dash-540', 'dash-audio'], 'nothing fits: the smallest that is too big, to be scaled down');
});

test('a page with a player, or a plain link to a file: what is there', () => {
  // <video> with two <source>s, and nothing said about either.
  assert.deepEqual(picked([version('0', { ext: 'ogv' }), version('1', { ext: 'mp4' })], 1080), ['1', null], 'the one that is usually H.264');
  assert.deepEqual(picked([version('0', {})], 360), ['0', null]);
  // A stream as one list, picture and sound together, in three sizes.
  const stream = [
    version('hls-400', { list: true, vcodec: 'avc1.42c01e', acodec: 'mp4a.40.2', width: 640, height: 360, tbr: 400 }),
    version('hls-1500', { list: true, vcodec: 'avc1.4d001f', acodec: 'mp4a.40.2', width: 1280, height: 720, tbr: 1500 }),
    version('hls-4000', { list: true, vcodec: 'avc1.640028', acodec: 'mp4a.40.2', width: 1920, height: 1080, tbr: 4000 }),
  ];
  assert.deepEqual(picked(stream, 720), ['hls-1500', null]);
  assert.deepEqual(picked(stream, 1080), ['hls-4000', null]);
});

test('H.264 is picked over what would have to be converted, sound in the right language, and the second-rate last', () => {
  const formats = [
    version('vp9-1080', { vcodec: 'vp09.00.40.08', acodec: 'none', width: 1920, height: 1080, ext: 'webm', tbr: 2500 }),
    version('avc-720', { vcodec: 'avc1.4d001f', acodec: 'none', width: 1280, height: 720, tbr: 2000 }),
    version('dub', { vcodec: 'none', acodec: 'mp4a.40.2', abr: 160, language: 'de', languagePreference: -10, ext: 'm4a' }),
    version('own', { vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, language: 'en', languagePreference: 10, ext: 'm4a' }),
    version('surround', { vcodec: 'none', acodec: 'ac-3', abr: 384, language: 'en', languagePreference: 10, channels: 6, ext: 'm4a' }),
  ];
  assert.deepEqual(picked(formats, 1080), ['avc-720', 'own']);
  assert.deepEqual(picked([formats[0], formats[3]], 1080), ['vp9-1080', 'own'], 'when it is all there is, it is converted');
  const marked = [version('watermarked', { width: 1280, height: 720, tbr: 3000, preference: -2 }), version('clean', { width: 960, height: 540, tbr: 1500 })];
  assert.deepEqual(picked(marked, 1080), ['clean', null]);
});

test("what ffmpeg can't be handed as one address is left out, and a link with nothing else can't be played", () => {
  const pieces = version('dash-pieces', { protocol: 'http_dash_segments', vcodec: 'avc1.640028', acodec: 'none', height: 1080, pieces: true });
  const locked = version('locked', { vcodec: 'avc1.640028', acodec: 'mp4a.40.2', height: 1080, drm: true });
  const storyboard = version('sb0', { ext: 'mhtml', protocol: 'mhtml', vcodec: 'none', acodec: 'none', note: 'storyboard' });
  const rtmp = version('rtmp', { protocol: 'rtmp', url: 'rtmp://media.example/live' });
  const song = version('mp3', { ext: 'mp3', vcodec: 'none', acodec: 'mp3' });
  const podcast = version('audio', { ext: 'mp3' });
  assert.equal(pickFormats([pieces, locked, storyboard, rtmp], 1080), null);
  assert.equal(pickFormats([song], 1080), null, 'sound alone is not a video');
  assert.equal(pickFormats([podcast], 1080), null, 'nor is a sound file nothing is said about');
  assert.equal(pickFormats([], 1080), null);
  assert.deepEqual(picked([pieces, locked, version('ok', { height: 480 })], 1080), ['ok', null]);
  assert.equal(pickFormats([{ ...version('odd', {}), url: 'file:///etc/passwd' }], 1080), null, 'only web addresses');
});

// ---- pass it on, or convert it ----

test('a picture is passed on to the car only when it is H.264 the car can decode as it stands', () => {
  const seen = (video) => ({ video: { codec: 'h264', profile: 'High', pixFmt: 'yuv420p', width: 1280, height: 720, fps: 30, interlaced: false, turned: false, ...video }, audio: true, duration: 60 });
  const any = version('0', {});
  assert.equal(whyConvert(any, seen({}), 1080), '');
  assert.equal(whyConvert(any, seen({ width: 1080, height: 1920 }), 1080), '', 'upright 1080p');
  assert.equal(whyConvert(any, seen({ width: 1920, height: 1088 }), 1080), '', 'a few rows over, as encoders make it');
  assert.match(whyConvert(any, seen({ codec: 'hevc' }), 1080), /it is hevc/);
  assert.match(whyConvert(any, seen({ codec: 'vp9' }), 1080), /it is vp9/);
  assert.match(whyConvert(any, seen({ pixFmt: 'yuv420p10le', profile: 'High 10' }), 1080), /browsers don't decode/);
  assert.match(whyConvert(any, seen({ pixFmt: 'yuv444p', profile: 'High 4:4:4 Predictive' }), 1080), /browsers don't decode/);
  assert.match(whyConvert(any, seen({ turned: true }), 1080), /on its side/);
  assert.match(whyConvert(any, seen({ interlaced: true }), 1080), /interlaced/);
  assert.match(whyConvert(any, seen({ width: 3840, height: 2160 }), 1080), /bigger than 1080p/);
  assert.match(whyConvert(any, seen({}), 480), /bigger than 480p/);
  // ffprobe couldn't look: the site's word is taken for it, and silence is not a yes.
  assert.equal(whyConvert(version('a', { vcodec: 'avc1.4d001f', height: 720 }), null, 1080), '');
  assert.match(whyConvert(version('a', { vcodec: 'avc1.4d001f', height: 1440 }), null, 1080), /bigger than/);
  assert.match(whyConvert(any, null, 1080), /isn't known to be H\.264/);
});

// ---- asking yt-dlp ----

const answers = (json) => ({ lookup: outside, ytdlp: async () => JSON.stringify(json) });
const fails = (message) => ({
  lookup: outside,
  ytdlp: async () => {
    throw new Error(message);
  },
});

test('a post becomes a row: what it is called, who posted it, where, and how to play it again', async () => {
  const url = 'https://x.com/someone/status/1001';
  const item = await linkItem(url, answers({
    id: '1001', title: 'Someone - a  thing\nhappened', uploader: 'Someone', duration: 111.278, thumbnail: 'https://pbs.example/thumb.jpg?name=orig', extractor_key: 'Twitter',
    http_headers: { 'User-Agent': 'UA' },
    formats: [{ format_id: 'http-832', url: 'https://video.example/832.mp4', protocol: 'https', ext: 'mp4', width: 640, height: 360, tbr: 832 }],
  }));
  assert.deepEqual(item, { id: linkId(url), url, site: 'X', title: 'Someone - a thing happened', channel: 'Someone', duration: 111, live: false, thumb: 'https://pbs.example/thumb.jpg?name=orig' });
  assert.equal(urlOf(item.id), url, 'and the server now knows which link that ID is');
});

test('a plain link to a file, a page with several videos, and a page that shows a YouTube video', async () => {
  // yt-dlp answers for a file with no list of versions: the answer is the version.
  const file = await linkItem('https://files.example/clips/holiday.mp4', answers({ id: 'holiday', title: 'holiday', url: 'https://files.example/clips/holiday.mp4', ext: 'mp4', protocol: 'https', direct: true }));
  assert.equal(file.title, 'holiday');
  assert.equal(file.site, 'files.example');
  assert.equal(file.duration, null);
  assert.equal(file.thumb, '');
  const found = await lookup('https://files.example/clips/holiday.mp4');
  assert.equal(found.formats.length, 1);
  assert.equal(found.formats[0].url, 'https://files.example/clips/holiday.mp4');

  // The first video of several.
  const page = await linkItem('https://news.example/story', answers({
    _type: 'playlist', title: 'Story', entries: [null, { id: 'a', title: 'First clip', formats: [{ format_id: '1', url: 'https://news.example/a.mp4' }] }, { id: 'b', title: 'Second clip', formats: [{ format_id: '1', url: 'https://news.example/b.mp4' }] }],
  }));
  assert.equal(page.title, 'First clip');

  // YouTube's player on someone's page: it plays as the YouTube video it is.
  const embedded = await linkItem('https://blog.example/post', answers({ _type: 'playlist', entries: [{ id: 'aqz-KE-bpKQ', title: 'Big Buck Bunny', channel: 'Blender', duration: 635, extractor_key: 'Youtube', formats: [{ format_id: '18', url: 'https://rr1.example/v' }] }] }));
  assert.deepEqual(embedded, { id: 'aqz-KE-bpKQ', title: 'Big Buck Bunny', channel: 'Blender', duration: 635, live: false, thumb: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg' });

  // A picture that isn't https would be blocked on an https page: left out.
  const plainThumb = await linkItem('https://old.example/v', answers({ id: 'v', title: 'Old', thumbnail: 'http://old.example/t.jpg', formats: [{ format_id: '1', url: 'https://old.example/v.mp4' }] }));
  assert.equal(plainThumb.thumb, '');
});

test('when a site has no video to give, the reason is said in plain words with no links in it', async () => {
  const said = async (url, message) => {
    forgetLink(linkId(url));
    return linkItem(url, fails(message)).then(() => assert.fail('should not have worked'), (e) => e.message);
  };
  assert.match(await said('https://www.reddit.com/r/a/comments/1/', '[Reddit] 6rrwyj: Account authentication is required. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies'), /^Reddit only shows that video to signed-in visitors/);
  assert.match(await said('https://www.instagram.com/reel/A/', '[Instagram] A: The webpage request was redirected to the login page. You have exceeded the rate-limit for accessing posts anonymously.'), /^Instagram only shows that video to signed-in visitors/);
  assert.match(await said('https://x.com/a/status/2', '[twitter] 2: No video could be found in this tweet'), /^No video was found at that link/);
  assert.match(await said('https://example.com/', 'Unsupported URL: https://example.com/'), /^No video was found at that link/);
  assert.match(await said('https://example.com/gone', '[generic] Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)'), /isn't available/);
  assert.match(await said('https://example.com/far', '[generic] far: Unable to download webpage: <urlopen error timed out>'), /couldn't reach example\.com/);
  assert.match(await said('https://tv.example/show', '[TV] show: This video is DRM protected'), /copy-protected/);
  assert.match(await said('https://www.instagram.com/reel/B/', "PermissionError: [Errno 13] Permission denied: '/data/cookies-sites.txt'"), /can't write to its cookies file/);
  for (const message of ['[generic] x: Something odd at https://secret.example/token=abc happened']) {
    assert.doesNotMatch(plainly(message, 'example.com'), /https?:|secret\.example/);
  }
  // Nothing in the answer at all.
  forgetLink(linkId('https://example.com/empty'));
  await assert.rejects(linkItem('https://example.com/empty', answers({ _type: 'playlist', entries: [] })), /No video was found/);
  // A link that leads inward is refused before yt-dlp is asked anything.
  let asked = false;
  await assert.rejects(
    linkItem('https://looks-fine.example/v', { lookup: leadsTo('192.168.70.1'), ytdlp: async () => { asked = true; return '{}'; } }),
    /inside this server's own network/
  );
  assert.equal(asked, false);
});

// ---- what ffmpeg is given ----

const probeSays = (streams, duration) => async () => JSON.stringify({ streams, format: duration ? { duration: String(duration) } : {} });
const h264Stream = { codec_type: 'video', codec_name: 'h264', profile: 'Main', pix_fmt: 'yuv420p', width: 1280, height: 720, avg_frame_rate: '30000/1001', field_order: 'progressive' };
const aacStream = { codec_type: 'audio', codec_name: 'aac', avg_frame_rate: '0/0' };

test("a link's video is handed to ffmpeg in the same shape as YouTube's, with what ffprobe saw", async () => {
  const url = 'https://x.com/someone/status/2002';
  const deps = { ...answers({ id: '2002', title: 'Clip', uploader: 'Someone', formats: [{ format_id: 'http-2176', url: 'https://video.example/2176.mp4', protocol: 'https', ext: 'mp4', width: 1280, height: 720, tbr: 2176, http_headers: { 'User-Agent': 'UA', Bad: 'x\r\ny' }, cookies: 'sid=abc; Domain=.example; Path=/; Secure; Expires=99; lang=en; Domain=.example; Path=/' }] }), run: probeSays([h264Stream, aacStream], 61.5) };
  const item = await linkItem(url, deps);
  const info = await linkStreamInfo(item.id, '1080', deps);
  assert.equal(info.duration, 61.5, 'the length the site left out');
  assert.equal(info.live, false);
  assert.equal(info.height, 720);
  assert.equal(info.convert, '');
  assert.equal(info.site, 'X');
  assert.match(info.vcodec, /^avc1/);
  assert.equal(chooseCodec('h264', info), 'h264');
  assert.equal(chooseCodec('mpeg1', info), 'mpeg1');
  assert.equal(info.inputs.length, 1);
  const input = info.inputs[0];
  assert.deepEqual([input.hasVideo, input.hasAudio, input.list, input.other], [true, true, false, true]);
  assert.deepEqual(input.headers, { 'User-Agent': 'UA', Cookie: 'sid=abc; lang=en' }, 'its cookies go along; a header that would break out of its line does not');
  const args = ffmpegArgs(info, 30, '1080', 48000, 'h264').join(' ');
  assert.match(args, /-protocol_whitelist http,https,tls,tcp,crypto,data,httpproxy [\s\S]*-ss 30 -i https:\/\/video\.example\/2176\.mp4/, 'ffmpeg is kept to the web');
  assert.match(args, /-map 0:v:0 -map 0:a:0\? /, 'sound if it turns out to have some');
  assert.match(args, /-c:v copy -bsf:v h264_mp4toannexb,filter_units=remove_types=6 /, "passed on without the encoder's notes, which a browser's decoder can trip over");
  // YouTube's own goes through exactly as it did.
  const youtube = { ...info, inputs: info.inputs.map((i) => ({ ...i, other: undefined })) };
  assert.match(ffmpegArgs(youtube, 0, '1080', 48000, 'h264').join(' '), /-map 0:v:0 -map 0:a:0 -c:v copy -bsf:v h264_mp4toannexb -c:a mp2/);
});

test("a file with no sound in it plays silent, one that isn't H.264 is converted, and an endless stream plays as live", async () => {
  // A "GIF": the site says nothing, ffprobe finds a picture and no sound.
  let url = 'https://i.example/funny.mp4';
  let deps = { ...answers({ id: 'funny', title: 'funny', url, ext: 'mp4', protocol: 'https' }), run: probeSays([{ ...h264Stream, width: 480, height: 481 }], 4) };
  let info = await linkStreamInfo((await linkItem(url, deps)).id, '720', deps);
  assert.equal(info.inputs[0].hasAudio, false);
  assert.equal(info.convert, '');
  assert.match(ffmpegArgs(info, 0, '720', 48000, 'mpeg1').join(' '), /scale=-2:'trunc\(min\(481,ih\)\/2\)\*2'.* -an /, 'an odd height is evened out when it is converted');

  // VP9 in a WebM.
  url = 'https://clips.example/a.webm';
  deps = { ...answers({ id: 'a', title: 'a', url, ext: 'webm', protocol: 'https' }), run: probeSays([{ ...h264Stream, codec_name: 'vp9', profile: 'Profile 0' }, { ...aacStream, codec_name: 'opus' }], 20) };
  info = await linkStreamInfo((await linkItem(url, deps)).id, '1080', deps);
  assert.match(info.convert, /it is vp9/);
  assert.equal(chooseCodec('h264', info), 'mpeg1');

  // A phone video stored on its side: converting turns it upright.
  url = 'https://clips.example/phone.mov';
  deps = { ...answers({ id: 'p', title: 'p', url, ext: 'mov', protocol: 'https' }), run: probeSays([{ ...h264Stream, side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }, aacStream], 12) };
  info = await linkStreamInfo((await linkItem(url, deps)).id, '1080', deps);
  assert.match(info.convert, /on its side/);

  // A list of segments with no end in sight.
  url = 'https://tv.example/live';
  deps = { ...answers({ id: 'live', title: 'Channel', formats: [{ format_id: 'hls-1', url: 'https://tv.example/live/index.m3u8', protocol: 'm3u8_native', ext: 'mp4', vcodec: 'avc1.4d001f', acodec: 'mp4a.40.2', height: 720 }] }), run: probeSays([h264Stream, aacStream], 0) };
  info = await linkStreamInfo((await linkItem(url, deps)).id, '720', deps);
  assert.equal(info.live, true);
  assert.equal(info.inputs[0].list, true);
  assert.equal(chooseCodec('h264', info), 'mpeg1', 'live is always converted');

  // Sound and nothing else.
  url = 'https://radio.example/show.mp4';
  deps = { ...answers({ id: 's', title: 's', url, ext: 'mp4', protocol: 'https' }), run: probeSays([aacStream], 1800) };
  await assert.rejects(linkStreamInfo((await linkItem(url, deps)).id, '720', deps), /sound but no picture/);

  // ffprobe can't look (it isn't there, or the site turns it away): the site's word is taken for it.
  url = 'https://x.com/someone/status/3003';
  deps = { ...answers({ id: '3003', title: 'Clip', duration: 9, formats: [{ format_id: 'hls-2176', url: 'https://video.example/2176.m3u8', protocol: 'm3u8_native', ext: 'mp4', vcodec: 'avc1.4d0020', acodec: 'mp4a.40.2', width: 1280, height: 720 }] }), run: async () => { throw new Error('Could not run ffprobe'); } };
  info = await linkStreamInfo((await linkItem(url, deps)).id, '1080', deps);
  assert.equal(info.seen, false);
  assert.equal(info.convert, '');
  assert.equal(info.inputs[0].hasAudio, true);
});

test('media that yt-dlp found somewhere inward is not fetched either', async () => {
  const url = 'https://tricky.example/watch';
  const names = async (host) => (host === 'tricky.example' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '10.0.0.5', family: 4 }]);
  const deps = { lookup: names, ytdlp: async () => JSON.stringify({ id: 't', title: 't', formats: [{ format_id: '0', url: 'http://files.tricky.example/secret.mp4', protocol: 'http', ext: 'mp4' }] }), run: async () => assert.fail('ffprobe was pointed at it') };
  const item = await linkItem(url, deps);
  await assert.rejects(linkStreamInfo(item.id, '720', deps), /inside this server's own network/);
});

test('a link is tried before it is played, looked up afresh when it has gone stale, and refused in the site\'s name', async () => {
  const id = rememberLink('https://x.com/someone/status/4004');
  const input = { url: 'https://video.example/a.mp4', headers: {}, hasVideo: true, hasAudio: true, list: false, other: true };
  const infoAt = (at) => ({ at, site: 'X', inputs: [{ ...input }], duration: 60, live: false });
  // Plays.
  let looked = 0;
  let found = await findPlayable(id, '720', { linkStreamInfo: async () => (looked++, infoAt(Date.now())), linkStatus: async () => 206 });
  assert.ok(found.info && found.lists instanceof Map);
  assert.equal(looked, 1);
  // Stale links: one fresh lookup, and then it plays.
  looked = 0;
  const statuses = [403, 200];
  found = await findPlayable(id, '720', { linkStreamInfo: async () => (looked++, infoAt(Date.now() - 10 * 60 * 1000)), linkStatus: async () => statuses.shift() });
  assert.ok(found.info);
  assert.equal(looked, 2);
  // Refused outright.
  found = await findPlayable(id, '720', { linkStreamInfo: async () => infoAt(Date.now()), linkStatus: async () => 403 });
  assert.equal(found.message, "Couldn't play this video: X refused to send it (403 Forbidden)");
  // An answer that isn't a plain no is left for ffmpeg to find out.
  found = await findPlayable(id, '720', { linkStreamInfo: async () => infoAt(Date.now()), linkStatus: async () => 405 });
  assert.ok(found.info);
  // The lookup's own words come through as they are.
  found = await findPlayable(id, '720', { linkStreamInfo: async () => { throw new Error('Reddit only shows that video to signed-in visitors.'); } });
  assert.equal(found.message, "Couldn't load this video: Reddit only shows that video to signed-in visitors.");
  found = await findPlayable(id, '720', { linkStreamInfo: async () => infoAt(Date.now()), linkStatus: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(found.message, "Couldn't load this video: this server couldn't reach X");
  // Whose refusal it is.
  assert.equal(refusalReason(429, 'Reddit'), 'Reddit is turning this server away for now (429 Too Many Requests)');
  assert.equal(refusalReason(403), 'YouTube refused to send it (403 Forbidden)');
  assert.equal(failureReason('[https @ 0x1] HTTP error 403 Forbidden\nhttps://video.example/a.mp4: Server returned 403 Forbidden (access denied)', 1, 'X').said, 'X refused to send it (403 Forbidden)');
});

// ---- rows, and the lists that stay YouTube's ----

test('a row for a link is kept only with the address its ID is made from', () => {
  const url = 'https://x.com/someone/status/5005';
  const id = linkId(url);
  const row = cleanItem({ id, url, site: 'Whatever The Phone Says', title: 'Clip', channel: 'Someone', duration: 42.4, live: false, thumb: 'https://pbs.example/t.jpg', extra: 'dropped' });
  assert.deepEqual(row, { id, title: 'Clip', channel: 'Someone', duration: 42, live: false, url, site: 'X', thumb: 'https://pbs.example/t.jpg' });
  assert.equal(urlOf(id), url);
  assert.equal(cleanItem({ id, url: 'https://x.com/someone/status/6006', title: 'Swapped' }), null, 'another address under the same ID');
  assert.equal(cleanItem({ id, title: 'No address' }), null);
  assert.equal(cleanItem({ id: linkId('file:///etc/passwd'), url: 'file:///etc/passwd', title: 'x' }), null);
  assert.equal(cleanItem({ id: linkId('https://a:b@x.com/'), url: 'https://a:b@x.com/', title: 'x' }), null);
  for (const thumb of ['http://pbs.example/t.jpg', 'javascript:alert(1)', 'https://pbs.example/t.jpg" onerror="x', `https://pbs.example/${'a'.repeat(1200)}`, 42]) {
    assert.equal(cleanItem({ id, url, title: 'Clip', thumb }).thumb, '', String(thumb).slice(0, 40));
  }
  // YouTube rows are what they were.
  assert.deepEqual(cleanItem({ id: 'aqz-KE-bpKQ', title: 'Bunny', url: 'https://evil.example/', site: 'X', thumb: 'https://evil.example/t.jpg' }), {
    id: 'aqz-KE-bpKQ', title: 'Bunny', channel: '', duration: null, live: false, thumb: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg',
  });
});

test('links are played, lined up, resumed and remembered like any other video', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drivepost-'));
  const store = new Store({ dataDir, defaultQuality: '720' });
  const url = 'https://x.com/someone/status/7007';
  const clip = { id: linkId(url), url, title: 'Clip', channel: 'Someone', duration: null };
  assert.equal(store.command('play', { item: { id: 'aqz-KE-bpKQ', title: 'Bunny', duration: 600 } }), null);
  assert.equal(store.command('enqueue', { item: clip }), null);
  assert.equal(store.queue[0].site, 'X');
  store.command('next');
  assert.equal(store.now.id, clip.id);
  assert.equal(store.history[0].id, clip.id);
  // The car learns how long it is, and the lists learn it with it.
  store.carPosition({ seq: store.now.seq, t: 40, state: 'playing', duration: 111.3 });
  assert.equal(store.now.duration, 111);
  assert.equal(store.history[0].duration, 111);
  assert.equal(store.history[1].duration, 600, "another video's length is left alone");
  // Come back to it later: it picks up where it was.
  store.command('play', { item: { id: 'aqz-KE-bpKQ', title: 'Bunny', duration: 600 } });
  store.command('play', { item: store.history.find((h) => h.id === clip.id) });
  assert.equal(store.now.startAt, 40);
  // And it is all still there after a restart, address included.
  store.saveNow();
  const again = new Store({ dataDir, defaultQuality: '720' });
  assert.equal(again.now.url, url);
  assert.equal(again.history.find((h) => h.id === clip.id).site, 'X');
});

test('For You goes by YouTube videos only: a link has nothing like it to recommend', async () => {
  const link = { id: linkId('https://x.com/someone/status/8008'), url: 'https://x.com/someone/status/8008', title: 'Clip' };
  const yt = { id: 'aqz-KE-bpKQ', title: 'Bunny' };
  const askedFor = [];
  const getRelated = async (id) => {
    askedFor.push(id);
    return [{ id: 'vid0001AAAA', title: 'Like Bunny' }];
  };
  const mixed = await recommendFor({ now: link, history: [link, yt], queue: [] }, getRelated);
  assert.deepEqual(askedFor, ['aqz-KE-bpKQ']);
  assert.equal(mixed.from, 1);
  assert.deepEqual(mixed.items.map((v) => v.id), ['vid0001AAAA']);
  const onlyLinks = await recommendFor({ now: link, history: [link], queue: [] }, getRelated);
  assert.deepEqual(onlyLinks, { items: [], from: 0 });
});
