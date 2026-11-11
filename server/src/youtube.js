import { spawn } from 'node:child_process';
import { config } from './config.js';

export const TEST_PATTERN_ID = 'test-pattern';
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isValidId(id) {
  return typeof id === 'string' && (ID_RE.test(id) || id === TEST_PATTERN_ID);
}

export function thumbFor(id) {
  return id === TEST_PATTERN_ID ? '' : `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}

export const TEST_PATTERN_ITEM = {
  id: TEST_PATTERN_ID,
  title: 'Test pattern',
  channel: 'Built in, no YouTube needed',
  duration: 600,
  live: false,
};

// Pull a YouTube video ID out of a link or any shared text.
export function extractVideoId(text) {
  if (!text) return null;
  const s = String(text).trim();
  if (ID_RE.test(s)) return s;
  const patterns = [
    /youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#\s]*&)?v=|embed\/|shorts\/|live\/|v\/)([A-Za-z0-9_-]{11})/i,
    /youtu\.be\/([A-Za-z0-9_-]{11})/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

function baseArgs() {
  const args = ['--no-warnings'];
  if (config.ytdlp.jsRuntime) args.push('--js-runtimes', config.ytdlp.jsRuntime);
  return args.concat(config.ytdlp.extraArgs);
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ${bin}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else {
        const line = err.trim().split('\n').filter((l) => /ERROR/.test(l)).pop() || err.trim().split('\n').pop() || '';
        reject(new Error(line.replace(/^ERROR:\s*/, '').slice(0, 300) || `${bin} exited with ${code}`));
      }
    });
  });
}

function ytdlp(args, timeoutMs = 45000) {
  return run(config.ytdlp.bin, baseArgs().concat(args), timeoutMs);
}

// Small TTL cache that also shares in-flight promises.
class Cache {
  constructor(ttlMs, max = 200) {
    this.ttl = ttlMs;
    this.max = max;
    this.map = new Map();
  }
  get(key, make) {
    const hit = this.map.get(key);
    if (hit && hit.exp > Date.now()) return hit.value;
    const value = make();
    this.map.set(key, { value, exp: Date.now() + this.ttl });
    value.catch(() => this.map.delete(key));
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return value;
  }
}

const searchCache = new Cache(10 * 60 * 1000);
const metaCache = new Cache(24 * 60 * 60 * 1000, 500);
const streamCache = new Cache(3 * 60 * 60 * 1000); // YouTube media URLs last about 6 hours

function toItem(e) {
  return {
    id: e.id,
    title: e.title || 'Untitled',
    channel: e.channel || e.uploader || '',
    duration: typeof e.duration === 'number' ? Math.round(e.duration) : null,
    live: e.live_status === 'is_live' || e.is_live === true,
    thumb: thumbFor(e.id),
  };
}

export function search(query, count = 20) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return Promise.resolve([]);
  return searchCache.get(q.toLowerCase(), async () => {
    const json = JSON.parse(await ytdlp(['--flat-playlist', '--dump-single-json', `ytsearch${count}:${q}`]));
    return (json.entries || []).filter((e) => e && ID_RE.test(e.id)).map(toItem);
  });
}

// Search suggestions while typing, from the same service youtube.com uses.
// Best effort: any failure just means no suggestions.
const suggestCache = new Cache(10 * 60 * 1000, 500);
export function suggest(query) {
  const q = String(query || '').trim().slice(0, 100);
  if (q.length < 2) return Promise.resolve([]);
  return suggestCache.get(q.toLowerCase(), async () => {
    const url = `${config.suggestUrl}?client=firefox&ds=yt&ie=utf8&oe=utf8&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`suggestions returned ${res.status}`);
    const json = JSON.parse(new TextDecoder('utf-8').decode(await res.arrayBuffer()));
    const list = Array.isArray(json) && Array.isArray(json[1]) ? json[1] : [];
    return list.filter((x) => typeof x === 'string' && x.trim()).slice(0, 8);
  });
}

