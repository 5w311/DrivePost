/*
 * The door the server's own browser fetches everything through.
 *
 * The browser DrivePost opens pages in (the browser container) is on a
 * network with no way out. This is its one exit: a plain forwarding proxy
 * that passes its requests on to the internet, and refuses any that lead
 * inside the home network (the router's settings page, other machines, this
 * server itself). The same rules as for links (links.js), applied to every
 * address a page asks for, whatever the page is.
 *
 * It serves the browser's machine and nobody else: `allowed(address)` says
 * who that is (webpage.js knows, from the program there having proved itself
 * with the shared key).
 *
 * It is also where ads are stopped, for a profile that has asked for that:
 * `blocked(name)` says whether a machine's name is one to refuse (adblock.js).
 *
 * And it answers one made-up name itself: READY_HOST, where a browser that
 * was started with its own ad blocker waits until the blocker is at work
 * (see WAIT_PAGE below, and browser/agent.js).
 */
import http from 'node:http';
import net from 'node:net';
import { whereTo } from './links.js';

export const READY_HOST = 'ready.drivepost.invalid';
export const WAITING = 'Starting the ad blocker'; // (browser/agent.js has the same two)

/*
 * The waiting page. An ad blocker comes up a moment after its browser does,
 * and a page opened in that moment would get its ads. So the browser is
 * started here, with the address that was asked for after the '#', and the
 * page finds out for itself when the blocker is at work, in the two ways a
 * blocker works:
 *
 *  - it asks this same made-up machine for three scripts with names every
 *    ad blocker stops, over and over. They are given (empty) until the
 *    blocker's rules are in place; then one fails to arrive.
 *  - it puts up small frames holding a box with an ad's name on it, over and
 *    over. A blocker that is at work inside pages hides the box.
 *
 * When both have happened it goes on to the page that was asked for; and
 * after six seconds it goes on regardless, so a blocker that works some other
 * way, or not at all, costs a wait and nothing else. On its way out it says
 * here which it was ('/up' or '/late'), so that the phone isn't told a blocker
 * is at work when it never came up.
 */
const WAIT_MS = 6000;
const WAIT_PAGE = `<!doctype html><meta charset="utf-8"><title>${WAITING}</title><body style="margin:0;background:#000"><script>
var to = ''; try { to = decodeURIComponent(location.hash.slice(1)); } catch (e) {}
var n = 0, rules = false, inPages = false, gone = false;
function leave() { if (to.indexOf('http://') === 0 || to.indexOf('https://') === 0) location.replace(to); to = ''; }
function go(up) {
  if (gone) return;
  gone = true;
  var t = setTimeout(leave, 500);
  var then = function () { clearTimeout(t); leave(); };
  try { fetch(up ? '/up' : '/late', { cache: 'no-store' }).then(then, then); } catch (e) { then(); }
}
function ready() { if (rules && inPages) go(true); }
function ask() {
  if (rules || gone) return;
  var left = 3;
  ['/prebid.js', '/ad_728x90.js', '/matomo.js'].forEach(function (name) {
    var s = document.createElement('script');
    s.onerror = function () { rules = true; ready(); };
    s.onload = function () { s.remove(); if (--left === 0) setTimeout(ask, 100); };
    s.src = name + '?' + (n++);
    document.head.appendChild(s);
  });
}
function box() {
  if (inPages || gone) return;
  var f = document.createElement('iframe');
  f.style.cssText = 'position:absolute;left:0;top:0;width:320px;height:120px;border:0;opacity:0';
  f.src = '/box?' + (n++);
  document.body.appendChild(f);
  setTimeout(function () { f.remove(); }, 700);
  setTimeout(box, 200);
}
addEventListener('message', function (e) { if (e.data === 'drivepost-box-hidden') { inPages = true; ready(); } });
setTimeout(function () { go(false); }, ${WAIT_MS});
ask(); box();
</script>`;
const WAIT_BOX = `<!doctype html><meta charset="utf-8"><body><div id="ad_banner" class="adsbox ad-banner adbanner">ad</div><script>
var k = 0;
(function see() {
  if (getComputedStyle(document.getElementById('ad_banner')).display === 'none') return parent.postMessage('drivepost-box-hidden', '*');
  if (++k < 12) setTimeout(see, 50);
})();
</script>`;
function waiting(u, res, said) {
  if (said && (u.pathname === '/up' || u.pathname === '/late')) said(u.pathname === '/up');
  const [body, type] = u.pathname === '/' ? [WAIT_PAGE, 'text/html'] : u.pathname === '/box' ? [WAIT_BOX, 'text/html'] : ['', 'text/javascript'];
  res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}
