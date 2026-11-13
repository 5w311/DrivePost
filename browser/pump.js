/*
 * Keeps the picture of the page coming at a steady pace.
 *
 * A browser only hands over a new frame of a captured tab when something on
 * it changes. A still picture (a paused video, a page nobody is
 * scrolling) is then a recording with no picture in it for as long as it
 * lasts, and whoever plays it falls that far behind for good once it moves
 * again. So every frame is passed on as it comes, and whenever none has come
 * for a moment the last one is sent again.
 *
 * This runs in a worker because a page's own timers slow to a crawl once its
 * tab is in the background, which is where the sharing page is while you
 * look at what you are sharing. A worker's timers keep their pace.
 */
'use strict';

var EVERY_MS = 100; // a still picture is sent again this often
var last = null; // a copy of the newest frame, to send again
var lastAt = 0; // when a frame last went out
var lastStamp = -1; // ...and the time written on it (microseconds)
var writer = null;
var over = false;
var told = false;

function out(frame) {
  // The recorder isn't taking frames just now: this one isn't needed.
  if (over || (writer.desiredSize !== null && writer.desiredSize <= 0)) {
    frame.close();
    return;
  }
  lastStamp = frame.timestamp;
  lastAt = performance.now();
  writer.write(frame).catch(function () {
    over = true;
  });
  if (!told) {
    told = true;
    self.postMessage({ flowing: true });
  }
}

/*
 * The last frame once more, as a frame of its own. A plain copy of it would
 * still carry the moment the original was captured, and the recorder goes by
 * that: frames that all claim the same moment are a picture standing still in
 * time, and the recording stops (its sound too, which waits for the picture).
 * So the copy is drawn afresh, which makes it a new frame from now.
 */
var sheet = null; // the last frame, drawn once for all its repeats
var drawn = false;
function again() {
  if (over || !last) return;
  var waited = performance.now() - lastAt;
  if (waited < EVERY_MS) return;
  var stamp = lastStamp + Math.round(waited * 1000);
  var copy;
  try {
    if (typeof OffscreenCanvas === 'function') {
      if (!drawn) {
        var w = last.displayWidth;
        var h = last.displayHeight;
        if (!sheet || sheet.width !== w || sheet.height !== h) sheet = new OffscreenCanvas(w, h);
        sheet.getContext('2d', { alpha: false }).drawImage(last, 0, 0, w, h);
        drawn = true;
      }
      copy = new VideoFrame(sheet, { timestamp: stamp });
    } else copy = new VideoFrame(last, { timestamp: stamp });
  } catch (e) {
    return;
  }
  out(copy);
}

self.onmessage = function (ev) {
  var d = ev.data || {};
  if (d.stop) {
    over = true;
    if (last) last.close();
    last = null;
    return;
  }
  if (!d.readable || !d.writable) return;
  var reader = d.readable.getReader();
  writer = d.writable.getWriter();
  setInterval(again, 25);
  (function next() {
    reader.read().then(function (r) {
      if (r.done || over) {
        over = true;
        return;
      }
      var frame = r.value;
      // Time only moves forward: a frame stamped earlier than one already
      // sent (a repeat went out just ahead of it) is stamped just after it.
      if (frame.timestamp <= lastStamp) {
        var fixed = new VideoFrame(frame, { timestamp: lastStamp + 1000 });
        frame.close();
        frame = fixed;
      }
      if (last) last.close();
      last = frame.clone();
      drawn = false;
      out(frame);
      next();
    }, function () {
      over = true;
    });
  })();
};
