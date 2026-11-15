/*
 * Keeping the video on a page and the car's picture of it together.
 *
 * The car plays a film of the page, a couple of seconds behind it and over a
 * mobile connection. When that connection dips, the car's picture stops while
 * the page plays on, and a car that came back to the page as it was by then
 * would have skipped a stretch of the video: stuck on one scene, back in the
 * next. So the video waits for the car instead:
 *
 *   - While the car isn't playing (it is loading, has run dry, or can't be
 *     heard from), the page's video is paused. That goes through the
 *     browser's own media controls (webpage.js), which also say where the
 *     video is, so nothing is done to the page.
 *   - Once the car is playing again and has shown everything up to where
 *     the video stopped, the video carries on. A car that lost its stream
 *     never showed the last stretch, and comes back on a new one: the video
 *     is taken back to where the car's picture stopped, which is the frame
 *     the new stream opens on, and played from there.
 *   - A car that has fallen further behind the page than it starts out is
 *     brought back up to it while the video stands still, when no picture is
 *     lost by it.
 *
 * With nothing to hold (no video on the page, or one that is paused), there
 * is nothing to lose either: a car that has fallen behind is simply brought
 * up to the page. A video that won't pause (a live broadcast) plays on, and
 * the car follows as far behind as its connection puts it, up to a limit.
 *
 * A video paused from here is never left paused. Whatever ends a hold, the
 * video is asked to play, and then watched: one that hasn't started again a
 * few seconds later is asked once more, and after that its player is taken
 * for one that these controls can stop and not start (`stuck` says so, with
 * whether it was someone's own pause that it didn't come back from, and its
 * video isn't held again).
 *
 * This module only decides. What it is told: what the page's video is doing
 * (`media`), what the car says of its stream twice a second (`car`), streams
 * closing (`gone`), and whether the page is what the car is meant to be
 * playing (`show`). What it asks for: pause, play, seek (seconds, back is
 * negative) and afresh (the car starts its stream again from where the page
 * is now).
 */

const HEARD_MS = 1300; // a car not heard from for this long isn't known to be playing
const STUCK_MS = 1500; // this long since it was last known to be playing: the video waits for it
const STEADY_MS = 600; // playing again for this long: it is back
const PAUSE_TAKES_MS = 2500; // a video asked to pause and still playing after this won't be held
const NEAR_S = 0.35; // "has shown everything up to there", within this
const SEEK_MIN_S = 0.6; // going back less than this isn't worth a skip
const TRIM_OVER_S = 2; // this much further behind than a car starts out, it is brought back up to the page
const HELD_OVER_S = 6; // ...this much, with a video playing: it is held for a moment so that can be done
const LIVE_OVER_S = 8; // ...and this much, with a video playing that can't be held
const STILL_MS = 1000; // how far into the standstill the car's picture must be before it is let go of
const AFRESH_EVERY_MS = 5000;
const AFRESH_GRACE_MS = 4000; // a car just started afresh is given this long to be heard from before it counts as stuck
const RESUME_TAKES_MS = 3000; // a video asked to play again and still not playing after this is asked once more...
const RESUME_LAST_MS = 5000; // ...and given up on this long after that
const FROM_START_S = 45; // a car that has shown none of a video that began this recently is shown it from where it began
const LOG_MS = 3 * 60 * 1000;

export class PageKeeper {
  constructor({ pause, play, seek, afresh, stuck, hold = true, base = 2.5, now = Date.now } = {}) {
    this.act = { pause, play, seek, afresh, stuck };
    this.base = base; // seconds behind the page a car's picture is when its stream has just started
    this.now = now;
    this.on = false;
    this.onSince = 0;
    this.m = null; // the page's video, as last said: { status, t, d, rate, seek, at }
    this.log = []; // ...and before that, to work out where it was at a given moment
    this.report = null; // the car, as last heard: { stream, state, lag, at }
    this.playingSince = 0;
    this.playedAt = 0; // when the car last said it was playing
    this.wait = null; // the video is being held: { since, shown, stream, paused, pausedPos, pausedAt, back, old }
    this.canHold = true; // asked to pause, this video does
    this.noHold = !hold; // this page's player can be stopped from here and not started again: it is left alone
    this.userPlays = false; // someone played it while it was held: it is left alone until the car is back
    this.afreshAt = 0;
    this.resuming = null; // it was let go of and should be playing again: { at, since, tries }
    this.leftHeld = false; // the car was taken off the page while its video was being held
    this.steeredAt = 0;
    this.met = false; // the car has had its first picture of the page since the page was put on
  }