// Title and channel for a shared link. oEmbed is fast; yt-dlp is the fallback.
export function videoMeta(id) {
  if (id === TEST_PATTERN_ID) return Promise.resolve({ ...TEST_PATTERN_ITEM, thumb: '' });
  return metaCache.get(id, async () => {
    try {
      const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const j = await res.json();
        return { id, title: j.title || 'Untitled', channel: j.author_name || '', duration: null, live: false, thumb: thumbFor(id) };
      }
    } catch {}
    const json = JSON.parse(await ytdlp(['-J', '--no-playlist', '--skip-download', `https://www.youtube.com/watch?v=${id}`]));
    return toItem(json);
  });
}

const HEIGHTS = { 360: 360, 480: 480, 720: 720, 1080: 1080 };

/*
 * The ways to get a video out of YouTube, first choice first.
 *
 * Two things can stand between a lookup and a video that plays:
 *
 * - A wait. Where an ad would play first, YouTube refuses the media (403)
 *   until the ad's time is up, typically several seconds after the lookup.
 *   yt-dlp reports when each file becomes available, and the server holds
 *   off until then.
 * - A refusal. YouTube closes one way of fetching or another from time to
 *   time, for some connections and not others. The lookup still hands out
 *   links; they just keep answering 403.
 *
 * So the server doesn't count on any one route. It checks that a link
 * really delivers before playing, puts a refused route at the back for a
 * while, and when the first choice is behind a long wait it starts with
 * one that is ready.
 *
 *   hls     the stream in short segments that YouTube gives embedded
 *           players, up to 1080p. No ad break in front of it, and it
 *           comes in many times faster than it plays.
 *   direct  the separate picture and sound files, up to 1080p. Usually
 *           behind a wait of a few seconds, and YouTube feeds a plain
 *           download of them at barely twice the speed they play at.
 *   basic   the one small ready-made file (360p) every video has.
 *
 * (Measured from a home connection in November 2026 with
 * src/check-youtube.js: hls no wait and 23x, direct a 4 second wait and
 * 1.8x, basic a 5 second wait and 200x.)
 */
export const ROUTES = [
  {
    name: 'hls',
    // The usual sources plus the embedded player, which is the one that has these streams.
    args: ['--extractor-args', 'youtube:player_client=default,web_embedded'],
    format: (height) =>
      [
        `bv*[height<=${height}][vcodec^=avc1][protocol^=m3u8]+ba[protocol^=m3u8]`,
        `b[height<=${height}][vcodec^=avc1][protocol^=m3u8]`,
        `bv*[height<=${height}][protocol^=m3u8]+ba[protocol^=m3u8]`,
        `b[height<=${height}][protocol^=m3u8]`,
      ].join('/'),
  },
  {
    name: 'direct',
    args: [],
    // Prefer H.264 + AAC: cheap to decode, and it can be passed straight on to the car.
    format: (height) =>
      [
        `bv*[height<=${height}][vcodec^=avc1][protocol^=http]+ba[acodec^=mp4a][audio_channels<=2][protocol^=http]`,
        `bv*[height<=${height}][vcodec^=avc1][protocol^=http]+ba[acodec^=mp4a][protocol^=http]`,
        `bv*[height<=${height}][vcodec^=avc1][protocol^=http]+ba[protocol^=http]`,
        `bv*[height<=${height}][protocol^=http]+ba[protocol^=http]`,
        `b[height<=${height}]`,
        'b',
      ].join('/'),
  },
  {
    name: 'basic',
    args: [],
    format: () => '18/b[height<=360][protocol^=http]/b[protocol^=http]',
    // What to tell people when this is all there is.
    notice: 'YouTube is only letting this server have its basic 360p version right now, so that is what is playing.',
  },
];

const routeNamed = (name) => ROUTES.find((r) => r.name === name) || ROUTES[0];

