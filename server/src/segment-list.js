/*
 * Starting a segmented stream partway through.
 *
 * YouTube's "hls" streams are a list of short segments (a few seconds each)
 * for the picture and another for the sound. To start at, say, 12:34, ffmpeg
 * could be told to seek there itself, but its seeking in such a list can't be
 * relied on: the picture can begin a whole segment late, and the sound can
 * begin at the start of its segment while being labelled as the spot asked
 * for, which leaves it seconds out of step with the picture.
 *
 * So the server does the seeking. It writes ffmpeg a shorter list that begins
 * with the segment holding the spot, hands that over from a little web server
 * of its own (this machine only), and has ffmpeg read it from the top with the
 * stream's own timestamps left alone. The picture then begins on that
 * segment's first frame, at most one segment early, and the sound is cut to
 * begin exactly at the spot.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const attr = (line, name) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(line);
  return m ? m[1] : null;
};

// Tags that say something about the one segment that follows them.
const ABOUT_A_SEGMENT = /^#(EXTINF|EXT-X-BYTERANGE|EXT-X-DISCONTINUITY(?!-SEQUENCE)|EXT-X-PROGRAM-DATE-TIME|EXT-X-GAP|EXT-X-BITRATE)\b/;

/*
 * `text` is a finished list of segments fetched from `listUrl`. Returns the
 * same list starting at the segment that holds `startAt` (seconds), with
 * every address made absolute, and where that segment begins:
 * { text, begins }. Returns null for anything it can't safely cut: a list of
 * lists, a live list that is still growing, or one it doesn't understand.
 */
export function trimList(text, listUrl, startAt) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) return null;
  const abs = (uri) => new URL(uri, listUrl).href;
  // A tag that names a file of its own (a key, or a start-up section), with that address made absolute.
  const withAbsUri = (line) => {
    const uri = attr(line, 'URI');
    return uri ? line.replace(`URI="${uri}"`, `URI="${abs(uri)}"`) : line;
  };

  const head = []; // tags about the whole list
  const segments = []; // { tags, uri, length, key, map }
  let tags = []; // tags waiting for their segment's address
  let length = null;
  let key = null; // how the segments from here on are encrypted, if they are
  let map = null; // the start-up section the segments from here on need, if any
  let sequence = 0;
  let finished = false;

  try {
    for (const line of lines.slice(1)) {
      if (!line.startsWith('#')) {
        if (length === null) return null; // an address with no length: not a list of segments
        segments.push({ tags, uri: abs(line), length, key, map });
        tags = [];
        length = null;
      } else if (line.startsWith('#EXT-X-STREAM-INF') || line.startsWith('#EXT-X-MEDIA:') || line.startsWith('#EXT-X-I-FRAME')) {
        return null; // a list of lists
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        finished = true;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        sequence = parseInt(line.slice(line.indexOf(':') + 1), 10) || 0;
      } else if (line.startsWith('#EXT-X-KEY')) {
        key = withAbsUri(line);
      } else if (line.startsWith('#EXT-X-MAP')) {
        map = withAbsUri(line);
      } else if (line.startsWith('#EXTINF:')) {
        length = parseFloat(line.slice(8));
        if (!(length >= 0)) return null;
        tags.push(line);
      } else if (line.startsWith('#EXT-X-BYTERANGE')) {
        if (!line.includes('@')) return null; // "carries on from the last one": can't be cut loose
        tags.push(line);
      } else if (ABOUT_A_SEGMENT.test(line) || segments.length || tags.length) {
        tags.push(line);
      } else if (line.startsWith('#EXT')) {
        head.push(line);
      }
    }
  } catch {
    return null; // an address that isn't one
  }
  if (!finished || !segments.length) return null;

  // The last segment that begins at or before the spot.
  let first = 0;
  let begins = 0;
  for (let i = 0, at = 0; i < segments.length; at += segments[i].length, i++) {
    if (at > startAt) break;
    first = i;
    begins = at;
  }

  const out = ['#EXTM3U', ...head, `#EXT-X-MEDIA-SEQUENCE:${sequence + first}`];
  let lastKey = null;
  let lastMap = null;
  for (const s of segments.slice(first)) {
    if (s.map !== lastMap && s.map) out.push(s.map);
    if (s.key !== lastKey && s.key) out.push(s.key);
    lastMap = s.map;
    lastKey = s.key;
    out.push(...s.tags, s.uri);
  }
  out.push('#EXT-X-ENDLIST', '');
  return { text: out.join('\n'), begins };
}

// ---- handing a list to ffmpeg ----

const offered = new Map(); // token -> list text
let listening = null; // resolves to the port once the little server is up

function listen() {
  if (!listening) {
    listening = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const m = /^\/([a-f0-9]{32})\.m3u8$/.exec((req.url || '').split('?')[0]);
        const text = m ? offered.get(m[1]) : undefined;
        if (text === undefined) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Content-Length': Buffer.byteLength(text),
          'Cache-Control': 'no-store',
        });
        res.end(text);
      });
      server.on('error', (err) => {
        listening = null;
        reject(err);
      });
      // This machine only, on whatever port is free. Nothing outside can reach it.
      server.listen(0, '127.0.0.1', () => {
        server.unref();
        resolve(server.address().port);
      });
    });
  }
  return listening;
}

// Make `text` fetchable by ffmpeg. Returns its address and a function to take it away again.
export async function offerList(text) {
  const port = await listen();
  const token = randomBytes(16).toString('hex');
  offered.set(token, text);
  return { url: `http://127.0.0.1:${port}/${token}.m3u8`, done: () => offered.delete(token) };
}