  // ---- what it is told ----

  // The page is, or stops being, what the car is meant to be playing.
  show(on) {
    on = !!on;
    if (on === this.on) return;
    this.on = on;
    const now = this.now();
    this.report = null;
    this.playingSince = 0;
    this.userPlays = false;
    this.playedAt = 0;
    if (on) {
      this.onSince = now;
      this.met = false;
      // Its video was being held for the car when the car was taken off the page: it carries on once the car has the page again.
      if (this.leftHeld && !this.wait && this.m && this.m.status === 'paused') {
        this.wait = { since: now, shown: this.m.t, stream: null, paused: true, pausedPos: this.m.t, pausedAt: now, back: 0, old: null };
      }
      this.leftHeld = false;
    } else {
      this.leftHeld = !!(this.wait && this.wait.paused);
      this.wait = null;
    }
  }

  // What the browser says the page's video is doing, or null for none.
  media(m) {
    const now = this.now();
    const was = this.m;
    this.m = m ? { status: m.status, t: m.t, d: m.d ?? null, rate: m.rate || 1, seek: m.seek !== false, at: m.at ?? now } : null;
    if (this.m) this.log.push(this.m);
    while (this.log.length > 1 && now - this.log[1].at > LOG_MS) this.log.shift();
    // Another video (or none): what was learned about the last one goes with it.
    if (!this.m || !was || (was.d === null) !== (this.m.d === null) || (was.d !== null && Math.abs(was.d - this.m.d) > 0.5)) this.canHold = true;
    if (this.m && this.m.status === 'playing') {
      this.resuming = null;
      this.leftHeld = false;
    }
    const w = this.wait;
    if (w) {
      if (!this.m) {
        // Gone from the browser's controls: a player that takes being paused for being switched off. Nothing is known
        // of where it stopped, but it is still asked to play once the car is back.
        w.paused = true;
        w.pausedPos = null;
        if (!w.pausedAt) w.pausedAt = now;
        if (w.back === null) w.back = 0;
      } else if (this.m.status === 'paused' && !w.paused) {
        w.paused = true;
        w.pausedPos = this.m.t; // (null for a video that doesn't say where it is)
        w.pausedAt = this.m.at;
        if (w.stream === null) this.goBack(w);
      } else if (this.m.status === 'playing' && w.paused) {
        // Played from the page itself, or by the page: that is respected.
        this.wait = null;
        this.userPlays = true;
      }
    }
    this.check();
  }

  // The car says where its stream is: `state` as its player has it, `lag` seconds behind the browser's screen
  // (`late` seconds of which are the recording of the screen itself arriving late, on a busy machine).
  car(stream, state, lag, late = 0) {
    const at = this.now();
    if (state === 'playing') {
      if (!this.playingSince || !this.report || this.report.stream !== stream) this.playingSince = at;
      this.playedAt = at;
    } else this.playingSince = 0;
    this.report = { stream, state, lag: Math.max(0, Number(lag) || 0), late: Math.max(0, Number(late) || 0), at };
    const w = this.wait;
    if (w && w.stream === stream) {
      // How far the car has got through what was sent before the video stopped.
      const seen = this.mediaAt(at - this.report.lag * 1000);
      if (seen !== null && (w.shown === null || seen > w.shown)) w.shown = seen;
    } else if (w && w.stream !== null && stream !== w.old) {
      // Another stream than the one it was on: that one is as good as gone.
      w.stream = null;
      this.goBack(w);
    }
    this.check();
  }

  // A stream of the car's has closed.
  gone(stream) {
    const w = this.wait;
    if (w && w.stream === stream) {
      w.stream = null;
      this.goBack(w);
    }
    if (this.report && this.report.stream === stream) {
      this.playingSince = 0;
      this.report.gone = true;
    }
    this.check();
  }

  /*
   * The stream the car was on when the video stopped has gone, or there
   * never was one: what the car comes back on is a new stream, of the page
   * as it is by then. So the video, standing still, is taken back to where
   * the car's picture stopped. That frame is what the new stream opens on,
   * and the car carries on from the scene it was in. (Once it is known where
   * the video stopped: until then this waits.)
   */
  goBack(w) {
    if (w.back !== null || !w.paused) return;
    w.back = w.shown === null || w.pausedPos === null ? 0 : Math.max(0, w.pausedPos - w.shown);
    if (w.back >= SEEK_MIN_S && this.m && this.m.seek) this.act.seek(-Math.round(w.back * 10) / 10);
  }