// Routes YouTube refused lately: when, and how many times in a row.
const RETRY_AFTER = 30 * 60 * 1000;
const RETRY_AFTER_MOST = 6 * 60 * 60 * 1000;
const refused = new Map(); // name -> { at, times }
let using = null; // the route in use, only so a change shows up in the log

function resting(name, now) {
  const r = refused.get(name);
  return !!r && now - r.at < Math.min(RETRY_AFTER * 2 ** (r.times - 1), RETRY_AFTER_MOST);
}

// The order to try routes in right now: best first, with the ones refused
// lately at the back. A refused route gets another go after half an hour,
// then an hour, and so on up to six, so the server finds its way back to
// the better routes once YouTube lets them through again. (Refused routes
// are still tried last rather than not at all: the wait is only a guess.)
export function routeOrder(now = Date.now()) {
  const names = ROUTES.map((r) => r.name);
  return [...names.filter((n) => !resting(n, now)), ...names.filter((n) => resting(n, now))];
}

export function routeWorked(name) {
  if (using !== name) console.log(`[youtube] getting videos by the "${name}" route`);
  using = name;
  refused.delete(name);
}

export function routeRefused(name, why) {
  console.warn(`[youtube] the "${name}" route was refused${why ? ` (${why})` : ''}`);
  const before = refused.get(name);
  refused.set(name, { at: Date.now(), times: before ? before.times + 1 : 1 });
}

export function forgetRoutes() {
  using = null;
  refused.clear();
  nothingFor.clear();
}

export function routeNotice(name) {
  return routeNamed(name).notice || '';
}

// Does this link really hand over the video? Asks for the first few bytes
// (or, for a segmented stream, its list and then the first segment) and
// returns the answer's status: 200 or 206 means yes, 403 is a refusal. A
// segmented stream's list is also put in `lists` (a Map, by input) when one is
// given, for starting partway through it: see segment-list.js.
export async function linkStatus(input, fetchImpl = fetch, lists = null) {
  const ask = async (url, range) => {
    const res = await fetchImpl(url, {
      headers: { ...(input.headers || {}), ...(range ? { Range: 'bytes=0-1023' } : {}) },
      signal: AbortSignal.timeout(10000),
    });
    const text = range ? '' : await res.text().catch(() => '');
    if (range && res.body) await res.body.cancel().catch(() => {});
    return { status: res.status, text };
  };
  if (!input.list) return (await ask(input.url, true)).status;
  const list = await ask(input.url, false);
  if (list.status !== 200) return list.status;
  if (lists) lists.set(input, list.text);
  // The first line that isn't a comment is the first segment (or a list of its own).
  const first = list.text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!first) return 200;
  try {
    return (await ask(new URL(first, input.url).href, true)).status;
  } catch {
    return 200; // couldn't tell; ffmpeg will find out
  }
}

/*
 * Which of the formats yt-dlp picked carry the picture and which the sound.
 *
 * yt-dlp says 'none' for a format that has no picture (or no sound), names
 * the codec when it knows it, and says nothing when it doesn't know. Not
 * knowing isn't not having: the sound of a segmented stream comes with no
 * codec named, and treating that as "no sound" plays the video silent.
 *
 * So: a named codec is a yes and 'none' is a no. If no format is a definite
 * yes for the picture, the first one that might have it does; if none is a
 * definite yes for the sound, the last one that might have it does (yt-dlp
 * lists the picture first and the sound last). A format on its own that names
 * neither therefore counts as having both.
 */
export function whatEachHas(formats) {
  const has = (codec) => (codec === 'none' ? false : typeof codec === 'string' && codec ? true : null);
  const out = formats.map((f) => ({ hasVideo: has(f.vcodec), hasAudio: has(f.acodec) }));
  if (!out.some((o) => o.hasVideo === true)) {
    const maybe = out.find((o) => o.hasVideo === null);
    if (maybe) maybe.hasVideo = true;
  }
  if (!out.some((o) => o.hasAudio === true)) {
    const maybe = [...out].reverse().find((o) => o.hasAudio === null);
    if (maybe) maybe.hasAudio = true;
  }
  return out.map((o) => ({ hasVideo: o.hasVideo === true, hasAudio: o.hasAudio === true }));
}

