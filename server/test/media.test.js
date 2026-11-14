import test from 'node:test';
import assert from 'node:assert/strict';
import { readPlayer, expected, isNews } from '../../browser/media.js';

// What dbus-send prints for a browser playing a 90-second video, 9.9 seconds in.
const PLAYING = `method return time=1.2 sender=:1.1 -> destination=:1.9 serial=50 reply_serial=2
   array [
      dict entry(
         string "CanGoNext"
         variant             boolean false
      )
      dict entry(
         string "CanSeek"
         variant             boolean true
      )
      dict entry(
         string "Metadata"
         variant             array [
               dict entry(
                  string "mpris:length"
                  variant                      int64 90000000
               )
               dict entry(
                  string "xesam:title"
                  variant                      string "A film"
               )
            ]
      )
      dict entry(
         string "PlaybackStatus"
         variant             string "Playing"
      )
      dict entry(
         string "Position"
         variant             int64 9896346
      )
      dict entry(
         string "Rate"
         variant             double 1
      )
   ]
`;

test("the browser's media controls are read: playing or paused, how far in, how long", () => {
  const m = readPlayer(PLAYING, 1000);
  assert.deepEqual(m, { status: 'playing', t: 9.896346, d: 90, rate: 1, seek: true, at: 1000 });
  const paused = readPlayer(PLAYING.replace('"Playing"', '"Paused"').replace('double 1', 'double 1.5'), 5);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.rate, 1.5);
  // A live broadcast: no length to speak of, and no skipping.
  const live = readPlayer(PLAYING.replace('int64 90000000', 'int64 9223372036854775807').replace('boolean true', 'boolean false'));
  assert.equal(live.d, null);
  assert.equal(live.seek, false);
  assert.equal(readPlayer(PLAYING.replace(/string "mpris:length"[^)]*\)/, ')')).d, null);
  assert.equal(readPlayer(PLAYING.replace('"Playing"', '"Stopped"')).status, 'stopped');
  assert.equal(readPlayer('Error org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable'), null);
  assert.equal(readPlayer(''), null);
});

test('time passing on a playing video is not news; a pause, a skip or another video is', () => {
  const at = 100000;
  const was = { status: 'playing', t: 10, d: 90, rate: 1, seek: true, at };
  assert.equal(expected(was, at + 4000), 14);
  assert.equal(expected({ ...was, status: 'paused' }, at + 4000), 10);
  assert.equal(expected({ ...was, rate: 2 }, at + 4000), 18);
  assert.equal(expected(null, at), null);
  const later = (over) => ({ ...was, t: 14, at: at + 4000, ...over });
  assert.equal(isNews(was, later()), false, 'four seconds on, four seconds further');
  assert.equal(isNews(was, later({ t: 14.4 })), false, 'near enough');
  assert.equal(isNews(was, later({ status: 'paused' })), true);
  assert.equal(isNews(was, later({ t: 40 })), true, 'skipped ahead');
  assert.equal(isNews(was, later({ t: 4 })), true, 'skipped back');
  assert.equal(isNews(was, later({ d: 200 })), true, 'another video');
  assert.equal(isNews(was, later({ d: null })), true);
  assert.equal(isNews(was, later({ rate: 2, t: 14 })), true);
  assert.equal(isNews(null, was), true, 'something started');
  assert.equal(isNews(was, null), true, 'and went away');
  assert.equal(isNews(null, null), false);
});