  // Someone is steering the page from a phone: what they do should show in the car soon.
  steered() {
    const now = this.now();
    this.steeredAt = now;
    const r = this.report;
    if (!this.on || this.wait || !this.inStep(now)) return;
    if (this.over(r) > 1 && !this.holdable()) this.startAfresh(now);
  }

  // Looked at a few times a second, for a car that has simply gone quiet.
  tick() {
    this.check();
  }

  /*
   * The car has been paused on purpose while its video was being held:
   * whoever plays it again takes it from here. Returns how far back the
   * video has to go for the car to miss nothing (seconds), or null if it
   * wasn't being held.
   */
  handOver() {
    const w = this.wait;
    if (!w) return null;
    this.wait = null;
    return !w.paused || w.pausedPos === null || w.shown === null ? 0 : Math.max(0, w.pausedPos - w.shown);
  }

  /*
   * The video was paused on purpose and is to play again, the car starting
   * a new stream to show it. It is played once the car has that picture and
   * not a moment before, so the car sees it from where it starts. Returns
   * false when there is no video known to wait with: the caller plays it.
   */
  playWhenBack() {
    if (!this.m || this.m.t === null) return false;
    const now = this.now();
    this.wait = { since: now, shown: this.m.t, stream: null, paused: true, pausedPos: this.m.t, pausedAt: now, back: 0, old: null, asked: true };
    this.userPlays = false;
    return true;
  }

  // ---- what it can be asked ----

  get waiting() {
    return !!this.wait;
  }

  // Seconds behind the browser's screen the car's picture is, as last heard, or null.
  lag(now = this.now()) {
    const r = this.report;
    return r && now - r.at <= 3000 ? r.lag : null;
  }

  // Where the video was at a moment (a time on this machine's clock), or null if that isn't known.
  mediaAt(wall) {
    let e = null;
    let next = null;
    for (const m of this.log) {
      if (m.at <= wall) e = m;
      else {
        next = m;
        break;
      }
    }
    if (!e) e = this.log[0] || null;
    if (!e || e.t === null) return null;
    if (e.status !== 'playing' || wall <= e.at) return e.t;
    let t = e.t + ((wall - e.at) / 1000) * e.rate;
    if (e.d !== null) t = Math.min(t, e.d);
    // (It stopped a moment before word of that got here: it never played past where it stopped.)
    if (next && next.status === 'paused' && next.t !== null && next.t >= e.t) t = Math.min(t, next.t);
    return t;
  }

  // ---- deciding ----

  inStep(now) {
    const r = this.report;
    return !!r && now - r.at <= HEARD_MS && r.state === 'playing';
  }

  /*
   * How much further behind the page the car is than it would be on a
   * stream started now (seconds): what starting afresh would gain it. (A
   * recording that is itself arriving late puts every stream that far
   * behind, a new one too.)
   */
  over(r) {
    return r.lag - r.late - this.base;
  }

  holdable() {
    return !!this.m && this.m.status === 'playing' && this.canHold && !this.noHold && !this.userPlays && !this.resuming;
  }

  /*
   * Where a car that has shown none of the page yet is to see its video
   * from: where the video was when the page was put on, or where it began,
   * if that was only a little before. (A video that starts by itself as its
   * page opens has played its first seconds before any car could have the
   * picture.)
   */
  unseenFrom() {
    const at = this.mediaAt(this.onSince);
    const first = this.log[0];
    if (at === null || !first || first.t === null || !this.m) return at;
    const same = (first.d === null) === (this.m.d === null) && (first.d === null || Math.abs(first.d - this.m.d) <= 0.5);
    return same && at >= first.t && at - first.t <= FROM_START_S ? first.t : at;
  }

  // The hold is over: the video is asked to play, and watched until it does (see check).
  release(now, w) {
    this.wait = null;
    // (`asked`: it was someone's own pause, played again by them, and not a hold made here.)
    this.resuming = { at: now, since: w.since, tries: 1, asked: !!w.asked };
    this.act.play();
  }

  startAfresh(now) {
    if (now - this.afreshAt < AFRESH_EVERY_MS) return false;
    this.afreshAt = now;
    this.playingSince = 0;
    this.act.afresh();
    return true;
  }

