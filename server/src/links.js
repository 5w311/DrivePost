/*
 * Videos from somewhere other than YouTube: a link to a post on X, Reddit or
 * Instagram, to a page with a video player on it, or straight to a video file.
 *
 * yt-dlp knows how to find the video behind a great many sites' links, and
 * reads any other page for a player the way a browser would. So the link is
 * handed to yt-dlp, which answers with what the video is called and every
 * version of it the site has. The server picks the version that suits the
 * car, has ffprobe look at what it really is, and from there it is played
 * like any other video: passed through when it is H.264 the car can decode,
 * converted when it isn't.
 *
 * Such a video is known by an ID made from its address ("link-" and sixteen
 * characters), and its row carries the address. Search and For You stay
 * YouTube's: there is nothing to search on a link, and nothing like it to
 * recommend.
 *
 * Fetching whatever address someone pastes is a way to make a server reach
 * things only it can reach, so an address is checked before anything is
 * fetched from it: see addressAllowed.
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';
import { Cache, run, ytdlp, isValidId, thumbFor, HEIGHTS } from './youtube.js';

const LINK_ID = /^link-[0-9a-f]{16}$/;
export const isLinkId = (id) => typeof id === 'string' && LINK_ID.test(id);
// Anything the car can be asked to play: a YouTube video, the test pattern, or a link.
export const isPlayableId = (id) => isValidId(id) || isLinkId(id);
export const linkId = (url) => `link-${crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 16)}`;

// Additions to a shared link that say who shared it and from where, not which video it is.
const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|igsh|igshid|share_id|ref_src|ref_url)$/i;

/*
 * The web address in a piece of text (what a share sheet hands over is often
 * a sentence with the link in it), tidied so the same video shared twice is
 * the same address. null when there isn't one.
 */
export function linkIn(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 4000) return null;
  let raw = (s.match(/https?:\/\/[^\s<>"'`]+/i) || [])[0];
  // "x.com/someone/status/1", typed or copied without the https://
  if (!raw && /^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(s)) raw = `https://${s}`;
  if (!raw) return null;
  // Punctuation from the sentence it sat in.
  raw = raw.replace(/[.,!?;:]+$/, '');
  if (raw.endsWith(')') && !raw.includes('(')) raw = raw.slice(0, -1);
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname) return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  const drop = [...new Set(u.searchParams.keys())].filter((name) => TRACKING.test(name));
  // X adds who shared a post, as ?s= and ?t=.
  if (/(^|\.)(x|twitter)\.com$/i.test(u.hostname)) drop.push(...['s', 't'].filter((name) => u.searchParams.has(name)));
  for (const name of drop) u.searchParams.delete(name);
  return u.href.length <= 2000 ? u.href : null;
}

// A link as a row carries it: one address, http or https, nobody's password in it.
export function isLinkAddress(url) {
  if (typeof url !== 'string' || url.length > 2000 || /\s/.test(url)) return false;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

const SITES = [
  [/(^|\.)(x\.com|twitter\.com|t\.co)$/, 'X'],
  [/(^|\.)(reddit\.com|redd\.it)$/, 'Reddit'],
  [/(^|\.)(instagram\.com|instagr\.am)$/, 'Instagram'],
  [/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/, 'Facebook'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'],
  [/(^|\.)vimeo\.com$/, 'Vimeo'],
  [/(^|\.)twitch\.tv$/, 'Twitch'],
  [/(^|\.)(dailymotion\.com|dai\.ly)$/, 'Dailymotion'],
  [/(^|\.)threads\.(net|com)$/, 'Threads'],
  [/(^|\.)bsky\.app$/, 'Bluesky'],
  [/(^|\.)streamable\.com$/, 'Streamable'],
  [/(^|\.)imgur\.com$/, 'Imgur'],
  [/(^|\.)rumble\.com$/, 'Rumble'],
];

// What to call where a link goes: "X", "Reddit", or the site's own name ("example.com").
export function siteOf(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {}
  const known = SITES.find(([re]) => re.test(host));
  if (known) return known[1];
  return host.replace(/^(www|m|mobile)\./, '').slice(0, 60) || 'that site';
}

// ---- which link an ID stands for ----
// A stream is asked for by ID. The address comes with the row, so every row
// that passes through (played, lined up, or read back after a restart) is
// noted here.
const known = new Map(); // id -> address
export function rememberLink(url) {
  const id = linkId(url);
  known.delete(id);
  known.set(id, url);
  if (known.size > 5000) known.delete(known.keys().next().value);
  return id;
}
export const urlOf = (id) => known.get(id) || null;

// ---- addresses the server won't fetch from ----

// Not out on the internet: this machine, the home network, and ranges set aside for other things.
const inside = new net.BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  inside.addSubnet(address, bits, 'ipv4');
}
for (const [address, bits] of [
  ['::', 127], // "no address" and this machine
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
]) {
  inside.addSubnet(address, bits, 'ipv6');
}

// An IPv6 address as its sixteen bytes, or null.
function bytesOf(ip) {
  let s = ip;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  const groups = tail === null ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (!/^[0-9a-f]{1,4}$/i.test(g) || !(n >= 0)) return null;
    out.push(n >> 8, n & 255);
  }
  return out;
}

// Is this address somewhere other than out on the internet? Anything that isn't an address counts as yes.
export function isPrivateAddress(address) {
  const ip = String(address || '').replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = net.isIP(ip);
  if (family === 4) return inside.check(ip, 'ipv4');
  if (family !== 6) return true;
  if (inside.check(ip, 'ipv6')) return true;
  const b = bytesOf(ip);
  if (!b) return true;
  const v4 = (from) => inside.check(b.slice(from, from + 4).join('.'), 'ipv4');
  const zero = (from, to) => b.slice(from, to).every((x) => x === 0);
  // An IPv4 address written as an IPv6 one, four ways.
  if (zero(0, 12)) return v4(12);
  if (zero(0, 10) && b[10] === 255 && b[11] === 255) return v4(12);
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return v4(12);
  if (b[0] === 0x20 && b[1] === 0x02) return v4(2);
  return false;
}

// Names that only mean something inside a network.
const INSIDE_NAMES = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa)$/i;
const REFUSED = "That link points inside this server's own network, which DrivePost doesn't open.";

