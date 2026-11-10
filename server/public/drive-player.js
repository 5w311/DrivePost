/*
 * DrivePlayer: plays a server stream through JSMpeg on a <canvas>.
 *
 * The server sends video one frame per message and audio in short runs, each
 * tagged with its presentation time. We keep several seconds in reserve and
 * run our own clock:
 *   - each video frame is decoded just before the moment it's due, so motion
 *     is even no matter how the data arrived or how often the browser repaints;
 *   - audio is scheduled on the sound card against the same clock, so sound
 *     and picture stay together;
 *   - when data runs out, or on pause, the clock and the sound card both
 *     freeze and later carry on from the same spot.
 * JSMpeg does the decoding and drawing; its own playback loop is not used.
 */
(function () {
  'use strict';

  var START_BUFFER = 1.5; // seconds buffered before starting
  var REBUFFER = 3; // seconds buffered before resuming after running dry
  var STALL_TIMEOUT = 20; // seconds with no data before giving up on a socket
  var PREROLL = 0.1; // start the clock this far before the first frame
  var VIDEO_LEAD = 0.02; // decode a frame this long before it's due (about one repaint)
  var AUDIO_LEAD = 0.5; // sound queued ahead on the sound card (rides out short hiccups)
  var AUDIO_TOLERANCE = 0.07; // re-align sound if it drifts further than this from the picture
  var MAX_FRAMES_PER_TICK = 4; // catch up after a hiccup by decoding a few frames at once
  var TICK_BUDGET_MS = 28;
  var LATE_LIMIT = 0.4; // picture this far behind and not catching up: hold the clock rather than lose sync
  var LATE_PATIENCE = 0.5; // how long catching up may take before we hold
  var SLOW_DECODE_SHARE = 0.35; // decoding uses this much of each frame's time: the screen is the bottleneck
  var GAP_LIMIT = 0.8; // a pause in our own timers this long means the page was asleep
  var AUDIO_GONE = 2; // sound this far behind the picture in arriving: the video has none here
  var VIDEO_STREAM = 0xe0;
  var AUDIO_STREAM = 0xc0;

  function now() {
    return performance.now() / 1000;
  }

  // ---- sound card (one AudioContext for the whole page) ----

  var wantAudio = false;

  function audioContext() {
    var WA = JSMpeg.AudioOutput.WebAudio;
    if (!WA.IsSupported()) return null;
    if (!WA.CachedContext) {
      try {
        WA.CachedContext = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        return null;
      }
    }
    var ctx = WA.CachedContext;
    if (!ctx._dtPinned) {
      // Keep it alive between videos, so a new one doesn't need another tap.
      ctx._connections = (ctx._connections || 0) + 1;
      ctx._dtPinned = true;
    }
    return ctx;
  }

  // Run or freeze the sound card's clock. Freezing keeps queued sound in
  // place, so it continues without a gap. `done` is called once the change
  // has taken effect, or after a short wait if the browser won't confirm.
  function audioRun(run, done) {
    var called = false;
    function fin() {
      if (called) return;
      called = true;
      if (done) done();
    }
    wantAudio = run;
    var ctx = audioContext();
    if (!ctx) return fin();
    var p = null;
    try {
      if (run && ctx.state !== 'running') p = ctx.resume();
      else if (!run && ctx.state === 'running') p = ctx.suspend();
    } catch (e) {}
    if (p && p.then) {
      p.then(fin, fin);
      setTimeout(fin, 400);
    } else fin();
  }

  // Delay between handing sound to the sound card and hearing it.
  function outputDelay(ctx) {
    return ctx ? Math.min(0.25, (ctx.outputLatency || 0) + (ctx.baseLatency || 0)) : 0;
  }

  function audioRate() {
    var ctx = audioContext();
    var r = ctx ? ctx.sampleRate : 48000;
    return r === 44100 || r === 32000 ? r : 48000;
  }

  // ---- one stream ----

  function StreamSession(o) {
    var self = this;
    this.o = o;
    this.seq = o.seq;
    this.quality = o.quality;
    this.vq = []; // video frames waiting for their time
    this.aq = []; // audio runs waiting for their time
    this.basePts = null; // timestamp of the stream's first frame
    this.clock = null; // current stream time
    this.clockBase = 0;
    this.wallBase = 0;
    this.lastTick = now();
    this.lastVideoPts = null; // newest frame received
    this.lastAudioPts = null; // newest audio run received
    this.lastFedPts = null; // newest frame shown
    this.lastDataAt = now();
    this.state = 'buffering'; // buffering | playing | paused | done
    this.wantPause = !!o.paused;
    this.starting = false;
    this.everPlayed = false;
    this.primed = false;
    this.serverEnded = false;
    this.complete = false;
    this.dropped = false;
    this.failed = false;
    this.closedByUs = false;
    this.duration = null;
    this.live = false;
    this.startAt = o.startAt || 0;
    this.sink = null;
    this.frames = 0;
    this.audioSynced = false;
    this.holds = [];
    this.slowReportedAt = 0;
    this.lateSince = 0;
    this.stats = {
      bytes: 0,
      fps: null,
      kbps: null,
      decodeMs: 0,
      decodeMax: 0,
      late: 0,
      holds: 0,
      stalls: 0,
      resyncs: 0,
      audioSkipped: 0,
      serverSpeed: null,
      serverLimited: false
    };

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'video-canvas pending';
    o.host.appendChild(this.canvas);

    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var url =
      proto + location.host + '/ws/stream?id=' + encodeURIComponent(o.id) +
      '&t=' + Math.floor(this.startAt) + '&q=' + encodeURIComponent(o.quality || '') +
      '&ar=' + audioRate();
    var ws = (this.ws = new WebSocket(url));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = function (ev) {
      self.onMessage(ev.data);
    };
    ws.onclose = function () {
      if (!self.closedByUs && !self.serverEnded) self.dropped = true;
    };

    // Custom JSMpeg source: we decide when bytes reach the decoder.
    function Source() {
      this.streaming = true;
      this.established = false;
      this.completed = false;
      this.progress = 0;
      this.destination = null;
    }
    Source.prototype.connect = function (d) {
      this.destination = d;
    };
    Source.prototype.start = function () {
      var src = this;
      self.sink = function (bytes) {
        src.established = true;
        src.progress = 1;
        if (src.destination) src.destination.write(bytes);
      };
    };
    Source.prototype.resume = function () {};
    Source.prototype.destroy = function () {
      self.sink = null;
    };

    this.player = new JSMpeg.Player('stream', {
      source: Source,
      canvas: this.canvas,
      audio: true,
      pauseWhenHidden: false,
      decodeFirstFrame: false,
      maxAudioLag: 60,
      videoBufferSize: 4 * 1024 * 1024,
      audioBufferSize: 256 * 1024,
      onVideoDecode: function (decoder, elapsed) {
        var ms = elapsed * 1000;
        var st = self.stats;
        st.decodeMs = st.decodeMs ? st.decodeMs * 0.95 + ms * 0.05 : ms;
        if (ms > st.decodeMax) st.decodeMax = ms;
        self.frames++;
        if (self.frames === 1) {
          self.canvas.classList.remove('pending');
          if (o.onFirstFrame) o.onFirstFrame(self);
        }
      }
    });
    // We drive decoding ourselves; make sure JSMpeg's own loop stays off.
    this.player.autoplay = false;
    this.player.pause();
    if (this.player.audioOut) this.player.audioOut.unlocked = true;
    this.player.volume = o.volume === undefined ? 1 : o.volume;

    function frame() {
      if (self.state === 'done') return;
      self.raf = requestAnimationFrame(frame);
      self.tick();
    }
    this.raf = requestAnimationFrame(frame);
    // Timers keep things moving if the browser repaints slowly.
    this.timer = setInterval(function () {
      self.tick();
    }, 12);
    this.reportTimer = setInterval(function () {
      if (self.ws.readyState === 1 && self.clock !== null) self.ws.send(JSON.stringify({ clock: self.clock }));
    }, 500);
  }

  StreamSession.prototype.onMessage = function (data) {
    if (typeof data === 'string') {
      var msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        return;
      }
      if (msg.type === 'meta') {
        this.duration = msg.duration;
        this.live = !!msg.live;
        this.startAt = msg.startAt || 0;
        this.stats.fps = msg.fps || null;
        this.stats.kbps = msg.kbps || null;
        if (this.o.onMeta) this.o.onMeta(this);
      } else if (msg.type === 'base') {
        this.basePts = msg.pts;
      } else if (msg.type === 'speed') {
        this.stats.serverSpeed = msg.x;
        this.stats.serverLimited = !!msg.limitedByNetwork;
      } else if (msg.type === 'end') {
        this.serverEnded = true;
        this.complete = !!msg.complete;
      } else if (msg.type === 'error') {
        this.failed = true;
        this.finish();
        if (this.o.onError) this.o.onError(this, msg.message || 'Playback error');
      }
      return;
    }
    if (data.byteLength < 10) return;
    var view = new DataView(data);
    var chunk = { pts: view.getFloat64(0, true), data: new Uint8Array(data, 9) };
    this.stats.bytes += data.byteLength - 9;
    this.lastDataAt = now();
    if (view.getUint8(8) === 0) {
      this.vq.push(chunk);
      this.lastVideoPts = chunk.pts;
      if (this.basePts === null) this.basePts = chunk.pts;
      if (this.clock === null) this.clock = chunk.pts - PREROLL;
    } else {
      this.aq.push(chunk);
      this.lastAudioPts = chunk.pts;
    }
  };

  // Is sound still arriving alongside the picture? Some videos have none, or
  // a sound track that ends early; then only the picture decides buffering.
  StreamSession.prototype.audioArriving = function () {
    return this.lastAudioPts !== null && this.lastVideoPts - this.lastAudioPts < AUDIO_GONE;
  };

  StreamSession.prototype.setState = function (s) {
    if (this.state === s) return;
    this.state = s;
    if (this.o.onState) this.o.onState(this);
  };

  StreamSession.prototype.feedVideo = function (chunk) {
    var p = this.player;
    this.sink(chunk.data);
    // One message is exactly one frame: tell the demuxer it's complete now
    // instead of letting it wait for the start of the next one.
    var pi = p.demuxer.pesPacketInfo[VIDEO_STREAM];
    if (pi && pi.currentLength) p.demuxer.packetComplete(pi);
    this.lastFedPts = chunk.pts;
    var n = 0;
    while (p.video.decode() && ++n < 2) {}
  };

  StreamSession.prototype.feedAudio = function (chunk) {
    var p = this.player;
    var out = p.audioOut;
    var ctx = out && out.context;
    if (!p.audio || !ctx || ctx.state !== 'running') {
      // No working sound right now: keep the picture going without it.
      this.stats.audioSkipped++;
      this.audioSynced = false;
      return;
    }
    // When should this run start, in the sound card's own time?
    var desired = ctx.currentTime + (chunk.pts - this.clock) - outputDelay(ctx);
    // Queue ran dry (a hiccup longer than what was queued): line up afresh.
    if (out.startTime < ctx.currentTime) this.audioSynced = false;
    if (!this.audioSynced || Math.abs(out.startTime - desired) > AUDIO_TOLERANCE) {
      if (desired < ctx.currentTime - 0.03) {
        // Already too late to play in time; skip it and line up on the next.
        this.stats.audioSkipped++;
        this.audioSynced = false;
        return;
      }
      var start = Math.max(desired, ctx.currentTime);
      out.startTime = start;
      out.wallclockStartTime = now() + (start - ctx.currentTime);
      if (this.audioSynced) this.stats.resyncs++;
      this.audioSynced = true;
    }
    this.sink(chunk.data);
    var pi = p.demuxer.pesPacketInfo[AUDIO_STREAM];
    if (pi && pi.currentLength) p.demuxer.packetComplete(pi);
    var n = 0;
    while (p.audio.decode() && ++n < 64) {}
  };

  StreamSession.prototype.tick = function () {
    if (this.state === 'done') return;
    var t = now();
    var gap = t - this.lastTick;
    this.lastTick = t;

    if (!this.serverEnded && !this.dropped && t - this.lastDataAt > STALL_TIMEOUT && !this.vq.length) {
      // Nothing has arrived for a while: drop this socket so we reconnect.
      this.dropped = true;
      this.closedByUs = true;
      try {
        this.ws.close();
      } catch (e) {}
    }
    if (this.clock === null) {
      if ((this.dropped || this.serverEnded) && !this.failed) this.finish();
      return;
    }

    if (this.state === 'buffering' && !this.starting) {
      // Sound arrives a little behind the picture, so count whichever is shorter.
      var have = this.audioArriving() ? Math.min(this.lastVideoPts, this.lastAudioPts) : this.lastVideoPts;
      var ahead = have - this.clock;
      var need = this.everPlayed ? REBUFFER : START_BUFFER;
      var noMore = this.serverEnded || this.dropped;
      if (this.sink && this.vq.length && (ahead >= need || noMore)) {
        if (this.wantPause) {
          // Starting paused: show the first frame so there's a picture.
          if (!this.primed && !this.everPlayed) {
            this.primed = true;
            this.feedVideo(this.vq.shift());
          }
          this.setState('paused');
        } else this.beginPlay();
      } else if (!this.vq.length && noMore) {
        this.finish();
      }
      return;
    }
    if (this.state !== 'playing') return;

    if (gap > GAP_LIMIT) {
      // The page was asleep (hidden tab, long freeze). Don't count that as
      // falling behind: carry on from where we were.
      this.wallBase += gap;
      this.audioSynced = false;
    }
    this.clock = this.clockBase + (t - this.wallBase);

    var audioLead = AUDIO_LEAD + outputDelay(audioContext());
    while (this.aq.length && this.aq[0].pts <= this.clock + audioLead) this.feedAudio(this.aq.shift());

    var deadline = performance.now() + TICK_BUDGET_MS;
    var n = 0;
    while (this.vq.length && this.vq[0].pts <= this.clock + VIDEO_LEAD) {
      if (n >= MAX_FRAMES_PER_TICK || performance.now() > deadline) break;
      var chunk = this.vq.shift();
      var late = this.clock - chunk.pts;
      this.stats.late = this.stats.late * 0.9 + Math.max(0, late) * 0.1;
      this.feedVideo(chunk);
      n++;
    }

    // After a short hiccup the loop above catches up within a few ticks. If
    // the picture stays behind, decoding can't keep up: hold the clock so
    // sound and picture stay together, and tell the page if it keeps happening.
    var behind = this.vq.length ? this.clock - this.vq[0].pts : 0;
    if (behind <= LATE_LIMIT) this.lateSince = 0;
    else if (!this.lateSince) this.lateSince = t;
    else if (t - this.lateSince > LATE_PATIENCE) {
      this.lateSince = 0;
      var back = behind;
      this.clockBase -= back;
      this.clock -= back;
      this.stats.holds++;
      this.holds.push(t);
      while (this.holds.length && t - this.holds[0] > 10) this.holds.shift();
      var frameMs = 1000 / (this.stats.fps || 30);
      if (this.holds.length >= 3 && t - this.slowReportedAt > 5 && this.stats.decodeMs > frameMs * SLOW_DECODE_SHARE) {
        this.slowReportedAt = t;
        if (this.o.onSlow) this.o.onSlow(this);
      }
    }

    if (this.serverEnded || this.dropped) {
      if (!this.vq.length && (this.lastFedPts === null || this.clock >= this.lastFedPts + 0.3)) this.finish();
      return;
    }
    // Out of data? The next frame is overdue, or the sound queued on the
    // sound card is about to run out with no more to add. Freeze picture and
    // sound together until more comes in, so they carry on without a gap.
    var videoDry = !this.vq.length && this.lastFedPts !== null && this.clock > this.lastFedPts + 1 / (this.stats.fps || 24) + 0.02;
    var out = this.player.audioOut;
    var audioDry =
      this.audioSynced && !this.aq.length && this.audioArriving() && out && out.context.state === 'running' &&
      out.startTime - out.context.currentTime < 0.06;
    if (videoDry || audioDry) {
      this.stats.stalls++;
      this.setState('buffering');
      audioRun(false);
      if (this.o.onStall) this.o.onStall(this);
    }
  };

  StreamSession.prototype.beginPlay = function () {
    var self = this;
    if (this.starting || this.state === 'done') return;
    this.starting = true;
    audioRun(true, function () {
      self.starting = false;
      if (self.state !== 'buffering' && self.state !== 'paused') return;
      if (self.wantPause) {
        // Paused again while the sound card was waking up.
        audioRun(false);
        self.setState('paused');
        return;
      }
      if (!self.everPlayed) {
        // Start just before whichever comes first, picture or sound.
        var first = self.vq.length ? self.vq[0].pts : self.clock + PREROLL;
        if (self.aq.length && self.aq[0].pts < first) first = self.aq[0].pts;
        self.clock = Math.min(self.clock, first - PREROLL - outputDelay(audioContext()));
      }
      var t = now();
      self.clockBase = self.clock;
      self.wallBase = t;
      self.lastTick = t;
      self.everPlayed = true;
      self.setState('playing');
    });
  };

  StreamSession.prototype.pause = function () {
    this.wantPause = true;
    if (this.state === 'playing') {
      this.clock = this.clockBase + (now() - this.wallBase);
      this.setState('paused');
      audioRun(false);
    }
  };

  StreamSession.prototype.resume = function () {
    this.wantPause = false;
    if (this.state === 'paused') this.beginPlay();
  };

  StreamSession.prototype.position = function () {
    if (this.basePts === null || this.clock === null) return this.startAt;
    return this.startAt + Math.max(0, this.clock - this.basePts);
  };

  StreamSession.prototype.buffered = function () {
    if (this.lastVideoPts === null || this.clock === null) return 0;
    return Math.max(0, this.lastVideoPts - this.clock);
  };

  StreamSession.prototype.setVolume = function (v) {
    this.player.volume = v;
  };

  // A snapshot for the Stats readout.
  StreamSession.prototype.info = function () {
    var st = this.stats;
    var ctx = this.player.audioOut && this.player.audioOut.context;
    var received = this.lastVideoPts !== null && this.basePts !== null ? this.lastVideoPts - this.basePts : 0;
    return {
      width: this.frames ? this.canvas.width : 0,
      height: this.frames ? this.canvas.height : 0,
      fps: st.fps,
      targetKbps: st.kbps,
      kbps: received > 2 ? Math.round((st.bytes * 8) / received / 1000) : null,
      decodeMs: st.decodeMs,
      decodeMax: st.decodeMax,
      lateMs: st.late * 1000,
      holds: st.holds,
      stalls: st.stalls,
      buffer: this.buffered(),
      resyncs: st.resyncs,
      audioSkipped: st.audioSkipped,
      audio: ctx ? ctx.state + ' ' + ctx.sampleRate + ' Hz' : 'none',
      serverSpeed: st.serverSpeed,
      serverLimited: st.serverLimited,
      frames: this.frames,
      state: this.state
    };
  };

  // Stop playback (and downloading) but keep the last frame on screen.
  StreamSession.prototype.freeze = function () {
    if (this.state === 'done') return;
    this.state = 'done';
    cancelAnimationFrame(this.raf);
    clearInterval(this.timer);
    clearInterval(this.reportTimer);
    this.closedByUs = true;
    try {
      this.ws.close();
    } catch (e) {}
    this.vq = [];
    this.aq = [];
    // Silence whatever this stream still has queued on the sound card.
    if (this.player.audioOut) this.player.audioOut.stop();
  };

  StreamSession.prototype.finish = function () {
    if (this.state === 'done') return;
    var wasFailed = this.failed;
    var pos = this.position();
    this.freeze();
    if (this.o.onState) this.o.onState(this);
    if (wasFailed) return;
    if (this.serverEnded && this.complete) {
      if (this.o.onEnded) this.o.onEnded(this);
    } else if (this.o.onDropped) {
      this.o.onDropped(this, pos);
    }
  };

  StreamSession.prototype.destroy = function () {
    this.freeze();
    try {
      this.player.destroy();
    } catch (e) {}
    try {
      var gl = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl');
      var ext = gl && gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    } catch (e) {}
    this.canvas.remove();
  };

  // Manages sessions so a seek or reconnect keeps the old picture up until
  // the new stream has its first frame.
  function DrivePlayer(host, callbacks) {
    this.host = host;
    this.cb = callbacks || {};
    this.active = null;
    this.stale = [];
    this.volume = 1;
  }

  DrivePlayer.prototype.load = function (spec) {
    var self = this;
    if (this.active) {
      this.active.freeze();
      this.stale.push(this.active);
    }
    var cb = this.cb;
    function ifActive(fn) {
      return function (s, a) {
        if (s === self.active && fn) fn(s, a);
      };
    }
    var session = new StreamSession({
      id: spec.id,
      seq: spec.seq,
      startAt: spec.startAt,
      quality: spec.quality,
      paused: spec.paused,
      host: this.host,
      volume: this.volume,
      onFirstFrame: function (s) {
        if (s === self.active) self.clearStale();
        if (cb.onChange) cb.onChange(s);
      },
      onState: function (s) {
        if (cb.onChange) cb.onChange(s);
      },
      onMeta: function (s) {
        if (cb.onChange) cb.onChange(s);
      },
      onEnded: ifActive(cb.onEnded),
      onDropped: ifActive(cb.onDropped),
      onSlow: ifActive(cb.onSlow),
      onStall: ifActive(cb.onStall),
      onError: function (s, message) {
        if (s === self.active) {
          self.clearStale();
          if (cb.onError) cb.onError(s, message);
        }
      }
    });
    this.active = session;
    // Don't keep an old frame up forever if the new stream never starts.
    setTimeout(function () {
      if (self.active === session) self.clearStale();
    }, 15000);
    if (cb.onChange) cb.onChange(session);
    return session;
  };

  DrivePlayer.prototype.clearStale = function () {
    this.stale.forEach(function (s) {
      s.destroy();
    });
    this.stale = [];
  };

  DrivePlayer.prototype.stop = function () {
    this.clearStale();
    if (this.active) this.active.destroy();
    this.active = null;
    wantAudio = false;
    if (this.cb.onChange) this.cb.onChange(null);
  };

  DrivePlayer.prototype.setPaused = function (paused) {
    if (!this.active) return;
    if (paused) this.active.pause();
    else this.active.resume();
  };

  DrivePlayer.prototype.setVolume = function (v) {
    this.volume = v;
    if (this.active) this.active.setVolume(v);
  };

  // Call from a tap: browsers only let sound start after one.
  DrivePlayer.unlockAudio = function () {
    var ctx = audioContext();
    if (ctx && wantAudio && ctx.state === 'suspended' && ctx.resume) ctx.resume();
  };

  window.DrivePlayer = DrivePlayer;
})();
