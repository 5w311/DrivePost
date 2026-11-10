/*
 * DrivePlayer: plays a server stream through JSMpeg on a <canvas>.
 *
 * The server sends MPEG-TS chunks tagged with their presentation time. We keep
 * a few seconds in reserve and hand chunks to JSMpeg at real-time speed, so a
 * choppy mobile connection causes a brief "buffering" pause instead of video
 * that races ahead or stutters.
 */
(function () {
  'use strict';

  var LEAD = 0.15; // hand data to the decoder this far ahead of the clock
  var START_BUFFER = 1.5; // seconds buffered before starting
  var REBUFFER = 2.5; // seconds buffered before resuming after a stall
  var STALL_TIMEOUT = 20; // seconds with no data before giving up on a socket

  function now() {
    return performance.now() / 1000;
  }

  // Keep one AudioContext alive for the whole page, so a new stream doesn't
  // need another tap to unlock sound.
  function pinAudio() {
    var ctx = JSMpeg.AudioOutput.WebAudio.CachedContext;
    if (ctx && !ctx._dtPinned) {
      ctx._connections = (ctx._connections || 0) + 1;
      ctx._dtPinned = true;
    }
    if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume();
  }

  function StreamSession(o) {
    var self = this;
    this.o = o;
    this.seq = o.seq;
    this.queue = [];
    this.basePts = null;
    this.clock = null;
    this.clockBase = 0;
    this.wallBase = 0;
    this.lastRecvPts = null;
    this.lastRelPts = null;
    this.lastDataAt = now();
    this.state = 'buffering'; // buffering | playing | paused | done
    this.wantPause = !!o.paused;
    this.everPlayed = false;
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

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'video-canvas pending';
    o.host.appendChild(this.canvas);

    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var url =
      proto + location.host + '/ws/stream?id=' + encodeURIComponent(o.id) +
      '&t=' + Math.floor(this.startAt) + '&q=' + encodeURIComponent(o.quality || '');
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
      self.sink = function (buf) {
        if (!src.established) {
          src.established = true;
          src.progress = 1;
        }
        if (src.destination) src.destination.write(buf);
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
      maxAudioLag: 0.5,
      videoBufferSize: 2 * 1024 * 1024,
      audioBufferSize: 256 * 1024,
      onVideoDecode: function () {
        self.frames++;
        if (self.frames === 1) {
          self.canvas.classList.remove('pending');
          if (o.onFirstFrame) o.onFirstFrame(self);
        }
      }
    });
    pinAudio();
    this.player.volume = o.volume === undefined ? 1 : o.volume;

    this.timer = setInterval(function () {
      self.tick();
    }, 15);
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
        if (this.o.onMeta) this.o.onMeta(this);
      } else if (msg.type === 'base') {
        this.basePts = msg.pts;
        if (this.clock === null) this.clock = msg.pts;
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
    var pts = new DataView(data, 0, 8).getFloat64(0, true);
    this.queue.push({ pts: pts, data: data.slice(8) });
    this.lastRecvPts = pts;
    this.lastDataAt = now();
    if (this.basePts === null) this.basePts = pts;
    if (this.clock === null) this.clock = this.basePts;
  };

  StreamSession.prototype.setState = function (s) {
    if (this.state === s) return;
    this.state = s;
    if (this.o.onState) this.o.onState(this);
  };

  StreamSession.prototype.tick = function () {
    if (this.state === 'done') return;
    var t = now();

    if (!this.serverEnded && !this.dropped && t - this.lastDataAt > STALL_TIMEOUT && this.queue.length === 0) {
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

    if (this.state === 'playing') this.clock = this.clockBase + (t - this.wallBase);

    if (this.state === 'buffering') {
      var ahead = this.lastRecvPts === null ? 0 : this.lastRecvPts - this.clock;
      var need = this.everPlayed ? REBUFFER : START_BUFFER;
      if (this.sink && this.queue.length && (ahead >= need || this.serverEnded || this.dropped)) {
        if (this.wantPause) {
          // Starting paused: decode a moment of video so there's a picture.
          if (!this.everPlayed) {
            while (this.queue.length && this.queue[0].pts <= this.clock + LEAD) {
              var first = this.queue.shift();
              this.sink(first.data);
              this.lastRelPts = first.pts;
            }
            if (this.player.audioOut) this.player.audioOut.stop();
          }
          this.setState('paused');
        } else this.startClock(t);
      } else if (!this.queue.length && (this.serverEnded || this.dropped)) {
        this.finish();
        return;
      }
    }

    if (this.state === 'playing') {
      while (this.queue.length && this.queue[0].pts <= this.clock + LEAD) {
        var chunk = this.queue.shift();
        this.sink(chunk.data);
        this.lastRelPts = chunk.pts;
      }
      if (!this.queue.length) {
        if (this.serverEnded || this.dropped) {
          if (this.lastRelPts === null || this.clock >= this.lastRelPts + 0.5) this.finish();
        } else if (this.lastRelPts !== null && this.clock > this.lastRelPts + 0.05) {
          // Ran out of data: hold the clock until more arrives.
          this.setState('buffering');
        }
      }
    }
  };

  StreamSession.prototype.startClock = function (t) {
    this.clockBase = this.clock;
    this.wallBase = t;
    this.everPlayed = true;
    this.setState('playing');
  };

  StreamSession.prototype.pause = function () {
    this.wantPause = true;
    if (this.state === 'playing') {
      this.setState('paused');
      if (this.player.audioOut) this.player.audioOut.stop();
    }
  };

  StreamSession.prototype.resume = function () {
    this.wantPause = false;
    if (this.state === 'paused') this.startClock(now());
  };

  StreamSession.prototype.position = function () {
    if (this.basePts === null || this.clock === null) return this.startAt;
    return this.startAt + Math.max(0, this.clock - this.basePts);
  };

  StreamSession.prototype.buffered = function () {
    if (this.lastRecvPts === null || this.clock === null) return 0;
    return Math.max(0, this.lastRecvPts - this.clock);
  };

  StreamSession.prototype.setVolume = function (v) {
    this.player.volume = v;
  };

  // Stop playback (and downloading) but keep the last frame on screen.
  StreamSession.prototype.freeze = function () {
    if (this.state === 'done') return;
    this.state = 'done';
    clearInterval(this.timer);
    clearInterval(this.reportTimer);
    this.closedByUs = true;
    try {
      this.ws.close();
    } catch (e) {}
    if (this.player.audioOut) this.player.audioOut.stop();
  };

  StreamSession.prototype.finish = function () {
    if (this.state === 'done') return;
    var wasFailed = this.failed;
    this.freeze();
    if (this.o.onState) this.o.onState(this);
    if (wasFailed) return;
    if (this.serverEnded && this.complete) {
      if (this.o.onEnded) this.o.onEnded(this);
    } else if (this.o.onDropped) {
      this.o.onDropped(this, this.position());
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
      onEnded: function (s) {
        if (s === self.active && cb.onEnded) cb.onEnded(s);
      },
      onDropped: function (s, pos) {
        if (s === self.active && cb.onDropped) cb.onDropped(s, pos);
      },
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

  DrivePlayer.unlockAudio = function () {
    var ctx = JSMpeg.AudioOutput.WebAudio.CachedContext;
    if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume();
  };

  window.DrivePlayer = DrivePlayer;
})();
