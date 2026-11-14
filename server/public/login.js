/*
 * The sign-in page: a passcode opens a profile (or, typed for Admin, the
 * Admin page), and someone new can ask for a profile of their own and wait
 * here to be allowed. Kept in a file of its own, like every page's script,
 * so that the pages can be told to run this server's scripts and no others.
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  // Where to go once signed in: somewhere on this server, and nowhere else.
  // (An address that starts with two slashes, or a slash and a backslash,
  // looks like a path here and is another site to a browser. So it is worked
  // out the way the browser will work it out, and then checked.)
  var next = '/';
  try {
    var asked = params.get('next') || '/';
    var to = new URL(asked, location.origin);
    if (to.origin === location.origin && /^\/(?![\/\\])/.test(asked)) next = to.pathname + to.search;
  } catch (e) {}
  var INTRO = $('intro').textContent;
  if (params.get('expired')) {
    $('intro').textContent =
      'That pairing code has expired or was already used. Tap Phone on the car screen for a new one, or enter your passcode.';
  }

  function post(path, body, method) {
    return fetch(path, {
      method: method || 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  // Signing in to the Admin page: that takes the server's own passcode.
  var forAdmin = !!params.get('admin');
  if (forAdmin) {
    next = '/admin';
    INTRO = "Admin: enter the server's own passcode, the one set as DRIVE_PASSCODE in its .env file. This device stays signed in to Admin for 30 days.";
    $('intro').textContent = INTRO;
    document.title = 'Admin sign-in · DrivePost';
  }

  function show(which) {
    ['signIn', 'ask', 'waiting'].forEach(function (id) { $(id).classList.toggle('hidden', id !== which); });
  }
  function offerAsking(text) {
    if (forAdmin) return;
    $('newHereText').textContent = text || 'New here?';
    $('newHere').classList.remove('hidden');
  }

  // ---- waiting to be allowed ----
  // The passcode is kept only in this page's memory, to sign in with once
  // the profile is allowed.
  var held = null;
  var asked = null;
  var poll = null;

  function backToSignIn(message) {
    clearInterval(poll);
    held = asked = null;
    $('intro').textContent = message || INTRO;
    $('error').textContent = '';
    $('passcode').value = '';
    show('signIn');
  }

  function checkRequest() {
    if (!asked) return;
    var mine = asked;
    fetch('/api/join/' + encodeURIComponent(mine.id), { credentials: 'same-origin' }).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (r) {
      if (!r || r.waiting || asked !== mine) return; // still waiting (or the server is restarting)
      clearInterval(poll);
      // Answered. If it was a yes, the passcode now signs in.
      return post('/api/login', { passcode: held }).then(function (signIn) {
        if (signIn.ok && !signIn.data.waiting) return void (location.href = next);
        backToSignIn(signIn.status === 401
          ? "Your request wasn't allowed, or it ran out. You can ask again."
          : 'Your request was answered. Sign in with your passcode in a few minutes.');
      });
    }).catch(function () {});
  }

  function wait(request, passcode) {
    asked = request;
    held = passcode;
    $('waitName').textContent = request.name;
    $('waitCode').textContent = request.code;
    show('waiting');
    clearInterval(poll);
    poll = setInterval(checkRequest, 4000);
  }

  $('waitCancel').addEventListener('click', function () {
    if (!asked) return;
    var id = asked.id;
    backToSignIn();
    post('/api/join/' + encodeURIComponent(id), null, 'DELETE').catch(function () {});
  });

  // ---- signing in ----
  $('form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var err = $('error');
    var passcode = $('passcode').value;
    err.textContent = '';
    post(forAdmin ? '/api/admin/login' : '/api/login', { passcode: passcode }).then(function (r) {
      if (r.ok && r.data.waiting) return wait(r.data.waiting, passcode);
      // The server's own passcode opens Admin, wherever it is typed.
      if (r.ok) return void (location.href = r.data.admin ? '/admin' : next);
      err.textContent = r.data.error || 'Sign-in failed';
      if (r.status === 401 && r.data.canAsk) offerAsking('Not your passcode yet?');
    }).catch(function (e) {
      err.textContent = e.message;
    });
  });

  // ---- asking for a profile ----
  $('askLink').addEventListener('click', function () {
    // Carry over what was typed, shown in the open so it can be checked.
    $('askPass').value = $('passcode').value;
    $('askError').textContent = '';
    show('ask');
    $('askName').focus();
  });
  $('askBack').addEventListener('click', function () { backToSignIn($('intro').textContent); });
  $('askForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var err = $('askError');
    var passcode = $('askPass').value;
    err.textContent = '';
    post('/api/join', { name: $('askName').value, passcode: passcode }).then(function (r) {
      if (!r.ok) throw new Error(r.data.error || "Couldn't send your request");
      wait(r.data.waiting, passcode);
    }).catch(function (e) {
      err.textContent = e.message;
    });
  });

  // Offer it up front when this server takes requests.
  fetch('/api/join', { credentials: 'same-origin' }).then(function (res) {
    return res.ok ? res.json() : {};
  }).then(function (r) {
    if (r.open) offerAsking();
  }).catch(function () {});
})();