const WHY = "DrivePost's browser doesn't open addresses on its own network.";
const AD = "Stopped by DrivePost's ad block list.";

function turnAway(socket, code, text) {
  const body = `${text}\n`;
  socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code] || 'Refused'}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

/*
 * Start it. `opts`: { port, allowed(address), blocked(name), waited(up), lookup, allowLocal, connect }.
 * `waited(up)` hears from the waiting page as it leaves: whether the browser's ad blocker came up in time.
 * Returns the http.Server (its 'listening' and 'error' events are the caller's to hear).
 */
export function startGuard({ port, host = '0.0.0.0', allowed, lookup, allowLocal, connect = net.connect, blocked = null, waited = null }) {
  const lead = (name) => whereTo(name, lookup, allowLocal);

  // http:// pages: the browser sends the whole address and this fetches it.
  const server = http.createServer(async (req, res) => {
    const deny = (code, text) => {
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
      res.end(`${text}\n`);
    };
    if (!allowed(req.socket.remoteAddress)) return deny(403, 'Not for you.');
    let u;
    try {
      u = new URL(req.url);
    } catch {
      return deny(400, 'This is a proxy for one browser, not a website.');
    }
    if (u.protocol !== 'http:') return deny(400, 'Only web addresses.');
    if (u.hostname === READY_HOST) return waiting(u, res, waited);
    if (blocked && blocked(u.hostname)) return deny(403, AD);
    let to;
    try {
      to = await lead(u.hostname);
    } catch {
      return deny(403, WHY);
    }
    // (Via is what a proxy says of itself; it also lets a site see it wasn't asked directly.)
    const headers = { ...req.headers, host: u.host, via: '1.1 drivepost' };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const up = http.request({ host: to.address, family: to.family, port: Number(u.port) || 80, method: req.method, path: u.pathname + u.search, headers, setHost: false }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (res.headersSent) res.destroy();
      else deny(502, "That site couldn't be reached.");
    });
    req.pipe(up);
  });

  // https:// pages (and anything else that asks for a straight line): the
  // browser names where it wants to be connected to.
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    if (!allowed(client.remoteAddress)) return turnAway(client, 403, 'Not for you.');
    const m = /^(\[[0-9a-f:.]+\]|[^:\s]+):(\d{1,5})$/i.exec(req.url || '');
    const port = m ? Number(m[2]) : 0;
    if (!m || port < 1 || port > 65535) return turnAway(client, 400, 'Where to?');
    if (blocked && blocked(m[1])) return turnAway(client, 403, AD);
    let to;
    try {
      to = await lead(m[1]);
    } catch {
      return turnAway(client, 403, WHY);
    }
    if (client.destroyed) return;
    let joined = false;
    const up = connect({ host: to.address, port, family: to.family });
    up.once('connect', () => {
      joined = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => {
      if (joined) client.destroy();
      else turnAway(client, 502, "That site couldn't be reached.");
    });
    up.on('close', () => client.destroy());
    client.on('close', () => up.destroy());
  });

  server.on('clientError', (err, socket) => socket.destroy());
  server.listen(port, host);
  return server;
}
