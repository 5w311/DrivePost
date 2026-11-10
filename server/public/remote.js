(function () {
  'use strict';
  var $ = DT.$;
  var el = DT.el;
  var state = null;

  var control = new DT.Control('remote', {
    state: function (msg) {
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
    $('#carText').textContent = state.carOnline ? 'Car connected' : 'Car offline';

    var np = $('#np');
    np.innerHTML = '';
    if (state.now) {
      var n = state.now;
      np.appendChild(el('div', { class: 'thumb' }, [n.thumb ? el('img', { src: n.thumb, alt: '' }) : el('div', { class: 'thumb-pattern' })]));
      np.appendChild(el('div', { style: 'min-width:0' }, [
        el('div', { class: 'np-title', text: n.title }),
        el('div', { class: 'np-sub', text: [n.channel, n.live ? 'LIVE' : null, state.paused ? 'Paused' : null].filter(Boolean).join(' · ') })
      ]));
    } else {
      np.appendChild(el('div', { class: 'muted', text: 'Nothing playing. Search below or paste a link.' }));
    }
    playBtn.innerHTML = '';
    playBtn.appendChild(DT.icon(state.now && !state.paused ? 'pause' : 'play'));
    controls.style.opacity = state.now ? '1' : '0.4';

    document.querySelectorAll('#qualitySeg button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-q') === state.settings.quality);
    });

    renderQueue();
    renderRecent();
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

  function resolveLink() {
    var text = $('#link').value.trim();
    if (!text) {
      DT.toast('Paste a YouTube link first');
      return Promise.reject(new Error('empty'));
    }
    return DT.api('/api/resolve', { body: { text: text } }).catch(function (e) {
      DT.toast(e.message);
      throw e;
    });
  }
  $('#playNowBtn').addEventListener('click', function () {
    resolveLink().then(function (r) {
      control.cmd('play', { item: r.item });
      $('#link').value = '';
      DT.toast('Playing: ' + r.item.title);
    }).catch(function () {});
  });
  $('#queueBtn').addEventListener('click', function () {
    resolveLink().then(function (r) {
      control.cmd('enqueue', { item: r.item });
      $('#link').value = '';
      DT.toast(state && state.now ? 'Added to Up Next' : 'Playing: ' + r.item.title);
    }).catch(function () {});
  });
  $('#linkForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    $('#queueBtn').click();
  });
  $('#pasteBtn').addEventListener('click', function () {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      DT.toast('Long-press the box and choose Paste');
      $('#link').focus();
      return;
    }
    navigator.clipboard.readText().then(function (t) {
      $('#link').value = t.trim();
    }).catch(function () {
      DT.toast('Long-press the box and choose Paste');
      $('#link').focus();
    });
  });

  // ---------- search ----------

  function addButtons(item) {
    return [
      el('button', { class: 'primary', text: 'Play', onclick: function () { control.cmd('play', { item: item }); DT.toast('Playing: ' + item.title); } }),
      el('button', { text: 'Next', onclick: function () { control.cmd('playNext', { item: item }); DT.toast('Playing next'); } }),
      el('button', { text: '+ Up Next', onclick: function () { control.cmd('enqueue', { item: item }); DT.toast('Added to Up Next'); } })
    ];
  }

  function resultRow(item) {
    var wrap = el('div', { style: 'border-bottom:1px solid var(--line)' });
    var row = DT.itemRow(item, { progress: state && state.progress[item.id] });
    row.style.borderBottom = '0';
    wrap.appendChild(row);
    wrap.appendChild(el('div', { class: 'btn-row', style: 'margin:0;padding:0 12px 12px' }, addButtons(item)));
    return wrap;
  }

  $('#searchForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var q = $('#q').value.trim();
    if (!q) return;
    $('#q').blur();
    var box = $('#results');
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'spinner' })]));
    DT.api('/api/search?q=' + encodeURIComponent(q)).then(function (r) {
      box.innerHTML = '';
      if (!r.results.length) box.appendChild(el('div', { class: 'empty', text: 'No results.' }));
      r.results.forEach(function (item) { box.appendChild(resultRow(item)); });
    }).catch(function (e) {
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'empty', text: e.message }));
    });
  });

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
})();
