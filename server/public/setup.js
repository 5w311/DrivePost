(function () {
  'use strict';
  var $ = DT.$;
  var cfg = null;

  // ---------- profiles ----------

  function profileAction(body, done) {
    DT.api('/api/profiles', { body: body }).then(function (r) {
      cfg.profiles = r.profiles;
      var me = r.profiles.filter(function (p) { return p.id === cfg.profile.id; })[0];
      if (me) cfg.profile.name = me.name;
      showProfiles();
      if (done) DT.toast(done);
    }).catch(function (e) { DT.toast(e.message); });
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
      ? ', the main profile. Add a profile for each person or car that should have its own.'
      : '. Its name and passcode are managed from the main profile.'));
    $('#ownerProfiles').classList.toggle('hidden', !me.owner);
    if (!me.owner) return;
    var list = $('#profileList');
    list.innerHTML = '';
    (cfg.profiles || []).forEach(function (p) { list.appendChild(profileRow(p)); });
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

  DT.api('/api/setup').then(function (c) {
    cfg = c;
    show();
  }).catch(function (e) {
    DT.toast(e.message);
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
      cfg.profiles = r.profiles;
      showProfiles();
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
      return DT.api('/api/setup').then(function (c) {
        cfg = c;
        show();
      });
    }).catch(function (e) { DT.toast(e.message); });
  });

  $('#logoutAll').addEventListener('click', function () {
    if (!confirm('Sign out the car and every phone on this profile?')) return;
    DT.api('/api/logout-all', { body: {} }).then(function () {
      location.href = '/login';
    }).catch(function (e) { DT.toast(e.message); });
  });
})();
