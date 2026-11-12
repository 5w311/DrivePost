/*
 * "Share this screen": show a tab, a window or this device's whole screen in
 * the car, with its sound.
 *
 * It works the way sharing a screen in a video call does. The browser asks
 * what to share, captures it, and this page records the capture and sends
 * the recording to the server as it is made. The server keeps it as a live
 * video (mirror.js) and the car plays that, a few seconds behind.
 *
 * Whatever is on the screen is played by this device, as it always is. The
 * car only gets a picture of it.
 *
 * The card shows wherever the browser can capture a screen: Chrome and Edge
 * on a computer, and Safari on an iPhone or iPad from iOS 27. On any device
 * it also shows while a screen is being shared, to bring it back to the car
 * or to stop it.
 */
(function () {
  'use strict';
  var $ = DT.$;

  // The picture asked for, and how much the recording of it may take (bits a second).
  var SIZES = {
    '480': { width: 854, height: 480, bps: 1500000 },
    '720': { width: 1280, height: 720, bps: 3500000 },
    '1080': { width: 1920, height: 1080, bps: 6000000 }
  };
  var SOUND_BPS = 128000;
  var SLICE_MS = 200; // the recording is sent in pieces this long
  var BEHIND_S = 4; // this much of it waiting to be sent: the connection can't keep up
  var GIVE_UP_MS = 2 * 60 * 1000; // how long a lost connection to the server is tried again

  var md = navigator.mediaDevices;
  var can = !!(window.isSecureContext && md && md.getDisplayMedia && window.MediaRecorder && window.WebSocket);
  // Chrome and its relatives take the finer requests below; other browsers get the plain one.
  var chromium = !!(navigator.userAgentData && navigator.userAgentData.brands) || !!window.chrome;

  var server = null; // the latest state from the server
  var allowed = true; // this server takes shared screens
  var control = null; // the page's line to the server, for "Show it in the car"
  var size = '720';
  var picking = false; // the browser is asking what to share
  var sit = null; // this device's sharing, while it shares
  var note = ''; // what went wrong last time, until the next try
  var awake = null;

  try {
    var kept = localStorage.getItem('dp.share.size');
    if (SIZES[kept]) size = kept;
  } catch (e) {}

  var WHAT = { browser: 'a tab', window: 'a window', monitor: 'this screen' };
  var WHAT_ELSEWHERE = { browser: 'a tab', window: 'a window', monitor: 'its screen' };

  // ---------- the card ----------

  function show(node, on) {
    node.classList.toggle('hidden', !on);
  }

  function paint() {
    var card = $('#shareCard');
    if (!card) return;
    var on = !!(server && server.screen);
    var showing = !!(server && server.now && server.now.id === 'screen');
    var insecure = !window.isSecureContext;
    show(card, allowed && (can || !!sit || on || insecure));
    var say = '';
    var hint = note;

    if (sit) {
      var what = WHAT[sit.surface] || 'this screen';
      if (sit.phase === 'reconnecting') say = 'Lost the connection to DrivePost. Trying again…';
      else if (sit.phase === 'turning') say = 'Turning the picture…';
      else if (sit.phase !== 'live') say = 'Starting to share ' + what + '…';
      else if (server && !server.carOnline) say = 'Sharing ' + what + '. The car is offline: it shows there once the car has DrivePost open.';
      else if (showing && server.paused) say = 'Sharing ' + what + '. It is paused in the car.';
      else if (showing) say = 'Sharing ' + what + '. The car is showing it, a few seconds behind.';
      else say = 'Sharing ' + what + ', but the car is playing something else.';
      hint = sit.sound
        ? 'Keep this page open. Its sound plays in the car' + (chromium ? ', not here.' : '.')
        : chromium
          ? "Keep this page open. No sound is coming with it: to hear it in the car, stop, share again, and switch on the sound in the browser's share window (it is offered for a tab, and on some computers for the whole screen)."
          : 'Keep this page open. This browser shares the picture without its sound.';
    } else if (picking) {
      say = "Choose what to share in the browser's window.";
      hint = '';
    } else if (on) {
      say = 'Another device is sharing ' + (WHAT_ELSEWHERE[server.screen.surface] || 'its screen') + ' to the car' +
        (showing ? '.' : ', but the car is playing something else.');
    } else if (can) {
      say = chromium
        ? "Show what is on this device's screen in the car, with its sound: a tab, a window, or all of it. The car plays it a few seconds behind."
        : "Show what is on this device's screen in the car. The car plays it a few seconds behind.";
    } else if (insecure) {
      say = "Sharing a screen only works at DrivePost's https address.";
    }

    $('#shareSay').textContent = say;
    show($('#shareSize'), can && !sit && !picking && !on);
    document.querySelectorAll('#shareSize button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-s') === size);
    });
    var start = $('#shareBtn');
    show(start, can && !sit && !on);
    start.disabled = picking;
    start.textContent = picking ? 'Choosing…' : 'Share to the car';
    show($('#shareShow'), (on || (sit && sit.phase === 'live')) && !showing);
    show($('#shareStop'), !!sit || on);
    // For a picture that arrives on its side, which a phone held sideways can
    // send: offered whenever what is captured is taller than it is wide.
    var shape = sit && sit.vtrack.getSettings ? sit.vtrack.getSettings() : {};
    show($('#shareTurn'), !!sit && (shape.height > shape.width || sit.turn > 0) && sit.phase !== 'connecting');
    $('#shareNote').textContent = hint;
    show($('#shareNote'), !!hint);
  }

  // ---------- starting ----------

  function begin() {
    if (sit || picking || !can) return;
    note = '';
    picking = true;
    var s = SIZES[size];
    // In Chrome the sound is passed on through a mixer of this page's own,
    // which has to be made from this tap (browsers insist). Elsewhere the
    // captured sound is recorded as it comes: a page that opens a sound
    // output of its own can get in the way of other apps' sound on a phone.
    var AC = chromium ? window.AudioContext || window.webkitAudioContext : null;
    var ctx = null;
    try {
      ctx = AC ? new AC({ sampleRate: 48000 }) : null;
    } catch (e) {
      try {
        ctx = new AC();
      } catch (e2) {
        ctx = null;
      }
    }
    var want = chromium
      ? {
          video: { frameRate: { ideal: 30, max: 30 }, width: { max: s.width }, height: { max: s.height } },
          // The sound as it is: no call-style clean-up, both channels, and
          // played in the car only, not on this device as well.
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, suppressLocalAudioPlayback: true },
          systemAudio: 'include',
          selfBrowserSurface: 'exclude', // not this page itself
          surfaceSwitching: 'include', // "share this tab instead" keeps working
          monitorTypeSurfaces: 'include'
        }
      : { video: true, audio: true };
    var asked;
    try {
      asked = md.getDisplayMedia(want);
    } catch (e) {
      asked = Promise.reject(e);
    }
    paint();
    asked.then(function (stream) {
      picking = false;
      started(stream, ctx);
    }, function (e) {
      picking = false;
      if (ctx) try { ctx.close(); } catch (e2) {}
      // Closing the browser's "choose what to share" window isn't a fault.
      if (!e || (e.name !== 'NotAllowedError' && e.name !== 'AbortError')) {
        note = "This browser couldn't share the screen" + (e && e.message ? ' (' + String(e.message).slice(0, 120) + ')' : '') + '.';
      }
      paint();
    });
  }

  function started(stream, ctx) {
    var vtrack = stream.getVideoTracks()[0];
    var atrack = stream.getAudioTracks()[0] || null;
    if (!vtrack) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      note = 'Nothing came from the screen.';
      return paint();
    }
    var set = vtrack.getSettings ? vtrack.getSettings() : {};
    var mine = (sit = {
      stream: stream,
      vtrack: vtrack,
      ctx: ctx,
      size: size,
      surface: WHAT[set.displaySurface] ? set.displaySurface : 'monitor',
      turn: 0, // quarter turns asked for, in degrees
      sound: !!atrack, // sound was shared with the picture
      out: null, // what is recorded: the steadied picture and the sound
      pump: null,
      ws: null,
      rec: null,
      phase: 'connecting',
      again: false, // the car has been sent to this sharing once already
      tries: 0,
      lostAt: 0,
      liveAt: 0,
      failures: 0 // times in a row the server couldn't use the recording
    });
    // "Stop sharing" in the browser's own bar, or the shared window was closed.
    vtrack.addEventListener('ended', function () {
      if (sit === mine) stop();
    });

    // Sound: through the mixer, which keeps a sound track going when nothing
    // is playing (and when no sound was shared), so that the recording
    // always has picture and sound side by side on one clock.
    var outSound = atrack;
    if (ctx) {
      try {
        var dest = ctx.createMediaStreamDestination();
        var hush = ctx.createConstantSource();
        hush.offset.value = 0;
        hush.connect(dest);
        hush.start();
        if (atrack) ctx.createMediaStreamSource(new MediaStream([atrack])).connect(dest);
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
        outSound = dest.stream.getAudioTracks()[0] || atrack;
      } catch (e) {
        outSound = atrack;
      }
    }
    mine.hasSound = !!outSound;

    steady(vtrack, mine).then(function (outPicture) {
      if (sit !== mine) return;
      mine.out = new MediaStream(outSound ? [outPicture, outSound] : [outPicture]);
      connect(mine);
    });
    keepAwake();
    paint();
  }

  /*
   * The picture at a steady pace (screen-pump.js says why). Resolves with a
   * track to record: the steadied one where this browser can make it, the
   * captured one as it is otherwise.
   */
  function steady(track, mine) {
    return new Promise(function (resolve) {
      if (!(window.MediaStreamTrackProcessor && window.MediaStreamTrackGenerator && window.Worker)) return resolve(track);
      var worker = null;
      var done = false;
      function settle(t) {
        if (done) return;
        done = true;
        if (t === track && worker) {
          try { worker.terminate(); } catch (e) {}
          worker = null;
        }
        mine.pump = worker;
        resolve(t);
      }
      try {
        var proc = new MediaStreamTrackProcessor({ track: track, maxBufferSize: 2 });
        var gen = new MediaStreamTrackGenerator({ kind: 'video' });
        worker = new Worker('/static/screen-pump.js?v=' + encodeURIComponent(DT.version || ''));
        worker.onmessage = function (ev) {
          if (ev.data && ev.data.flowing) settle(gen);
        };
        worker.onerror = function () { settle(track); };
        worker.postMessage({ readable: proc.readable, writable: gen.writable }, [proc.readable, gen.writable]);
      } catch (e) {
        return settle(track);
      }
      setTimeout(function () { settle(track); }, 2500);
    });
  }

  // ---------- sending ----------

  function recordingType() {
    // Chrome: VP8, which takes a picture that changes size in its stride.
    // Others (Safari): MP4 first, which an iPhone makes with its own chip.
    var types = chromium
      ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=h264,opus', 'video/webm', 'video/mp4']
      : ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
    if (DT.screenShare.type) return DT.screenShare.type; // for trying one out
    for (var i = 0; i < types.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported(types[i])) return types[i];
      } catch (e) {}
    }
    return '';
  }

  function connect(mine) {
    if (sit !== mine) return;
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = (mine.ws = new WebSocket(proto + location.host + '/ws/screen'));
    ws.onopen = function () {
      if (mine.ws !== ws) return;
      ws.send(JSON.stringify({ type: 'start', size: mine.size, audio: mine.hasSound, surface: mine.surface, again: mine.again, turn: mine.turn }));
    };
    ws.onmessage = function (ev) {
      if (sit !== mine || mine.ws !== ws || typeof ev.data !== 'string') return;
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'go') record(mine, ws);
      else if (msg.type === 'ready') {
        mine.phase = 'live';
        mine.again = true;
        mine.tries = 0;
        mine.lostAt = 0;
        mine.liveAt = Date.now();
        paint();
      } else if (msg.type === 'error') failed(mine, msg);
      else if (msg.type === 'replaced') stop('Another device started sharing to this car, so this one stopped.', true);
      else if (msg.type === 'stopped') stop('Sharing was stopped from another device.', true);
    };
    ws.onclose = function (ev) {
      if (sit !== mine || mine.ws !== ws) return;
      if (ev && ev.code === 4401) return stop('This device was signed out, so sharing stopped.', true);
      lost(mine);
    };
  }

  // The server couldn't use the recording. One that had been playing gets a
  // couple of fresh starts before that is taken for an answer.
  function failed(mine, msg) {
    if (Date.now() - mine.liveAt > 60000) mine.failures = 0;
    if (msg.again && mine.failures < 2) {
      mine.failures++;
      return lost(mine);
    }
    stop(msg.message || "The screen couldn't be shared.");
  }

  // The line to the server is gone (or no use any more): try again with a
  // fresh recording. `onPurpose` names why when it is this page's own doing.
  function lost(mine, onPurpose) {
    if (sit !== mine) return;
    endRecording(mine);
    var ws = mine.ws;
    mine.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      try { ws.close(); } catch (e) {}
    }
    if (onPurpose) {
      mine.phase = onPurpose;
      paint();
      return connect(mine);
    }
    if (!mine.lostAt) mine.lostAt = Date.now();
    if (Date.now() - mine.lostAt > GIVE_UP_MS) return stop('Lost the connection to DrivePost, so sharing stopped.', true);
    mine.phase = 'reconnecting';
    paint();
    setTimeout(function () { connect(mine); }, Math.min(5000, 500 * Math.pow(2, mine.tries++)));
  }

  function record(mine, ws) {
    var bps = SIZES[mine.size].bps;
    var opts = { videoBitsPerSecond: bps, audioBitsPerSecond: SOUND_BPS };
    var type = recordingType();
    if (type) opts.mimeType = type;
    var rec;
    try {
      rec = new MediaRecorder(mine.out, opts);
    } catch (e) {
      try {
        rec = new MediaRecorder(mine.out);
      } catch (e2) {
        return stop("This browser couldn't record the screen.");
      }
    }
    mine.rec = rec;
    if (mine.phase !== 'turning') mine.phase = 'starting';
    rec.ondataavailable = function (ev) {
      if (mine.rec !== rec || mine.ws !== ws || ws.readyState !== 1 || !ev.data || !ev.data.size) return;
      ws.send(ev.data);
      // The connection isn't carrying it as fast as it is made. Carrying on
      // would put the car further and further behind, so start afresh from now.
      if (ws.bufferedAmount > (BEHIND_S * (bps + SOUND_BPS)) / 8) lost(mine, 'reconnecting');
    };
    rec.onerror = function () {
      if (mine.rec === rec) lost(mine);
    };
    rec.start(SLICE_MS);
    paint();
  }

  function endRecording(mine) {
    var rec = mine.rec;
    mine.rec = null;
    if (!rec) return;
    rec.ondataavailable = rec.onerror = null;
    try {
      if (rec.state !== 'inactive') rec.stop();
    } catch (e) {}
  }

  // ---------- stopping ----------

  // `message` is shown on the card afterwards. `told`: the server already knows.
  function stop(message, told) {
    var mine = sit;
    if (!mine) return;
    sit = null;
    endRecording(mine);
    var ws = mine.ws;
    mine.ws = null;
    var said = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      try {
        if (ws.readyState === 1 && !told) {
          ws.send(JSON.stringify({ type: 'stop' }));
          said = true;
        }
        ws.close();
      } catch (e) {}
    }
    // Not on the line just now (it was being tried again): say so the other way.
    if (!told && !said) DT.api('/api/screen/stop', { method: 'POST' }).catch(function () {});
    mine.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    if (mine.out) mine.out.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    if (mine.pump) {
      try {
        mine.pump.postMessage({ stop: true });
        mine.pump.terminate();
      } catch (e) {}
    }
    if (mine.ctx) try { mine.ctx.close(); } catch (e) {}
    letSleep();
    note = message || '';
    paint();
  }

  // This page being closed ends the sharing: tell the server so the car moves on at once.
  window.addEventListener('pagehide', function (ev) {
    if (!sit || (ev && ev.persisted)) return;
    if (navigator.sendBeacon) navigator.sendBeacon('/api/screen/stop');
  });

  // Keep the screen from switching itself off while it is shared (where the
  // browser lets a page ask, and for as long as this page is the one in view).
  function keepAwake() {
    if (!sit || awake || !navigator.wakeLock || document.hidden) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      if (!sit) return lock.release();
      awake = lock;
      lock.addEventListener('release', function () {
        if (awake === lock) awake = null;
      });
    }).catch(function () {});
  }
  function letSleep() {
    var lock = awake;
    awake = null;
    if (lock) lock.release().catch(function () {});
  }
  document.addEventListener('visibilitychange', keepAwake);

  // ---------- buttons ----------

  function ready() {
    if (!$('#shareCard')) return;
    $('#shareBtn').addEventListener('click', begin);
    $('#shareStop').addEventListener('click', function () {
      if (sit) return stop();
      // Someone else's sharing, stopped from here.
      DT.api('/api/screen/stop', { method: 'POST' }).then(function () {
        DT.toast('Sharing stopped');
      }, function (e) {
        DT.toast(e.message);
      });
    });
    $('#shareTurn').addEventListener('click', function () {
      if (!sit || !sit.ws) return;
      // A quarter turn more, in a fresh recording: the car picks it up in a few seconds.
      sit.turn = (sit.turn + 90) % 360;
      lost(sit, 'turning');
    });
    $('#shareShow').addEventListener('click', function () {
      if (control) control.cmd('play', { item: { id: 'screen' } });
    });
    document.querySelectorAll('#shareSize button').forEach(function (b) {
      b.addEventListener('click', function () {
        size = b.getAttribute('data-s');
        try { localStorage.setItem('dp.share.size', size); } catch (e) {}
        paint();
      });
    });
    paint();
  }

  DT.screenShare = {
    can: can,
    type: '',
    // From the page: its line to the server, what the server says it allows, and each new state.
    use: function (c) { control = c; },
    hello: function (msg) {
      allowed = msg.screenShare !== false;
      if (!allowed && sit) stop('Screen sharing is switched off on this server.', true);
      paint();
    },
    state: function (s) {
      server = s;
      paint();
    },
    // Is this device sharing (or about to)? A page that is mustn't reload itself.
    busy: function () { return !!sit || picking; },
    debug: function () { return sit; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
