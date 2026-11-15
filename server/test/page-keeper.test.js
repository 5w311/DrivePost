import test from 'node:test';
import assert from 'node:assert/strict';
import { PageKeeper } from '../src/page-keeper.js';

// A keeper with a clock that is moved by hand, a page whose video obeys, and a car that reports twice a second.
// (`resumes: false`: a player that pauses when asked and won't play again. `tearsDown`: one that is gone from the
// browser's controls once it is paused. `noPos`: one that doesn't say where in its video it is.)
function world({ base = 2.5, obeys = true, seekable = true, resumes = true, tearsDown = false, noPos = false, hold = true } = {}) {
  let t = 1_000_000;
  const did = [];
  let obeyed = 0;
  const video = { status: 'playing', pos: 0, at: t, d: 600 };
  const posNow = () => video.pos + (video.status === 'playing' ? (t - video.at) / 1000 : 0);
  const say = () => k.media(video.status === 'gone' ? null : { status: video.status, t: noPos ? null : posNow(), d: noPos ? null : video.d, rate: 1, seek: seekable, at: t });
  const set = (status, pos = posNow()) => {
    video.pos = pos;
    video.at = t;
    video.status = status;
    say();
  };
  const k = new PageKeeper({
    base,
    hold,
    stuck: (asked) => did.push(asked ? 'stuck (their own pause)' : 'stuck'),
    now: () => t,
    pause: () => {
      did.push('pause');
      if (obeys) setTimeout(() => {}, 0);
    },
    play: () => did.push('play'),
    seek: (by) => did.push(`seek ${by}`),
    afresh: () => did.push('afresh'),
  });
  const w = {
    k,
    did,
    video,
    posNow,
    set,
    say,
    get t() {
      return t;
    },
    // Time passes; the car reports as told: { stream, state, lag } or null for silence. The browser obeys what was asked of it.
    run(ms, car) {
      const until = t + ms;
      while (t < until) {
        t += 100;
        if ((t / 100) % 5 === 0) {
          if (car) k.car(car.stream, car.state, typeof car.lag === 'function' ? car.lag() : car.lag, car.late);
          else k.tick();
        }
        // (Whatever has been asked of the browser by now, in a test's own calls too, it does.)
        while (obeyed < did.length) {
          const a = did[obeyed++];
          if (!obeys) continue;
          if (a === 'pause' && video.status === 'playing') set(tearsDown ? 'gone' : 'paused');
          else if (a === 'play' && video.status === 'paused' && resumes) set('playing');
          else if (a.startsWith('seek ')) set(video.status, Math.max(0, posNow() + Number(a.slice(5))));
        }
      }
    },
  };
  say();
  return w;
}

