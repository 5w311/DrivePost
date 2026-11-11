(function () {
  'use strict';
  var $ = DT.$;
  var view = null; // what the server last said: profiles, requests, the switch, the build

  // Only redraw when something changed, so a button isn't swapped out from
  // under a finger. (The minute is part of it, for "asked 5 min ago".)
  var shown = '';
  function took(v) {
    var key = JSON.stringify(v) + (v.requests.length ? Math.floor(Date.now() / 60000) : '');
    view = v;
    if (key === shown) return;
    shown = key;
    show();
  }

  // Not signed in to Admin (any more): back to its sign-in.
  function signedOut(e) {
    if (e && e.status === 403) location.href = '/login?admin=1';
    return e && e.status === 403;
  }

  function refresh() {
    return DT.api('/api/admin').then(took);
  }

  // Change something, then show the server's answer.
  function act(body, done) {
    return DT.api('/api/profiles', { body: body }).then(function (v) {
      took(v);
      if (done) DT.toast(done);
    }).catch(function (e) {
      if (signedOut(e)) return;
      DT.toast(e.message);
      if (view) show(); // put back anything on screen that didn't go through (the tick box)
    });
  }

  function profileRow(p) {
    var buttons = [
      DT.el('button', { type: 'button', text: 'Rename', onclick: function () {
        var name = prompt('New name for this profile:', p.name);
        if (name !== null && name.trim()) act({ action: 'rename', id: p.id, name: name }, 'Renamed');
      } })
    ];
    if (!p.owner) {
      buttons.push(DT.el('button', { type: 'button', text: 'Passcode', onclick: function () {
        var pass = prompt('New passcode for ' + p.name + ' (at least 4 characters). Devices already signed in stay signed in.');
        if (pass !== null && pass) act({ action: 'passcode', id: p.id, passcode: pass }, 'Passcode changed');
      } }));
      buttons.push(DT.el('button', { type: 'button', text: 'Sign out', onclick: function () {
        if (confirm('Sign out the car and every phone on ' + p.name + '?')) act({ action: 'signout', id: p.id }, 'Signed out');
      } }));
      buttons.push(DT.el('button', { type: 'button', text: 'Remove', onclick: function () {
        if (confirm('Remove ' + p.name + '? Its Up Next, history and settings are deleted and its devices are signed out.')) {
          act({ action: 'remove', id: p.id }, 'Removed');
        }
      } }));
    }
    var car = p.playing ? 'Car connected, playing' : p.carOnline ? 'Car connected' : 'Car not connected';
    return DT.el('div', { class: 'prow' }, [
      DT.el('div', { class: 'pname' }, [
        DT.el('b', { text: p.name }),
        p.owner ? DT.el('span', { class: 'muted', text: ' · main profile, also opened by the passcode in .env' }) : null,
        DT.el('div', { class: 'psub', text: car })
      ]),
      DT.el('div', { class: 'pbtns' }, buttons)
    ]);
  }

  function show() {
    // People who asked for a profile from the sign-in page.
    $('#noRequests').classList.toggle('hidden', !!view.requests.length);
    $('#requestList').classList.toggle('hidden', !view.requests.length);
    DT.showRequests($('#requestList'), view.requests, took);
    $('#allowAsk').checked = view.allowRequests !== false;

    var list = $('#profileList');
    list.innerHTML = '';
    view.profiles.forEach(function (p) { list.appendChild(profileRow(p)); });

    $('#build').textContent = view.server.version;
    $('#since').textContent = new Date(view.server.startedAt).toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }

  $('#allowAsk').addEventListener('change', function () {
    var on = this.checked;
    act({ action: 'asking', on: on }, on ? 'New people can ask for a profile' : 'Nobody new can ask for a profile');
  });

  $('#addProfile').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = $('#newName').value;
    var pass = $('#newPass').value;
    DT.api('/api/profiles', { body: { action: 'add', name: name, passcode: pass } }).then(function (v) {
      took(v);
      $('#newName').value = '';
      $('#newPass').value = '';
      DT.toast('Added. Their passcode is ' + pass);
    }).catch(function (e) { DT.toast(e.message); });
  });

  $('#adminOut').addEventListener('click', function () {
    DT.api('/api/admin/logout', { body: {} }).then(function () {
      location.href = '/login?admin=1';
    }).catch(function (e) { DT.toast(e.message); });
  });

  refresh().catch(function (e) {
    if (!signedOut(e)) DT.toast(e.message);
  });

  // Look again every few seconds while this page is in view, so someone
  // asking for a profile, or a car coming and going, shows up by itself.
  setInterval(function () {
    if (!document.hidden) refresh().catch(signedOut);
  }, 5000);
})();
