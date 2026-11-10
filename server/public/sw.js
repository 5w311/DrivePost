// Minimal service worker so the remote can be installed (and used as a
// share target on Android). Everything goes straight to the network.
self.addEventListener('install', function () {
  self.skipWaiting();
});
self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', function () {});