  check() {
    if (!this.on) return;
    const now = this.now();
    const r = this.report;
    const inStep = this.inStep(now);
    if (inStep && !this.wait) this.userPlays = false;
    const steady = inStep && now - this.playingSince >= STEADY_MS;
    const w = this.wait;

    // A video that was let go of and isn't playing: asked once more, then given up on.
    const rs = this.resuming;
    if (rs && now - rs.at >= (rs.tries < 2 ? RESUME_TAKES_MS : RESUME_LAST_MS)) {
      if (rs.tries < 2) {
        rs.tries++;
        rs.at = now;
        this.act.play();
      } else {
        this.resuming = null;
        // (Unless someone has been at the page meanwhile: what it is doing now may be their doing.)
        if (this.steeredAt < rs.since) {
          this.noHold = true;
          if (this.act.stuck) this.act.stuck(rs.asked);
        }
      }
    }

    // The car has its first picture of the page. A video that had begun before the page was put on has played its
    // opening unseen: it is taken back to where it began (see unseenFrom). Not a broadcast, which has no beginning to go to.
    if (steady && !this.met) {
      this.met = true;
      if (!w && this.m && this.m.status === 'playing' && this.m.seek && this.m.d !== null && !this.userPlays) {
        const from = this.unseenFrom();
        const at = this.mediaAt(this.onSince);
        const here = this.mediaAt(now);
        if (from !== null && at !== null && here !== null && at - from >= 1.5 && here > from) this.act.seek(-Math.round((here - from) * 10) / 10);
      }
    }

    if (!w) {
      // (A car that was started afresh a moment ago is between two streams, not stuck.)
      if (!inStep && now - (this.playedAt || this.onSince) >= STUCK_MS && now - this.afreshAt >= AFRESH_GRACE_MS && this.holdable()) {
        // Where the car's picture stopped: what it last said, or, having said nothing yet, see unseenFrom.
        const heard = r && now - r.at <= 60 * 1000;
        if (!heard) this.met = true; // (held from before its first picture: where it is to see the video from is settled here)
        this.wait = {
          since: now,
          shown: heard ? this.mediaAt(r.at - r.lag * 1000) : this.unseenFrom(),
          // (The stream it was on, if that still stands: it may yet come back to life and play out what it was sent.)
          stream: heard && !r.gone && now - r.at <= HEARD_MS * 2 ? r.stream : null,
          paused: false,
          pausedPos: null,
          pausedAt: 0,
          back: null,
        };
        this.act.pause();
        return;
      }
      // Nothing being held, and the car has fallen behind the page: brought back up to it, where nothing is lost by that.
      if (steady) {
        const playing = !!this.m && this.m.status === 'playing';
        const over = this.over(r);
        if ((!playing && over > TRIM_OVER_S) || (playing && !this.holdable() && over > LIVE_OVER_S)) this.startAfresh(now);
        else if (playing && this.holdable() && over > HELD_OVER_S && now - this.afreshAt >= AFRESH_EVERY_MS) {
          // Many small dips have added up. The video is held for a moment: the car plays up to there, and is then brought up to the page.
          this.wait = { since: now, shown: this.mediaAt(r.at - r.lag * 1000), stream: r.stream, paused: false, pausedPos: null, pausedAt: 0, back: null, old: null };
          this.act.pause();
        }
      }
      return;
    }

    // The video is being held.
    if (!w.paused) {
      // It was asked to pause and plays on: one that can't be held (a live broadcast, say).
      if (now - w.since > PAUSE_TAKES_MS) {
        this.canHold = false;
        this.wait = null;
        this.act.play(); // (in case the pause is only late in landing: it isn't to stand)
      }
      return;
    }
    if (!steady) return;
    if (w.back === null) {
      if (w.stream !== null && w.stream === r.stream) {
        // The same stream came back to life: the car plays out what it was sent, up to where the video stopped.
        // (Told by where the video was at the moment the car is showing, or, for a video that doesn't say where it
        // is, by that moment itself.)
        const showing = r.at - r.lag * 1000;
        const shownAll = w.pausedPos !== null ? (w.shown !== null && w.shown >= w.pausedPos - NEAR_S) || showing >= w.pausedAt + 1500 : showing >= w.pausedAt;
        if (!shownAll) return;
        // And is then brought up to the page while the video stands still, if
        // it has fallen behind it: once its picture is well into the
        // standstill, so that nothing before it is cut off.
        if (this.over(r) > TRIM_OVER_S && now - this.afreshAt >= AFRESH_EVERY_MS) {
          if (r.at - r.lag * 1000 < w.pausedAt + STILL_MS) return;
          this.startAfresh(now);
          w.back = 0;
          w.old = r.stream;
          w.stream = null;
          return;
        }
        w.back = 0;
      } else this.goBack(w); // (a new stream: see goBack)
    } else if (w.old && r.stream === w.old) return; // (still the stream that is being replaced)
    this.release(now, w);
  }
}