/*
 * May the server fetch from this address? Throws, in words for the screen,
 * when it may not.
 *
 * The server sits on a home network and can reach what the internet can't:
 * the router's settings page, other machines, itself. So a link is only
 * followed when it is http or https and its name leads out onto the
 * internet. This is asked about the link that was pasted, about every media
 * address yt-dlp hands back, and about each hop of the server's own
 * requests. (yt-dlp and ffmpeg follow redirects by themselves, and those
 * aren't checked: a page out on the internet can still point them inward.
 * Nothing that comes back from such a request is shown to anyone.)
 *
 * OTHER_SITES_LOCAL=on lets links lead inward, for a video on a NAS.
 */
export async function addressAllowed(url, lookup = dns.lookup, allowLocal = config.links.local) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("That isn't a web address.");
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https links can be opened.');
  if (allowLocal) return;
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(REFUSED);
    return;
  }
  if (!host.includes('.') || INSIDE_NAMES.test(host)) throw new Error(REFUSED);
  let found;
  try {
    found = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Couldn't find ${host.slice(0, 60)}. Is the link right?`);
  }
  // Every address the name leads to, not just the first.
  if (!found.length || found.some((a) => isPrivateAddress(a.address))) throw new Error(REFUSED);
}

// fetch() that asks addressAllowed about the address and about wherever it is sent on to.
export async function guardedFetch(url, opts = {}) {
  let at = String(url);
  for (let hop = 0; hop < 6; hop++) {
    await addressAllowed(at);
    const res = await fetch(at, { ...opts, redirect: 'manual' });
    const to = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!to) return res;
    if (res.body) await res.body.cancel().catch(() => {});
    at = new URL(to, at).href;
  }
  throw new Error('sent from one address to the next too many times');
}

// What ffmpeg and ffprobe may use to read a link: the web, and nothing on this machine.
export const LINK_PROTOCOLS = 'http,https,tls,tcp,crypto,data,httpproxy';

// ---- what yt-dlp says about a link ----

