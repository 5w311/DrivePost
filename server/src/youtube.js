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

function formatFor(height) {
  // Prefer H.264 + AAC: cheap to decode, so a Raspberry Pi keeps up.
  return [
    `bv*[height<=${height}][vcodec^=avc1]+ba[acodec^=mp4a][audio_channels<=2]`,
    `bv*[height<=${height}][vcodec^=avc1]+ba[acodec^=mp4a]`,
    `bv*[height<=${height}][vcodec^=avc1]+ba`,
    `bv*[height<=${height}]+ba`,
    `b[height<=${height}]`,
    'b',
  ].join('/');
}

// Direct media URLs (and headers) for ffmpeg to read.
export function streamInfo(id, quality) {
  const height = HEIGHTS[quality] || 480;
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
    });
  }
  return streamCache.get(`${id}:${height}`, async () => {
    const json = JSON.parse(
      await ytdlp(['-J', '--no-playlist', '-f', formatFor(height), `https://www.youtube.com/watch?v=${id}`], 60000)
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
      }));
    if (!inputs.length) throw new Error('No playable format found');
    // A single muxed format may not report codecs; assume it has both.
    if (inputs.length === 1 && !inputs[0].hasVideo && !inputs[0].hasAudio) {
      inputs[0].hasVideo = true;
      inputs[0].hasAudio = true;
    }
    return {
      title: json.title || '',
      duration: typeof json.duration === 'number' ? json.duration : null,
      live: json.is_live === true,
      inputs,
      height,
      fps: (inputs.find((i) => i.hasVideo) || {}).fps || (typeof json.fps === 'number' ? json.fps : null),
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
  streamInfo(id, quality).then(
    () => prewarmFailed.delete(key),
    () => {
      prewarmFailed.set(key, Date.now());
      if (prewarmFailed.size > 200) prewarmFailed.delete(prewarmFailed.keys().next().value);
    }
  );
}

export function forgetStream(id, quality) {
  streamCache.map.delete(`${id}:${HEIGHTS[quality] || 480}`);
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
