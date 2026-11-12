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

  // ---- people asking for a profile ----
  function ago(at) {
    var min = Math.floor((Date.now() - at) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    if (min < 48 * 60) return Math.floor(min / 60) + ' h ago';
    return Math.floor(min / 1440) + ' days ago';
  }
  // Fills `list` with one row per request, each with Allow and Decline.
  // `done(answer)` gets the server's answer after either.
  function showRequests(list, requests, done) {
    list.innerHTML = '';
    (requests || []).forEach(function (r) {
      function answer(action, said) {
        DT.api('/api/profiles', { body: { action: action, id: r.id } }).then(function (res) {
          DT.toast(said);
          if (done) done(res);
        }).catch(function (e) {
          if (!signedOut(e)) DT.toast(e.message);
        });
      }
      list.appendChild(DT.el('div', { class: 'prow asking' }, [
        DT.el('div', { class: 'pname' }, [
          DT.el('b', { text: r.name }),
          ' is asking for a profile',
          DT.el('div', { class: 'psub', text: 'Number on their screen: ' + r.code + ' · asked ' + ago(r.at) })
        ]),
        DT.el('div', { class: 'pbtns' }, [
          DT.el('button', { type: 'button', class: 'primary', text: 'Allow', onclick: function () {
            answer('approve', r.name + ' can sign in now');
          } }),
          DT.el('button', { type: 'button', text: 'Decline', onclick: function () {
            answer('decline', 'Declined');
          } })
        ])
      ]));
    });
  }

  function profileRow(p) {
    var buttons = [
      DT.el('button', { type: 'button', text: 'Rename', onclick: function () {
        var name = prompt('New name for this profile:', p.name);
        if (name !== null && name.trim()) act({ action: 'rename', id: p.id, name: name }, 'Renamed');
      } }),
      DT.el('button', { type: 'button', text: 'Passcode', onclick: function () {
        var pass = prompt('New passcode for ' + p.name + ' (at least 4 characters). Devices already signed in stay signed in.');
        if (pass !== null && pass) act({ action: 'passcode', id: p.id, passcode: pass }, 'Passcode changed');
      } }),
      DT.el('button', { type: 'button', text: 'Sign out', onclick: function () {
        if (confirm('Sign out the car and every phone on ' + p.name + '?')) act({ action: 'signout', id: p.id }, 'Signed out');
      } }),
      DT.el('button', { type: 'button', text: 'Remove', onclick: function () {
        if (confirm('Remove ' + p.name + '? Its Up Next, history and settings are deleted and its devices are signed out.')) {
          act({ action: 'remove', id: p.id }, 'Removed');
        }
      } })
    ];
    var car = p.playing ? 'Car connected, playing' : p.carOnline ? 'Car connected' : 'Car not connected';
    return DT.el('div', { class: 'prow' }, [
      DT.el('div', { class: 'pname' }, [
        DT.el('b', { text: p.name }),
        DT.el('div', { class: 'psub', text: car }),
        // Only the profile a server had before profiles existed can be without one.
        p.hasPasscode ? null : DT.el('div', { class: 'psub', text: 'No passcode: only devices already signed in can use it. Give it one with Passcode, or remove it.' })
      ]),
      DT.el('div', { class: 'pbtns' }, buttons)
    ]);
  }

  function show() {
    // People who asked for a profile from the sign-in page.
    $('#noRequests').classList.toggle('hidden', !!view.requests.length);
    $('#requestList').classList.toggle('hidden', !view.requests.length);
    showRequests($('#requestList'), view.requests, took);
    $('#allowAsk').checked = view.allowRequests !== false;

    var list = $('#profileList');
    list.innerHTML = '';
    view.profiles.forEach(function (p) { list.appendChild(profileRow(p)); });
    list.classList.toggle('hidden', !view.profiles.length);
    $('#noProfiles').classList.toggle('hidden', !!view.profiles.length);

    $('#build').textContent = view.server.version;
    // "3faa11d Title of the update", when the server was told as it was built.
    $('#commit').textContent = view.server.commit || 'Not recorded for this build. It shows after the next automatic update.';
    if (view.server.commits) {
      $('#commitsLink').href = view.server.commits;
      $('#commitsLink').textContent = view.server.commits.replace(/^https:\/\//, '');
    }
    $('#since').textContent = new Date(view.server.startedAt).toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }

  // Pull down from the top to reload: the only way to, when this page is on a phone's home screen.
  DT.pullToReload();

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
