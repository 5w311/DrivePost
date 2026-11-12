/*
 * DrivePlayer: plays a server stream on a <canvas>, with sound through Web Audio.
 *
 * The server sends video one frame per message and audio in short runs, each
 * tagged with its presentation time. We keep several seconds in reserve and
 * run our own clock:
 *   - each video frame is shown at the moment it's due, so motion is even no
 *     matter how the data arrived or how often the browser repaints;
 *   - audio is scheduled on the sound card against the same clock, so sound
 *     and picture stay together;
 *   - when data runs out, or on pause, the clock and the sound card both
 *     freeze and later carry on from the same spot.
 *
 * The picture comes in one of two formats:
 *   - H.264: YouTube's own video, decoded by the browser (WebCodecs). Sharper
 *     and about half the data. Used when the browser can do it.
 *   - MPEG-1: converted by the server, decoded here by JSMpeg. Works everywhere,
 *     and is what we fall back to if H.264 decoding fails or stops.
 * Sound is MP2 decoded by JSMpeg in both cases. JSMpeg's own playback loop is
 * not used; we drive its demuxer and decoders directly.
 */
(function () {
  'use strict';

  var START_BUFFER = 1.5; // seconds buffered before starting
  var REBUFFER = 3; // seconds buffered before resuming after running dry
  var STALL_TIMEOUT = 20; // seconds with no data before giving up on a socket
  var PREROLL = 0.1; // start the clock this far before the first frame
  var VIDEO_LEAD = 0.02; // show a frame this long before it's due (about one repaint)
  var AUDIO_LEAD = 0.5; // sound queued ahead on the sound card (rides out short hiccups)
  var AUDIO_TOLERANCE = 0.07; // re-align sound if it drifts further than this from the picture
  var MAX_FRAMES_PER_TICK = 4; // MPEG-1: catch up after a hiccup by decoding a few frames at once
  var TICK_BUDGET_MS = 28;
  var LATE_LIMIT = 0.4; // picture this far behind and not catching up: hold the clock rather than lose sync
  var LATE_PATIENCE = 0.5; // how long catching up may take before we hold
  var SLOW_DECODE_SHARE = 0.35; // MPEG-1: decoding uses this much of each frame's time, so the screen is the bottleneck
  var GAP_LIMIT = 0.8; // a pause in our own timers this long means the page was asleep
  var AUDIO_GONE = 2; // sound this far behind the picture in arriving: the video has none here
  var SEEK_PREROLL_MAX = 20; // H.264 after a seek starts at an earlier keyframe, at most this far back
  // H.264: frames in the decoder plus decoded frames waiting for their time.
  // Kept small because decoders only have so many pictures to hand out.
  var MAX_AHEAD = 16;
  var DECODER_SILENT = 4; // H.264: seconds a full decoder may stay silent before we give up on it
  var DECODER_WARMUP = 7; // the same, for the very first frame (starting a decoder can take a moment)
  var PACE_WINDOW = 4; // H.264: seconds over which skipped pictures are counted
  var PACE_MIN_FPS = 20; // H.264: fewer pictures a second than this, with most skipped, means the screen is too slow
  var H264_RETRY_MS = 2 * 60 * 60 * 1000; // after H.264 fails, use MPEG-1 for this long
  // Skipping around in what has already arrived (H.264 only), the way a
  // video site does within its loaded bar, instead of asking the server for
  // a new stream every time.
  // What has been played stays on hand for skipping back, for as long as
  // there is room: everything held, played and still to come, is kept under
  // `bytes`, and the oldest goes first. (At 1080p that is the two minutes the
  // server reads ahead plus the last two to four minutes played.)
  var KEEP = { behind: 600, bytes: 160 * 1024 * 1024 };
  var JUMP_NEEDS = 1.5; // seconds on hand past a spot for a skip to go there at once
  var JUMP_BUFFER = 0.25; // how much of that has to be lined up before it plays
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

  // ---- can this browser decode H.264 itself? ----

  var h264 = { supported: null, failedAt: 0, reason: '' };
  try {
    h264.failedAt = parseInt(localStorage.getItem('dt.h264failed'), 10) || 0;
    h264.reason = localStorage.getItem('dt.h264reason') || '';
  } catch (e) {}

  h264.probe = (function () {
    // WebCodecs only exists on secure pages (https, or localhost).
    if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window)) return Promise.resolve(false);
    try {
      return VideoDecoder.isConfigSupported({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080, optimizeForLatency: true })
        .then(function (r) { return !!(r && r.supported); }, function () { return false; });
    } catch (e) {
      return Promise.resolve(false);
    }
  })().then(function (ok) {
    h264.supported = ok;
    return ok;
  });

  function h264Usable() {
    return h264.supported === true && Date.now() - h264.failedAt > H264_RETRY_MS;
  }

  function h264Failed(reason) {
    h264.failedAt = Date.now();
    h264.reason = reason;
    try {
      localStorage.setItem('dt.h264failed', String(h264.failedAt));
      localStorage.setItem('dt.h264reason', reason);
    } catch (e) {}
  }

  // A video from another site is whatever that site's encoder made of it,
  // and a browser can give up on one of those while playing YouTube's H.264
  // without any trouble. So when one fails, only that video goes to the
  // built-in player, for as long as this page stays open, and what is
  // remembered above (which is about the browser) is left alone.
  var gaveUpOn = {}; // video ID -> why

  // ---- video, MPEG-1: JSMpeg decodes and draws a frame the moment we feed it ----

  function Mpeg1Video(session) {
    this.s = session;
    this.kind = 'mpeg1';
    this.lastShown = null;
    this.dropped = 0;
  }
  Mpeg1Video.prototype.feed = function (chunk) {
    var p = this.s.player;
    this.s.sink(chunk.data);
    // One message is exactly one frame: tell the demuxer it's complete now
    // instead of letting it wait for the start of the next one.
    var pi = p.demuxer.pesPacketInfo[VIDEO_STREAM];
    if (pi && pi.currentLength) p.demuxer.packetComplete(pi);
    this.lastShown = chunk.pts;
    var n = 0;
    while (p.video.decode() && ++n < 2) {}
  };
  Mpeg1Video.prototype.pump = function () {};
  Mpeg1Video.prototype.trim = function () {};
  Mpeg1Video.prototype.flush = function () {};
  Mpeg1Video.prototype.readyFor = function () {
    return this.s.vq.length > 0;
  };
  Mpeg1Video.prototype.poster = function () {
    if (this.s.vq.length) this.feed(this.s.vq.shift());
  };
  Mpeg1Video.prototype.present = function (clock) {
    var vq = this.s.vq;
    var deadline = performance.now() + TICK_BUDGET_MS;
    var n = 0;
    while (vq.length && vq[0].pts <= clock + VIDEO_LEAD) {
      if (n >= MAX_FRAMES_PER_TICK || performance.now() > deadline) break;
      var chunk = vq.shift();
      this.s.noteLate(clock - chunk.pts);
      this.feed(chunk);
      n++;
    }
  };
  Mpeg1Video.prototype.nextDue = function () {
    return this.s.vq.length ? this.s.vq[0].pts : null;
  };
  Mpeg1Video.prototype.starved = function () {
    return !this.s.vq.length;
  };
  Mpeg1Video.prototype.idle = function () {
    return !this.s.vq.length;
  };
  Mpeg1Video.prototype.destroy = function () {};
  Mpeg1Video.prototype.fail = function () {};

  // ---- video, H.264: the browser decodes ahead of time, we show frames on the clock ----

  function concat(buffers) {
    var total = 0;
    for (var i = 0; i < buffers.length; i++) total += buffers[i].length;
    var out = new Uint8Array(total);
    var o = 0;
    for (var j = 0; j < buffers.length; j++) {
      out.set(buffers[j], o);
      o += buffers[j].length;
    }
    return out;
  }

  // Look through the start of a frame's data: is it a keyframe, and does it
  // carry the stream settings (SPS)? Stops at the first picture data.
  function scanFrame(b) {
    var info = { key: false, sps: null };
    var n = b.length - 4;
    for (var i = 0; i < n; i++) {
      if (b[i] !== 0 || b[i + 1] !== 0 || b[i + 2] !== 1) continue;
      var type = b[i + 3] & 0x1f;
      if (type === 5) {
        info.key = true;
        break;
      }
      if (type === 1) break;
      if (type === 7 && !info.sps) info.sps = b.subarray(i + 3, Math.min(b.length, i + 7));
      i += 3;
    }
    return info;
  }

  function hex2(v) {
    return ('0' + v.toString(16)).slice(-2);
  }

  // Can decoding start at this frame? Its first packet says so (the
  // "random access" flag, which ffmpeg sets on keyframes).
  function startsHere(data) {
    return data.length > 5 && data[0] === 0x47 && (data[3] & 0x20) !== 0 && data[4] > 0 && (data[5] & 0x40) !== 0;
  }

  function H264Video(session) {
    var self = this;
    this.s = session;
    this.kind = 'h264';
    this.ready = []; // decoded frames waiting for their time: { ts, frame }
    this.inDecoder = 0; // frames handed to the decoder that haven't come back
    this.pending = []; // those frames: { ts, n, at }, in the order they went in
    this.fed = 0;
    this.parts = []; // bytes of the frame the demuxer is handing over
    this.configured = false;
    this.gotKey = false;
    this.skipped = 0;
    this.flushing = false;
    this.flushed = false;
    this.failed = false;
    this.fullSince = 0;
    this.outputs = 0;
    this.lastOutputAt = now();
    this.lastShown = null;
    this.dropped = 0;
    this.posterShown = false;
    this.ctx = session.canvas.getContext('2d', { alpha: false });
    this.decoder = this.newDecoder();
    session.player.demuxer.connect(VIDEO_STREAM, {
      write: function (pts, buffers) {
        for (var i = 0; i < buffers.length; i++) self.parts.push(buffers[i]);
      }
    });
  }

  H264Video.prototype.newDecoder = function () {
    var self = this;
    var decoder = new VideoDecoder({
      output: function (frame) {
        // A frame from a decoder that has since been replaced is of no use.
        if (decoder !== self.decoder) return frame.close();
        self.onFrame(frame);
      },
      error: function (e) {
        if (decoder === self.decoder) self.fail('decoder error' + (e && e.message ? ': ' + e.message : ''));
      }
    });
    return decoder;
  };

  H264Video.prototype.fail = function (reason) {
    if (this.failed) return;
    this.failed = true;
    this.s.videoFailed(reason);
  };

  H264Video.prototype.feed = function (chunk) {
    var p = this.s.player;
    this.parts = [];
    this.s.sink(chunk.data);
    var pi = p.demuxer.pesPacketInfo[VIDEO_STREAM];
    if (pi && pi.currentLength) p.demuxer.packetComplete(pi);
    if (!this.parts.length) return;
    var bytes = concat(this.parts);
    this.parts = [];

    var info = scanFrame(bytes);
    if (!this.gotKey) {
      // Decoding has to start on a keyframe.
      if (!info.key && !(info.sps && this.skipped > 300)) {
        if (++this.skipped > 900) this.fail('no keyframe in the stream');
        return;
      }
      this.gotKey = true;
    }
    // A decoder that has shut down says so, whichever notices first: this or the regular check.
    if (this.decoder.state === 'closed') return this.fail('decoder closed');
    try {
      if (!this.configured) {
        var sps = info.sps;
        var codec = sps && sps.length >= 4 ? 'avc1.' + hex2(sps[1]) + hex2(sps[2]) + hex2(sps[3]) : 'avc1.640028';
        this.decoder.configure({ codec: codec, optimizeForLatency: true });
        this.configured = true;
        this.codec = codec;
      }
      var ts = Math.round(chunk.pts * 1e6);
      this.decoder.decode(new EncodedVideoChunk({ type: info.key ? 'key' : 'delta', timestamp: ts, data: bytes }));
      this.pending.push({ ts: ts, n: this.fed++, at: performance.now() });
      this.inDecoder = this.pending.length;
    } catch (e) {
      this.fail('decoder refused the video' + (e && e.message ? ': ' + e.message : ''));
    }
  };

  H264Video.prototype.onFrame = function (frame) {
    this.outputs++;
    this.lastOutputAt = now();
    var pending = this.pending;
    for (var k = 0; k < pending.length; k++) {
      if (pending[k].ts !== frame.timestamp) continue;
      var was = pending.splice(k, 1)[0];
      var ms = performance.now() - was.at;
      var st = this.s.stats;
      st.decodeMs = st.decodeMs ? st.decodeMs * 0.95 + ms * 0.05 : ms;
      if (ms > st.decodeMax) st.decodeMax = ms;
      // A frame that went in long before this one and never came back isn't
      // coming (H.264 reorders by 16 frames at most). Stop waiting for it.
      while (pending.length && pending[0].n < was.n - 32) pending.shift();
      break;
    }
    this.inDecoder = pending.length;
    if (this.s.state === 'done' || this.failed) {
      frame.close();
      return;
    }
    var item = { ts: frame.timestamp / 1e6, frame: frame };
    var r = this.ready;
    // Frames come out in display order; keep it that way even if one doesn't.
    var i = r.length;
    while (i > 0 && r[i - 1].ts > item.ts) i--;
    r.splice(i, 0, item);
  };

  // Hand queued frames to the decoder ahead of time, without flooding it.
  H264Video.prototype.pump = function () {
    if (this.failed) return;
    var vq = this.s.vq;
    var n = 0;
    while (vq.length && this.inDecoder + this.ready.length < MAX_AHEAD && n++ < 30) {
      this.feed(vq.shift());
      if (this.failed) return;
    }
    // A decoder that has been given plenty and returns nothing is not working
    // (for instance, if the browser stops decoding in some situations).
    if (this.decoder.state === 'closed') return this.fail('decoder closed');
    if (this.inDecoder >= MAX_AHEAD && !this.ready.length) {
      if (!this.fullSince) this.fullSince = now();
      else if (now() - this.fullSince > (this.outputs ? DECODER_SILENT : DECODER_WARMUP)) {
        this.fail(this.outputs ? 'decoder stopped returning frames' : 'decoder never returned a frame');
      }
    } else this.fullSince = 0;
  };

  // Before playback starts: drop frames from before the start point, keeping
  // the one that is on screen at that moment. (After a seek the stream begins
  // at an earlier keyframe, which has to be decoded but not shown.)
  H264Video.prototype.trim = function (start) {
    var r = this.ready;
    while (r.length > 1 && r[1].ts <= start) r.shift().frame.close();
  };

  H264Video.prototype.readyFor = function (start) {
    var r = this.ready;
    if (!r.length) return false;
    if (r[r.length - 1].ts >= start - 0.001) return true;
    // Shorter than expected: start with what there is once nothing more is coming.
    return this.s.noMore() && !this.s.vq.length && (this.inDecoder === 0 || this.flushed);
  };

  H264Video.prototype.draw = function (frame) {
    var c = this.s.canvas;
    var w = frame.displayWidth;
    var h = frame.displayHeight;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    this.ctx.drawImage(frame, 0, 0, w, h);
    this.s.onPicture();
  };

  // Show the first picture without starting (while loading, or paused).
  H264Video.prototype.poster = function () {
    if (this.posterShown || !this.ready.length) return;
    this.posterShown = true;
    this.draw(this.ready[0].frame);
  };

  H264Video.prototype.present = function (clock) {
    var r = this.ready;
    var due = null;
    while (r.length && r[0].ts <= clock + VIDEO_LEAD) {
      if (due) {
        due.frame.close(); // more than one was due: skip to the newest
        this.dropped++;
      }
      due = r.shift();
    }
    if (!due) return;
    this.s.noteLate(clock - due.ts);
    this.draw(due.frame);
    due.frame.close();
    this.lastShown = due.ts;
  };

  H264Video.prototype.nextDue = function () {
    if (this.ready.length) return this.ready[0].ts;
    if (this.lastShown !== null && (this.inDecoder > 0 || this.s.vq.length)) return this.lastShown + this.s.frameTime();
    return null;
  };

  // Is the decoder handing frames back at all? (If not, it isn't slow, it's
  // stuck, and lowering the quality won't help.)
  H264Video.prototype.producing = function () {
    return now() - this.lastOutputAt < 1;
  };

  // Out of input: nothing queued, nothing decoded, and the decoder isn't
  // about to hand anything over.
  H264Video.prototype.starved = function () {
    return !this.s.vq.length && !this.ready.length && (this.inDecoder === 0 || now() - this.lastOutputAt > 0.15);
  };

  H264Video.prototype.idle = function () {
    return !this.s.vq.length && !this.ready.length && (this.inDecoder === 0 || this.flushed);
  };

  // End of the stream: ask the decoder for the frames it is still holding.
  H264Video.prototype.flush = function () {
    var self = this;
    if (this.flushing || this.s.vq.length) return;
    this.flushing = true;
    if (!this.configured || this.failed) {
      this.flushed = true;
      return;
    }
    try {
      this.decoder.flush().then(function () { self.flushed = true; }, function () { self.flushed = true; });
    } catch (e) {
      this.flushed = true;
    }
  };

  // Begin again from a keyframe elsewhere in the stream: forget what was
  // decoded and what the decoder was in the middle of.
  H264Video.prototype.restart = function () {
    this.ready.forEach(function (it) {
      try { it.frame.close(); } catch (e) {}
    });
    this.ready = [];
    this.pending = [];
    this.inDecoder = 0;
    this.parts = [];
    this.gotKey = false;
    this.skipped = 0;
    this.flushing = false;
    this.flushed = false;
    this.fullSince = 0;
    this.lastOutputAt = now();
    this.lastShown = null;
    this.posterShown = false;
    this.configured = false;
    try {
      this.decoder.reset();
      return true;
    } catch (e) {}
    // It wouldn't start over: use a new one. If that can't be had either, say
    // so, and the stream is opened again instead; this isn't the decoder
    // failing at the video.
    try {
      var old = this.decoder;
      this.decoder = this.newDecoder();
      try { if (old.state !== 'closed') old.close(); } catch (e2) {}
      return true;
    } catch (e3) {
      return false;
    }
  };

  H264Video.prototype.destroy = function () {
    this.ready.forEach(function (it) {
      try { it.frame.close(); } catch (e) {}
    });
    this.ready = [];
    this.pending = [];
    this.inDecoder = 0;
    try {
      if (this.decoder.state !== 'closed') this.decoder.close();
    } catch (e) {}
  };

  // ---- one stream ----

  function StreamSession(o) {
    var self = this;
    this.o = o;
    this.seq = o.seq;
    this.quality = o.quality;
    this.vq = []; // video frames received, in the order they must be decoded
    this.aq = []; // audio runs waiting for their time
    // Everything that has arrived and isn't long past, played or not, so a
    // skip within it needs nothing from the server (see jumpTo).
    this.kept = { v: [], a: [], bytes: 0 };
    this.jump = null; // a skip within what is kept, being lined up: the stream time it goes to
    this.landed = null; // where the last such skip went
    this.lastForget = 0;
    this.basePts = null; // stream time that `startAt` corresponds to
    this.clock = null; // current stream time
    this.clockBase = 0;
    this.wallBase = 0;
    this.lastTick = now();
    this.firstVideoPts = null;
    this.firstAudioPts = null;
    this.lastVideoPts = null; // furthest frame received
    this.lastAudioPts = null; // newest audio run received
    this.lastDataAt = now();
    this.state = 'buffering'; // buffering | playing | paused | done
    this.wantPause = !!o.paused;
    this.starting = false;
    this.everPlayed = false;
    this.serverEnded = false;
    this.complete = false;
    this.dropped = false;
    this.failed = false;
    this.closedByUs = false;
    this.duration = null;
    this.live = false;
    this.hasAudio = true;
    this.startAt = o.startAt || 0;
    this.sink = null;
    this.ws = null;
    this.player = null; // JSMpeg: demuxer, sound, and (for MPEG-1) the picture
    this.video = null; // Mpeg1Video or H264Video, once the server says which
    this.codec = null;
    this.asked = null; // what we asked the server for
    this.frames = 0; // pictures shown
    this.audioSynced = false;
    this.holds = [];
    this.slowReportedAt = 0;
    this.pace = null; // H.264: pictures shown and skipped since a moment ago
    this.paceBad = 0;
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

    // Open the stream once we know whether this browser can decode H.264.
    h264.probe.then(function () {
      if (self.state !== 'done') self.open(o.format !== 'mpeg1' && h264Usable() && !gaveUpOn[o.id]);
    });

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
      if (self.ws && self.ws.readyState === 1 && self.clock !== null) self.ws.send(JSON.stringify({ clock: self.clock }));
    }, 500);
  }

  StreamSession.prototype.open = function (wantH264) {
    var self = this;
    var o = this.o;
    this.asked = wantH264 ? 'h264' : 'mpeg1';
    this.lastDataAt = now();
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var url =
      proto + location.host + '/ws/stream?id=' + encodeURIComponent(o.id) +
      '&t=' + Math.floor(this.startAt) + '&q=' + encodeURIComponent(o.quality || '') +
      '&ar=' + audioRate() + '&v=' + this.asked;
    var ws = (this.ws = new WebSocket(url));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = function (ev) {
      self.onMessage(ev.data);
    };
    ws.onclose = function () {
      if (!self.closedByUs && !self.serverEnded) self.dropped = true;
    };
  };

  // The server has said which picture format is coming: build the decoders.
  StreamSession.prototype.setup = function (codec) {
    var self = this;
    var o = this.o;
    if (this.player) return;
    this.codec = codec === 'h264' ? 'h264' : 'mpeg1';

    // Custom JSMpeg source: we decide when bytes reach the decoders.
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

    var options = {
      source: Source,
      audio: true,
      pauseWhenHidden: false,
      maxAudioLag: 60,
      audioBufferSize: 256 * 1024
    };
    if (this.codec === 'mpeg1') {
      options.canvas = this.canvas;
      options.decodeFirstFrame = false;
      options.videoBufferSize = 4 * 1024 * 1024;
      options.onVideoDecode = function (decoder, elapsed) {
        var ms = elapsed * 1000;
        var st = self.stats;
        st.decodeMs = st.decodeMs ? st.decodeMs * 0.95 + ms * 0.05 : ms;
        if (ms > st.decodeMax) st.decodeMax = ms;
        self.onPicture();
      };
    } else {
      options.video = false; // JSMpeg only handles the sound here
    }
    this.player = new JSMpeg.Player('stream', options);
    // We drive decoding ourselves; make sure JSMpeg's own loop stays off.
    this.player.autoplay = false;
    this.player.pause();
    if (this.player.audioOut) this.player.audioOut.unlocked = true;
    this.player.volume = o.volume === undefined ? 1 : o.volume;

    if (this.codec === 'h264') {
      try {
        this.video = new H264Video(this);
      } catch (e) {
        this.videoFailed('could not start the decoder' + (e && e.message ? ': ' + e.message : ''));
      }
    } else {
      this.video = new Mpeg1Video(this);
    }
  };

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
        this.hasAudio = msg.audio !== false;
        this.why = msg.why || ''; // why another site's video is being converted, when it is
        this.stats.fps = msg.fps || null;
        this.stats.kbps = msg.kbps || null;
        this.setup(msg.codec);
        if (this.o.onMeta) this.o.onMeta(this);
      } else if (msg.type === 'speed') {
        this.stats.serverSpeed = msg.x;
        this.stats.serverLimited = !!msg.limitedByNetwork;
      } else if (msg.type === 'restart') {
        // The server is starting this stream over another way (no sound was
        // coming through). Don't play out what is buffered: start over now.
        this.serverEnded = false;
        this.finish();
      } else if (msg.type === 'end') {
        this.serverEnded = true;
        this.complete = !!msg.complete;
      } else if (msg.type === 'error') {
        this.failed = true;
        this.finish();
        if (this.o.onError) this.o.onError(this, msg.message || 'Playback error');
      } else if (msg.type === 'notice') {
        // Something worth knowing that isn't an error, like a lower quality than asked for.
        if (this.o.onNotice && msg.message) this.o.onNotice(this, String(msg.message));
      }
      return;
    }
    if (data.byteLength < 10) return;
    var view = new DataView(data);
    var chunk = { pts: view.getFloat64(0, true), data: new Uint8Array(data, 9) };
    this.stats.bytes += data.byteLength - 9;
    this.lastDataAt = now();
    if (this.codec === 'h264') {
      this.kept.bytes += chunk.data.length;
      if (view.getUint8(8) === 0) {
        chunk.key = startsHere(chunk.data);
        this.kept.v.push(chunk);
      } else this.kept.a.push(chunk);
    }
    if (view.getUint8(8) === 0) {
      this.vq.push(chunk);
      if (this.firstVideoPts === null) this.firstVideoPts = chunk.pts;
      // H.264 frames don't arrive in display order: keep the furthest.
      if (this.lastVideoPts === null || chunk.pts > this.lastVideoPts) this.lastVideoPts = chunk.pts;
      if (this.clock === null) this.clock = chunk.pts - PREROLL;
    } else {
      this.aq.push(chunk);
      if (this.firstAudioPts === null) this.firstAudioPts = chunk.pts;
      this.lastAudioPts = chunk.pts;
    }
  };

  StreamSession.prototype.noMore = function () {
    return this.serverEnded || this.dropped;
  };

  StreamSession.prototype.frameTime = function () {
    return 1 / (this.stats.fps || 30);
  };

  // Is sound still arriving alongside the picture? Some videos have none, or
  // a sound track that ends early; then only the picture decides buffering.
  StreamSession.prototype.audioArriving = function () {
    return this.lastAudioPts !== null && this.lastVideoPts - this.lastAudioPts < AUDIO_GONE;
  };

  // The stream time where playback should begin. Normally the first frame.
  // After a seek, passed-through H.264 begins at an earlier keyframe while the
  // sound begins exactly at the spot asked for, so the sound marks the start.
  // Returns null while that isn't known yet.
  StreamSession.prototype.startPts = function () {
    if (this.jump !== null) return this.jump; // a skip within what is on hand starts where it was aimed
    var v = this.firstVideoPts;
    var a = this.firstAudioPts;
    if (this.codec !== 'h264' || !(this.startAt > 0)) return v;
    if (a !== null) return a > v && a - v < SEEK_PREROLL_MAX ? a : v;
    // No sound yet. Wait for it, unless there is none to wait for.
    if (!this.hasAudio || this.noMore() || this.lastVideoPts - v > SEEK_PREROLL_MAX) return v;
    return null;
  };

  StreamSession.prototype.setState = function (s) {
    if (this.state === s) return;
    this.state = s;
    this.pace = null;
    if (this.o.onState) this.o.onState(this);
  };

  // A picture went on screen.
  StreamSession.prototype.onPicture = function () {
    this.frames++;
    if (this.frames === 1) {
      this.canvas.classList.remove('pending');
      if (this.o.onFirstFrame) this.o.onFirstFrame(this);
    }
  };

  StreamSession.prototype.noteLate = function (late) {
    this.stats.late = this.stats.late * 0.9 + Math.max(0, late) * 0.1;
  };

  // H.264 decoding didn't work: remember that and let the page reopen the
  // stream in MPEG-1 from the same spot.
  StreamSession.prototype.videoFailed = function (reason) {
    if (this.state === 'done') return;
    var pos = this.position();
    if (this.o.elsewhere) gaveUpOn[this.o.id] = reason;
    else h264Failed(reason);
    this.freeze();
    if (this.o.onState) this.o.onState(this);
    if (this.o.onVideoFail) this.o.onVideoFail(this, { reason: reason, position: pos });
  };

  // Silence what is already queued on the sound card, and take new sound
  // from here on. (JSMpeg's own stop only mutes until the next sound, which
  // would let the old queue be heard again.)
  StreamSession.prototype.cutSound = function () {
    var out = this.player && this.player.audioOut;
    if (out && out.context && out.gain) {
      try {
        var fresh = out.context.createGain();
        fresh.gain.value = out.volume;
        fresh.connect(out.context.destination);
        out.gain.disconnect();
        out.gain = fresh;
        out.destination = fresh;
      } catch (e) {}
      out.startTime = 0;
      out.wallclockStartTime = 0;
    }
    this.audioSynced = false;
  };

  // The stretch of the video that is on hand, in seconds into the video:
  // a skip to anywhere in it happens at once. Null if there is none.
  StreamSession.prototype.onHand = function () {
    var v = this.kept.v;
    var a = this.kept.a;
    if (this.basePts === null || !v.length || this.lastVideoPts === null) return null;
    var first = v[0].pts;
    if (this.hasAudio && a.length && a[0].pts > first) first = a[0].pts;
    var last = this.audioArriving() ? Math.min(this.lastVideoPts, this.lastAudioPts) : this.lastVideoPts;
    if (last <= first) return null;
    return { from: this.startAt + (first - this.basePts), to: this.startAt + (last - this.basePts) };
  };

  /*
   * Skip to `position` (seconds into the video) using what has already
   * arrived, without asking the server for anything. Returns false when that
   * spot isn't on hand; the stream then has to be opened again there.
   *
   * The picture has to be decoded from the keyframe before the spot, so the
   * decoder starts over there and the frames up to the spot are decoded
   * without being shown, exactly as at the start of a stream.
   */
  StreamSession.prototype.jumpTo = function (position) {
    var video = this.video;
    if (this.state === 'done' || this.live || this.codec !== 'h264' || !video || video.failed || !this.sink) return false;
    if (this.basePts === null || !isFinite(position)) return false;
    var spot = this.basePts + (position - this.startAt);
    var v = this.kept.v;
    var a = this.kept.a;
    var from = -1;
    for (var i = v.length - 1; i >= 0; i--) {
      if (v[i].key && v[i].pts <= spot + 0.001) {
        from = i;
        break;
      }
    }
    if (from < 0) return false; // before what is kept
    if (this.hasAudio && a.length && a[0].pts > spot + 0.15) return false; // picture on hand, but not its sound
    var have = this.audioArriving() ? Math.min(this.lastVideoPts, this.lastAudioPts) : this.lastVideoPts;
    if (have - spot < JUMP_NEEDS && !(this.noMore() && have > spot)) return false; // at or past the edge of what has arrived

    if (!video.restart()) return false;
    this.vq = v.slice(from);
    var k = 0;
    while (k < a.length && a[k].pts < spot - 0.12) k++;
    this.aq = a.slice(k);
    this.cutSound();
    this.jump = spot;
    this.landed = spot;
    this.clock = spot;
    this.clockBase = spot;
    this.wallBase = now();
    this.lateSince = 0;
    this.pace = null;
    // Lined up like the start of a stream: play once the picture for the spot
    // is decoded. Usually a fraction of a second.
    if (this.state !== 'buffering') this.setState('buffering');
    return true;
  };

  // Let go of what was played a while ago: everything before the last
  // keyframe that is far enough behind (frames are no use without the
  // keyframe they follow), and the sound that went with it.
  StreamSession.prototype.forget = function () {
    var k = this.kept;
    var v = k.v;
    if (!v.length || this.clock === null) return;
    var limit = this.clock - KEEP.behind;
    var size = 0; // bytes of the frames before the one being looked at
    var cut = 0;
    var cutSize = 0;
    for (var i = 0; i < v.length; i++) {
      if (i > 0 && v[i].key) {
        var tooMuch = k.bytes - cutSize > KEEP.bytes;
        if (v[i].pts <= limit || (tooMuch && v[i].pts < this.clock - 1)) {
          cut = i;
          cutSize = size;
        } else break;
      }
      size += v[i].data.length;
    }
    if (!cut) return;
    v.splice(0, cut);
    k.bytes -= cutSize;
    var a = k.a;
    var n = 0;
    while (n < a.length && a[n].pts < v[0].pts - 0.5) k.bytes -= a[n++].data.length;
    if (n) a.splice(0, n);
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
    var video = this.video;

    if (this.ws && !this.noMore() && t - this.lastDataAt > STALL_TIMEOUT && !this.vq.length) {
      // Nothing has arrived for a while: drop this socket so we reconnect.
      this.dropped = true;
      this.closedByUs = true;
      try {
        this.ws.close();
      } catch (e) {}
    }
    if (this.clock === null || !video) {
      if (this.noMore() && !this.failed && !this.vq.length) this.finish();
      return;
    }

    // H.264: keep the decoder working a little ahead, whatever the state.
    if (this.sink) video.pump();
    if (this.state === 'done') return; // the decoder failed just now
    if (this.kept.v.length && t - this.lastForget > 1) {
      this.lastForget = t;
      this.forget();
    }

    if (this.state === 'buffering' && !this.starting) {
      // Lining up a start: of the stream, or of a skip within what is on hand.
      var fresh = !this.everPlayed || this.jump !== null;
      var start = fresh ? this.startPts() : -Infinity;
      if (start === null) return; // the start point isn't known yet
      if (fresh) video.trim(start);
      // Sound arrives a little behind the picture, so count whichever is shorter.
      var have = this.audioArriving() ? Math.min(this.lastVideoPts, this.lastAudioPts) : this.lastVideoPts;
      var from = fresh ? Math.max(this.clock, start - PREROLL) : this.clock;
      var need = this.jump !== null ? JUMP_BUFFER : this.everPlayed ? REBUFFER : START_BUFFER;
      var enough = have - from >= need || this.noMore();
      if (this.noMore()) video.flush();
      if (this.sink && enough && video.readyFor(start)) {
        if (fresh) video.trim(start);
        if (this.wantPause) {
          // Starting paused: show the first frame so there's a picture.
          if (fresh) video.poster();
          this.setState('paused');
        } else this.beginPlay();
      } else if (this.noMore() && video.idle()) {
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
      this.pace = null;
    }
    this.clock = this.clockBase + (t - this.wallBase);

    var audioLead = AUDIO_LEAD + outputDelay(audioContext());
    while (this.aq.length && this.aq[0].pts <= this.clock + audioLead) this.feedAudio(this.aq.shift());

    video.present(this.clock);

    // After a short hiccup the picture catches up within a few ticks. If it
    // stays behind, decoding can't keep up: hold the clock so sound and
    // picture stay together, and tell the page if it keeps happening.
    var due = video.nextDue();
    var behind = due !== null ? this.clock - due : 0;
    if (behind <= LATE_LIMIT) this.lateSince = 0;
    else if (!this.lateSince) this.lateSince = t;
    else if (t - this.lateSince > LATE_PATIENCE) {
      this.lateSince = 0;
      this.clockBase -= behind;
      this.clock -= behind;
      this.stats.holds++;
      this.holds.push(t);
      while (this.holds.length && t - this.holds[0] > 10) this.holds.shift();
      // MPEG-1 is decoded on this page, so we can tell a slow screen from a
      // busy moment. The browser's own H.264 decoder doesn't say; there, slow
      // means frames keep coming but not fast enough.
      var slow = video.kind === 'mpeg1'
        ? this.stats.decodeMs > this.frameTime() * 1000 * SLOW_DECODE_SHARE
        : video.producing();
      if (this.holds.length >= 3 && t - this.slowReportedAt > 5 && slow) {
        this.slowReportedAt = t;
        if (this.o.onSlow) this.o.onSlow(this);
      }
    }

    // H.264 is decoded ahead of time, so a screen that can't draw fast enough
    // doesn't fall behind: it skips pictures. If most are being skipped and
    // few get shown, that's too slow as well.
    if (video.kind === 'h264' && !document.hidden) {
      if (!this.pace) this.pace = { at: t, shown: this.frames, skipped: video.dropped };
      else if (t - this.pace.at >= PACE_WINDOW) {
        var shown = this.frames - this.pace.shown;
        var skipped = video.dropped - this.pace.skipped;
        var bad = skipped > shown && shown / (t - this.pace.at) < PACE_MIN_FPS;
        this.paceBad = bad ? this.paceBad + 1 : 0;
        this.pace = { at: t, shown: this.frames, skipped: video.dropped };
        if (this.paceBad >= 2 && t - this.slowReportedAt > 5) {
          this.paceBad = 0;
          this.slowReportedAt = t;
          if (this.o.onSlow) this.o.onSlow(this);
        }
      }
    }

    if (this.noMore()) {
      video.flush();
      if (video.idle() && (video.lastShown === null || this.clock >= video.lastShown + 0.3)) this.finish();
      return;
    }
    // Out of data? The next frame is overdue with nothing to make it from, or
    // the sound queued on the sound card is about to run out with no more to
    // add. Freeze picture and sound together until more comes in, so they
    // carry on without a gap.
    var videoDry = video.starved() && video.lastShown !== null && this.clock > video.lastShown + this.frameTime() + 0.02;
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
      if (self.jump !== null) {
        // A skip within what was on hand: the same stream and the same clock, at a new spot.
        if (!self.video || !self.video.readyFor(self.jump)) {
          // Its picture isn't decoded yet: back to lining up, and the next tick tries again.
          if (self.state === 'paused') self.setState('buffering');
          return;
        }
        self.video.trim(self.jump);
        self.clock = self.jump - PREROLL - outputDelay(audioContext());
        self.jump = null;
      } else if (!self.everPlayed) {
        // Start just before the start point, or before the sound if that
        // comes a moment earlier.
        var start = self.startPts();
        if (start === null) start = self.firstVideoPts;
        var first = self.firstAudioPts !== null && self.firstAudioPts < start ? self.firstAudioPts : start;
        self.basePts = start;
        self.clock = first - PREROLL - outputDelay(audioContext());
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
    // The clock starts a moment early to line picture and sound up; the
    // position doesn't read earlier than where playback was started from.
    var from = this.landed !== null ? this.landed : this.basePts;
    return this.startAt + (Math.max(from, this.clock) - this.basePts);
  };

  StreamSession.prototype.buffered = function () {
    if (this.lastVideoPts === null || this.clock === null) return 0;
    var from = this.clock;
    if (this.basePts === null) {
      // Not started: count from the start point, not from the lead-in before it.
      var start = this.startPts();
      from = Math.max(from, start === null ? this.lastVideoPts : start);
    }
    return Math.max(0, this.lastVideoPts - from);
  };

  StreamSession.prototype.setVolume = function (v) {
    if (this.player) this.player.volume = v;
    else this.o.volume = v;
  };

  // A snapshot for the Stats readout.
  StreamSession.prototype.info = function () {
    var st = this.stats;
    var ctx = this.player && this.player.audioOut && this.player.audioOut.context;
    var received = this.lastVideoPts !== null && this.firstVideoPts !== null ? this.lastVideoPts - this.firstVideoPts : 0;
    return {
      width: this.frames ? this.canvas.width : 0,
      height: this.frames ? this.canvas.height : 0,
      fps: st.fps,
      codec: this.codec,
      asked: this.asked,
      targetKbps: st.kbps,
      kbps: received > 2 ? Math.round((st.bytes * 8) / received / 1000) : null,
      decodeMs: st.decodeMs,
      decodeMax: st.decodeMax,
      dropped: this.video ? this.video.dropped : 0,
      ready: this.video && this.video.ready ? this.video.ready.length : 0,
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
      if (this.ws) this.ws.close();
    } catch (e) {}
    this.vq = [];
    this.aq = [];
    // Silence whatever this stream still has queued on the sound card.
    if (this.player && this.player.audioOut) this.player.audioOut.stop();
    if (this.video) this.video.destroy();
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
      if (this.player) this.player.destroy();
    } catch (e) {}
    try {
      if (this.codec === 'mpeg1') {
        var gl = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl');
        var ext = gl && gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      }
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

  // spec.format: 'auto' uses H.264 when this browser can decode it; 'mpeg1'
  // always uses the JSMpeg player.
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
      format: spec.format,
      elsewhere: !!spec.elsewhere, // another site's video, not one of YouTube's
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
      onVideoFail: ifActive(cb.onVideoFail),
      onNotice: ifActive(cb.onNotice),
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

  // What this browser can do with H.264, for the Stats readout.
  DrivePlayer.h264 = function () {
    return {
      supported: h264.supported,
      usable: h264Usable(),
      failedAt: h264.failedAt,
      reason: h264.reason,
      retryAt: h264.failedAt ? h264.failedAt + H264_RETRY_MS : 0
    };
  };
  // Why this one video (from another site) is on the built-in player, if it is.
  DrivePlayer.gaveUpOn = function (id) {
    return gaveUpOn[id] || '';
  };
  // Try H.264 again now instead of waiting out the retry time.
  DrivePlayer.retryH264 = function () {
    h264.failedAt = 0;
    h264.reason = '';
    try {
      localStorage.removeItem('dt.h264failed');
      localStorage.removeItem('dt.h264reason');
    } catch (e) {}
  };

  DrivePlayer.keep = KEEP; // how much stays on hand (see above)

  window.DrivePlayer = DrivePlayer;
})();
