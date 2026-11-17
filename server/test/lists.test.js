import test from 'node:test';
import assert from 'node:assert/strict';
import { extractListId, extractChannel, isListId, isChannelRef, extractVideoId } from '../src/youtube.js';

test('a playlist is found in a link to the list, or in a video link that says which list it came from', () => {
  const pl = 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';
  assert.equal(extractListId(`https://www.youtube.com/playlist?list=${pl}`), pl);
  assert.equal(extractListId(`https://youtube.com/playlist?list=${pl}&si=abc`), pl);
  assert.equal(extractListId(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${pl}&index=3`), pl);
  assert.equal(extractListId(`https://youtu.be/dQw4w9WgXcQ?list=${pl}`), pl);
  assert.equal(extractListId(`https://music.youtube.com/playlist?list=OLAK5uy_kzcM3Lw9SwNXZpJdr2oB7XaBcd_Fq0fmE`), 'OLAK5uy_kzcM3Lw9SwNXZpJdr2oB7XaBcd_Fq0fmE');
  // (The video is still found in such a link.)
  assert.equal(extractVideoId(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${pl}`), 'dQw4w9WgXcQ');
  // YouTube's endless mixes and its private lists are not lists anyone else can read: the link is just the video's.
  assert.equal(extractListId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1'), null);
  assert.equal(extractListId('https://www.youtube.com/playlist?list=WL'), null);
  assert.equal(extractListId('https://www.youtube.com/playlist?list=LL'), null);
  // Not YouTube's, or nothing there.
  assert.equal(extractListId(`https://example.com/watch?list=${pl}`), null);
  assert.equal(extractListId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(extractListId(''), null);
  assert.equal(isListId(pl), true);
  assert.equal(isListId('PL short'), false);
  assert.equal(isListId('--exec=rm'), false);
});

test('a channel is found in a link by its ID, its handle, or its older names', () => {
  const id = 'UC' + 'x'.repeat(22);
  assert.equal(extractChannel(`https://www.youtube.com/channel/${id}`), id);
  assert.equal(extractChannel(`https://www.youtube.com/channel/${id}/videos`), id);
  assert.equal(extractChannel('https://www.youtube.com/@SomeChannel'), '@SomeChannel');
  assert.equal(extractChannel('https://youtube.com/@some.channel-2/streams?si=x'), '@some.channel-2');
  assert.equal(extractChannel('https://www.youtube.com/c/OldName/videos'), 'c/OldName');
  assert.equal(extractChannel('https://www.youtube.com/user/olderName'), 'user/olderName');
  assert.equal(extractChannel('look at https://www.youtube.com/@SomeChannel it is good'), '@SomeChannel');
  assert.equal(extractChannel('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(extractChannel('https://example.com/@SomeChannel'), null);
  assert.equal(extractChannel('https://www.youtube.com/channel/UCshort'), null);
  for (const ref of [id, '@SomeChannel', 'c/OldName', 'user/olderName']) assert.equal(isChannelRef(ref), true, ref);
  for (const ref of ['', '@', 'c/', '../etc', '@a b', 'channel/x', '--version', 'UC' + 'x'.repeat(22) + '/../..']) assert.equal(isChannelRef(ref), false, ref);
});

test('a link that says where to start is taken at its word', async () => {
  const { extractStartAt } = await import('../src/youtube.js');
  assert.equal(extractStartAt('https://youtu.be/ARNCiV2mb2s?t=96&si=ErGxguEPeR4Su1Fe'), 96);
  assert.equal(extractStartAt('https://youtu.be/ARNCiV2mb2s?si=ErGxguEPeR4Su1Fe&t=96'), 96);
  assert.equal(extractStartAt('https://www.youtube.com/watch?v=ARNCiV2mb2s&t=96s'), 96);
  assert.equal(extractStartAt('https://www.youtube.com/watch?v=ARNCiV2mb2s&t=1m36s'), 96);
  assert.equal(extractStartAt('https://www.youtube.com/watch?v=ARNCiV2mb2s&t=1h2m3s'), 3723);
  assert.equal(extractStartAt('https://www.youtube.com/watch?v=ARNCiV2mb2s&t=2m'), 120);
  assert.equal(extractStartAt('https://www.youtube.com/watch?v=ARNCiV2mb2s#t=45'), 45);
  assert.equal(extractStartAt('https://www.youtube.com/embed/ARNCiV2mb2s?start=30'), 30);
  assert.equal(extractStartAt('watch this https://youtu.be/ARNCiV2mb2s?t=12 it is good'), 12);
  // No time, a time of nothing, nonsense, and a link that isn't YouTube's.
  assert.equal(extractStartAt('https://youtu.be/ARNCiV2mb2s?si=abc'), null);
  assert.equal(extractStartAt('https://youtu.be/ARNCiV2mb2s?t=0'), null);
  assert.equal(extractStartAt('https://youtu.be/ARNCiV2mb2s?t=soon'), null);
  assert.equal(extractStartAt('https://youtu.be/ARNCiV2mb2s?list=PLxxxxxxxxxxxx&at=96'), null);
  assert.equal(extractStartAt('https://example.com/watch?t=96'), null);
  assert.equal(extractStartAt('https://youtu.be/ARNCiV2mb2s?t=999999999'), null);
});
