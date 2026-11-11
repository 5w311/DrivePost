(function () {
  'use strict';
  var $ = DT.$;
  var cfg = null;

  // ---------- profiles ----------

  // Take in the server's answer after any change to profiles or requests.
  function profilesChanged(r) {
    cfg.profiles = r.profiles;
    cfg.requests = r.requests;
    cfg.allowRequests = r.allowRequests;
    var me = r.profiles.filter(function (p) { return p.id === cfg.profile.id; })[0];
    if (me) cfg.profile.name = me.name;
    showProfiles();
  }

  function profileAction(body, done) {
    return DT.api('/api/profiles', { body: body }).then(function (r) {
      profilesChanged(r);
      if (done) DT.toast(done);
    }).catch(function (e) {
      DT.toast(e.message);
      showProfiles(); // put back anything on screen that didn't go through
    });
  }

  function profileRow(p) {
    var buttons = [
      DT.el('button', { type: 'button', text: 'Rename', onclick: function () {
        var name = prompt('New name for this profile:', p.name);
        if (name !== null && name.trim()) profileAction({ action: 'rename', id: p.id, name: name }, 'Renamed');
      } })
    ];
    if (!p.owner) {
      buttons.push(DT.el('button', { type: 'button', text: 'Passcode', onclick: function () {
        var pass = prompt('New passcode for ' + p.name + ' (at least 4 characters). Devices already signed in stay signed in.');
        if (pass !== null && pass) profileAction({ action: 'passcode', id: p.id, passcode: pass }, 'Passcode changed');
      } }));
      buttons.push(DT.el('button', { type: 'button', text: 'Sign out', onclick: function () {
        if (confirm('Sign out the car and every phone on ' + p.name + '?')) profileAction({ action: 'signout', id: p.id }, 'Signed out');
      } }));
      buttons.push(DT.el('button', { type: 'button', text: 'Remove', onclick: function () {
        if (confirm('Remove ' + p.name + '? Its Up Next, history and settings are deleted and its devices are signed out.')) {
          profileAction({ action: 'remove', id: p.id }, 'Removed');
        }
      } }));
    }
    return DT.el('div', { class: 'prow' }, [
      DT.el('div', { class: 'pname' }, [
        DT.el('b', { text: p.name }),
        p.owner ? DT.el('span', { class: 'muted', text: ' · main profile, passcode set in .env' }) : null
      ]),
      DT.el('div', { class: 'pbtns' }, buttons)
    ]);
  }

  function showProfiles() {
    var me = cfg.profile;
    var who = $('#whoAmI');
    who.innerHTML = '';
    who.appendChild(document.createTextNode("This device is signed in to "));
    who.appendChild(DT.el('b', { text: me.name, style: 'color:var(--text)' }));
    who.appendChild(document.createTextNode(me.owner
      ? ', the main profile. It decides who else gets a profile.'
      : '. Its name and passcode are managed from the main profile.'));
    $('#ownerProfiles').classList.toggle('hidden', !me.owner);
    if (!me.owner) return;
    var list = $('#profileList');
    list.innerHTML = '';
    (cfg.profiles || []).forEach(function (p) { list.appendChild(profileRow(p)); });
    // People who asked for a profile from the sign-in page.
    $('#requestList').classList.toggle('hidden', !(cfg.requests || []).length);
    DT.showRequests($('#requestList'), cfg.requests, profilesChanged);
    $('#allowAsk').checked = cfg.allowRequests !== false;
  }

  function show() {
    showProfiles();
    $('#shareLink').textContent = cfg.shareLink;
    // The ready-made Shortcut, when this copy of DrivePost has one. Without
    // it, the by-hand steps are the way, so show them opened up.
    var quick = !!cfg.shortcutUrl;
    $('#quickShortcut').classList.toggle('hidden', !quick);
    if (quick) $('#getShortcut').href = cfg.shortcutUrl;
    else $('#manualShortcut').open = true;
    $('#manualShortcut').querySelector('summary').textContent = quick ? 'Make it by hand instead' : 'How to make it';
    // Opened from the iPhone Home Screen, downloads may not work.
    $('#standaloneHint').classList.toggle('hidden', !(quick && navigator.standalone === true));
  }

  // Returns a promise that says whether the text reached the clipboard.
  function copy(text) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return Promise.resolve(false);
    return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
  }

  function copyLink() {
    if (!cfg) return;
    copy(cfg.shareLink).then(function (ok) {
      if (ok) return DT.toast('Link copied');
      // Couldn't copy (for instance, not on https): show it for copying by hand.
      $('#manualShortcut').open = true;
      DT.toast("Couldn't copy it. The link is shown below: select and copy it.");
    });
  }

  var live = null;
  DT.api('/api/setup').then(function (c) {
    cfg = c;
    show();
    // The main profile hears right away when someone asks for a profile, or
    // when a request was answered from another of its screens.
    if (cfg.profile.owner && !live) {
      live = new DT.Control('remote', {
        requests: function (msg) {
          var before = (cfg.requests || []).length;
          cfg.requests = msg.requests;
          // A request answered elsewhere may have become a profile.
          if (msg.requests.length < before) refresh();
          else showProfiles();
        }
      });
    }
  }).catch(function (e) {
    DT.toast(e.message);
  });

  function refresh() {
    return DT.api('/api/setup').then(function (c) {
      cfg = c;
      show();
    }).catch(function () {});
  }

  $('#allowAsk').addEventListener('change', function () {
    if (!cfg) return;
    var on = this.checked;
    profileAction({ action: 'asking', on: on }, on ? 'New people can ask for a profile' : 'Nobody new can ask for a profile');
  });

  $('#copyLink').addEventListener('click', copyLink);
  $('#copyLink2').addEventListener('click', copyLink);
  // The button is a plain download link; on the way, copy the personal link
  // so it's ready to paste when Shortcuts asks for it.
  $('#getShortcut').addEventListener('click', function (ev) {
    if (!cfg || !cfg.shortcutUrl) return ev.preventDefault();
    copyLink();
  });

  $('#addProfile').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!cfg) return;
    var name = $('#newName').value;
    var pass = $('#newPass').value;
    DT.api('/api/profiles', { body: { action: 'add', name: name, passcode: pass } }).then(function (r) {
      profilesChanged(r);
      $('#newName').value = '';
      $('#newPass').value = '';
      DT.toast('Added. Their passcode is ' + pass);
    }).catch(function (e) { DT.toast(e.message); });
  });

  $('#testBtn').addEventListener('click', function () {
    if (!cfg) return;
    var control = new DT.Control('remote', {
      online: function (on) {
        if (!on) return;
        control.cmd('play', { item: cfg.testItem });
        DT.toast('Sent to the car');
      }
    });
  });

  $('#newToken').addEventListener('click', function () {
    if (!confirm('Make a new share token? Your current Shortcut will stop working until you update it.')) return;
    DT.api('/api/share-token', { body: {} }).then(function (r) {
      DT.toast('New token ready');
      return refresh();
    }).catch(function (e) { DT.toast(e.message); });
  });

  $('#logoutAll').addEventListener('click', function () {
    if (!confirm('Sign out the car and every phone on this profile?')) return;
    DT.api('/api/logout-all', { body: {} }).then(function () {
      location.href = '/login';
    }).catch(function (e) { DT.toast(e.message); });
  });
})();
