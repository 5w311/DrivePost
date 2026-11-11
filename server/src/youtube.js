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
 * The ways to get a video out of YouTube, best first.
 *
 * YouTube closes one or another of these from time to time, for some
 * connections and not for others: the lookup still works and hands out
 * links, but the links answer 403. So the server doesn't count on any one
 * of them. It tries them in this order, checks that the link really
 * delivers before playing, and remembers which one worked.
 *
 *   direct  the separate picture and sound files, up to 1080p. Best quality
 *           and the quickest to skip around in.
 *   hls     the stream in short segments that YouTube gives embedded
 *           players and Apple devices, also up to 1080p.
 *   basic   the one small ready-made file (360p) every video has.
 */
export const ROUTES = [
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
}

export function routeNotice(name) {
  return routeNamed(name).notice || '';
}

// Does this link really hand over the video? Asks for the first few bytes
// (or, for a segmented stream, its list and then the first segment) and
// returns the answer's status: 200 or 206 means yes, 403 is a refusal.
export async function linkStatus(input, fetchImpl = fetch) {
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
  // The first line that isn't a comment is the first segment (or a list of its own).
  const first = list.text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!first) return 200;
  try {
    return (await ask(new URL(first, input.url).href, true)).status;
  } catch {
    return 200; // couldn't tell; ffmpeg will find out
  }
}

// Media links (and headers) for ffmpeg to read, got by one of the routes above.
export function streamInfo(id, quality, routeName = 'direct') {
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
    });
  }
  return streamCache.get(`${id}:${height}:${route.name}`, async () => {
    const json = JSON.parse(
      await ytdlp([...route.args, '-J', '--no-playlist', '-f', route.format(height), `https://www.youtube.com/watch?v=${id}`], 60000)
    );
    const formats = json.requested_formats && json.requested_formats.length ? json.requested_formats : [json];
    const inputs = formats
      .filter((f) => f && f.url)
      .map((f) => ({
        url: f.url,
        headers: f.http_headers || json.http_headers || {},
        hasVideo: !!f.vcodec && f.vcodec !== 'none',
        hasAudio: !!f.acodec && f.acodec !== 'none',
        fps: typeof f.fps === 'number' ? f.fps : null,
        vcodec: typeof f.vcodec === 'string' ? f.vcodec : '',
        tbr: typeof f.vbr === 'number' && f.vbr > 0 ? f.vbr : typeof f.tbr === 'number' ? f.tbr : null,
        height: typeof f.height === 'number' ? f.height : null,
        // A segmented stream: the link is a list of segments, not the file itself.
        list: /m3u8/i.test(f.protocol || '') || /\.m3u8(\?|$)/i.test(f.url),
      }));
    if (!inputs.length) throw new Error('No playable format found');
    // Which of YouTube's formats these are and how they are delivered, for the log
    // when a video won't start: e.g. "137+140 https via TVHTML5 from rr5---sn-x.googlevideo.com".
    const described = (() => {
      try {
        const picked = formats.filter((f) => f && f.url);
        const first = new URL(picked[0].url);
        const ids = picked.map((f) => f.format_id).filter(Boolean).join('+');
        const protocols = [...new Set(picked.map((f) => f.protocol).filter(Boolean))].join('/');
        const client = first.searchParams.get('c');
        return `${ids || '?'} ${protocols || '?'}${client ? ` via ${client}` : ''} from ${first.hostname}`;
      } catch {
        return '';
      }
    })();
    // A single muxed format may not report codecs; assume it has both.
    if (inputs.length === 1 && !inputs[0].hasVideo && !inputs[0].hasAudio) {
      inputs[0].hasVideo = true;
      inputs[0].hasAudio = true;
    }
    return {
      at: Date.now(), // when these links were looked up; they go stale
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
  // By the route a video would be played by right now.
  streamInfo(id, quality, routeOrder()[0]).then(
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