// yt-dlp's (or a site's) reason for coming back empty-handed, in words for the screen.
export function plainly(message, site) {
  const said = String(message || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*\[[^\]]*\]\s*[^:\s]*:\s*/, '') // "[twitter] 12345: "
    .replace(/\s+/g, ' ')
    .trim();
  // yt-dlp keeps a cookies file up to date, and stops when it can't write to it.
  if (/permission denied|read-only file system/i.test(said)) {
    return 'The server can\'t write to its cookies file, which yt-dlp keeps up to date. The README\'s "Other sites" part has the fix.';
  }
  if (/unsupported url|no video (formats )?(could be |was )?found|no media found|there is no video|cannot parse data|not a video/i.test(said)) {
    return `No video was found at that link. If the page has one, ${site} may be showing it in a way yt-dlp can't read.`;
  }
  if (/log ?in|logged-in|sign in|authenticat|cookies|rate-limit|registered users|account/i.test(said)) {
    return `${site} only shows that video to signed-in visitors. The README's "Other sites" part says how to sign this server in.`;
  }
  if (/drm/i.test(said)) return 'That video is copy-protected, so it can only be played on the site itself.';
  if (/geo|not available in your (country|region|location)|from your location/i.test(said)) return `${site} doesn't show that video in this server's country.`;
  if (/private|removed|deleted|suspended|not available|unavailable|does not exist|no longer|HTTP Error 404|not found/i.test(said)) {
    return "That video isn't available: it may be private or removed, or the link may be wrong.";
  }
  if (/HTTP Error 429|too many requests/i.test(said)) return `${site} is turning this server away for now (too many requests).`;
  if (/HTTP Error 40[13]|forbidden/i.test(said)) return `${site} refused to show that page to this server.`;
  if (/timed out|temporary failure|name or service|getaddrinfo|connection (reset|refused)|unable to connect|unreachable|network/i.test(said)) {
    return `This server couldn't reach ${site}.`;
  }
  return said.slice(0, 160) || `Couldn't get that video from ${site}.`;
}

