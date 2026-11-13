/*
 * The Page card: steering a web page that is open in the server's own
 * browser and showing in the car.
 *
 * Some links have no video in them to send: the page has a player of its
 * own. The server then opens the page itself (webpage.js) and the car is
 * shown the page. This card is how a phone works it, as a remote desktop
 * works a computer: a small live view of the browser's screen, a box to
 * type into it, and a few keys.
 *
 * On the live view a tap is a click and a drag scrolls. A finger held still
 * moves the mouse there without clicking, and it then follows the finger:
 * that is how a player's buttons, which hide until the mouse comes near,
 * are woken so they can be tapped. The view can be made to fill the phone's
 * screen, for small buttons.
 *
 * The live view costs data, so it only runs while it is being used: it
 * stops after a minute untouched and comes back with a tap.
 *
 * "Block ads" has the server refuse what the page asks of ad and tracker
 * machines (adblock.js on the server). It is this profile's own setting,
 * and it is a switch because a few sites won't play with their ads blocked.
 */
(function () {
  'use strict';
  var $ = DT.$;

  var REST_AFTER_MS = 60 * 1000; // untouched this long, the live view stops until tapped
  var HOLD_MS = 350; // a finger held still this long is pointing, not tapping
  var server = null; // the latest state from the server
  var control = null; // the page's line to the server, for "Show it in the car"
  var available = false; // the server has a browser to open pages in
  var ws = null; // the live view, and the way taps go up
  var waiting = []; // things to send once it is connected
  var resting = false; // the live view has been stopped to save data
  var restTimer = null;
  var picture = null; // the address of the picture being shown
  var loading = null; // the next one, being made ready
  var size = { w: 16, h: 9 }; // the picture's own size
  var big = false; // the live view fills the phone's screen
  var ads = null; // how blocking ads stands, as the server last said: { on, list, stopped }
  var adsTimer = null;
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
      setBig(false);
      ads = null;
      watchAds();
      return stopView();
    }
    // Another page: start with a clean slate.
    if (p.since !== pageWas) {
      pageWas = p.since;
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
    // (Switched from another phone of this profile: what was heard here before no longer holds.)
    if (ads && server.settings && !!server.settings.blockAds !== ads.on) ads = null;
    paintAds();
    watchAds();
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
      // Each picture is made ready out of sight and then put in place whole,
      // so the view never blinks between one and the next. If a newer one
      // arrives while it is being made ready, the newer one wins.
      var next = URL.createObjectURL(ev.data);
      var ready = new Image();
      loading = ready;
      ready.onload = function () {
        if (loading !== ready || ws !== mine) return URL.revokeObjectURL(next);
        var old = picture;
        picture = next;
        size = { w: ready.naturalWidth, h: ready.naturalHeight };
        $('#pageImg').src = next;
        if (old) setTimeout(function () { URL.revokeObjectURL(old); }, 1000);
        show($('#pageVeil'), false);
      };
      ready.onerror = function () { URL.revokeObjectURL(next); };
      ready.src = next;
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

  // ---------- blocking ads ----------

  function paintAds() {
    var on = ads ? ads.on : !!(server && server.settings && server.settings.blockAds);
    var btn = $('#pageAds');
    btn.textContent = 'Block ads: ' + (on ? 'on' : 'off');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    var say = '';
    if (on && ads) {
      if (ads.list === 'failed') say = "The block list couldn't be fetched, so nothing is blocked yet. The server tries again by itself.";
      else if (ads.list !== 'ready') say = 'Fetching the block list…';
      else say = ads.stopped + (ads.stopped === 1 ? ' request' : ' requests') + " to ad and tracker companies stopped on this page. If the site won't play, switch this off and tap Reload.";
    }
    $('#pageAdsSay').textContent = say;
    show($('#pageAdsSay'), !!say);
  }

  function askAds(body) {
    return DT.api('/api/page/ads', body ? { body: body } : {}).then(function (r) {
      ads = r;
      paintAds();
      return r;
    });
  }

  // While a page is open and ads are being blocked, the count is kept up to date.
  function watchAds() {
    var want = !!page() && !document.hidden && !!(ads ? ads.on : server && server.settings && server.settings.blockAds);
    if (want && !adsTimer) {
      askAds().catch(function () {});
      adsTimer = setInterval(function () { askAds().catch(function () {}); }, 5000);
    } else if (!want && adsTimer) {
      clearInterval(adsTimer);
      adsTimer = null;
    }
  }

  // The live view over the whole of the phone's screen, or back in its card.
  function setBig(on) {
    big = !!on;
    var view = $('#pageView');
    if (!view) return;
    view.classList.toggle('big', big);
    document.documentElement.classList.toggle('page-big', big);
    show($('#pageDone'), big);
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
    var nw = size.w || 16;
    var nh = size.h || 9;
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
      if (ev.target.closest && ev.target.closest('button')) return; // the big view's own Done button
      if (resting) {
        resting = false;
        paint();
        return;
      }
      var at = spot(ev);
      if (!at) return;
      var mine = (down = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, lastY: ev.clientY, at: at, moved: false, pointing: false, owed: 0, sentAt: 0, hold: null });
      // Held still: the mouse goes there without clicking, and then follows the finger.
      mine.hold = setTimeout(function () {
        if (down !== mine || mine.moved) return;
        mine.pointing = true;
        view.classList.add('pointing');
        send({ t: 'input', kind: 'point', x: mine.at.x, y: mine.at.y });
        try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {}
      }, HOLD_MS);
      try { view.setPointerCapture(ev.pointerId); } catch (e) {}
    });
    view.addEventListener('pointermove', function (ev) {
      if (!down || ev.pointerId !== down.id) return;
      var now = Date.now();
      if (down.pointing) {
        var at = spot(ev);
        if (at && now - down.sentAt > 70) {
          send({ t: 'input', kind: 'point', x: at.x, y: at.y });
          down.sentAt = now;
        }
        return;
      }
      if (!down.moved && Math.abs(ev.clientY - down.y) < 10 && Math.abs(ev.clientX - down.x) < 10) return;
      down.moved = true;
      clearTimeout(down.hold);
      // A drag up moves the page down, as on any touch screen. Sent in small steps, not one a pixel.
      down.owed += (down.lastY - ev.clientY) / down.at.h;
      down.lastY = ev.clientY;
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
      clearTimeout(d.hold);
      view.classList.remove('pointing');
      if (d.pointing) {
        // Where the finger left is where the mouse stays.
        var at = ev.type === 'pointerup' ? spot(ev) : null;
        if (at) send({ t: 'input', kind: 'point', x: at.x, y: at.y });
      } else if (d.moved) {
        if (Math.abs(d.owed) > 0.002) send({ t: 'input', kind: 'scroll', x: d.at.x, y: d.at.y, dy: d.owed });
      } else if (ev.type === 'pointerup') send({ t: 'input', kind: 'tap', x: d.at.x, y: d.at.y });
    }
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', up);
    // (A long press on a picture is what a phone offers to save or copy it for: not here.)
    view.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
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
    function key(id, name) {
      $(id).addEventListener('click', function () { send({ t: 'input', kind: 'key', key: name }); });
    }
    key('#pageEnter', 'Enter');
    key('#pageDel', 'Backspace');
    key('#pageEsc', 'Escape');
    // The keys most players answer to: F for full screen, C for captions.
    key('#pageF', 'F');
    key('#pageC', 'C');
    $('#pageBack').addEventListener('click', function () { send({ t: 'nav', what: 'back' }); });
    $('#pageReload').addEventListener('click', function () { send({ t: 'nav', what: 'reload' }); });
    $('#pageAds').addEventListener('click', function () {
      var on = !(ads ? ads.on : server && server.settings && server.settings.blockAds);
      askAds({ on: on }).then(function () {
        DT.toast(on
          ? 'Blocking ads from here on. Tap Reload to clear the ones already on the page.'
          : 'Ads are no longer blocked. Tap Reload for the page to load them.');
        watchAds();
      }).catch(function (e) { DT.toast(e.message); });
    });
    $('#pageBig').addEventListener('click', function () { setBig(true); });
    $('#pageDone').addEventListener('click', function (ev) {
      ev.stopPropagation();
      setBig(false);
    });
    $('#pageShow').addEventListener('click', function () {
      if (control) control.cmd('play', { item: { id: 'page' } });
    });
    $('#pageClose').addEventListener('click', function () {
      DT.api('/api/page/close', { method: 'POST' }).catch(function (e) { DT.toast(e.message); });
    });
    // Out of sight, the live view is only data spent.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        stopView();
        watchAds();
      } else paint();
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
