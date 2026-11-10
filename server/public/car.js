(function () {
  'use strict';
  var $ = DT.$;
  var el = DT.el;

  var state = null; // latest state from the server
  var activated = false; // the passenger has tapped the page (needed for sound)
  var loadedSeq = null;
  var retries = [];
  var errorMsg = null;
  var searchResults = null;
  var searching = false;
  var tab = 'queue';
  var overlayTimer = null;
  var volume = 1;
  var QUALITIES = ['360', '480', '720', '1080'];
  var stalls = [];
  var lastStepDown = 0;
  var showStats = false;

  try {
    var v = parseFloat(localStorage.getItem('dt.volume'));
    if (v >= 0 && v <= 1) volume = v;
    showStats = localStorage.getItem('dt.stats') === '1';
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
    onSlow: function (s) {
      // Decoding keeps falling behind: this screen can't handle the quality.
      stepDown("This screen can't keep up with " + s.quality + 'p.');
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
        ? "Your server can't convert " + s.quality + 'p fast enough.'
        : "The connection can't keep up with " + s.quality + 'p.');
    }
  });
  player.setVolume(volume);
  // Handy from the browser console when troubleshooting.
  DT.debug = { player: player, state: function () { return state; } };

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
    player.load({
      id: now.id,
      seq: now.seq,
      startAt: startAt,
      quality: playQuality(),
      paused: state.paused
    });
    renderStage();
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
      // Picks up from the last reported spot (e.g. after reloading the page).
      var p = state.position;
      var startAt = p && p.seq === now.seq && p.state !== 'loading' ? Math.max(0, p.t - 2) : now.startAt || 0;
      startStream(now, startAt);
    }
    player.setPaused(!!state.paused);
    renderStage();
  }

  // ---------- control channel ----------

  var control = new DT.Control('car', {
    state: function (msg) {
      state = msg.state;
      applyFullscreen();
      $('#quality').value = playQuality();
      renderLists();
      syncPlayback();
    },
    pos: function () {},
    toast: function (msg) {
      DT.toast(msg.message);
    },
    online: function (on) {
      $('#conn').classList.toggle('on', on);
    }
  });

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

    if (!now) {
      msg.appendChild(el('div', {}, [
        el('div', { class: 'big', text: 'Nothing playing' }),
        el('div', { text: 'Search for a video, or send one from your phone.' })
      ]));
      $('#nowTitle').textContent = '';
      $('#nowSub').textContent = '';
      showOverlay(false);
      return;
    }

    $('#nowTitle').textContent = now.title;
    $('#fsTitle').textContent = now.title;
    $('#nowSub').textContent = [now.channel, now.live ? 'Live' : null].filter(Boolean).join(' · ');

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
      msg.appendChild(el('div', {}, [el('div', { class: 'spinner' }), el('div', { style: 'margin-top:12px', text: s.frames ? 'Buffering…' : 'Loading…' })]));
    }
    setIcon($('#playPause'), state.paused ? 'play' : 'pause');
    if (state.paused) showOverlay(true, true);
  }

  $('#tapStartBtn').addEventListener('click', function () {
    activate();
  });

  function showOverlay(show, sticky) {
    var o = $('#overlay');
    clearTimeout(overlayTimer);
    o.classList.toggle('show', !!show);
    if (show && !sticky) {
      overlayTimer = setTimeout(function () {
        if (state && !state.paused) o.classList.remove('show');
      }, 4000);
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
    control.cmd('skip', { by: -10 });
    bump();
  });
  $('#fwd10').addEventListener('click', function (e) {
    e.stopPropagation();
    control.cmd('skip', { by: 10 });
    bump();
  });
  $('#nextBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    control.cmd('next');
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
      control.cmd('seek', { to: to });
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
  var browserLine =
    (chromeVersion ? 'Chrome ' + chromeVersion : 'Unknown browser') +
    ' · WebCodecs ' + ('VideoDecoder' in window ? 'yes' : 'no');

  function renderStats() {
    var box = $('#stats');
    var s = player.active;
    var on = showStats && !!s;
    box.classList.toggle('hidden', !on);
    $('#statsBtn').classList.toggle('on', showStats);
    if (!on) return;
    var i = s.info();
    var frameMs = 1000 / (i.fps || 30);
    var rows = [
      ['Picture',
        (i.width ? i.width + '×' + i.height : s.quality + 'p') +
        (i.fps ? ' · ' + Math.round(i.fps * 100) / 100 + ' fps' : '') +
        (i.kbps ? ' · ' + (i.kbps / 1000).toFixed(1) + ' Mbps' : '')],
      ['Decoding', i.frames
        ? i.decodeMs.toFixed(1) + ' ms a frame (' + Math.round((i.decodeMs / frameMs) * 100) + '% of the time available) · peak ' + Math.round(i.decodeMax) + ' ms'
        : 'waiting'],
      ['Buffer', i.buffer.toFixed(1) + ' s ahead · ran dry ' + i.stalls + '× · fell behind ' + i.holds + '×'],
      ['Sound', i.audio + ' · realigned ' + i.resyncs + '×'],
      ['Server', i.serverSpeed
        ? 'converting at ' + i.serverSpeed + '× real time' + (i.serverLimited ? ' (held back by the connection)' : '')
        : 'measuring…'],
      ['Browser', browserLine]
    ];
    box.innerHTML = '';
    rows.forEach(function (r) {
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
    $('#fullscreenBtn').classList.toggle('on', on);
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

  $('#fullscreenBtn').addEventListener('click', function () {
    setFullscreen(!isFullscreen());
  });
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

  $('#phoneBtn').addEventListener('click', function () {
    var qr = el('div', { class: 'qr' }, [el('div', { class: 'spinner', style: 'margin-top:90px;border-color:#ddd;border-top-color:#333' })]);
    var sheet = openSheet('Connect your phone', [
      qr,
      el('div', { class: 'muted', style: 'text-align:center', text: 'Scan with your phone camera. The code works once and expires in 10 minutes.' })
    ], true);
    DT.api('/api/pair').then(function (r) {
      qr.innerHTML = r.svg;
    }).catch(function (e) {
      qr.textContent = e.message;
    });
    return sheet;
  });

  // ---------- search ----------

  $('#searchForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var q = $('#q').value.trim();
    if (!q) return;
    $('#q').blur();
    setTab('search');
    searching = true;
    searchResults = null;
    renderLists();
    var looksLikeLink = /youtu\.?be|youtube\.com/i.test(q);
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
  });

  // ---------- lists ----------

  function setTab(name) {
    tab = name;
    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === name);
    });
    ['queue', 'search', 'recent'].forEach(function (n) {
      $('#panel-' + n).classList.toggle('hidden', n !== name);
    });
  }
  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
  });

  function openSheet(title, children, center) {
    var scrim = el('div', { class: 'scrim' + (center ? ' center' : '') });
    var sheet = el('div', { class: 'sheet' }, [el('div', { class: 'sheet-title', text: title })].concat(children || []));
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
      buttons.push(act(progress ? 'Resume from ' + DT.fmt(progress) : 'Play now', function () { control.cmd('play', { item: item }); }, true));
      if (progress) buttons.push(act('Play from start', function () { control.cmd('play', { item: item, fromStart: true }); }));
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
      q.appendChild(el('div', { class: 'empty', text: 'Up Next is empty. Videos you add from search or your phone line up here.' }));
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
                act('Play now', function () { control.cmd('playFromQueue', { key: item.key }); }, true),
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

    // Search
    var s = $('#panel-search');
    s.innerHTML = '';
    if (searching) s.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'spinner' })]));
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