// The first thing in yt-dlp's answer that is a video: the answer itself, or the first entry of a page with several.
function videoIn(json, depth = 0) {
  if (!json || typeof json !== 'object' || depth > 3) return null;
  if (Array.isArray(json.entries)) {
    for (const entry of json.entries) {
      const found = videoIn(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  return (Array.isArray(json.formats) && json.formats.length) || typeof json.url === 'string' ? json : null;
}

// The headers to fetch a format with. yt-dlp keeps cookies apart from them,
// as "name=value; Domain=...; Path=...; name2=value2; ...".
function headersFor(f, video) {
  const headers = {};
  for (const [name, value] of Object.entries(f.http_headers || video.http_headers || {})) {
    if (typeof value === 'string' && !/[\r\n]/.test(name + value)) headers[name] = value;
  }
  if (typeof f.cookies === 'string' && f.cookies && !headers.Cookie) {
    const pairs = f.cookies
      .split(/;\s*/)
      .filter((part) => part.includes('=') && !/^(Domain|Path|Expires|Version|Max-Age|SameSite)=/i.test(part) && !/[\r\n]/.test(part));
    if (pairs.length) headers.Cookie = pairs.join('; ');
  }
  return headers;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

// One version of a video, with only what picking and playing need.
function slim(f, video) {
  return {
    id: String(f.format_id || ''),
    url: f.url,
    protocol: String(f.protocol || ''),
    ext: String(f.ext || ''),
    vcodec: typeof f.vcodec === 'string' ? f.vcodec : null,
    acodec: typeof f.acodec === 'string' ? f.acodec : null,
    width: num(f.width),
    height: num(f.height),
    fps: num(f.fps),
    tbr: num(f.vbr) || num(f.tbr),
    abr: num(f.abr) || num(f.tbr),
    note: String(f.format_note || ''),
    language: typeof f.language === 'string' ? f.language : '',
    languagePreference: typeof f.language_preference === 'number' ? f.language_preference : -1,
    preference: typeof f.preference === 'number' ? f.preference : 0,
    channels: num(f.audio_channels),
    soundOnly: f.resolution === 'audio only',
    drm: f.has_drm === true,
    pieces: Array.isArray(f.fragments), // delivered as many small files that yt-dlp would stitch together
    headers: headersFor(f, video),
  };
}

// How long what a site said is kept. Its media addresses can stop working
// sooner than that; they are tried before every use, and looked up afresh
// when they have (findLinked in stream.js). Asking less often also keeps the
// sites that count requests from turning the server away.
const LOOKUP_MS = 2 * 60 * 60 * 1000;
const lookups = new Cache(LOOKUP_MS, 300);

/*
 * Everything about the video at `url`: { site, title, channel, duration,
 * live, thumb, formats }, or { youtube: row } when the link turns out to be
 * a YouTube video after all (a page with YouTube's player on it), which then
 * plays as one. Kept for a couple of hours.
 */
export function lookup(url, deps = {}) {
  const ask = deps.ytdlp || ytdlp;
  const site = siteOf(url);
  return lookups.get(linkId(url), async () => {
    await addressAllowed(url, deps.lookup);
    let json;
    try {
      // The first video of a page that has several.
      json = JSON.parse(await ask([...config.links.extraArgs, '--socket-timeout', '20', '-J', '--no-playlist', '--playlist-items', '1', '--', url], 60000));
    } catch (err) {
      throw new Error(err instanceof SyntaxError ? plainly('no video found', site) : plainly(err.message, site));
    }
    const video = videoIn(json);
    if (!video) throw new Error(plainly('no video found', site));
    const duration = num(video.duration);
    const live = video.is_live === true || video.live_status === 'is_live';
    const title = String(video.title || video.fulltitle || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const channel = String(video.uploader || video.channel || video.creator || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (video.extractor_key === 'Youtube' && isValidId(video.id)) {
      return { youtube: { id: video.id, title: title || 'YouTube video', channel, duration: duration ? Math.round(duration) : null, live, thumb: thumbFor(video.id) } };
    }
    const formats = (Array.isArray(video.formats) && video.formats.length ? video.formats : [video])
      .filter((f) => f && typeof f.url === 'string')
      .map((f) => slim(f, video));
    const thumb = typeof video.thumbnail === 'string' && /^https:\/\/[^\s"'<>]+$/.test(video.thumbnail) && video.thumbnail.length <= 1000 ? video.thumbnail : '';
    return { at: Date.now(), site, title: title || `Video from ${site}`, channel, duration, live, thumb, formats };
  });
}

// The row for a link: what the lists show, and what is sent back to play it.
export async function linkItem(url, deps) {
  const found = await lookup(url, deps);
  if (found.youtube) return found.youtube;
  return {
    id: rememberLink(url),
    url,
    site: found.site,
    title: found.title,
    channel: found.channel,
    duration: found.duration ? Math.round(found.duration) : null,
    live: found.live,
    thumb: found.thumb,
  };
}

// ---- picking the version to play ----

// yt-dlp says 'none' for a format with no picture (or no sound), names the
// codec when it knows it, and says nothing when it doesn't.
const sure = (codec) => (codec === 'none' ? false : typeof codec === 'string' && codec ? true : null);
const isList = (f) => /^m3u8/i.test(f.protocol || '') || /\.m3u8(\?|$)/i.test(f.url);
// The shorter side: a phone video held upright is 1080 wide and 1920 tall, and is still "1080p".
const sizeOf = (f) => (f.width && f.height ? Math.min(f.width, f.height) : f.height || null);
const SOUND_FILES = /^(m4a|mp3|aac|oga|opus|wav|flac|weba|wma)$/i;
const USUALLY_H264 = /^(mp4|m4v|mov)$/i;
const USUALLY_NOT = /^(webm|ogv|ogg|flv|avi|wmv|mkv|3gp|mpg|mpeg)$/i;

// One address ffmpeg can read from start to end: a file, or a list of segments.
function playable(f) {
  if (!f || typeof f.url !== 'string' || !/^https?:\/\//i.test(f.url)) return false;
  if (f.drm || f.pieces) return false;
  if (!/^(|https?|m3u8(_native)?)$/i.test(f.protocol)) return false;
  if (f.vcodec === 'none' && f.acodec === 'none') return false;
  return !/storyboard/i.test(f.note) && f.ext !== 'mhtml';
}

const later = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/*
 * Out of the versions of a video a site has, the one to play at `height`:
 * { video, audio } (audio is null when the picture's file has the sound in
 * it, or there is none), or null when nothing here can be played.
 *
 * In order of what matters: one with sound over one without; one the site
 * doesn't mark as second-rate; one that fits the quality asked for (the
 * smallest that is too big, if none does); H.264, which can be passed
 * straight on to the car, over anything that has to be converted; the
 * biggest picture; and then how it is delivered. A plain file with picture
 * and sound together is the simplest thing to play and to skip around in,
 * then separate files, then lists of segments.
 */
export function pickFormats(formats, height) {
  const kinds = (formats || []).filter(playable).map((f, index) => {
    const picture = sure(f.vcodec);
    const soundOnly = picture === false || (picture === null && (f.soundOnly || SOUND_FILES.test(f.ext)));
    return { f, index, picture: !soundOnly, sound: sure(f.acodec) !== false, list: isList(f) };
  });
  const sounds = kinds.filter((k) => !k.picture && k.sound);
  const pictures = kinds.filter((k) => k.picture);
  if (!pictures.length) return null;
  const rank = (k) => {
    const size = sizeOf(k.f);
    const fits = size === null ? 1 : size <= height * 1.05 ? 2 : 0;
    const named = sure(k.f.vcodec);
    const h264 = named ? (/^(avc|h264)/i.test(k.f.vcodec) ? 2 : 0) : k.list || USUALLY_H264.test(k.f.ext) ? 2 : USUALLY_NOT.test(k.f.ext) ? 0 : 1;
    return [
      k.sound || sounds.length ? 1 : 0,
      k.f.preference < 0 ? 0 : 1,
      fits,
      h264,
      fits === 2 ? size : fits === 1 ? 0 : -size,
      (k.list ? 0 : 2) + (k.sound ? 2 : 1),
      k.f.tbr || 0,
      k.index,
    ];
  };
  const best = pictures.map((k) => ({ k, r: rank(k) })).sort((a, b) => later(a.r, b.r)).pop().k;
  let audio = null;
  if (!best.sound && sounds.length) {
    // Delivered the same way as the picture, in the video's own language, not surround.
    const rankSound = (k) => [k.list === best.list ? 1 : 0, k.f.languagePreference, (k.f.channels || 2) <= 2 ? 1 : 0, k.f.abr || 0, k.index];
    audio = sounds.map((k) => ({ k, r: rankSound(k) })).sort((a, b) => later(a.r, b.r)).pop().k.f;
  }
  return { video: best.f, audio };
}

// ---- looking at what was picked ----

const headerLines = (headers) =>
  Object.entries(headers || {})
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');

/*
 * What a file or stream really is, according to ffprobe: { video: { codec,
 * profile, pixFmt, width, height, fps, interlaced, turned } or null, audio:
 * true/false, duration }. null when it couldn't be looked at.
 *
 * Sites say little about their files, and what they say isn't always so. A
 * plain link to a file says nothing at all.
 */
export async function lookAt(format, deps = {}) {
  const probe = deps.run || run;
  const headers = headerLines(format.headers);
  let json;
  try {
    json = JSON.parse(
      await probe(
        config.ffprobeBin,
        [
          '-v', 'error',
          '-protocol_whitelist', LINK_PROTOCOLS,
          ...(headers ? ['-headers', headers] : []),
          '-show_streams', '-show_format',
          '-of', 'json',
          '-i', format.url,
        ],
        15000
      )
    );
  } catch {
    return null;
  }
  const streams = Array.isArray(json.streams) ? json.streams : [];
  // Not the cover picture of a sound file.
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const [n, d] = String((v && v.avg_frame_rate) || '').split('/').map(Number);
  const turn = v
    ? Number(((v.side_data_list || []).find((side) => side && side.rotation !== undefined) || {}).rotation ?? (v.tags && v.tags.rotate) ?? 0) || 0
    : 0;
  return {
    video: v
      ? {
          codec: String(v.codec_name || ''),
          profile: String(v.profile || ''),
          pixFmt: String(v.pix_fmt || ''),
          width: num(v.width),
          height: num(v.height),
          fps: n > 0 && d > 0 ? n / d : null,
          interlaced: !!v.field_order && !/^(progressive|unknown)$/.test(v.field_order),
          turned: Math.abs(turn) % 360 !== 0,
        }
      : null,
    audio: streams.some((s) => s.codec_type === 'audio'),
    duration: num(Number(json.format && json.format.duration)),
  };
}

/*
 * Why this picture has to be converted for the car instead of being passed
 * on as it is, or '' when it can be. `seen` is what ffprobe saw (null if it
 * couldn't look, and then the site's word is taken for it).
 */
export function whyConvert(format, seen, height) {
  const v = seen && seen.video;
  if (!v) {
    if (!/^(avc|h264)/i.test(format.vcodec || '')) return "it isn't known to be H.264";
    return (sizeOf(format) || 0) <= height * 1.05 ? '' : `it is bigger than ${height}p`;
  }
  if (v.codec !== 'h264') return `it is ${v.codec || 'something other than H.264'}`;
  if (!/^yuvj?420p$/.test(v.pixFmt) || /10|4:2:2|4:4:4/.test(v.profile)) return `it is a kind of H.264 browsers don't decode (${v.profile || v.pixFmt})`;
  if (v.turned) return 'it is stored on its side';
  if (v.interlaced) return 'it is interlaced';
  if ((sizeOf(v) || 0) > height * 1.05) return `it is bigger than ${height}p`;
  return '';
}

const infos = new Cache(LOOKUP_MS, 300);

// Media links for ffmpeg to read, in the shape streamInfo (youtube.js) gives them.
export function linkStreamInfo(id, quality, deps = {}) {
  const height = HEIGHTS[quality] || 480;
  const url = urlOf(id);
  if (!url) return Promise.reject(new Error("The server doesn't have this link any more. Send it again."));
  if (!config.links.on) return Promise.reject(new Error('This server is set to play YouTube videos only.'));
  return infos.get(`${id}:${height}`, async () => {
    const found = await lookup(url, deps);
    if (found.youtube) throw new Error('That link is a YouTube video. Send it again and it plays as one.');
    const picked = pickFormats(found.formats, height);
    if (!picked) {
      throw new Error(found.formats.length ? `${found.site} only has that video in a form DrivePost can't play.` : plainly('no video found', found.site));
    }
    const chosen = [picked.video, picked.audio].filter(Boolean);
    for (const f of chosen) await addressAllowed(f.url, deps.lookup);
    const seen = await (deps.lookAt || lookAt)(picked.video, deps);
    if (seen && !seen.video) throw new Error('That link has sound but no picture.');
    const real = (seen && seen.video) || {};
    const convert = whyConvert(picked.video, seen, height);
    const duration = found.duration || (seen && seen.duration) || null;
    // Sound in the picture's own file: ffprobe knows; otherwise the site wasn't sure, and it is taken to be there.
    const soundInFile = seen ? seen.audio : sure(picked.video.acodec) !== false;
    const inputs = chosen.map((f) => ({
      url: f.url,
      headers: f.headers,
      hasVideo: f === picked.video,
      hasAudio: f === picked.audio || (f === picked.video && !picked.audio && soundInFile),
      fps: f.fps,
      vcodec: f.vcodec || '',
      // What the site says this one is, for the check tool: "http-2176 https mp4 1280x720".
      what: [f.id, f.protocol, f.ext, f.vcodec && f.vcodec !== 'none' ? f.vcodec : '', f.acodec && f.acodec !== 'none' ? f.acodec : '', f.width && f.height ? `${f.width}x${f.height}` : '', f.language ? `lang ${f.language}` : '', f.note]
        .filter(Boolean)
        .join(' '),
      tbr: f.tbr,
      height: f.height,
      readyAt: 0,
      list: isList(f),
      other: true, // not YouTube's: read with ffmpeg kept to the web, and sound only if it turns out to have some
    }));
    let from = '';
    try {
      from = new URL(picked.video.url).hostname;
    } catch {}
    const tall = real.height || picked.video.height || null;
    return {
      at: Date.now(),
      readyAt: 0,
      title: found.title,
      duration,
      // A stream with no end in sight plays as live: converted, and no skipping around in it.
      live: found.live || (!duration && inputs[0].list),
      inputs,
      height: Math.min(height, tall || height),
      fps: picked.video.fps || real.fps || null,
      vcodec: real.codec === 'h264' ? `avc1 ${real.profile}`.trim() : real.codec || picked.video.vcodec || '',
      tbr: picked.video.tbr,
      route: `${found.site}: ${chosen.map((f) => f.id).filter(Boolean).join('+') || '?'} ${[...new Set(chosen.map((f) => f.protocol).filter(Boolean))].join('/') || '?'} from ${from}`,
      routeName: 'link',
      site: found.site,
      convert,
      seen: !!seen,
    };
  });
}

export function forgetLink(id) {
  lookups.map.delete(id);
  for (const height of Object.values(HEIGHTS)) infos.map.delete(`${id}:${height}`);
}

// Look a link up ahead of time, as prewarm (youtube.js) does for YouTube's.
const warmFailed = new Map();
export function prewarmLink(id, quality) {
  if (!isLinkId(id) || !config.links.on || !urlOf(id)) return;
  const key = `${id}:${quality}`;
  if (Date.now() - (warmFailed.get(key) || 0) < 60000) return;
  linkStreamInfo(id, quality).then(
    () => warmFailed.delete(key),
    () => {
      warmFailed.set(key, Date.now());
      if (warmFailed.size > 200) warmFailed.delete(warmFailed.keys().next().value);
    }
  );
}
