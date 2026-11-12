(function () {
  'use strict';
  var $ = DT.$;
  var el = DT.el;

  var state = null; // latest state from the server
  var activated = false; // the passenger has tapped the page (needed for sound)
  var loadedSeq = null;
  var loadedId = null; // the video the open stream is of
  var loadedFormat = null; // and the video format setting it was opened under
  var retries = [];
  var jumps = []; // skips made on this page before the server knew: { to, at }
  var errorMsg = null;
  var searchResults = null;
  var searching = false;
  var tab = 'queue';
  var overlayTimer = null;
  var OVERLAY_MS = 3000; // controls hide this long after the last touch
  var wasPaused = null;
  var volume = 1;
  var QUALITIES = ['360', '480', '720', '1080'];
  var stalls = [];
  var lastStepDown = 0;
  var showStats = false;
  var theater = false;
  var pairing = null; // the QR sheet that's open, if any

  try {
    var v = parseFloat(localStorage.getItem('dt.volume'));
    if (v >= 0 && v <= 1) volume = v;
    showStats = localStorage.getItem('dt.stats') === '1';
    theater = localStorage.getItem('dt.theater') === '1';
  } catch (e) {}

  // ---------- player ----------

  var player = new DrivePlayer($('#canvasHost'), {
    onChange: function () {
      renderStage();
    },
    onEnded: function (s) {
      control.send({ type: 'ended', seq: s.seq });
    },
    onDropped: function (s, pos) {
      // Connection dropped or the stream stopped early: pick up where we were.
      var t = Date.now();
      retries = retries.filter(function (r) { return t - r < 60000; });
      retries.push(t);
      if (retries.length > 4) {
        showError("Lost the connection to your server. Check the car's internet, then tap Try again.");
        return;
      }
      setTimeout(function () {
        if (!state || !state.now || state.now.seq !== s.seq) return;
        startStream(state.now, Math.max(0, pos - 1));
      }, 1000 * retries.length);
    },
    onError: function (s, message) {
      showError(message);
      control.send({ type: 'carError', message: message });
    },
    onNotice: function (s, message) {
      // Shown here and on the phones (the server passes a car's notes round).
      control.send({ type: 'carNote', message: message });
    },
    onSlow: function (s) {
      // Decoding keeps falling behind: this screen can't handle the quality.
      if (s.codec === 'h264' && QUALITIES.indexOf(playQuality()) <= 0) {
        // Already at the lowest quality: this browser's H.264 decoder isn't
        // up to it, so use the built-in player instead.
        s.video.fail("it can't keep up even at " + s.quality + 'p');
        return;
      }
      stepDown("This screen can't keep up with " + s.quality + 'p.');
    },
    onVideoFail: function (s, info) {
      // The browser's own H.264 decoder gave up. Carry on from the same spot
      // with the built-in player; the page stays on it for a couple of hours.
      // (Another site's video is a one-off: only that video stays on it.)
      var message = s.o.elsewhere
        ? "This browser couldn't play this video as it came (" + info.reason + '). Playing it with the built-in player instead.'
        : "This browser couldn't play the H.264 video (" + info.reason + '). Switched to the built-in player.';
      control.send({ type: 'carNote', message: message }); // shown on every screen, this one included
      if (state && state.now && state.now.seq === s.seq) startStream(state.now, info.position);
    },
    onStall: function (s) {
      // Ran out of data. Three times in two minutes means the quality is too
      // much for the connection (or for the server).
      var t = Date.now();
      stalls = stalls.filter(function (x) { return t - x < 120000; });
      stalls.push(t);
      if (stalls.length < 3) return;
      var slowServer = s.stats.serverSpeed !== null && s.stats.serverSpeed < 1.1 && !s.stats.serverLimited;
      stepDown(slowServer
        ? 'Your server can\'t ' + (s.codec === 'h264' ? 'fetch ' : 'convert ') + s.quality + 'p fast enough.'
        : "The connection can't keep up with " + s.quality + 'p.');
    }
  });
  player.setVolume(volume);
  // Handy from the browser console when troubleshooting.
  DT.debug = {
    player: player,
    control: null, // filled in below, once the control channel exists
    state: function () { return state; },
    pairingLink: function () { return pairing && pairing.link; },
    feedbackLink: function () { return feedbackLink; }
  };

  // Drop one quality level for the rest of this video and say why.
  function stepDown(reason) {
    var i = QUALITIES.indexOf(playQuality());
    if (i <= 0 || Date.now() - lastStepDown < 15000) return;
    lastStepDown = Date.now();
    stalls = [];
    control.cmd('stepDown');
    control.send({ type: 'carNote', message: reason + ' Switched to ' + QUALITIES[i - 1] + 'p for this video.' });
  }

  function playQuality() {
    return (state && (state.playQuality || state.settings.quality)) || '480';
  }

  function startStream(now, startAt) {
    errorMsg = null;
    loadedSeq = now.seq;
    loadedId = now.id;
    loadedFormat = state.settings.format;
    jumps = [];
    player.load({
      id: now.id,
      seq: now.seq,
      startAt: startAt,
      quality: playQuality(),
      format: state.settings.format,
      elsewhere: !!now.url, // not YouTube's: a link to another site
      paused: state.paused
    });
    renderStage();
  }

  // ---------- skipping within what has loaded ----------
  // The player keeps what it has received: the stretch ahead that the seek
  // bar shows as loaded, and the last half minute played. A skip to a spot
  // in there happens on this page at once; only a skip to somewhere else
  // has the server start a new stream.

  // Go to `to` (seconds) now if it's on hand, then tell the server either way.
  function skipTo(to) {
    var d = duration();
    to = Math.max(0, d ? Math.min(d - 1, to) : to);
    var s = player.active;
    if (s && state && state.now && s.seq === state.now.seq && !errorMsg && s.jumpTo(to)) {
      jumps.push({ to: to, at: Date.now() });
    }
    control.cmd('seek', { to: to });
  }

  // The server says this video is now at another spot. True if the stream
  // that is open can simply go there (or already has).
  function skippedWithin(now) {
    var s = player.active;
    if (!s || s.state === 'done' || errorMsg || loadedId !== now.id) return false;
    if (s.quality !== playQuality() || loadedFormat !== state.settings.format) return false;
    var to = now.startAt || 0;
    var t = Date.now();
    jumps = jumps.filter(function (j) { return t - j.at < 5000; });
    // Our own skip coming back from the server (which rounds to whole seconds): already there.
    if (jumps.some(function (j) { return Math.abs(j.to - to) < 1.5; })) return true;
    return s.jumpTo(to);
  }

  function showError(message) {
    errorMsg = message;
    player.stop();
    renderStage();
  }

  function syncPlayback() {
    var now = state && state.now;
    if (!now) {
      if (loadedSeq !== null || player.active) player.stop();
      loadedSeq = null;
      errorMsg = null;
      renderStage();
      return;
    }
    if (!activated) {
      renderStage();
      return;
    }
    if (now.seq !== loadedSeq) {
      retries = [];
      if (skippedWithin(now)) {
        // The same video at another spot, and that spot was already on hand:
        // the stream carries on, only the place in it changed.
        loadedSeq = now.seq;
        player.active.seq = now.seq;
      } else {
        // Picks up from the last reported spot (e.g. after reloading the page).
        var p = state.position;
        var startAt = p && p.seq === now.seq && p.state !== 'loading' ? Math.max(0, p.t - 2) : now.startAt || 0;
        startStream(now, startAt);
      }
    }
    player.setPaused(!!state.paused);
    renderStage();
  }

  // ---------- control channel ----------

  var control = new DT.Control('car', {
    version: function (msg) {
      DT.noteVersion(msg.version);
      $('#feedbackBtn').classList.toggle('hidden', msg.feedback === false);
      // With more than one profile on the server, say whose this is.
      $('.passenger-note').textContent = 'For passengers while the car is moving.' + (msg.profile ? ' Profile: ' + msg.profile : '');
    },
    state: function (msg) {
      state = msg.state;
      // This page is older than the server (updated while it was open, or
      // brought back from the browser's saved copy): load the new one, once
      // that won't interrupt a video.
      if (DT.stale && !(state.now && !state.paused && activated) && DT.reloadIfStale()) return;
      // A pause made when this page went out of view (below) that the server
      // hasn't taken in yet, say because the connection was down: ask again,
      // and stay paused here meanwhile.
      if (pauseOwed) {
        if (!state.now || state.paused) pauseOwed = false;
        else {
          control.send({ type: 'cmd', action: 'pause' });
          state.paused = true;
        }
      }
      applyFullscreen();
      $('#quality').value = playQuality();
      renderLists();
      syncPlayback();
    },
    pos: function () {},
    format: function (msg) {
      // Someone chose H.264 on the phone: try it now, even if it failed earlier.
      if (msg.v === 'auto') DrivePlayer.retryH264();
    },
    toast: function (msg) {
      DT.toast(msg.message);
    },
    paired: function (msg) {
      // The phone scanned our QR code: put the code away.
      if (!pairing || pairing.code !== msg.code) return;
      pairing.sheet.close();
      pairing = null;
      DT.toast('Phone connected');
    },
    online: function (on) {
      $('#conn').classList.toggle('on', on);
    }
  });

  DT.debug.control = control;

  // Report position so the phone and resume points stay current.
  setInterval(function () {
    var s = player.active;
    if (!s || !state || !state.now || s.seq !== state.now.seq || s.state === 'done') return;
    control.send({
      type: 'pos',
      seq: s.seq,
      t: s.position(),
      state: s.state,
      duration: s.duration
    });
  }, 1000);

  // ---------- pause when the browser is put away ----------
  // Closing the browser in the car can leave this page running out of sight,
  // and the sound would carry on. So when the page stops being shown, pause,
  // just as the pause button would. It stays paused until someone presses
  // play, in the car or on a phone.
  var outOfView = false; // this time out of view has been dealt with: a play pressed on a phone after it is respected
  var pauseOwed = false; // paused here, and the server hasn't confirmed it yet

  function playingNow() {
    return !!(state && state.now && !state.paused && activated);
  }

  function wentOutOfView() {
    if (outOfView) return;
    outOfView = true;
    if (!playingNow()) return;
    pauseOwed = true;
    state.paused = true;
    player.setPaused(true); // at once, without waiting for the server
    renderStage();
    control.send({ type: 'cmd', action: 'pause' });
    control.send({ type: 'carNote', message: 'Paused: the browser in the car was closed.' });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) wentOutOfView();
    else outOfView = false;
  });
  // The page itself is being closed or left. A message on the usual channel
  // may not get out in time, so also send one the browser promises to deliver.
  window.addEventListener('pagehide', function () {
    if (playingNow() && navigator.sendBeacon) navigator.sendBeacon('/api/pause');
    wentOutOfView();
  });
  window.addEventListener('pageshow', function () {
    if (!document.hidden) outOfView = false;
  });

  // Any tap counts as permission to play sound.
  function activate() {
    DrivePlayer.unlockAudio();
    if (activated) return;
    activated = true;
    if (state) syncPlayback();
  }
  document.addEventListener('pointerdown', activate, true);
  document.addEventListener('keydown', activate, true);

  // ---------- stage ----------

  function setIcon(btn, name) {
    btn.innerHTML = '';
    btn.appendChild(DT.icon(name));
  }
  setIcon($('#back10'), 'back10');
  setIcon($('#fwd10'), 'fwd10');
  setIcon($('#nextBtn'), 'next');

  function renderStage() {
    var now = state && state.now;
    var s = player.active;
    var msg = $('#stageMsg');
    msg.innerHTML = '';
    $('#tapStart').classList.add('hidden');
    $('#pausedTag').classList.add('hidden');

    if (!now) {
      msg.appendChild(el('div', {}, [
        el('div', { class: 'big', text: 'Nothing playing' }),
        el('div', { text: 'Search for a video, or send one from your phone.' })
      ]));
      $('#nowTitle').textContent = '';
      $('#nowSub').textContent = '';
      wasPaused = null;
      showOverlay(false);
      return;
    }

    $('#nowTitle').textContent = now.title;
    $('#fsTitle').textContent = now.title;
    $('#nowSub').textContent = [now.channel, now.site, now.live ? 'Live' : null].filter(Boolean).join(' · ');

    if (errorMsg) {
      var box = el('div', {}, [
        el('div', { class: 'big', text: "Couldn't play this" }),
        el('div', { text: errorMsg }),
        el('div', { class: 'btn-row', style: 'justify-content:center;pointer-events:auto' }, [
          el('button', { class: 'primary', text: 'Try again', onclick: function () {
            retries = [];
            startStream(now, DT.positionOf(state));
          } }),
          el('button', { text: 'Skip', onclick: function () { control.cmd('next'); } })
        ])
      ]);
      msg.appendChild(box);
      return;
    }

    if (!activated) {
      $('#tapStartBtn').textContent = 'Tap to play';
      $('#tapStart').classList.remove('hidden');
      return;
    }

    if (s && (s.state === 'buffering' || s.frames === 0) && !state.paused) {
      // "Buffering" only once it has lasted a moment: a skip within what is loaded takes a fraction of a second.
      msg.appendChild(el('div', { class: s.frames ? 'after-a-moment' : '' }, [el('div', { class: 'spinner' }), el('div', { style: 'margin-top:12px', text: s.frames ? 'Buffering…' : 'Loading…' })]));
    }
    setIcon($('#playPause'), state.paused ? 'play' : 'pause');
    // Pausing (from the car or the phone) shows the controls for a moment.
    // After that a small "Paused" tag explains the still picture.
    if (state.paused && wasPaused !== true) showOverlay(true);
    wasPaused = !!state.paused;
    $('#pausedTag').classList.toggle('hidden', !state.paused);
  }

  // "Tap to play" means play: also when the video is waiting paused, as it is
  // after the browser was closed or the server restarted. (A tap anywhere
  // else only allows sound, and leaves a paused video paused.)
  function tapToPlay() {
    activate();
    if (state && state.now && state.paused) control.send({ type: 'cmd', action: 'resume' });
  }
  // On the press itself: the button is gone by the time a click would arrive.
  $('#tapStartBtn').addEventListener('pointerdown', tapToPlay);
  $('#tapStartBtn').addEventListener('click', tapToPlay);

  // The controls go away by themselves once nobody has touched them for a
  // few seconds, playing or paused. Every touch starts the wait over.
  function showOverlay(show) {
    var o = $('#overlay');
    clearTimeout(overlayTimer);
    o.classList.toggle('show', !!show);
    if (show) {
      overlayTimer = setTimeout(function () {
        o.classList.remove('show');
      }, OVERLAY_MS);
    }
  }

  $('#stage').addEventListener('click', function (ev) {
    if (!state || !state.now || !activated || errorMsg) return;
    if (ev.target.closest('button, .scrub, .tap-start')) return;
    var o = $('#overlay');
    showOverlay(!o.classList.contains('show'));
  });

  function bump() {
    showOverlay(true);
  }
  $('#playPause').addEventListener('click', function (e) {
    e.stopPropagation();
    control.cmd('toggle');
    bump();
  });
  $('#back10').addEventListener('click', function (e) {
    e.stopPropagation();
    skipTo(currentTime() - 10);
    bump();
  });
  $('#fwd10').addEventListener('click', function (e) {
    e.stopPropagation();
    skipTo(currentTime() + 10);
    bump();
  });
  $('#nextBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    control.cmd('next');
    bump();
  });

  function currentTime() {
    var s = player.active;
    if (s && state && state.now && s.seq === state.now.seq && s.state !== 'done') return s.position();
    return DT.positionOf(state);
  }

  function duration() {
    if (!state || !state.now) return 0;
    var s = player.active;
    return state.now.duration || (s && s.duration) || 0;
  }

  // Scrubber: tap or drag to seek.
  (function () {
    var scrub = $('#scrub');
    var dragging = false;
    var preview = null;
    function frac(ev) {
      var r = scrub.getBoundingClientRect();
      return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    }
    scrub.addEventListener('pointerdown', function (ev) {
      if (!duration() || state.now.live) return;
      ev.stopPropagation();
      dragging = true;
      scrub.setPointerCapture(ev.pointerId);
      preview = frac(ev) * duration();
      clearTimeout(overlayTimer);
      paintTime();
    });
    scrub.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      preview = frac(ev) * duration();
      paintTime();
    });
    scrub.addEventListener('pointerup', function (ev) {
      if (!dragging) return;
      dragging = false;
      var to = frac(ev) * duration();
      preview = null;
      skipTo(to);
      bump();
    });
    scrub.addEventListener('pointercancel', function () {
      if (!dragging) return;
      dragging = false;
      preview = null;
      bump();
    });
    scrub.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });
    window.paintTime = function () {
      var d = duration();
      var live = state && state.now && state.now.live;
      var t = preview !== null ? preview : currentTime();
      $('#tCur').textContent = live ? '' : DT.fmt(t);
      $('#tDur').innerHTML = '';
      if (live) $('#tDur').appendChild(el('span', { class: 'live-badge', text: 'LIVE' }));
      else $('#tDur').textContent = d ? DT.fmt(d) : '–:––';
      var pct = d ? Math.min(100, (t / d) * 100) : 0;
      $('#scrubFill').style.width = pct + '%';
      $('#scrubKnob').style.left = pct + '%';
      var s = player.active;
      var buf = s && d ? Math.min(100, ((t + s.buffered()) / d) * 100) : pct;
      $('#scrubBuf').style.width = buf + '%';
      // The played part that is still on hand (a skip back into it happens at
      // once) is drawn at full strength; what has been let go is dimmer.
      var held = s && s.onHand ? s.onHand() : null;
      var gone = held && t > 0 && preview === null ? Math.max(0, Math.min(100, (held.from / t) * 100)) : 0;
      $('#scrubFill').style.background = gone > 0.5
        ? 'linear-gradient(to right, var(--accent-gone) 0, var(--accent-gone) ' + gone + '%, var(--rig-accent) ' + gone + '%)'
        : '';
      scrub.style.visibility = live ? 'hidden' : 'visible';
    };
  })();
  setInterval(paintTime, 250);

  // ---------- top bar ----------

  $('#quality').addEventListener('change', function () {
    control.cmd('quality', { q: this.value });
  });

  // ---------- stats readout ----------

  var chromeVersion = (navigator.userAgent.match(/Chrom(?:e|ium)\/(\d+)/) || [])[1];
  // Which kinds of video this browser can decode by itself (shown in Stats).
  var decoders = { 'H.264': 'avc1.640028', VP9: 'vp09.00.40.08', AV1: 'av01.0.08M.08' };
  var canDecode = {};
  if ('VideoDecoder' in window) {
    Object.keys(decoders).forEach(function (name) {
      try {
        VideoDecoder.isConfigSupported({ codec: decoders[name], codedWidth: 1920, codedHeight: 1080 }).then(
          function (r) { canDecode[name] = !!(r && r.supported); },
          function () { canDecode[name] = false; }
        );
      } catch (e) {
        canDecode[name] = false;
      }
    });
  }
  function browserLine() {
    var line = chromeVersion ? 'Chrome ' + chromeVersion : 'Unknown browser';
    if (!('VideoDecoder' in window)) return line + ' · no WebCodecs' + (window.isSecureContext ? '' : ' (needs https)');
    return line + ' · decodes ' + Object.keys(decoders).map(function (name) {
      return name + ' ' + (canDecode[name] === undefined ? '…' : canDecode[name] ? 'yes' : 'no');
    }).join(', ');
  }

  // Which format is playing, and why it isn't H.264 when it isn't.
  function formatLine(s, i) {
    if (!i.codec) return 'waiting';
    // Whose video it is as it stands: YouTube's, or the site a pasted link led to.
    if (i.codec === 'h264') return 'H.264 · ' + (state && state.now && state.now.site ? state.now.site : 'YouTube') + "'s own video, decoded by this browser";
    var line = 'MPEG-1 · converted by your server';
    var h = DrivePlayer.h264();
    if (state && state.settings.format === 'mpeg1') return line + ' (H.264 is switched off on the phone remote)';
    if (i.asked === 'h264') return line + (s.live ? ' (live videos are always converted)' : s.why ? ' (' + s.why + ')' : ' (no H.264 version of this video)');
    if (state && state.now && DrivePlayer.gaveUpOn(state.now.id)) return line + " (this browser couldn't decode this one as it came: " + DrivePlayer.gaveUpOn(state.now.id) + ')';
    if (h.supported === false) return line + " (this browser can't decode H.264)";
    if (h.failedAt && !h.usable) {
      var at = new Date(h.retryAt);
      return line + ' (H.264 failed here: ' + h.reason + '. Trying again after ' +
        at.getHours() + ':' + ('0' + at.getMinutes()).slice(-2) + ')';
    }
    return line;
  }

  function decodingLine(i) {
    if (!i.frames) return 'waiting';
    if (i.codec === 'h264') return "by the browser's own decoder · " + i.ready + ' frames ready · skipped ' + i.dropped;
    var frameMs = 1000 / (i.fps || 30);
    return i.decodeMs.toFixed(1) + ' ms a frame (' + Math.round((i.decodeMs / frameMs) * 100) + '% of the time available) · peak ' + Math.round(i.decodeMax) + ' ms';
  }

  function statsRows(s) {
    var i = s.info();
    return [
      ['Picture',
        (i.width ? i.width + '×' + i.height : s.quality + 'p') +
        (i.fps ? ' · ' + Math.round(i.fps * 100) / 100 + ' fps' : '') +
        (i.kbps ? ' · ' + (i.kbps / 1000).toFixed(1) + ' Mbps' : '')],
      ['Format', formatLine(s, i)],
      ['Decoding', decodingLine(i)],
      ['Buffer', i.buffer.toFixed(1) + ' s ahead · ran dry ' + i.stalls + '× · fell behind ' + i.holds + '×'],
      ['Sound', i.audio + ' · realigned ' + i.resyncs + '×'],
      ['Server', i.serverSpeed
        ? (i.codec === 'h264' ? 'fetching at ' : 'converting at ') + i.serverSpeed + '× real time' + (i.serverLimited ? ' (held back by the connection)' : '')
        : 'measuring…'],
      ['Browser', browserLine()]
    ];
  }

  function renderStats() {
    var box = $('#stats');
    var s = player.active;
    var on = showStats && !!s;
    box.classList.toggle('hidden', !on);
    pressed($('#statsBtn'), showStats);
    if (!on) return;
    box.innerHTML = '';
    statsRows(s).forEach(function (r) {
      box.appendChild(el('div', { class: 'stats-k', text: r[0] }));
      box.appendChild(el('div', { class: 'stats-v', text: r[1] }));
    });
  }
  setInterval(renderStats, 500);

  $('#statsBtn').addEventListener('click', function () {
    showStats = !showStats;
    try { localStorage.setItem('dt.stats', showStats ? '1' : '0'); } catch (e) {}
    renderStats();
  });

  // A toggle that's on looks pressed (and says so to screen readers).
  function pressed(btn, on) {
    btn.classList.toggle('on', !!on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // ---------- theater ----------
  // The Theater button shows or hides the lists (Up Next, Search, Recent).
  // Blue means they're showing; off leaves just the video. `theater` is true
  // while they're hidden.

  function applyTheater() {
    document.body.classList.toggle('theater', theater);
    pressed($('#theaterBtn'), !theater);
  }
  applyTheater();
  $('#theaterBtn').addEventListener('click', function () {
    theater = !theater;
    try { localStorage.setItem('dt.theater', theater ? '1' : '0'); } catch (e) {}
    applyTheater();
  });

  // ---------- fullscreen ----------
  // The setting lives on the server, so the phone can flip it too and it
  // survives a reload. It only takes effect while something is playing.

  function isFullscreen() {
    return !!(state && state.settings && state.settings.fullscreen);
  }

  function applyFullscreen() {
    var on = isFullscreen();
    document.body.classList.toggle('fullscreen', on);
    document.body.classList.toggle('has-now', !!(state && state.now));
    setIcon($('#fsToggle'), on ? 'compress' : 'expand');
    $('#fsToggle').setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
    // Fill zooms the picture to cover the window (edges are cropped); Fit
    // shows all of it with black bars.
    var fill = !!(state && state.settings && state.settings.fill);
    document.body.classList.toggle('fill', fill);
    $('#fillToggle').textContent = fill ? 'Fit' : 'Fill';
  }

  // Where the browser allows it, also hide the browser's own bars. Tesla only
  // allows that in Park, so this is a bonus, not something we rely on.
  function browserFullscreen(on) {
    try {
      var root = document.documentElement;
      var active = document.fullscreenElement || document.webkitFullscreenElement;
      if (on && !active) {
        var enter = root.requestFullscreen || root.webkitRequestFullscreen;
        var p = enter && enter.call(root);
        if (p && p.catch) p.catch(function () {});
      } else if (!on && active) {
        var leave = document.exitFullscreen || document.webkitExitFullscreen;
        var q = leave && leave.call(document);
        if (q && q.catch) q.catch(function () {});
      }
    } catch (e) {}
  }

  function setFullscreen(on) {
    if (!state) return;
    state.settings.fullscreen = on; // show it at once; the server confirms
    applyFullscreen();
    control.cmd('fullscreen', { on: on });
    browserFullscreen(on);
    if (on && state.now) showOverlay(true); // show where the exit button is
  }

  $('#fsToggle').addEventListener('click', function (e) {
    e.stopPropagation();
    setFullscreen(!isFullscreen());
  });
  $('#fillToggle').addEventListener('click', function (e) {
    e.stopPropagation();
    if (!state) return;
    state.settings.fill = !state.settings.fill;
    applyFullscreen();
    control.cmd('fill', { on: state.settings.fill });
    showOverlay(true);
  });
  document.addEventListener('keydown', function (ev) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((ev.target && ev.target.tagName) || '');
    if (ev.key === 'Escape' && isFullscreen()) setFullscreen(false);
    else if ((ev.key === 'f' || ev.key === 'F') && !typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey) setFullscreen(!isFullscreen());
  });

  // ---------- feedback ----------

  // What goes into the feedback: the same technical details Stats shows, in
  // plain characters so the QR code stays easy to scan. It ends up in a
  // public GitHub issue, so nothing about the video or this server is in it.
  function plain(text) {
    return String(text).replace(/×/g, 'x').replace(/ · /g, ', ').replace(/…/g, '...').replace(/[^\x20-\x7E]/g, '');
  }
  function feedbackDetails() {
    var s = player.active;
    var h = DrivePlayer.h264();
    var lines = ['Browser: ' + browserLine().replace('decodes ', ''), 'Window: ' + window.innerWidth + 'x' + window.innerHeight];
    if (state) {
      lines.push('Quality: ' + state.settings.quality + 'p' + (playQuality() !== state.settings.quality ? ' (stepped down to ' + playQuality() + 'p)' : ''));
    }
    if (!s) {
      lines.push('Playing: nothing');
      if (state && state.settings.format === 'mpeg1') lines.push('Format: MPEG-1 (chosen on the phone)');
      else if (h.failedAt && !h.usable) lines.push('Format: MPEG-1 (H.264 failed: ' + h.reason + ')');
      return lines.map(plain).join('\n');
    }
    var i = s.info();
    var format = 'waiting';
    if (i.codec === 'h264') format = 'H.264';
    else if (i.codec) {
      format = 'MPEG-1';
      if (state && state.settings.format === 'mpeg1') format += ' (chosen on the phone)';
      else if (i.asked === 'h264') format += s.live ? ' (live video)' : ' (no H.264 version)';
      else if (h.supported === false) format += " (browser can't decode H.264)";
      else if (h.failedAt && !h.usable) format += ' (H.264 failed: ' + h.reason + ')';
    }
    lines.push('Format: ' + format);
    lines.push('Picture: ' + (i.width ? i.width + 'x' + i.height : 'none yet') +
      (i.fps ? ' ' + Math.round(i.fps * 100) / 100 + 'fps' : '') + (i.kbps ? ' ' + (i.kbps / 1000).toFixed(1) + 'Mbps' : ''));
    if (i.frames) {
      lines.push('Decoding: ' + (i.codec === 'h264'
        ? i.ready + ' ready, ' + i.dropped + ' skipped'
        : i.decodeMs.toFixed(1) + 'ms a frame, peak ' + Math.round(i.decodeMax) + 'ms'));
    }
    lines.push('Buffer: ' + i.buffer.toFixed(1) + 's, ran dry ' + i.stalls + ', fell behind ' + i.holds);
    lines.push('Sound: ' + i.audio.replace(' Hz', 'Hz') + ', realigned ' + i.resyncs + ', skipped ' + i.audioSkipped);
    lines.push('Server: ' + (i.serverSpeed ? i.serverSpeed + 'x real time' + (i.serverLimited ? ', held back by the connection' : '') : 'measuring'));
    lines.push('State: ' + i.state + (s.live ? ', live' : ''));
    return lines.map(plain).join('\n');
  }

  var feedbackLink = null;
  $('#feedbackBtn').addEventListener('click', function () {
    var details = feedbackDetails();
    var qr = el('div', { class: 'qr' }, [el('div', { class: 'spinner', style: 'margin-top:120px;border-color:#ddd;border-top-color:#333' })]);
    openSheet('Send feedback', [
      el('div', { class: 'feedback' }, [
        qr,
        el('div', { class: 'feedback-text' }, [
          el('div', { text: 'Scan this with your phone camera. It opens a new issue on the DrivePost GitHub page, ready for you to say what happened.' }),
          el('div', { class: 'muted', text: 'These details from the car are filled in for you. Nothing about what you watch or your server is included.' }),
          el('div', { class: 'details', text: details })
        ])
      ])
    ], true, true);
    feedbackLink = null;
    DT.api('/api/feedback', { body: { details: details } }).then(function (r) {
      showQr(qr, r.svg);
      feedbackLink = r.link;
    }).catch(function (e) {
      qr.textContent = e.message;
    });
  });

  // Put a QR code in its box with every square a whole number of pixels
  // wide, so the edges are sharp and cameras read it easily.
  function showQr(box, svgText) {
    box.innerHTML = svgText;
    var svg = box.querySelector('svg');
    if (!svg || !svg.viewBox || !svg.viewBox.baseVal.width) return;
    var squares = svg.viewBox.baseVal.width;
    var room = Math.min(box.clientWidth, box.clientHeight) - 24;
    // Whole pixels of the screen itself, which on sharp screens is finer than a CSS pixel.
    var dpr = window.devicePixelRatio || 1;
    var px = Math.floor((room * dpr) / squares) / dpr;
    if (px < 1) return; // too small to snap: leave it stretched to fit
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.style.width = svg.style.height = px * squares + 'px';
  }

  $('#phoneBtn').addEventListener('click', function () {
    var qr = el('div', { class: 'qr' }, [el('div', { class: 'spinner', style: 'margin-top:90px;border-color:#ddd;border-top-color:#333' })]);
    var sheet = openSheet('Connect your phone', [
      qr,
      el('div', { class: 'muted', style: 'text-align:center', text: 'Scan with your phone camera. The code works once and expires in 10 minutes.' })
    ], true);
    pairing = null;
    DT.api('/api/pair').then(function (r) {
      showQr(qr, r.svg);
      pairing = { code: r.link.split('/p/')[1], link: r.link, sheet: sheet };
    }).catch(function (e) {
      qr.textContent = e.message;
    });
    return sheet;
  });

  // ---------- search ----------

  function recentTitles() {
    return state ? state.history.map(function (h) { return h.title; }) : [];
  }
  function searchedBefore() {
    return state ? state.searches || [] : [];
  }
  DT.autocomplete($('#q'), { local: recentTitles, recent: searchedBefore, onPick: runSearch });

  // Emptying the box puts the earlier searches back in place of the results.
  $('#q').addEventListener('input', function () {
    if (!$('#q').value.trim() && searchResults && !searching) {
      searchResults = null;
      renderLists();
    }
  });

  $('#searchForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    runSearch();
  });

  // In the one-column layout (the car's browser) the lists sit below the video.
  function oneColumn() {
    return window.matchMedia('(max-width: 900px)').matches;
  }
  function scrollToLists() {
    if (!oneColumn()) return;
    try { $('.side').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { $('.side').scrollIntoView(true); }
  }
  function scrollToVideo() {
    if (!oneColumn()) return;
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
  }

  function runSearch() {
    var q = $('#q').value.trim();
    if (!q) return;
    $('#q').blur();
    // The results are one of the lists: show them if they're hidden.
    if (theater) {
      theater = false;
      try { localStorage.setItem('dt.theater', '0'); } catch (e) {}
      applyTheater();
    }
    setTab('search');
    scrollToLists();
    searching = true;
    searchResults = null;
    renderLists();
    // A link to anywhere is looked up rather than searched for.
    var looksLikeLink = /^(https?:\/\/|www\.)|youtu\.?be|youtube\.com/i.test(q);
    var req = looksLikeLink
      ? DT.api('/api/resolve', { body: { text: q } }).then(function (r) { return [r.item]; })
      : DT.api('/api/search?q=' + encodeURIComponent(q)).then(function (r) { return r.results; });
    req.then(function (results) {
      searchResults = results;
    }).catch(function (e) {
      searchResults = [];
      DT.toast(e.message);
    }).then(function () {
      searching = false;
      renderLists();
    });
  }

  // ---------- lists ----------

  function setTab(name) {
    tab = name;
    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === name);
    });
    ['queue', 'foryou', 'search', 'recent'].forEach(function (n) {
      $('#panel-' + n).classList.toggle('hidden', n !== name);
    });
    if (name === 'foryou') loadRecs();
  }

  // ---------- recommendations ----------
  // Videos like the ones this profile has been watching. Fetched when the
  // list is opened, and again when what they are based on has changed.

  var recs = { items: null, basis: null, loading: false, failed: false };
  function recsBasis() {
    return (state.now ? state.now.id : '') + '|' + (state.history[0] ? state.history[0].id : '');
  }
  function loadRecs(again) {
    if (!state || recs.loading) return;
    var basis = recsBasis();
    if (!again && recs.items && recs.basis === basis) return;
    recs.loading = true;
    recs.basis = basis;
    renderLists();
    DT.api('/api/recommended').then(function (r) {
      recs.items = r.items || [];
      recs.failed = !!r.failed;
    }).catch(function () {
      recs.items = recs.items || [];
      recs.failed = true;
    }).then(function () {
      recs.loading = false;
      renderLists();
    });
  }
  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
  });

  function openSheet(title, children, center, wide) {
    var scrim = el('div', { class: 'scrim' + (center ? ' center' : '') });
    var sheet = el('div', { class: 'sheet' + (wide ? ' wide' : '') }, [el('div', { class: 'sheet-title', text: title })].concat(children || []));
    sheet.appendChild(el('button', { class: 'ghost', text: 'Close', onclick: close }));
    scrim.appendChild(sheet);
    scrim.addEventListener('click', function (ev) { if (ev.target === scrim) close(); });
    document.body.appendChild(scrim);
    function close() { scrim.remove(); }
    return { close: close };
  }

  function itemSheet(item, extra) {
    var sheet;
    function act(label, fn, primary) {
      return el('button', { class: primary ? 'primary' : '', text: label, onclick: function () { fn(); sheet.close(); } });
    }
    var progress = state && state.progress[item.id];
    var buttons = [];
    if (extra) buttons = buttons.concat(extra(act));
    else {
      buttons.push(act(progress ? 'Resume from ' + DT.fmt(progress) : 'Play now', function () { control.cmd('play', { item: item }); scrollToVideo(); }, true));
      if (progress) buttons.push(act('Play from start', function () { control.cmd('play', { item: item, fromStart: true }); scrollToVideo(); }));
      buttons.push(act('Play next', function () { control.cmd('playNext', { item: item }); DT.toast('Playing next'); }));
      buttons.push(act('Add to Up Next', function () { control.cmd('enqueue', { item: item }); DT.toast('Added to Up Next'); }));
    }
    sheet = openSheet(item.title, buttons);
  }

  function renderLists() {
    if (!state) return;
    var progress = state.progress || {};

    // Up Next
    var q = $('#panel-queue');
    q.innerHTML = '';
    $('#qCount').textContent = state.queue.length ? String(state.queue.length) : '';
    if (!state.queue.length) {
      q.appendChild(el('div', { class: 'empty' }, [
        el('div', { text: 'Up Next is empty. Videos you add from search or your phone line up here.' }),
        state.history.length || state.now
          ? el('button', { class: 'see-foryou', text: 'See videos for you', onclick: function () { setTab('foryou'); } })
          : null
      ]));
    } else {
      q.appendChild(el('div', { class: 'panel-head' }, [
        el('span', { text: state.queue.length + (state.queue.length === 1 ? ' video' : ' videos') }),
        el('button', { class: 'ghost', text: 'Clear', onclick: function () { control.cmd('clearQueue'); } })
      ]));
      state.queue.forEach(function (item, i) {
        q.appendChild(DT.itemRow(item, {
          progress: progress[item.id],
          onclick: function () {
            itemSheet(item, function (act) {
              return [
                act('Play now', function () { control.cmd('playFromQueue', { key: item.key }); scrollToVideo(); }, true),
                act('Remove', function () { control.cmd('remove', { key: item.key }); })
              ];
            });
          },
          actions: [
            DT.iconButton('up', 'Move up', function () { control.cmd('move', { key: item.key, dir: -1 }); }, i === 0 ? 'hidden' : ''),
            DT.iconButton('x', 'Remove', function () { control.cmd('remove', { key: item.key }); })
          ]
        }));
      });
    }

    // For You
    var f = $('#panel-foryou');
    f.innerHTML = '';
    f.appendChild(el('div', { class: 'panel-head' }, [
      el('span', { text: "Like what you've been watching" }),
      el('button', { class: 'ghost', text: recs.loading ? 'Loading…' : 'Refresh', onclick: function () { loadRecs(true); } })
    ]));
    if (!recs.items) {
      f.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'spinner' })]));
    } else if (!recs.items.length) {
      f.appendChild(el('div', { class: 'empty', text: recs.failed
        ? "Couldn't get recommendations just now. Tap Refresh to try again."
        : 'Play a YouTube video or two and videos like them show up here.' }));
    } else {
      recs.items.forEach(function (item) {
        // Not what is playing or already lined up, even if the list was fetched before that.
        if ((state.now && state.now.id === item.id) || state.queue.some(function (x) { return x.id === item.id; })) return;
        f.appendChild(DT.itemRow(item, {
          progress: progress[item.id],
          onclick: function () { itemSheet(item); }
        }));
      });
    }
    if (tab === 'foryou') loadRecs();

    // Search
    var s = $('#panel-search');
    s.innerHTML = '';
    var before = searchedBefore();
    if (searching) s.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'spinner' })]));
    else if (!searchResults && before.length) {
      s.appendChild(el('div', { class: 'panel-head' }, [
        el('span', { text: 'Recent searches' }),
        el('button', { class: 'ghost', text: 'Clear', onclick: function () { control.cmd('clearSearches'); } })
      ]));
      DT.searchRows(before, {
        onPick: function (text) { $('#q').value = text; runSearch(); },
        onForget: function (text) { control.cmd('forgetSearch', { q: text }); }
      }).forEach(function (row) { s.appendChild(row); });
    }
    else if (!searchResults) s.appendChild(el('div', { class: 'empty', text: 'Type in the search box at the top.' }));
    else if (!searchResults.length) s.appendChild(el('div', { class: 'empty', text: 'No results.' }));
    else searchResults.forEach(function (item) {
      s.appendChild(DT.itemRow(item, {
        progress: progress[item.id],
        active: state.now && state.now.id === item.id,
        onclick: function () { itemSheet(item); }
      }));
    });

    // Recent
    var r = $('#panel-recent');
    r.innerHTML = '';
    r.appendChild(el('div', { class: 'panel-head' }, [
      el('span', { text: 'Recently played' }),
      el('button', { class: 'ghost', text: 'Play test pattern', onclick: function () {
        DT.api('/api/setup').then(function (cfg) { control.cmd('play', { item: cfg.testItem }); });
      } })
    ]));
    if (!state.history.length) r.appendChild(el('div', { class: 'empty', text: "Videos you've played show up here." }));
    else {
      state.history.forEach(function (item) {
        r.appendChild(DT.itemRow(item, {
          progress: progress[item.id],
          active: state.now && state.now.id === item.id,
          onclick: function () { itemSheet(item); }
        }));
      });
    }
  }
})();
