(function () {
  'use strict';
  var $ = DT.$;
  var cfg = null;

  function show() {
    $('#shareLink').textContent = cfg.shareLink;
    // The ready-made Shortcut, when this copy of DriveTest has one. Without
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
    if (!confirm('Sign out the car and every phone?')) return;
    DT.api('/api/logout-all', { body: {} }).then(function () {
      location.href = '/login';
    }).catch(function (e) { DT.toast(e.message); });
  });
})();
