/*
 * A video's captions, as lines with the times they are on screen, for the
 * car to draw over its picture.
 *
 * Which tracks a video has comes with the lookup it gets anyway (extras.js).
 * The track itself is fetched by yt-dlp, which knows how each site hands
 * them over, into a folder of its own that is thrown away afterwards. Of the
 * forms a track comes in, two are read here: YouTube's own ("json3", which
 * says each line once, where its subtitle files for captions made from the
 * sound repeat every line three times over), and WebVTT, which is what most
 * other sites give.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { ytdlp, isValidId, TEST_PATTERN_ID } from './youtube.js';
import { isLinkId, urlOf } from './links.js';
import { notedFor, pickCaptions } from './extras.js';

const CUES_MAX = 8000;
const LINE_MAX = 220;

const clean = (text) =>
  String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/​/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, LINE_MAX);

// In order, without the empty and the endless, and no more than a screen can use.
export function tidyCues(cues) {
  const out = [];
  for (const c of cues) {
    if (!c || !Number.isFinite(c.s) || !Number.isFinite(c.e) || c.s < 0 || !c.text) continue;
    // (A line said to stay up for minutes is a mistake in the track.)
    const e = Math.min(c.e, c.s + 20);
    if (e - c.s < 0.05) continue;
    out.push({ s: Math.round(c.s * 100) / 100, e: Math.round(e * 100) / 100, text: c.text });
  }
  out.sort((a, b) => a.s - b.s || a.e - b.e);
  // The same words twice running, one starting where the other stops: one line for as long as both.
  const joined = [];
  for (const c of out) {
    const last = joined[joined.length - 1];
    if (last && last.text === c.text && c.s <= last.e + 0.1) last.e = Math.max(last.e, c.e);
    else joined.push(c);
  }
  return joined.slice(0, CUES_MAX);
}

/*
 * YouTube's own form. Each "event" with words in it is one line: when it
 * comes up and for how long. Captions made from the sound roll: a line stays
 * while the next is said under it, so two are up at once. (Events without
 * words set up the window, and a lone line break only says "new line".)
 */
export function cuesFromJson3(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const cues = [];
  for (const ev of Array.isArray(json && json.events) ? json.events : []) {
    if (!ev || !Array.isArray(ev.segs)) continue;
    const words = clean(ev.segs.map((s) => (s && typeof s.utf8 === 'string' ? s.utf8 : '')).join(''));
    if (!words) continue;
    const s = Number(ev.tStartMs) / 1000;
    const d = Number(ev.dDurationMs) / 1000;
    cues.push({ s, e: s + (Number.isFinite(d) && d > 0 ? d : 3), text: words });
  }
  return tidyCues(cues);
}

// "01:02:03.456" or "02:03.456", in seconds.
function vttTime(v) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(v.trim());
  if (!m) return NaN;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

// WebVTT (and SubRip, which differs in a comma): blocks of a line of times and the words under it.
export function cuesFromVtt(text) {
  const cues = [];
  for (const block of String(text).replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [from, rest] = lines[at].split('-->');
    const s = vttTime(from);
    const e = vttTime((rest || '').trim().split(/\s+/)[0] || '');
    const words = clean(lines.slice(at + 1).join('\n'));
    if (words) cues.push({ s, e, text: words });
  }
  return tidyCues(cues);
}

const KEPT_FOR_MS = 6 * 60 * 60 * 1000;
const KEPT_MAX = 40;
const kept = new Map(); // "id:lang" -> { at, value (a promise) }

/*
 * The captions to show for the video `id`, in the language this server is
 * set to: { lang, auto, cues: [[from, to, words], ...] }, or { none: why }
 * when it has none to show. (`deps.ytdlp` stands in for yt-dlp in tests.)
 */
export function captionsFor(id, deps = {}) {
  if (id === TEST_PATTERN_ID || !(isValidId(id) || isLinkId(id))) return Promise.resolve({ none: 'This has no captions.' });
  const pick = pickCaptions(notedFor(id), deps.lang || config.captionsLang);
  if (!pick) return Promise.resolve({ none: 'This video has no captions.' });
  const key = `${id}:${pick.lang}:${pick.auto ? 'a' : 'w'}`;
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < KEPT_FOR_MS) return hit.value;
  const value = fetchTrack(id, pick, deps);
  kept.set(key, { at: Date.now(), value });
  value.then(
    (got) => got.none && kept.get(key) && kept.get(key).value === value && setTimeout(() => kept.delete(key), 5 * 60 * 1000).unref(),
    () => kept.delete(key)
  );
  if (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value);
  return value;
}

async function fetchTrack(id, pick, deps) {
  const ask = deps.ytdlp || ytdlp;
  const link = isLinkId(id) ? urlOf(id) : null;
  if (isLinkId(id) && !link) return { none: 'This video has no captions.' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drivepost-captions-'));
  try {
    await ask(
      [
        ...(link ? config.links.extraArgs : []),
        '--skip-download',
        '--no-playlist',
        pick.auto ? '--write-auto-subs' : '--write-subs',
        '--sub-langs',
        pick.lang,
        '--sub-format',
        'json3/vtt/srt/best',
        '-o',
        path.join(dir, 'track.%(ext)s'),
        ...(link ? ['--', link] : [`https://www.youtube.com/watch?v=${id}`]),
      ],
      40000
    );
    // yt-dlp names what it wrote "track.<language>.<form>".
    const files = fs.readdirSync(dir).filter((f) => /\.(json3|vtt|srt)$/i.test(f));
    const file = files.find((f) => f.toLowerCase().endsWith('.json3')) || files[0];
    if (!file) return { none: "This video's captions couldn't be fetched just now." };
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const cues = /\.json3$/i.test(file) ? cuesFromJson3(text) : cuesFromVtt(text);
    if (!cues.length) return { none: 'This video has no captions.' };
    return { lang: pick.lang, auto: pick.auto, cues: cues.map((c) => [c.s, c.e, c.text]) };
  } catch (err) {
    console.warn(`[captions] ${id}: ${String(err.message || err).slice(0, 200)}`);
    throw new Error("This video's captions couldn't be fetched just now.");
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

export function forgetCaptions() {
  kept.clear();
}
