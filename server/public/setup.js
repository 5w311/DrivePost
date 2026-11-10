(function () {
  'use strict';
  var $ = DT.$;
  var cfg = null;

  function show() {
    $('#shareUrl').textContent = cfg.shareUrl;
    $('#authHeader').textContent = 'Bearer ' + cfg.shareToken;
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { DT.toast('Copied'); }, function () { DT.toast('Select the text and copy it'); });
    } else DT.toast('Select the text and copy it');
  }

  DT.api('/api/setup').then(function (c) {
    cfg = c;
    show();
  }).catch(function (e) {
    DT.toast(e.message);
  });

  $('#copyUrl').addEventListener('click', function () { if (cfg) copy(cfg.shareUrl); });
  $('#copyAuth').addEventListener('click', function () { if (cfg) copy('Bearer ' + cfg.shareToken); });

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
      cfg.shareToken = r.shareToken;
      show();
      DT.toast('New token ready');
    }).catch(function (e) { DT.toast(e.message); });
  });

  $('#logoutAll').addEventListener('click', function () {
    if (!confirm('Sign out the car and every phone?')) return;
    DT.api('/api/logout-all', { body: {} }).then(function () {
      location.href = '/login';
    }).catch(function (e) { DT.toast(e.message); });
  });
})();
