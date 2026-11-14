(function () {
  'use strict';
  var $ = DT.$;
  var view = null; // what the server last said: profiles, requests, the switch, the build
  var etag = ''; // the server's name for that state of things: it answers when it has another
  var lookedAt = 0; // when the updater last looked at GitHub, by this device's clock

  function typing() {
    var a = document.activeElement;
    return !!a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== 'checkbox' && !!a.value;
  }

  // The server is running pages newer than this one (an update went in):
  // load them, and say so once they're up. Not while a name or passcode is
  // being typed; then at the next news. True if the page is on its way out.
  function newPages(v) {
    if (!DT.version || !v.server || v.server.version === DT.version || typing()) return false;
    try {
      // Once per build, in case a browser hands back the old page all the same.
      if (sessionStorage.getItem('dp.admin.loadedFor') === v.server.version) return false;
      sessionStorage.setItem('dp.admin.loadedFor', v.server.version);
      sessionStorage.setItem('dp.admin.updated', v.server.commit || 'build ' + v.server.version);
    } catch (e) {}
    location.reload();
    return true;
  }
  // Loaded afresh because an update went in: say which one is running now.
  function sayIfUpdated() {
    var now = null;
    try {
      now = sessionStorage.getItem('dp.admin.updated');
      sessionStorage.removeItem('dp.admin.updated');
    } catch (e) {}
    if (now) DT.toast('Updated. Now running: ' + now);
  }

  // Only redraw when something changed, so a button isn't swapped out from
  // under a finger. (The minute is part of it, for "asked 5 min ago". How
  // long ago the updater last looked isn't: that line is kept up by itself.)
  var shown = '';
  function took(v) {
    if (newPages(v)) return;
    var first = !view;
    var restarted = view && view.server.startedAt !== v.server.startedAt;
    if (v.etag) etag = v.etag;
    var ago = v.server.update ? v.server.update.lookedAgo : null;
    lookedAt = typeof ago === 'number' ? Date.now() - ago : 0;
    var key = JSON.stringify(v, function (k, value) { return k === 'lookedAgo' || k === 'etag' ? undefined : value; }) +
      (v.requests.length ? Math.floor(Date.now() / 60000) : '');
    view = v;
    if (key !== shown) {
      shown = key;
      show();
    } else showSeen();
    if (first) sayIfUpdated();
    // The same pages, started again: an update that didn't touch them, or a restart by hand.
    if (restarted) DT.toast('The server restarted. Now running: ' + (v.server.commit || 'build ' + v.server.version));
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
        var pass = prompt('New passcode for ' + p.name + ' (at least 8 characters). Devices already signed in stay signed in.');
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
    showUpdate(view.server.update);
  }

  // ---- updates: what the server's updater is doing, and Force update ----
  // For each state: the heading, what it says, which button it has ('force',
  // 'cancel' or none), and how the box is drawn ('on' while something is
  // happening, 'bad' when something went wrong).
  var UPDATE_SAYS = {
    idle: ['Updates',
      'The server looks for updates every couple of minutes, and every few seconds while this page is open. It installs them by itself, waiting while a video is playing. Force update looks right now and installs what it finds, even if a video is playing.',
      'force', ''],
    checking: ['Checking for updates…',
      'Looking on GitHub for anything newer than the version below.',
      '', 'on'],
    asked: ['Force update is lined up',
      'The server takes it up at its next look, within about two minutes, and installs anything new right away, video or not.',
      'cancel', 'on'],
    uptodate: ['Up to date',
      'Checked GitHub just now: there is nothing newer than the version below.',
      'force', ''],
    waiting: ['An update is waiting',
      "It hasn't been installed because a video is playing. It goes in by itself within a couple of minutes of the video being paused or ending. Force update installs it now: the video keeps playing while the new version is built, stops when the server restarts, and then waits for a tap in the car.",
      'force', 'on'],
    next: ['An update is waiting',
      'Nothing is playing now, so it goes in by itself within a couple of minutes. Force update installs it now.',
      'force', 'on'],
    forced: ['An update is about to be installed',
      "It goes in at the server's next look, within about two minutes. The video stops when the server restarts, then waits for a tap in the car.",
      'cancel', 'on'],
    installing: ['Installing an update',
      'The new version is being built. When it is ready the server restarts: a video that is playing stops then and waits for a tap in the car. This page reloads by itself once the new version is running.',
      '', 'on'],
    // These two are this page's own: the server isn't answering.
    restarting: ['Restarting with the new version',
      'The new version is built and the server is starting it. This page reloads by itself in a few seconds, once it is running.',
      '', 'on'],
    away: ["Can't reach the server",
      'This page keeps trying every few seconds, and carries on by itself when the server answers.',
      '', 'bad'],
    failed: ["An update couldn't be installed",
      'The version below is still running. The server tries again in an hour, or when the next update arrives; Force update tries again now. Its log says what went wrong. To read it, run this on the server:',
      'force', 'bad', 'journalctl -u drivepost-update -n 30 --no-pager'],
    off: ["Automatic updates aren't running",
      "The updater on this server hasn't been in touch for a while. Either automatic updates were never turned on, or the server can't reach GitHub. To turn them on, run this on the server, in the DrivePost folder:",
      '', 'bad', './scripts/install-auto-update.sh']
  };
  function showUpdate(u) {
    u = u || { state: 'idle', commit: '' };
    var says = UPDATE_SAYS[u.state] || UPDATE_SAYS.idle;
    var box = $('#updateBox');
    box.classList.toggle('on', says[3] === 'on');
    box.classList.toggle('bad', says[3] === 'bad');
    $('#updateTitle').textContent = says[0];
    $('#updateCommit').textContent = u.commit || '';
    $('#updateCommit').classList.toggle('hidden', !u.commit);
    $('#updateWhy').textContent = says[1];
    $('#updateLook').textContent = says[4] || '';
    $('#updateLook').classList.toggle('hidden', !says[4]);
    $('#forceUpdate').classList.toggle('hidden', says[2] !== 'force');
    $('#cancelForce').classList.toggle('hidden', says[2] !== 'cancel');
    $('#cancelForce').textContent = u.state === 'forced' ? 'Wait for the video after all' : 'Never mind';
    $('#updateBtns').classList.toggle('hidden', !says[2]);
    showSeen();
  }
  // How long ago the updater last looked at GitHub, kept up to date by the
  // second. Not while it is busy with something else, or isn't there at all.
  var QUIET = { checking: 1, installing: 1, restarting: 1, away: 1, off: 1 };
  function showSeen() {
    var state = lost || !view ? 'away' : (view.server.update || {}).state || 'idle';
    var line = $('#updateSeen');
    var s = lookedAt ? Math.max(0, Math.round((Date.now() - lookedAt) / 1000)) : -1;
    line.classList.toggle('hidden', s < 0 || !!QUIET[state] || !!lost);
    if (s < 0) return;
    var ago = s < 5 ? 'just now' : s < 60 ? Math.floor(s / 5) * 5 + ' seconds ago' : s < 120 ? 'a minute ago' : Math.floor(s / 60) + ' minutes ago';
    if (line.textContent !== 'Last looked for updates: ' + ago) line.textContent = 'Last looked for updates: ' + ago;
  }
  setInterval(showSeen, 1000);

  function forceUpdate(on) {
    DT.api('/api/admin/update', { body: { force: on } }).then(function (v) {
      took(v);
      if (!on) DT.toast('Force update taken back');
    }).catch(function (e) {
      if (signedOut(e)) return;
      DT.toast(e.message);
      refresh().catch(signedOut);
    });
  }
  $('#forceUpdate').addEventListener('click', function () {
    var u = (view && view.server.update) || {};
    // Only ask when it would interrupt someone.
    if (u.playing) {
      var known = u.state === 'waiting' || u.state === 'failed';
      var ask = (known ? 'Install the update now?' : 'Look for an update now, and install it if there is one?') +
        ' A video is playing: it will stop when the server restarts, and wait for a tap in the car.';
      if (!confirm(ask)) return;
    }
    forceUpdate(true);
  });
  $('#cancelForce').addEventListener('click', function () { forceUpdate(false); });

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

  // ---- kept up to date ----
  // While this page is in view it keeps one request waiting on the server,
  // which answers the moment anything shown here changes: an update arriving
  // or going in, someone asking for a profile, a car coming or going. (That
  // request is also what has the server look for updates every few seconds.)
  // When an update restarts the server the request fails; the page then
  // tries again until the new version answers, and loads its pages.
  var waiting = null; // the request that is waiting, as its AbortController
  var lost = 0; // how many times in a row the server hasn't answered
  var lostWhile = ''; // ...and what it was doing when it stopped

  function watch() {
    if (waiting || document.hidden) return;
    var mine = (waiting = new AbortController());
    fetch('/api/admin/watch?seen=' + encodeURIComponent(etag), { credentials: 'same-origin', cache: 'no-store', signal: mine.signal })
      .then(function (res) {
        if (res.status === 403) {
          location.href = '/login?admin=1';
          return null;
        }
        if (!res.ok) throw new Error('The server answered ' + res.status);
        return res.json();
      })
      .then(function (v) {
        if (waiting !== mine) return;
        waiting = null;
        if (!v) return;
        if (lost) shown = ''; // what the box said meanwhile was this page's own
        lost = 0;
        took(v);
        watch();
      })
      .catch(function () {
        if (waiting !== mine) return; // stopped on purpose: the page went out of view
        waiting = null;
        if (!lost) lostWhile = view ? (view.server.update || {}).state || '' : '';
        lost++;
        // In the middle of an install, the server going quiet is the restart.
        // Otherwise one missed answer is nothing; a few in a row is worth saying.
        if (lostWhile === 'installing') showUpdate({ state: 'restarting', commit: view.server.update.commit });
        else if (lost >= 3 && view) showUpdate({ state: 'away' });
        setTimeout(watch, Math.min(3000, 500 + lost * 500));
      });
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) return watch();
    // Out of view: let go, so the server isn't kept looking for updates for nobody.
    var mine = waiting;
    waiting = null;
    if (mine) mine.abort();
  });
  watch();
})();
