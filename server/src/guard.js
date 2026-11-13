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
 */
import http from 'node:http';
import net from 'node:net';
import { whereTo } from './links.js';

const WHY = "DrivePost's browser doesn't open addresses on its own network.";
const AD = "Stopped by DrivePost's ad block list.";

function turnAway(socket, code, text) {
  const body = `${text}\n`;
  socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code] || 'Refused'}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

/*
 * Start it. `opts`: { port, allowed(address), blocked(name), lookup, allowLocal, connect }.
 * Returns the http.Server (its 'listening' and 'error' events are the caller's to hear).
 */
export function startGuard({ port, host = '0.0.0.0', allowed, lookup, allowLocal, connect = net.connect, blocked = null }) {
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
