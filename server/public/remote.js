(function () {
  'use strict';
  var $ = DT.$;
  var el = DT.el;
  var state = null;

  // An old copy of this page (kept open, or brought back by the browser)
  // loads the new one, unless you're in the middle of typing.
  function typing() {
    var a = document.activeElement;
    return !!a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && !!a.value;
  }

  var control = new DT.Control('remote', {
    version: function (msg) {
      DT.noteVersion(msg.version);
      $('#who').textContent = msg.profile || ''; // whose profile, once there's more than one
      // A server can be set to take YouTube links only. And an iPhone asks
      // before it hands over what was copied: a small "Paste" button of its
      // own shows up where the tap was.
      var apple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      $('#sendHint').textContent = (msg.otherSites === false
        ? "Copy a YouTube video's link, then tap a button."
        : "Copy a video's link in YouTube, X, Reddit, Instagram or on a web page, then tap a button.") +
        (apple ? ' A small Paste button then pops up: tap that too.' : '');
    },
    state: function (msg) {
      if (DT.stale && !typing() && DT.reloadIfStale()) return;
      state = msg.state;
      render();
    },
    pos: function (msg) {
      if (state) state.position = msg.position;
    },
    toast: function (msg) {
      DT.toast(msg.message);
    }
  });

  // Message passed back after sharing from another app.
  var params = new URLSearchParams(location.search);
  if (params.get('msg')) {
    DT.toast(params.get('msg'));
    history.replaceState(null, '', '/remote');
  }

  // Install as an app (enables "share to" on Android).
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});

  // ---------- now playing ----------

  var controls = $('#controls');
  var playBtn = DT.iconButton('play', 'Play or pause', function () { control.cmd('toggle'); }, 'play-btn');
  [
    DT.iconButton('stop', 'Stop', function () { control.cmd('stop'); }),
    DT.iconButton('back10', 'Back 10 seconds', function () { control.cmd('skip', { by: -10 }); }),
    playBtn,
    DT.iconButton('fwd10', 'Forward 10 seconds', function () { control.cmd('skip', { by: 10 }); }),
    DT.iconButton('next', 'Next video', function () { control.cmd('next'); })
  ].forEach(function (b) { controls.appendChild(b); });

  function render() {
    if (!state) return;
    $('#carDot').classList.toggle('on', state.carOnline);
    $('#carDot').parentNode.classList.toggle('on', state.carOnline);   // the badge around it turns green too
    $('#carText').textContent = state.carOnline ? 'Car connected' : 'Car offline';

    var np = $('#np');
    np.innerHTML = '';
    if (state.now) {
      var n = state.now;
      np.appendChild(el('div', { class: 'thumb' }, [DT.thumbOf(n)]));
      np.appendChild(el('div', { style: 'min-width:0' }, [
        el('div', { class: 'np-title', text: n.title }),
        el('div', { class: 'np-sub', text: [n.channel, n.site, n.live ? 'LIVE' : null, state.paused ? 'Paused' : null].filter(Boolean).join(' · ') })
      ]));
    } else {
      np.appendChild(el('div', { class: 'muted', text: 'Nothing playing. Search below or paste a link.' }));
    }
    playBtn.innerHTML = '';
    playBtn.appendChild(DT.icon(state.now && !state.paused ? 'pause' : 'play'));
    controls.style.opacity = state.now ? '1' : '0.4';

    document.querySelectorAll('#qualitySeg button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-q') === (state.playQuality || state.settings.quality));
    });

    document.querySelectorAll('#screenSeg button').forEach(function (b) {
      b.classList.toggle('on', (b.getAttribute('data-fs') === '1') === !!state.settings.fullscreen);
    });

    document.querySelectorAll('#formatSeg button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-v') === (state.settings.format || 'auto'));
    });

    renderQueue();
    renderRecent();
    renderSearches();
    renderRecs();
    loadRecs();
    paintTime();
  }

  var preview = null;
  function paintTime() {
    if (!state || !state.now) {
      $('#rCur').textContent = '0:00';
      $('#rDur').textContent = '0:00';
      $('#rFill').style.width = '0%';
      $('#rKnob').style.left = '0%';
      return;
    }
    var d = state.now.duration || 0;
    var t = preview !== null ? preview : DT.positionOf(state);
    if (d) t = Math.min(t, d);
    $('#rCur').textContent = state.now.live ? 'LIVE' : DT.fmt(t);
    $('#rDur').textContent = d ? DT.fmt(d) : '';
    var pct = d ? (t / d) * 100 : 0;
    $('#rFill').style.width = pct + '%';
    $('#rKnob').style.left = pct + '%';
  }
  setInterval(paintTime, 500);

  (function () {
    var scrub = $('#rScrub');
    var dragging = false;
    function frac(ev) {
      var r = scrub.getBoundingClientRect();
      return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    }
    function dur() {
      return state && state.now && !state.now.live ? state.now.duration || 0 : 0;
    }
    scrub.addEventListener('pointerdown', function (ev) {
      if (!dur()) return;
      dragging = true;
      scrub.setPointerCapture(ev.pointerId);
      preview = frac(ev) * dur();
      paintTime();
    });
    scrub.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      preview = frac(ev) * dur();
      paintTime();
    });
    scrub.addEventListener('pointerup', function (ev) {
      if (!dragging) return;
      dragging = false;
      control.cmd('seek', { to: frac(ev) * dur() });
      preview = null;
    });
  })();

  // ---------- send a link ----------
  // Copy a video's link in another app, come here, and tap once: "Paste &
  // Play" takes what was copied and plays it, "Paste & Up Next" lines it up.
  // With something in the box (typed, or pasted by hand where the phone won't
  // let a page read what was copied) the same two buttons send that instead,
  // and say so: "Play" and "Up Next".

  var linkBox = $('#link');
  var sendBtn = { play: $('#playNowBtn'), queue: $('#queueBtn') };
  var asking = false; // a tap is being dealt with
  var finding = null; // which button's video the server is looking up
  $('#linkClear').appendChild(DT.icon('x'));

  function labelSend() {
    var typed = !!linkBox.value.trim();
    sendBtn.play.textContent = finding === 'play' ? 'Finding it…' : typed ? 'Play' : 'Paste & Play';
    sendBtn.queue.textContent = finding === 'queue' ? 'Finding it…' : typed ? 'Up Next' : 'Paste & Up Next';
    sendBtn.play.disabled = sendBtn.queue.disabled = !!finding;
    $('#linkClear').classList.toggle('hidden', !typed || !!finding);
  }

  // What was copied. A phone only hands it over when asked straight from a
  // tap, and an iPhone shows its own little "Paste" button first.
  function copied() {
    if (!navigator.clipboard || !navigator.clipboard.readText) return Promise.reject(new Error('no clipboard'));
    return navigator.clipboard.readText();
  }

  function send(how) {
    if (asking) return;
    asking = true;
    var typed = linkBox.value.trim();
    (typed ? Promise.resolve(typed) : copied()).then(function (text) {
      text = String(text || '').trim();
      if (!text) {
        DT.toast("Nothing is copied yet. Copy a video's link first.");
        return null;
      }
      finding = how;
      labelSend();
      // Finding out what a link is can take a few seconds for a site that isn't YouTube.
      return DT.api('/api/resolve', { body: { text: text } }).then(function (r) {
        var lined = how === 'queue' && state && state.now;
        control.cmd(how === 'play' ? 'play' : 'enqueue', { item: r.item });
        linkBox.value = '';
        DT.toast((lined ? 'Added to Up Next: ' : 'Playing: ') + r.item.title);
      }, function (e) {
        // Leave what was pasted in the box, to see what it was and to try again.
        if (!typed) linkBox.value = text.slice(0, 500);
        DT.toast(e.message);
      });
    }, function () {
      DT.toast("Couldn't read what you copied. Long-press the box and choose Paste.");
      linkBox.focus();
    }).then(function () {
      asking = false;
      finding = null;
      labelSend();
    });
  }
  sendBtn.play.addEventListener('click', function () { send('play'); });
  sendBtn.queue.addEventListener('click', function () { send('queue'); });
  linkBox.addEventListener('input', labelSend);
  $('#linkClear').addEventListener('click', function () {
    linkBox.value = '';
    labelSend();
    linkBox.focus();
  });
  $('#linkForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (linkBox.value.trim()) send('queue');
  });
  labelSend();

  // ---------- search ----------

  function addButtons(item) {
    return [
      el('button', { class: 'primary', text: 'Play', onclick: function () { control.cmd('play', { item: item }); DT.toast('Playing: ' + item.title); } }),
      el('button', { text: 'Next', onclick: function () { control.cmd('playNext', { item: item }); DT.toast('Playing next'); } }),
      el('button', { text: '+ Up Next', onclick: function () { control.cmd('enqueue', { item: item }); DT.toast('Added to Up Next'); } })
    ];
  }

  function resultRow(item) {
    var wrap = el('div', { style: 'border-bottom:1px solid var(--rig-line)' });
    var row = DT.itemRow(item, { progress: state && state.progress[item.id] });
    row.style.borderBottom = '0';
    wrap.appendChild(row);
    wrap.appendChild(el('div', { class: 'btn-row', style: 'margin:0;padding:0 12px 12px' }, addButtons(item)));
    return wrap;
  }

  DT.autocomplete($('#q'), {
    local: function () { return state ? state.history.map(function (h) { return h.title; }) : []; },
    recent: function () { return state ? state.searches || [] : []; },
    listWhenEmpty: false, // they are listed under the box already
    onPick: runSearch,
    max: 5,
    reveal: true
  });

  // Searches made before, listed under the box until there are results to show.
  function renderSearches() {
    var box = $('#searches');
    box.innerHTML = '';
    var before = (state && state.searches) || [];
    if (!before.length || $('#results').children.length) return;
    box.appendChild(el('div', { class: 'panel-head' }, [
      el('span', { text: 'Recent searches' }),
      el('button', { class: 'ghost', text: 'Clear', onclick: function () { control.cmd('clearSearches'); } })
    ]));
    DT.searchRows(before.slice(0, 8), {
      onPick: function (text) { $('#q').value = text; runSearch(); },
      onForget: function (text) { control.cmd('forgetSearch', { q: text }); }
    }).forEach(function (row) { box.appendChild(row); });
  }
  // Emptying the box puts them back in place of the results.
  $('#q').addEventListener('input', function () {
    if (!$('#q').value.trim() && $('#results').children.length) {
      $('#results').innerHTML = '';
      renderSearches();
    }
  });

  $('#searchForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    runSearch();
  });

  function runSearch() {
    var q = $('#q').value.trim();
    if (!q) return;
    $('#q').blur();
    var box = $('#results');
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'spinner' })]));
    renderSearches();
    DT.api('/api/search?q=' + encodeURIComponent(q)).then(function (r) {
      box.innerHTML = '';
      if (!r.results.length) box.appendChild(el('div', { class: 'empty', text: 'No results.' }));
      r.results.forEach(function (item) { box.appendChild(resultRow(item)); });
      renderSearches();
    }).catch(function (e) {
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'empty', text: e.message }));
    });
  }

  // ---------- recommendations ----------
  // Videos like the ones this profile has been watching. Fetched once the
  // page knows the profile's state, and again when what they are based on
  // has changed.

  var recs = { items: null, basis: null, loading: false, failed: false, all: false };
  function loadRecs(again) {
    if (!state || recs.loading) return;
    var basis = (state.now ? state.now.id : '') + '|' + (state.history[0] ? state.history[0].id : '');
    if (!again && recs.items && recs.basis === basis) return;
    recs.loading = true;
    recs.basis = basis;
    renderRecs();
    DT.api('/api/recommended').then(function (r) {
      recs.items = r.items || [];
      recs.failed = !!r.failed;
    }).catch(function () {
      recs.items = recs.items || [];
      recs.failed = true;
    }).then(function () {
      recs.loading = false;
      renderRecs();
    });
  }
  $('#recsRefresh').addEventListener('click', function () { loadRecs(true); });

  function renderRecs() {
    var box = $('#foryou');
    box.innerHTML = '';
    $('#recsRefresh').textContent = recs.loading ? 'Loading…' : 'Refresh';
    if (!recs.items) {
      box.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'spinner' })]));
      return;
    }
    // Not what is playing or already lined up, even if the list was fetched before that.
    var items = recs.items.filter(function (item) {
      return !(state.now && state.now.id === item.id) && !state.queue.some(function (x) { return x.id === item.id; });
    });
    if (!items.length) {
      box.appendChild(el('div', { class: 'empty', text: recs.failed
        ? "Couldn't get recommendations just now. Tap Refresh to try again."
        : 'Play a YouTube video or two and videos like them show up here.' }));
      return;
    }
    items.slice(0, recs.all ? items.length : 6).forEach(function (item) { box.appendChild(resultRow(item)); });
    if (!recs.all && items.length > 6) {
      box.appendChild(el('div', { class: 'btn-row', style: 'margin:0;padding:12px' }, [
        el('button', { text: 'Show ' + (items.length - 6) + ' more', onclick: function () { recs.all = true; renderRecs(); } })
      ]));
    }
  }

  // ---------- queue & recent ----------

  function renderQueue() {
    var box = $('#queue');
    box.innerHTML = '';
    $('#qCount').textContent = state.queue.length ? '(' + state.queue.length + ')' : '';
    $('#clearQ').classList.toggle('hidden', !state.queue.length);
    if (!state.queue.length) {
      box.appendChild(el('div', { class: 'empty', text: 'Nothing lined up.' }));
      return;
    }
    state.queue.forEach(function (item, i) {
      box.appendChild(DT.itemRow(item, {
        progress: state.progress[item.id],
        onclick: function () { control.cmd('playFromQueue', { key: item.key }); },
        actions: [
          DT.iconButton('up', 'Move up', function () { control.cmd('move', { key: item.key, dir: -1 }); }, i === 0 ? 'hidden' : ''),
          DT.iconButton('down', 'Move down', function () { control.cmd('move', { key: item.key, dir: 1 }); }, i === state.queue.length - 1 ? 'hidden' : ''),
          DT.iconButton('x', 'Remove', function () { control.cmd('remove', { key: item.key }); })
        ]
      }));
    });
  }
  $('#clearQ').addEventListener('click', function () { control.cmd('clearQueue'); });

  function renderRecent() {
    var box = $('#recent');
    box.innerHTML = '';
    if (!state.history.length) {
      box.appendChild(el('div', { class: 'empty', text: "Videos you've played show up here." }));
      return;
    }
    state.history.slice(0, 12).forEach(function (item) {
      box.appendChild(DT.itemRow(item, {
        progress: state.progress[item.id],
        active: state.now && state.now.id === item.id,
        onclick: function () { control.cmd('play', { item: item }); DT.toast('Playing: ' + item.title); },
        actions: [DT.iconButton('next', 'Add to Up Next', function () { control.cmd('enqueue', { item: item }); DT.toast('Added to Up Next'); })]
      }));
    });
  }

  document.querySelectorAll('#qualitySeg button').forEach(function (b) {
    b.addEventListener('click', function () { control.cmd('quality', { q: b.getAttribute('data-q') }); });
  });
  document.querySelectorAll('#screenSeg button').forEach(function (b) {
    b.addEventListener('click', function () { control.cmd('fullscreen', { on: b.getAttribute('data-fs') === '1' }); });
  });
  document.querySelectorAll('#formatSeg button').forEach(function (b) {
    b.addEventListener('click', function () { control.cmd('format', { v: b.getAttribute('data-v') }); });
  });
})();