test('a car that keeps playing is left alone, and so is its video', () => {
  const w = world();
  w.k.show(true);
  w.run(10000, { stream: 'a', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, []);
  assert.equal(w.k.waiting, false);
});

test("while the car's stream has run dry the video waits, and carries on once the car has shown everything up to there", () => {
  const w = world();
  w.k.show(true);
  w.run(5000, { stream: 'a', state: 'playing', lag: 2.5 });
  // The car runs dry: its picture stands still, so it falls further behind the page by the second.
  const froze = w.t;
  w.run(1500, { stream: 'a', state: 'buffering', lag: () => 2.5 + (w.t - froze) / 1000 });
  assert.deepEqual(w.did, ['pause'], 'paused within a second or so');
  assert.equal(w.video.status, 'paused');
  assert.equal(w.k.waiting, true);
  const stoppedAt = w.posNow();
  w.run(3000, { stream: 'a', state: 'buffering', lag: () => 2.5 + (w.t - froze) / 1000 });
  assert.deepEqual(w.did, ['pause'], 'and held for as long as it takes');
  // The same stream comes back: the car plays out what it was sent, 7 seconds behind the page by now.
  const lag = 2.5 + (w.t - froze) / 1000;
  w.run(1000, { stream: 'a', state: 'playing', lag });
  assert.deepEqual(w.did, ['pause'], "not yet: the car hasn't shown the last stretch before the stop");
  w.run(lag * 1000, { stream: 'a', state: 'playing', lag });
  // It has now. And being that far behind, it is first brought up to the page, while the video stands still.
  assert.deepEqual(w.did, ['pause', 'afresh']);
  assert.equal(w.video.status, 'paused');
  w.run(400, { stream: 'a', state: 'playing', lag }); // (the old stream, on its way out)
  assert.deepEqual(w.did, ['pause', 'afresh']);
  w.run(1500, { stream: 'b', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, ['pause', 'afresh', 'play'], 'no skip back: nothing was missed');
  assert.equal(w.video.status, 'playing');
  assert.ok(Math.abs(w.posNow() - stoppedAt) < 2, 'it carries on from where it stopped');
  assert.equal(w.k.waiting, false);
  w.run(5000, { stream: 'b', state: 'playing', lag: 2.5 });
  assert.equal(w.did.length, 3);
});

test('a short dip, with the car hardly behind afterwards, needs no fresh stream', () => {
  const w = world();
  w.k.show(true);
  w.run(4000, { stream: 'a', state: 'playing', lag: 2.5 });
  const froze = w.t;
  w.run(1600, { stream: 'a', state: 'buffering', lag: () => 2.5 + (w.t - froze) / 1000 });
  assert.deepEqual(w.did, ['pause']);
  w.run(5000, { stream: 'a', state: 'playing', lag: 4.1 });
  assert.deepEqual(w.did, ['pause', 'play']);
});

test('a car that lost its stream and starts a new one: the video goes back to where its picture stopped', () => {
  const w = world();
  w.k.show(true);
  w.run(6000, { stream: 'a', state: 'playing', lag: 3 });
  const shown = w.posNow() - 3; // what the car had on its screen when it was last heard from
  w.run(4000, null); // not a word from it
  assert.deepEqual(w.did, ['pause']);
  const stopped = w.posNow();
  assert.ok(stopped - shown > 3.5 && stopped - shown < 6, `the video ran ${stopped - shown} s past the car's picture before it stopped`);
  w.k.gone('a');
  // Its stream is gone: what it comes back on will be a new one, of the page as it is then. So the video,
  // standing still, goes back to where the car's picture stopped, and that is the frame the new stream opens on.
  assert.equal(w.did.length, 2);
  assert.match(w.did[1], /^seek -\d/);
  const back = -Number(w.did[1].slice(5));
  assert.ok(Math.abs(back - (stopped - shown)) < 0.8, `back ${back} s for the ${stopped - shown} s the car never showed`);
  w.run(100, null);
  assert.equal(w.video.status, 'paused');
  assert.ok(Math.abs(w.posNow() - shown) < 0.8);
  w.run(20000, null);
  assert.equal(w.did.length, 2, 'it waits there, however long the car is away');
  w.run(1500, { stream: 'b', state: 'loading', lag: 2.5 });
  assert.equal(w.did.length, 2);
  w.run(1500, { stream: 'b', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did.slice(2), ['play']);
});

test('a page just opened, its video having started by itself: it waits until the car has its picture, and starts over from where it began', () => {
  const w = world();
  w.run(4000, null); // the page loads and its video starts, before there is any picture of it to show
  w.k.show(true);
  w.run(3000, null); // the car is still loading the page's picture
  // Paused, and taken back to where it began: the car has seen none of it.
  assert.equal(w.did.length, 2);
  assert.equal(w.did[0], 'pause');
  assert.match(w.did[1], /^seek -5(\.\d)?$/);
  assert.equal(w.video.status, 'paused');
  assert.ok(w.posNow() < 1, String(w.posNow()));
  w.run(1500, { stream: 'a', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did.slice(2), ['play']);
  assert.ok(w.posNow() < 2, `it plays from its beginning (${w.posNow()})`);
});

test('a car that has the picture at once: nothing is held, and a video that began before the page was put on is taken back to its beginning', () => {
  const w = world();
  w.run(3000, null); // the page loads and its video starts
  w.k.show(true);
  w.run(2000, { stream: 'a', state: 'playing', lag: 1.5 });
  assert.equal(w.did.length, 1);
  assert.match(w.did[0], /^seek -[34](\.\d)?$/);
  assert.ok(w.posNow() < 1.5, String(w.posNow()));
  w.run(5000, { stream: 'a', state: 'playing', lag: 1.5 });
  assert.equal(w.did.length, 1, 'once');
  // A video that starts after the car has the picture needs nothing done. Nor does a broadcast, which has no beginning to go to.
  const late = world();
  late.set('paused');
  late.k.show(true);
  late.run(3000, { stream: 'a', state: 'playing', lag: 1.5 });
  late.set('playing');
  late.run(4000, { stream: 'a', state: 'playing', lag: 1.5 });
  assert.deepEqual(late.did, []);
  const live = world({ noPos: true });
  live.run(3000, null);
  live.k.show(true);
  live.run(4000, { stream: 'a', state: 'playing', lag: 1.5 });
  assert.deepEqual(live.did, []);
});

test('a page put back on in the car with its video well under way: the video waits from where it was then, not from its beginning', () => {
  const w = world();
  w.run(5 * 60 * 1000, null); // five minutes in, on a page the car wasn't showing
  w.k.show(true);
  const from = w.posNow();
  w.run(3000, null);
  assert.equal(w.did[0], 'pause');
  assert.match(w.did[1], /^seek -1\.\d$/);
  w.run(1500, { stream: 'a', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did.slice(2), ['play']);
  assert.ok(Math.abs(w.posNow() - from) < 2, `${from} -> ${w.posNow()}`);
});

test('played from the page itself while it was held: that is respected, until the car is back', () => {
  const w = world();
  w.k.show(true);
  w.run(4000, { stream: 'a', state: 'playing', lag: 2.5 });
  w.run(2000, null);
  assert.deepEqual(w.did, ['pause']);
  w.set('playing'); // someone taps play on the page
  assert.equal(w.k.waiting, false);
  w.run(8000, null);
  assert.deepEqual(w.did, ['pause'], 'not paused a second time');
  // Once the car has been playing again, the next dip is held as usual.
  w.run(3000, { stream: 'b', state: 'playing', lag: 2.5 });
  w.run(2000, null);
  assert.deepEqual(w.did, ['pause', 'pause']);
});

test("a video that won't pause is left to play, and the car follows as its connection allows, up to a limit", () => {
  const w = world({ obeys: false });
  w.k.show(true);
  w.run(4000, { stream: 'a', state: 'playing', lag: 2.5 });
  w.run(5000, null);
  // (Given up on, and told to play in case the pause is only late in landing: it isn't to be left paused.)
  assert.deepEqual(w.did, ['pause', 'play']);
  assert.equal(w.k.waiting, false, 'given up on');
  w.run(4000, { stream: 'a', state: 'playing', lag: 6 });
  assert.deepEqual(w.did, ['pause', 'play'], 'six seconds behind a broadcast is lived with');
  w.run(2000, { stream: 'a', state: 'playing', lag: 12 });
  assert.deepEqual(w.did, ['pause', 'play', 'afresh'], 'twelve is not');
  // Not asked to pause again and again.
  w.run(6000, null);
  assert.deepEqual(w.did, ['pause', 'play', 'afresh']);
});

test('a car between two streams, having just been started afresh, is not a car that is stuck', () => {
  // Someone taps play on the page from a phone. The car, a little behind, is brought up to the page at that tap, and
  // the video starts while the car's new stream is still on its way.
  const w = world();
  w.set('paused');
  w.k.show(true);
  w.run(4000, { stream: 'a', state: 'playing', lag: 4.2 });
  w.did.length = 0;
  w.k.steered();
  assert.deepEqual(w.did, ['afresh']);
  w.set('playing');
  w.run(3000, null); // the old stream has stopped, the new one hasn't said anything yet
  assert.deepEqual(w.did, ['afresh'], 'the video is left playing');
  w.run(3000, { stream: 'b', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, ['afresh']);
  // But a car that never comes back from it is stuck like any other.
  w.k.steered();
  w.run(1000, { stream: 'b', state: 'playing', lag: 2.5 });
  w.run(6000, null);
  assert.equal(w.did[w.did.length - 1], 'pause');
});

test("a video that doesn't say where it is: held all the same, and let go once the car's picture has reached the standstill", () => {
  const w = world({ noPos: true });
  w.k.show(true);
  w.run(4000, { stream: 'a', state: 'playing', lag: 2.5 });
  w.run(2500, null);
  assert.deepEqual(w.did, ['pause']);
  assert.equal(w.video.status, 'paused');
  assert.equal(w.k.waiting, true, 'not taken for a video that plays on: it did pause');
  w.run(4000, null);
  assert.equal(w.k.waiting, true);
  // The same stream comes back to life. Its picture is 2.5 s behind: it is let go once that picture is past the pause.
  w.run(1000, { stream: 'a', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, ['pause', 'play']);
  assert.equal(w.video.status, 'playing');
});

test("a player that pauses when asked and won't start again: asked twice, then said to be stuck, and never held again", () => {
  const w = world({ resumes: false });
  w.k.show(true);
  w.run(4000, { stream: 'a', state: 'playing', lag: 2.5 });
  w.run(3000, null);
  w.run(2500, { stream: 'a', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, ['pause', 'play'], 'let go of once the car is back');
  w.run(3000, { stream: 'a', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, ['pause', 'play', 'play'], 'asked again');
  w.run(2500, { stream: 'a', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, ['pause', 'play', 'play'], 'given a little longer the second time');
  w.run(3000, { stream: 'a', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, ['pause', 'play', 'play', 'stuck']);
  // Someone starts it on the page itself. From then on it is left alone, however the car is doing.
  w.set('playing');
  w.run(2000, { stream: 'a', state: 'playing', lag: 2.5 });
  w.run(8000, null);
  assert.deepEqual(w.did, ['pause', 'play', 'play', 'stuck']);
  assert.equal(w.video.status, 'playing');
});

test("a player that is gone from the browser's controls once it is paused: asked to play once the car is back, then said to be stuck", () => {
  const w = world({ tearsDown: true });
  w.k.show(true);
  w.run(4000, { stream: 'a', state: 'playing', lag: 2.5 });
  w.run(3000, null);
  assert.deepEqual(w.did, ['pause']);
  assert.equal(w.video.status, 'gone');
  assert.equal(w.k.waiting, true, 'still being waited with: the car has not come back');
  w.run(11000, { stream: 'a', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, ['pause', 'play', 'play', 'stuck']);
});

test("a video that didn't start again because someone was at the page meanwhile isn't called stuck", () => {
  const w = world({ resumes: false });
  w.k.show(true);
  w.run(4000, { stream: 'a', state: 'playing', lag: 2.5 });
  w.run(3000, null);
  w.k.steered(); // a tap on the page, from a phone
  w.run(12000, { stream: 'a', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, ['pause', 'play', 'play']);
});

test('the car is taken off the page while its video is held, and put back on it: the video carries on once the car has the picture', () => {
  const w = world();
  w.k.show(true);
  w.run(4000, { stream: 'a', state: 'playing', lag: 2.5 });
  w.run(3000, null);
  assert.deepEqual(w.did, ['pause']);
  w.k.show(false); // another video is put on in the car
  w.run(20000, null);
  assert.deepEqual(w.did, ['pause'], 'left as it is while the car plays something else');
  w.k.show(true); // "Show it in the car"
  assert.equal(w.k.waiting, true);
  w.run(1500, { stream: 'b', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, ['pause', 'play']);
  // Not if someone played and paused it on the page in between: then it is theirs.
  const v = world();
  v.k.show(true);
  v.run(4000, { stream: 'a', state: 'playing', lag: 2.5 });
  v.run(3000, null);
  v.k.show(false);
  v.set('playing');
  v.run(2000, null);
  v.set('paused');
  v.k.show(true);
  v.run(3000, { stream: 'b', state: 'playing', lag: 2.5 });
  assert.deepEqual(v.did, ['pause']);
});

test("a page whose player is known not to start again is never paused for the car", () => {
  const w = world({ hold: false });
  w.k.show(true);
  w.run(4000, { stream: 'a', state: 'playing', lag: 2.5 });
  w.run(9000, null);
  assert.deepEqual(w.did, []);
  assert.equal(w.k.waiting, false);
});

test('with no video playing there is nothing to hold, and a car that has fallen behind is simply brought up to the page', () => {
  const w = world();
  w.set('paused');
  w.k.show(true);
  w.run(4000, { stream: 'a', state: 'playing', lag: 2.5 });
  w.run(3000, null);
  assert.deepEqual(w.did, []);
  w.run(1500, { stream: 'a', state: 'playing', lag: 5.5 });
  assert.deepEqual(w.did, ['afresh']);
  w.run(3000, { stream: 'b', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, ['afresh']);
  // A page with no video at all.
  const n = world();
  n.k.media(null);
  n.k.show(true);
  n.run(3000, null);
  n.run(1500, { stream: 'a', state: 'playing', lag: 6 });
  assert.deepEqual(n.did, ['afresh']);
});

test('someone steering the page sees it in the car soon: a car a little behind is brought up to it', () => {
  const w = world();
  w.set('paused');
  w.k.show(true);
  w.run(3000, { stream: 'a', state: 'playing', lag: 4 });
  assert.deepEqual(w.did, [], 'a second and a half behind where it started is let be');
  w.k.steered();
  assert.deepEqual(w.did, ['afresh']);
  w.k.steered();
  w.k.steered();
  assert.deepEqual(w.did, ['afresh'], 'once, not for every tap');
  // With a video playing that can be held, steering skips nothing.
  const p = world();
  p.k.show(true);
  p.run(3000, { stream: 'a', state: 'playing', lag: 4 });
  p.k.steered();
  assert.deepEqual(p.did, []);
});

test("a recording that is itself arriving late puts any stream that far behind: starting afresh wouldn't help, so it isn't done", () => {
  // A busy server: the browser's screen is being recorded three seconds late. The car is as close to the page as it can be.
  const w = world();
  w.set('paused');
  w.k.show(true);
  w.run(12000, { stream: 'a', state: 'playing', lag: 5.5, late: 3 });
  w.k.steered();
  assert.deepEqual(w.did, [], 'no stream after stream, each as far behind as the last');
  assert.equal(w.k.lag(), 5.5, 'the screens are still told how far behind the car really is');
  // The recording catches up, and all of it reaches the car at once, which plays it in its own time: now it is the car that is behind.
  w.run(1500, { stream: 'a', state: 'playing', lag: 5.5, late: 0 });
  assert.deepEqual(w.did, ['afresh']);
});

test("someone's own pause that the player doesn't come back from is found out the same way, and said to be theirs", () => {
  const w = world({ resumes: false });
  w.k.show(true);
  w.run(4000, { stream: 'a', state: 'playing', lag: 2.5 });
  // Pause on the car: the page's video is paused, and the car stops showing the page.
  assert.equal(w.k.handOver(), null);
  w.set('paused');
  w.k.show(false);
  w.run(5000, null);
  // Play on the car: the video is played once the car has the page's picture again.
  assert.equal(w.k.playWhenBack(), true);
  w.k.show(true);
  w.run(2000, { stream: 'b', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, ['play']);
  w.run(9000, { stream: 'b', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, ['play', 'play', 'stuck (their own pause)']);
});

test('paused from the car while its video was being held: playing it again goes back over what the car missed', () => {
  const w = world();
  w.k.show(true);
  w.run(6000, { stream: 'a', state: 'playing', lag: 3 });
  w.run(3000, null);
  assert.equal(w.k.waiting, true);
  const owed = w.k.handOver();
  assert.ok(owed > 3 && owed < 5.5, `${owed} s`);
  assert.equal(w.k.waiting, false);
  assert.equal(w.k.handOver(), null);
  w.k.show(false);
  w.run(5000, null);
  assert.deepEqual(w.did, ['pause'], 'and nothing more is done while the car is paused');
});

test('where the video was at a given moment', () => {
  const w = world();
  const t0 = w.t;
  w.run(4000, null);
  w.set('paused');
  w.run(3000, null);
  w.set('playing', 100);
  w.run(2000, null);
  assert.equal(w.k.mediaAt(t0 + 2000), 2);
  assert.equal(w.k.mediaAt(t0 + 5000), 4, 'paused then');
  assert.equal(w.k.mediaAt(t0 + 8000), 101);
  assert.equal(w.k.mediaAt(t0 - 5000), 0, 'before anything was known: as first known');
  assert.equal(new PageKeeper({}).mediaAt(5), null);
});

test('many small dips add up: the video is held for a moment so the car can be brought up to the page, and nothing is skipped', () => {
  const w = world();
  w.k.show(true);
  w.run(4000, { stream: 'a', state: 'playing', lag: 2.5 });
  w.run(3000, { stream: 'a', state: 'playing', lag: 7 });
  assert.deepEqual(w.did, [], 'four and a half seconds further behind is still let be');
  const t0 = w.t;
  w.run(1000, { stream: 'a', state: 'playing', lag: 9 });
  assert.deepEqual(w.did, ['pause']);
  const stopped = w.posNow();
  // The car plays on up to the standstill (nine seconds of it), and a second into it.
  w.run(9000, { stream: 'a', state: 'playing', lag: 9 });
  assert.deepEqual(w.did, ['pause'], 'not before it has shown all of it');
  w.run(2500, { stream: 'a', state: 'playing', lag: 9 });
  assert.deepEqual(w.did, ['pause', 'afresh']);
  w.run(1500, { stream: 'b', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, ['pause', 'afresh', 'play']);
  assert.ok(Math.abs(w.posNow() - stopped) < 1.6, 'on from where it stopped');
  assert.ok(w.t - t0 < 16000);
});

test('played again after a pause made from the car: the video starts when the car has its picture, not before', () => {
  const w = world();
  w.k.show(true);
  w.run(4000, { stream: 'a', state: 'playing', lag: 2.5 });
  // Paused from the car: DrivePost pauses the video itself, and the keeper stands down.
  w.set('paused');
  w.k.show(false);
  w.run(5000, null);
  assert.deepEqual(w.did, []);
  assert.equal(w.k.playWhenBack(), true);
  w.k.show(true);
  w.run(2500, null); // the car is starting its new stream
  assert.deepEqual(w.did, [], 'held, without being asked to pause again');
  assert.equal(w.k.waiting, true);
  w.run(1500, { stream: 'b', state: 'playing', lag: 2.5 });
  assert.deepEqual(w.did, ['play']);
  // With no video known, there is nothing to wait with.
  const n = world();
  n.k.media(null);
  assert.equal(n.k.playWhenBack(), false);
});

test('a car that comes back on another stream while the old one still stands: the video goes back as soon as that is seen', () => {
  const w = world();
  w.k.show(true);
  w.run(6000, { stream: 'a', state: 'playing', lag: 3 });
  w.run(4000, null);
  assert.deepEqual(w.did, ['pause']);
  w.run(500, { stream: 'b', state: 'loading', lag: 1.4 });
  assert.equal(w.did.length, 2, 'at its first word, before it is even playing');
  assert.match(w.did[1], /^seek -\d/);
  w.run(1500, { stream: 'b', state: 'playing', lag: 1.4 });
  assert.deepEqual(w.did.slice(2), ['play']);
});

test("a car whose stream closed before the video was even paused: the video is taken back the moment it has stopped", () => {
  const w = world();
  w.k.show(true);
  w.run(6000, { stream: 'a', state: 'playing', lag: 1.5 });
  const shown = w.posNow() - 1.5;
  w.k.gone('a'); // the car's connection is cut, and the server sees it at once
  w.run(2500, null);
  assert.equal(w.did.length, 2);
  assert.equal(w.did[0], 'pause');
  assert.match(w.did[1], /^seek -\d/, 'not left until the car is back: its new stream is to open on the scene it left');
  assert.ok(Math.abs(w.posNow() - shown) < 0.8, `${w.posNow()} against ${shown}`);
  w.run(1500, { stream: 'b', state: 'playing', lag: 1.4 });
  assert.deepEqual(w.did.slice(2), ['play']);
});
