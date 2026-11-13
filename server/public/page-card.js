/*
 * The Page card: steering a web page that is open in the server's own
 * browser and showing in the car.
 *
 * Some links have no video in them to send: the page has a player of its
 * own. The server then opens the page itself (webpage.js) and the car is
 * shown the page. This card is how a phone works it: a small live view of
 * the page, where a tap is a click and a drag scrolls, a box to type into
 * it, and the few buttons a browser needs.
 *
 * The live view costs data, so it only runs while it is being used: it
 * stops after a minute untouched and comes back with a tap.
 */
(function () {
  'use strict';
  var $ = DT.$;

  var REST_AFTER_MS = 60 * 1000; // untouched this long, the live view stops until tapped
  var server = null; // the latest state from the server
  var control = null; // the page's line to the server, for "Show it in the car"
  var available = false; // the server has a browser to open pages in
  var ws = null; // the live view, and the way taps go up
  var waiting = []; // things to send once it is connected
  var resting = false; // the live view has been stopped to save data
  var restTimer = null;
  var picture = null; // the address of the picture being shown
  var filled = false; // the video was asked to fill the screen
  var pageWas = ''; // which page the card was last drawn for

  function show(node, on) {
    node.classList.toggle('hidden', !on);
  }
  function page() {
    return server && server.page ? server.page : null;
  }

  // ---------- the card ----------

  function paint() {
    var card = $('#pageCard');
    if (!card) return;
    show($('#pageBtn'), available);
    var p = page();
    show(card, !!p);
    if (!p) {
      pageWas = '';
      filled = false;
      return stopView();
    }
    // Another page, or the same one sent somewhere new: start with a clean slate.
    if (p.since !== pageWas) {
      pageWas = p.since;
      filled = false;
      resting = false;
    }
    var showing = !!(server.now && server.now.id === 'page');
    var site = p.site || 'the page';
    var say;
    if (p.phase !== 'live') say = 'Opening ' + site + " in the server's browser…";
    else if (!server.carOnline) say = site + ' is open. The car is offline: it shows there once the car has DrivePost open.';
    else if (showing && server.paused) say = site + ' is open. It is paused in the car.';
    else if (showing) say = 'The car is showing ' + site + ', a few seconds behind.';
    else say = site + ' is open, but the car is playing something else.';
    $('#pageSay').textContent = say;
    $('#pageSite').textContent = p.title && p.title !== site ? p.title : '';
    show($('#pageShow'), p.phase === 'live' && !showing);
    $('#pageFill').textContent = filled ? 'Show the whole page' : 'Fill the screen with the video';
    show($('#pageVeil'), resting || !picture);
    $('#pageVeil').textContent = resting ? 'Tap to see the page' : p.phase !== 'live' ? 'Opening…' : 'One moment…';
    if (!resting && !document.hidden) startView();
  }

  // ---------- the live view ----------

  function startView() {
    if (ws || !page()) return;
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var mine = (ws = new WebSocket(proto + location.host + '/ws/page'));
    mine.binaryType = 'blob';
    mine.onopen = function () {
      if (ws !== mine) return;
      var q = waiting;
      waiting = [];
      q.forEach(function (m) { mine.send(JSON.stringify(m)); });
      touched();
    };
    mine.onmessage = function (ev) {
      if (ws !== mine || typeof ev.data === 'string') return;
      var img = $('#pageImg');
      var next = URL.createObjectURL(ev.data);
      var old = picture;
      picture = next;
      img.onload = function () {
        if (old) URL.revokeObjectURL(old);
      };
      img.src = next;
      show($('#pageVeil'), false);
    };
    mine.onclose = function () {
      if (ws !== mine) return;
      ws = null;
      // Dropped while it was wanted (a patch of bad signal): try again shortly.
      if (page() && !resting && !document.hidden) setTimeout(paint, 1500);
    };
  }

  function stopView() {
    clearTimeout(restTimer);
    waiting = [];
    var mine = ws;
    ws = null;
    if (mine) {
      mine.onopen = mine.onmessage = mine.onclose = null;
      try { mine.close(); } catch (e) {}
    }
  }

  // Something was done to the page: the live view stays on a while longer.
  function touched() {
    clearTimeout(restTimer);
    restTimer = setTimeout(function () {
      resting = true;
      stopView();
      paint();
    }, REST_AFTER_MS);
  }

  // Send something to the page, waking the live view first if it was resting.
  function send(msg) {
    if (!page()) return;
    if (resting) {
      resting = false;
      paint();
    }
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
      touched();
    } else {
      waiting.push(msg);
      startView();
    }
  }

  // Where on the page a touch on the live view lands, as fractions of its
  // width and height. The picture sits inside the box with bars at the sides
  // or top and bottom when it isn't the box's shape. null: outside the picture.
  function spot(ev) {
    var box = $('#pageView').getBoundingClientRect();
    var img = $('#pageImg');
    var nw = img.naturalWidth || 16;
    var nh = img.naturalHeight || 9;
    var scale = Math.min(box.width / nw, box.height / nh);
    var w = nw * scale;
    var h = nh * scale;
    var x = (ev.clientX - box.left - (box.width - w) / 2) / w;
    var y = (ev.clientY - box.top - (box.height - h) / 2) / h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: x, y: y, h: h };
  }

  function ready() {
    if (!$('#pageCard')) return;
    var view = $('#pageView');
    var down = null; // the touch in progress: where it started and how far it has scrolled

    view.addEventListener('pointerdown', function (ev) {
      if (resting) {
        resting = false;
        paint();
        return;
      }
      var at = spot(ev);
      if (!at) return;
      down = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, lastY: ev.clientY, at: at, moved: false, t: Date.now(), owed: 0, sentAt: 0 };
      try { view.setPointerCapture(ev.pointerId); } catch (e) {}
    });
    view.addEventListener('pointermove', function (ev) {
      if (!down || ev.pointerId !== down.id) return;
      if (!down.moved && Math.abs(ev.clientY - down.y) < 10 && Math.abs(ev.clientX - down.x) < 10) return;
      down.moved = true;
      // A drag up moves the page down, as on any touch screen. Sent in small steps, not one a pixel.
      down.owed += (down.lastY - ev.clientY) / down.at.h;
      down.lastY = ev.clientY;
      var now = Date.now();
      if (now - down.sentAt > 60 && Math.abs(down.owed) > 0.005) {
        send({ t: 'input', kind: 'scroll', x: down.at.x, y: down.at.y, dy: down.owed });
        down.owed = 0;
        down.sentAt = now;
      }
    });
    function up(ev) {
      if (!down || ev.pointerId !== down.id) return;
      var d = down;
      down = null;
      if (d.moved) {
        if (Math.abs(d.owed) > 0.002) send({ t: 'input', kind: 'scroll', x: d.at.x, y: d.at.y, dy: d.owed });
      } else if (ev.type === 'pointerup' && Date.now() - d.t < 800) send({ t: 'input', kind: 'tap', x: d.at.x, y: d.at.y });
    }
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', up);
    // A mouse wheel, where the remote is open on a computer.
    view.addEventListener('wheel', function (ev) {
      var at = spot(ev);
      if (!at || resting) return;
      ev.preventDefault();
      send({ t: 'input', kind: 'scroll', x: at.x, y: at.y, dy: Math.max(-1, Math.min(1, ev.deltaY / 600)) });
    }, { passive: false });

    $('#pageTypeForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var box = $('#pageText');
      if (!box.value) return;
      send({ t: 'input', kind: 'text', text: box.value });
      box.value = '';
    });
    $('#pageEnter').addEventListener('click', function () { send({ t: 'input', kind: 'key', key: 'Enter' }); });
    $('#pageDel').addEventListener('click', function () { send({ t: 'input', kind: 'key', key: 'Backspace' }); });
    $('#pageBack').addEventListener('click', function () { send({ t: 'nav', what: 'back' }); });
    $('#pageReload').addEventListener('click', function () { send({ t: 'nav', what: 'reload' }); });
    $('#pageFill').addEventListener('click', function () {
      filled = !filled;
      send({ t: 'fill', on: filled });
      paint();
    });
    $('#pageShow').addEventListener('click', function () {
      if (control) control.cmd('play', { item: { id: 'page' } });
    });
    $('#pageClose').addEventListener('click', function () {
      DT.api('/api/page/close', { method: 'POST' }).catch(function (e) { DT.toast(e.message); });
    });
    // Out of sight, the live view is only data spent.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopView();
      else paint();
    });
    paint();
  }

  DT.pageCard = {
    // From the page: its line to the server, what the server says it can do, and each new state.
    use: function (c) { control = c; },
    hello: function (msg) {
      available = !!msg.pages;
      paint();
    },
    state: function (s) {
      server = s;
      paint();
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