// "This route has nothing for this video", as opposed to anything being wrong
// with the video. One that can't be embedded has no "hls" stream, for one.
export const NO_SUCH_FORMAT = /format is not available|no playable format/i;
// Remembered for a while, so playing such a video doesn't start with a lookup
// that is known to come back empty.
const NOTHING_FOR_MS = 60 * 60 * 1000;
const nothingFor = new Map(); // "id:height:route" -> when that was found out

// Media links (and headers) for ffmpeg to read, got by one of the routes above.
export function streamInfo(id, quality, routeName = ROUTES[0].name) {
  const height = HEIGHTS[quality] || 480;
  const route = routeNamed(routeName);
  if (id === TEST_PATTERN_ID) {
    return Promise.resolve({
      title: TEST_PATTERN_ITEM.title,
      duration: TEST_PATTERN_ITEM.duration,
      live: false,
      // Generated at the requested size, so 1080p really exercises 1080p.
      inputs: [
        { lavfi: `testsrc2=size=${Math.round((height * 16) / 18) * 2}x${height}:rate=30:duration=${TEST_PATTERN_ITEM.duration}`, hasVideo: true, hasAudio: false },
        { lavfi: `sine=frequency=330:beep_factor=2:sample_rate=48000:duration=${TEST_PATTERN_ITEM.duration},volume=0.2`, hasVideo: false, hasAudio: true },
      ],
      height,
      fps: 30,
      vcodec: 'generated',
      tbr: null,
      route: 'built in',
      routeName: 'direct',
      readyAt: 0,
    });
  }
  const key = `${id}:${height}:${route.name}`;
  if (Date.now() - (nothingFor.get(key) || 0) < NOTHING_FOR_MS) {
    return Promise.reject(new Error(`Requested format is not available by the "${route.name}" route`));
  }
  return streamCache.get(key, async () => {
    let json;
    try {
      json = JSON.parse(
        await ytdlp([...route.args, '-J', '--no-playlist', '-f', route.format(height), `https://www.youtube.com/watch?v=${id}`], 60000)
      );
    } catch (err) {
      if (NO_SUCH_FORMAT.test(err.message || '')) {
        nothingFor.set(key, Date.now());
        if (nothingFor.size > 500) nothingFor.delete(nothingFor.keys().next().value);
      }
      throw err;
    }
    const formats = json.requested_formats && json.requested_formats.length ? json.requested_formats : [json];
    const picked = formats.filter((f) => f && f.url);
    const each = whatEachHas(picked);
    const inputs = picked
      .map((f, i) => ({
        url: f.url,
        headers: f.http_headers || json.http_headers || {},
        hasVideo: each[i].hasVideo,
        hasAudio: each[i].hasAudio,
        fps: typeof f.fps === 'number' ? f.fps : null,
        vcodec: typeof f.vcodec === 'string' ? f.vcodec : '',
        // What YouTube says this one is, for the check tool: "234 m3u8_native mp4a.40.2 44100Hz 2ch".
        what: [
          f.format_id,
          f.protocol,
          f.vcodec && f.vcodec !== 'none' ? f.vcodec : '',
          f.acodec && f.acodec !== 'none' ? f.acodec : '',
          f.asr ? `${f.asr}Hz` : '',
          f.audio_channels ? `${f.audio_channels}ch` : '',
          f.language ? `lang ${f.language}` : '',
          f.format_note,
        ]
          .filter(Boolean)
          .join(' '),
        tbr: typeof f.vbr === 'number' && f.vbr > 0 ? f.vbr : typeof f.tbr === 'number' ? f.tbr : null,
        height: typeof f.height === 'number' ? f.height : null,
        // When YouTube will start handing this file over (see ROUTES): yt-dlp's available_at, in ms.
        readyAt: typeof f.available_at === 'number' && f.available_at > 0 ? f.available_at * 1000 : 0,
        // A segmented stream: the link is a list of segments, not the file itself.
        list: /m3u8/i.test(f.protocol || '') || /\.m3u8(\?|$)/i.test(f.url),
      }));
    if (!inputs.length) throw new Error('No playable format found');
    // Which of YouTube's formats these are and how they are delivered, for the log
    // when a video won't start: e.g. "137+140 https via TVHTML5 from rr5---sn-x.googlevideo.com".
    const described = (() => {
      try {
        const first = new URL(picked[0].url);
        const ids = picked.map((f) => f.format_id).filter(Boolean).join('+');
        const protocols = [...new Set(picked.map((f) => f.protocol).filter(Boolean))].join('/');
        const client = first.searchParams.get('c');
        return `${ids || '?'} ${protocols || '?'}${client ? ` via ${client}` : ''} from ${first.hostname}`;
      } catch {
        return '';
      }
    })();
    return {
      at: Date.now(), // when these links were looked up; they go stale
      // The moment every file of this video can be fetched. 0 when there is no wait.
      readyAt: Math.max(0, ...inputs.map((i) => i.readyAt || 0)),
      title: json.title || '',
      duration: typeof json.duration === 'number' ? json.duration : null,
      live: json.is_live === true,
      inputs,
      // What was really found, which can be less than what was asked for.
      height: Math.min(height, (inputs.find((i) => i.hasVideo) || {}).height || height),
      fps: (inputs.find((i) => i.hasVideo) || {}).fps || (typeof json.fps === 'number' ? json.fps : null),
      // What YouTube encoded the picture with (avc1 = H.264) and at what rate.
      vcodec: (inputs.find((i) => i.hasVideo) || {}).vcodec || (typeof json.vcodec === 'string' ? json.vcodec : ''),
      tbr: (inputs.find((i) => i.hasVideo) || {}).tbr || null,
      route: `${route.name}: ${described}`,
      routeName: route.name,
    };
  });
}

