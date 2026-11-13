/*
 * The Page card: steering a web page that is open in the server's own
 * browser and showing in the car.
 *
 * Some links have no video in them to send: the page has a player of its
 * own. The server then opens the page itself (webpage.js) and the car is
 * shown the page. This card is how a phone works it, as a remote desktop
 * works a computer. It is drawn as a small browser: a bar (Back, Reload,
 * where the page is, Bigger) with a live view of the browser's screen under
 * it, then a box to type into the page, and a few keys.
 *
 * On the live view a tap is a click and a drag scrolls. A finger held still
 * moves the mouse there without clicking, and it then follows the finger:
 * that is how a player's buttons, which hide until the mouse comes near,
 * are woken so they can be tapped. A ring is drawn where the finger was, so
 * a tap is seen to have gone even though the picture is a moment behind.
 *
 * "Bigger" puts the live view over the whole of the phone's screen, for
 * small buttons, and the long way round: on a phone held upright the picture
 * is turned on its side, so the phone is turned to look at it, whether or
 * not the phone turns its own screen.
 *
 * The live view costs data, so it only runs while it is being used: it
 * stops after a minute untouched and comes back with a tap.
 *
 * "Block ads" gives the server's browser an ad blocker for this profile's
 * pages: uBlock Origin Lite in the browser itself, where the browser has it,
 * with the server's own list of ad and tracker machines behind it (adblock.js
 * on the server). It is a switch because a few sites won't play with their
 * ads blocked. The browser takes its blocker on as it starts, so switching
 * with a page open opens that page again.
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
  var turned = false; // ...and is drawn on its side, for a phone held upright
  var turnTimer = null;
  var dropped = false; // the live view's line went down while it was wanted
  var ads = null; // how blocking ads stands, as the server last said: { on, with, list, stopped }
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
    // Another page: start with a clean slate, and not with the last page's picture.
    if (p.since !== pageWas) {
      pageWas = p.since;
      resting = false;
      dropped = false;
      forgetPicture();
    }
    var showing = !!(server.now && server.now.id === 'page');
    var live = p.phase === 'live';
    var site = p.site || 'the page';
    // How it stands with the car, in a word or two; and a note only when there is something to do about it.
    var status;
    var tone = '';
    var note = '';
    if (!live) {
      status = 'Opening…';
      tone = 'busy';
    } else if (!server.carOnline) {
      status = 'Car offline';
      note = 'The car is offline. The page shows there once the car has DrivePost open.';
    } else if (!showing) {
      status = 'Not in the car';
      note = 'The car is playing something else.';
    } else if (server.paused) status = 'Paused';
    else {
      status = 'In the car';
      tone = 'ok';
    }
    var badge = $('#pageStatus');
    badge.textContent = status;
    badge.className = 'page-status' + (tone ? ' ' + tone : '');
    $('#pageSay').textContent = note;
    show($('#pageShow'), live && !showing);
    show($('#pageNote'), !!note);
    $('#pageNote').classList.toggle('act', live && !showing && !!server.carOnline);
    $('#pageHost').textContent = p.site || '';
    $('#pageSite').textContent = p.title && p.title !== site ? p.title : '';
    // (Switched from another phone of this profile: what was heard here before no longer holds.)
    if (ads && server.settings && !!server.settings.blockAds !== ads.on) ads = null;
    paintAds();
    watchAds();
    paintVeil();
    if (!resting && !document.hidden) startView();
  }

  // What lies over the live view while there is nothing current to see in it.
  function paintVeil() {
    var p = page();
    if (!p) return;
    var say = '';
    if (resting) say = 'Tap to see the page';
    else if (p.phase !== 'live') say = 'Opening ' + (p.site || 'the page') + '…';
    else if (dropped) say = 'Reconnecting…';
    else if (!picture) say = 'One moment…';
    show($('#pageVeil'), !!say);
    show($('#pageSpin'), !!say && !resting);
    $('#pageVeilSay').textContent = say;
  }

  function forgetPicture() {
    loading = null;
    if (picture) URL.revokeObjectURL(picture);
    picture = null;
    var img = $('#pageImg');
    if (img) img.removeAttribute('src');
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
      dropped = false;
      paintVeil();
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
        paintVeil();
      };
      ready.onerror = function () { URL.revokeObjectURL(next); };
      ready.src = next;
    };
    mine.onclose = function () {
      if (ws !== mine) return;
      ws = null;
      // Dropped while it was wanted (a patch of bad signal): say so over the
      // picture, which is no longer current, and try again shortly.
      if (page() && !resting && !document.hidden) {
        dropped = true;
        paintVeil();
        setTimeout(paint, 1500);
      }
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
    $('#pageAds').setAttribute('aria-checked', on ? 'true' : 'false');
    var say;
    if (!on) say = 'Stops ads and trackers in the pages opened here.';
    else if (!ads) say = 'On.';
    // The browser's own blocker does the work, and what it stops never reaches the server to be counted.
    // (The browser says whether its blocker was at work by the time the page was opened.)
    else if (ads.with && (page() || {}).blocker === 'late') say = 'On, but ' + ads.with.replace(/ [0-9.]+$/, '') + " wasn't at work yet when this page opened. Tap Reload. If ads still show, it didn't start, and only the server's own list is blocking.";
    else if (ads.with) say = 'On, with ' + ads.with.replace(/ [0-9.]+$/, '') + ". If a site won't play, switch this off.";
    else if (ads.list === 'failed') say = "The block list couldn't be fetched, so nothing is blocked yet. The server tries again by itself.";
    else if (ads.list !== 'ready') say = 'Fetching the block list…';
    else if (!ads.stopped) say = 'On. Nothing stopped on this page yet.';
    else say = ads.stopped + (ads.stopped === 1 ? ' request' : ' requests') + " to ad and tracker companies stopped on this page. If the site won't play, switch this off and tap Reload.";
    $('#pageAdsSay').textContent = say;
  }

  function askAds(body) {
    return DT.api('/api/page/ads', body ? { body: body } : {}).then(function (r) {
      ads = r;
      paintAds();
      return r;
    });
  }

  // While a page is open and ads are being blocked, how that stands is kept
  // up to date: whether the browser's blocker came up, or the count of what
  // the server's list has stopped.
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
    var was = big;
    big = !!on;
    var view = $('#pageView');
    if (!view) return;
    view.classList.toggle('big', big);
    document.documentElement.classList.toggle('page-big', big);
    show($('#pageDone'), big);
    fit();
    // Drawn on its side, it wants the phone turned: say so once, as it opens.
    clearTimeout(turnTimer);
    show($('#pageTurn'), big && !was && turned);
    if (big && !was && turned) turnTimer = setTimeout(function () { show($('#pageTurn'), false); }, 2600);
  }

  // The page is wider than it is tall. Over a screen that is taller than it
  // is wide (a phone held upright) it is drawn on its side, to use the long
  // way round. The view is told the screen's size, since a phone's browser
  // doesn't agree with itself about how tall "100vh" is.
  function fit() {
    var view = $('#pageView');
    if (!view) return;
    turned = big && window.innerHeight > window.innerWidth;
    view.classList.toggle('turned', turned);
    if (turned) {
      view.style.setProperty('--long', window.innerHeight + 'px');
      view.style.setProperty('--short', window.innerWidth + 'px');
    }
  }

  // A ring on the live view where a finger tapped ('tap': it fades at once)
  // or is pointing ('point': it stays, and follows). u and v are measured in
  // the view's own frame, which may be lying on its side.
  function mark(kind, u, v) {
    var m = $('#pageTouch');
    if (!m) return;
    if (kind) {
      m.style.left = u + 'px';
      m.style.top = v + 'px';
    }
    if (m.dataset.kind === (kind || '')) return;
    m.dataset.kind = kind || '';
    m.className = 'page-touch';
    if (kind) {
      void m.offsetWidth; // (so that one tap straight after another draws its ring again)
      m.className = 'page-touch ' + kind;
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

  // Where in the live view's own frame a touch is: u across it and v down it,
  // with the frame's size. Drawn on its side, the frame's "across" runs down
  // the phone's screen and its "down" runs from the screen's right to its left.
  function local(ev) {
    var box = $('#pageView').getBoundingClientRect();
    return turned
      ? { u: ev.clientY - box.top, v: box.right - ev.clientX, w: box.height, h: box.width }
      : { u: ev.clientX - box.left, v: ev.clientY - box.top, w: box.width, h: box.height };
  }

  // Where on the page that is, as fractions of the page's width and height.
  // The picture sits inside the frame with bars at the sides or top and
  // bottom when it isn't the frame's shape. null: outside the picture.
  function spot(ev) {
    var at = local(ev);
    var nw = size.w || 16;
    var nh = size.h || 9;
    var scale = Math.min(at.w / nw, at.h / nh);
    var w = nw * scale;
    var h = nh * scale;
    var x = (at.u - (at.w - w) / 2) / w;
    var y = (at.v - (at.h - h) / 2) / h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: x, y: y, h: h, u: at.u, v: at.v };
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
      var mine = (down = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, lastV: at.v, at: at, moved: false, pointing: false, owed: 0, sentAt: 0, hold: null });
      // Held still: the mouse goes there without clicking, and then follows the finger.
      mine.hold = setTimeout(function () {
        if (down !== mine || mine.moved) return;
        mine.pointing = true;
        view.classList.add('pointing');
        mark('point', mine.at.u, mine.at.v);
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
        if (at) mark('point', at.u, at.v);
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
      var v = local(ev).v;
      down.owed += (down.lastV - v) / down.at.h;
      down.lastV = v;
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
      mark('');
      if (d.pointing) {
        // Where the finger left is where the mouse stays.
        var at = ev.type === 'pointerup' ? spot(ev) : null;
        if (at) send({ t: 'input', kind: 'point', x: at.x, y: at.y });
      } else if (d.moved) {
        if (Math.abs(d.owed) > 0.002) send({ t: 'input', kind: 'scroll', x: d.at.x, y: d.at.y, dy: d.owed });
      } else if (ev.type === 'pointerup') {
        send({ t: 'input', kind: 'tap', x: d.at.x, y: d.at.y });
        mark('tap', d.at.u, d.at.v);
      }
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
    key('#pageTab', 'Tab'); // on to the next box of a form
    // The keys most players answer to: F for full screen, C for captions.
    key('#pageF', 'F');
    key('#pageC', 'C');
    $('#pageBack').addEventListener('click', function () { send({ t: 'nav', what: 'back' }); });
    $('#pageReload').addEventListener('click', function () { send({ t: 'nav', what: 'reload' }); });
    $('#pageAds').addEventListener('click', function () {
      var on = !(ads ? ads.on : server && server.settings && server.settings.blockAds);
      askAds({ on: on }).then(function (r) {
        // With its own blocker to take on or leave off, the browser opens the page again by itself.
        if (r.reopened) DT.toast(on ? 'Blocking ads. The page is opening again with the blocker on.' : 'Ads are no longer blocked. The page is opening again.');
        else if (r.with || !page()) DT.toast(on ? 'Ads will be blocked in the pages opened here.' : 'Ads are no longer blocked.');
        else DT.toast(on
          ? 'Blocking ads from here on. Tap Reload to clear the ones already on the page.'
          : 'Ads are no longer blocked. Tap Reload for the page to load them.');
        watchAds();
      }).catch(function (e) { DT.toast(e.message); });
    });
    // The bar's buttons and the way back from the big view are drawn, not worded.
    $('#pageBack').appendChild(DT.icon('arrowLeft'));
    $('#pageReload').appendChild(DT.icon('reload'));
    $('#pageBig').appendChild(DT.icon('expand'));
    $('#pageDone').appendChild(DT.icon('compress'));
    $('#pageBig').addEventListener('click', function () {
      // (A keyboard left up would sit over the big view.)
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      setBig(true);
    });
    // The phone was turned, or its browser's bars came or went.
    window.addEventListener('resize', function () { if (big) fit(); });
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
