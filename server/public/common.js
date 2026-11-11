/* Shared helpers for the car page, phone remote and setup page. */
(function () {
  'use strict';

  var DT = (window.DT = {});

  DT.$ = function (sel, root) {
    return (root || document).querySelector(sel);
  };

  // Tiny element builder: DT.el('div', {class: 'x', onclick: fn}, [children])
  DT.el = function (tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  };

  DT.fmt = function (s) {
    if (s === null || s === undefined || !isFinite(s)) return '–:––';
    s = Math.max(0, Math.floor(s));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
  };

  DT.api = function (path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) {
      init.method = opts.method || 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (res) {
      if (res.status === 401 && path.indexOf('/api/login') !== 0) {
        location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
        throw new Error('Sign in first');
      }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
        return data;
      });
    });
  };

  DT.toast = function (msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(DT._toastTimer);
    DT._toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3500);
  };

  // ---- staying on the current version ----
  // The server stamps each page with the version it was built from. When the
  // server says it runs a different one, this page is old: either the server
  // was updated while it was open, or the browser brought the page back from
  // its own saved copy.
  DT.version = document.documentElement.getAttribute('data-version') || null;
  DT.serverVersion = null;
  DT.stale = false;
  DT.noteVersion = function (v) {
    if (!v) return;
    DT.serverVersion = v;
    if (!DT.version) DT.version = v; // an unstamped page goes by the first version it hears
    DT.stale = v !== DT.version;
  };
  // Load the new page. Returns true if a reload was started. Only once per
  // version, so a stubborn saved copy can't make the page reload forever.
  DT.reloadIfStale = function () {
    if (!DT.stale) return false;
    try {
      if (sessionStorage.getItem('dt.reloadedFor') === DT.serverVersion) return false;
      sessionStorage.setItem('dt.reloadedFor', DT.serverVersion);
    } catch (e) {
      if (DT._reloadTried) return false;
    }
    DT._reloadTried = true;
    location.reload();
    return true;
  };

  // Control channel: keeps queue, now playing and position in sync.
  DT.Control = function (role, handlers) {
    this.role = role;
    this.handlers = handlers || {};
    this.ws = null;
    this.retry = 0;
    this.connect();
  };
  DT.Control.prototype.connect = function () {
    var self = this;
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = (this.ws = new WebSocket(proto + location.host + '/ws/control'));
    ws.onopen = function () {
      self.retry = 0;
      ws.send(JSON.stringify({ type: 'hello', role: self.role }));
      if (self.handlers.online) self.handlers.online(true);
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      var h = self.handlers[msg.type];
      if (h) h(msg);
    };
    ws.onclose = function (ev) {
      if (self.handlers.online) self.handlers.online(false);
      // Closed because this device was signed out (or keeps failing to get
      // back in): ask the server, which sends us to the sign-in page if so.
      if ((ev && ev.code === 4401) || self.retry === 3) DT.api('/api/state').catch(function () {});
      var delay = Math.min(10000, 500 * Math.pow(2, self.retry++));
      setTimeout(function () { self.connect(); }, delay);
    };
  };
  DT.Control.prototype.send = function (msg) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  };
  DT.Control.prototype.cmd = function (action, data) {
    var msg = Object.assign({ type: 'cmd', action: action }, data || {});
    if (!this.send(msg)) DT.toast('Reconnecting… try again in a moment');
  };

  // Estimated position of what's playing, from the car's last report.
  DT.positionOf = function (state) {
    if (!state || !state.now) return 0;
    var p = state.position;
    if (p && p.seq === state.now.seq) {
      var drift = p.state === 'playing' ? (Date.now() - p.at) / 1000 : 0;
      return p.t + drift;
    }
    return state.now.startAt || 0;
  };

  var ICONS = {
    play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>',
    pause: '<rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/>',
    next: '<path d="M5 6.2v11.6a1 1 0 0 0 1.53.85L15 13.2V17a1 1 0 0 0 2 0V7a1 1 0 0 0-2 0v3.8L6.53 5.35A1 1 0 0 0 5 6.2z"/>',
    back10: '<path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="16.2" font-size="6.6" font-weight="700" text-anchor="middle" font-family="system-ui,sans-serif">10</text>',
    fwd10: '<path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16.2" font-size="6.6" font-weight="700" text-anchor="middle" font-family="system-ui,sans-serif">10</text>',
    up: '<path d="M12 6l-6 6h4v6h4v-6h4z"/>',
    down: '<path d="M12 18l6-6h-4V6h-4v6H6z"/>',
    x: '<path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    restart: '<path d="M6 6h2v12H6zM9.5 12l8.5 6V6z"/>',
    expand: '<path d="M5 5h5v2H7v3H5zM14 5h5v5h-2V7h-3zM5 14h2v3h3v2H5zM17 14h2v5h-5v-2h3z"/>',
    compress: '<path d="M8 5h2v5H5V8h3zM14 5h2v3h3v2h-5zM5 14h5v5H8v-3H5zM14 14h5v2h-3v3h-2z"/>'
  };
  DT.icon = function (name, cls) {
    var span = document.createElement('span');
    span.className = 'icon' + (cls ? ' ' + cls : '');
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
    return span;
  };

  // One row in a video list.
  DT.itemRow = function (item, opts) {
    opts = opts || {};
    var progress = opts.progress || 0;
    var sub = [item.channel, item.live ? 'LIVE' : item.duration ? DT.fmt(item.duration) : null]
      .filter(Boolean)
      .join(' · ');
    var thumb = DT.el('div', { class: 'thumb' }, [
      item.thumb ? DT.el('img', { src: item.thumb, alt: '', loading: 'lazy' }) : DT.el('div', { class: 'thumb-pattern' }),
      progress && item.duration
        ? DT.el('div', { class: 'thumb-progress' }, [
            DT.el('div', { style: 'width:' + Math.min(100, (progress / item.duration) * 100) + '%' })
          ])
        : null
    ]);
    var info = DT.el('div', { class: 'row-info' }, [
      DT.el('div', { class: 'row-title', text: item.title }),
      DT.el('div', { class: 'row-sub', text: sub })
    ]);
    var row = DT.el('div', { class: 'row' + (opts.active ? ' active' : '') }, [thumb, info]);
    if (opts.onclick) {
      info.addEventListener('click', opts.onclick);
      thumb.addEventListener('click', opts.onclick);
      row.classList.add('tappable');
    }
    if (opts.actions && opts.actions.length) {
      row.appendChild(DT.el('div', { class: 'row-actions' }, opts.actions));
    }
    return row;
  };

  // Suggestions under a search box while typing. `opts.local()` returns
  // titles to match on the spot (recently played); the rest come from
  // YouTube through the server. `opts.onPick(text)` runs when one is chosen.
  // `opts.max` limits the rows; `opts.reveal` scrolls the box into view on focus.
  DT.autocomplete = function (input, opts) {
    var form = input.form || input.parentNode;
    var box = DT.el('div', { class: 'suggest hidden', role: 'listbox' });
    form.classList.add('has-suggest');
    form.appendChild(box);
    var items = [];
    var active = -1;
    var timer = null;
    var ticket = 0;
    var remote = [];

    function hide() {
      clearTimeout(timer);
      ticket++;
      items = [];
      active = -1;
      box.classList.add('hidden');
      box.innerHTML = '';
    }

    function pick(text) {
      input.value = text;
      hide();
      opts.onPick(text);
    }

    function localMatches(q) {
      var all = (opts.local && opts.local()) || [];
      var seen = {};
      return all.filter(function (t) {
        var k = t.toLowerCase();
        if (seen[k] || k.indexOf(q) < 0 || k === q) return false;
        seen[k] = true;
        return true;
      }).slice(0, 2);
    }

    function render() {
      var typed = input.value.trim();
      var q = typed.toLowerCase();
      var seen = {};
      items = localMatches(q).concat(remote).filter(function (t) {
        var k = t.toLowerCase();
        if (seen[k]) return false;
        seen[k] = true;
        return true;
      }).slice(0, opts.max || 7);
      active = -1;
      box.innerHTML = '';
      box.classList.toggle('hidden', !items.length);
      items.forEach(function (text, i) {
        // Show what would be added to the typed words in bold, like YouTube does.
        var starts = text.toLowerCase().indexOf(q) === 0;
        var row = DT.el('div', { class: 'suggest-row', role: 'option' }, starts
          ? [DT.el('span', { text: text.slice(0, typed.length) }), DT.el('b', { text: text.slice(typed.length) })]
          : [DT.el('span', { text: text })]);
        // Keep the keyboard focus (and the on-screen keyboard) until the pick lands.
        row.addEventListener('pointerdown', function (ev) { ev.preventDefault(); });
        row.addEventListener('click', function () { pick(items[i]); });
        box.appendChild(row);
      });
    }

    function highlight(i) {
      active = i;
      Array.prototype.forEach.call(box.children, function (row, n) {
        row.classList.toggle('active', n === active);
      });
    }

    input.addEventListener('input', function () {
      var q = input.value.trim();
      clearTimeout(timer);
      var mine = ++ticket;
      if (q.length < 2 || /youtu\.?be|youtube\.com|^https?:/i.test(q)) {
        hide();
        return;
      }
      remote = remote.filter(function (t) { return t.toLowerCase().indexOf(q.toLowerCase()) === 0; });
      render();
      timer = setTimeout(function () {
        DT.api('/api/suggest?q=' + encodeURIComponent(q)).then(function (r) {
          if (mine !== ticket) return; // typed more since
          remote = r.suggestions || [];
          render();
        }).catch(function () {});
      }, 180);
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') return hide();
      if (!items.length) return;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); highlight((active + 1) % items.length); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); highlight(active <= 0 ? items.length - 1 : active - 1); }
      else if (ev.key === 'Enter' && active >= 0) { ev.preventDefault(); pick(items[active]); }
    });
    input.addEventListener('blur', function () { setTimeout(hide, 150); });
    if (opts.reveal) {
      // On a phone the keyboard covers the lower half of the screen: move the
      // search box to the top so the suggestions under it stay in view.
      input.addEventListener('focus', function () {
        setTimeout(function () {
          try { form.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { form.scrollIntoView(true); }
        }, 250);
      });
    }
    form.addEventListener('submit', hide);
    return { hide: hide };
  };

  DT.iconButton = function (name, label, onclick, cls) {
    var b = DT.el('button', { class: 'icon-btn' + (cls ? ' ' + cls : ''), 'aria-label': label, title: label, onclick: onclick });
    b.appendChild(DT.icon(name));
    return b;
  };
})();