// Look a video up ahead of time, so it starts without the usual wait. Used
// for what's playing and what's next in line. Failures are remembered for a
// minute so a blocked video isn't retried on every queue change.
const prewarmFailed = new Map();
export function prewarm(id, quality) {
  if (!isValidId(id) || id === TEST_PATTERN_ID) return;
  const key = `${id}:${quality}`;
  const failedAt = prewarmFailed.get(key);
  if (failedAt && Date.now() - failedAt < 60000) return;
  // By the route a video would be played by right now. If that one has
  // nothing for this video, by the next: its wait (see ROUTES) is then over
  // by the time the video comes up.
  const order = routeOrder();
  const look = (i) =>
    streamInfo(id, quality, order[i]).catch((err) => {
      if (i + 1 < order.length && NO_SUCH_FORMAT.test(err.message || '')) return look(i + 1);
      throw err;
    });
  look(0).then(
    () => prewarmFailed.delete(key),
    () => {
      prewarmFailed.set(key, Date.now());
      if (prewarmFailed.size > 200) prewarmFailed.delete(prewarmFailed.keys().next().value);
    }
  );
}

export function forgetStream(id, quality) {
  for (const r of ROUTES) streamCache.map.delete(`${id}:${HEIGHTS[quality] || 480}:${r.name}`);
}

// Keep yt-dlp current; YouTube changes often and old versions stop working.
export function startAutoUpdate() {
  const cmd = config.ytdlp.updateCmd;
  if (!cmd.length) return;
  const update = () =>
    run(cmd[0], cmd.slice(1), 5 * 60 * 1000)
      .then(() => console.log('yt-dlp update check done'))
      .catch((e) => console.warn('yt-dlp update failed:', e.message));
  update();
  setInterval(update, 24 * 60 * 60 * 1000).unref();
}
