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

  try {
    var v = parseFloat(localStorage.getItem('dt.volume'));
    if (v >= 0 && v <= 1) volume = v;
    if (localStorage.getItem('dt.theater') === '1') document.body.classList.add('theater');
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
    }
  });
  player.setVolume(volume);
  // Handy from the browser console when troubleshooting.
  DT.debug = { player: player, state: function () { return state; } };

  function startStream(now, startAt) {
    errorMsg = null;
    loadedSeq = now.seq;
    player.load({
      id: now.id,
      seq: now.seq,
      startAt: startAt,
      quality: state.settings.quality,
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
      $('#quality').value = state.settings.quality;
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

  $('#theaterBtn').addEventListener('click', function () {
    var on = document.body.classList.toggle('theater');
    try { localStorage.setItem('dt.theater', on ? '1' : '0'); } catch (e) {}
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
