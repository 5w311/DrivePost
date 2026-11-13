/*
 * Talks to the browser this container runs, over the pipe it was started
 * with (Chrome's --remote-debugging-pipe: it reads commands on one extra
 * file handle and answers on another, each message ending in a zero byte).
 * A pipe rather than a port, so that no page the browser visits can find a
 * way to drive the browser itself.
 */
import { EventEmitter } from 'node:events';

export class Cdp extends EventEmitter {
  constructor(toBrowser, fromBrowser) {
    super();
    this.setMaxListeners(0);
    this.out = toBrowser;
    this.next = 1;
    this.waiting = new Map(); // id → { resolve, reject, method }
    this.closed = false;
    let held = Buffer.alloc(0);
    fromBrowser.on('data', (chunk) => {
      held = held.length ? Buffer.concat([held, chunk]) : chunk;
      for (;;) {
        const end = held.indexOf(0);
        if (end < 0) break;
        const text = held.subarray(0, end).toString('utf8');
        held = held.subarray(end + 1);
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          continue;
        }
        if (msg.id !== undefined) {
          const w = this.waiting.get(msg.id);
          if (!w) continue;
          this.waiting.delete(msg.id);
          if (msg.error) w.reject(new Error(`${w.method}: ${msg.error.message}`));
          else w.resolve(msg.result || {});
        } else if (msg.method) {
          // An event: by its name, with what it carries and the tab (session) it is about.
          this.emit(msg.method, msg.params || {}, msg.sessionId || null);
        }
      }
    });
    const gone = () => this.close();
    fromBrowser.on('close', gone);
    fromBrowser.on('error', gone);
    toBrowser.on('error', gone);
  }

  // Ask the browser to do something. `sessionId` names the tab; without it the browser as a whole.
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(`${method}: the browser has gone`));
    const id = this.next++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, method });
      this.out.write(JSON.stringify(msg) + '\0', (err) => {
        if (err && this.waiting.delete(id)) reject(new Error(`${method}: ${err.message}`));
      });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiting.values()) w.reject(new Error(`${w.method}: the browser has gone`));
    this.waiting.clear();
    this.emit('gone');
  }
}
