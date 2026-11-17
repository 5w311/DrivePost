/*
 * What is known about a video besides the video itself: its chapters, whose
 * it is, which captions it has, and (for a profile that asked) the stretches
 * of it that are a sponsor's.
 *
 * The first three come with the lookup that every video gets before it is
 * played (yt-dlp says them along with where the video is), so they cost no
 * request of their own: whoever makes that lookup notes them here. The
 * sponsor stretches are another matter: see sponsorSkips.
 */
import crypto from 'node:crypto';
import { config } from './config.js';

const NOTED_MAX = 400;
const noted = new Map(); // video id -> { chapters, channel, subs, auto }

const tidy = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
export const isChannelId = (v) => typeof v === 'string' && CHANNEL_ID.test(v);

/*
 * A video's chapters, as { t, title } from the start of each, in order.
 * yt-dlp gives them as it finds them: from the site's own markers, or from
 * the times its maker wrote in the description. One chapter is no chapters.
 */
export function cleanChapters(raw, duration = null) {
  const out = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const t = Number(c && c.start_time);
    const title = tidy(c && c.title, 120);
    if (!Number.isFinite(t) || t < 0 || !title) continue;
    if (duration && t >= duration) continue;
    out.push({ t: Math.round(t * 10) / 10, title });
  }
  out.sort((a, b) => a.t - b.t);
  // (Two that start together: the later one named wins.)
  const apart = out.filter((c, i) => i === out.length - 1 || out[i + 1].t - c.t >= 1);
  return apart.length >= 2 ? apart.slice(0, 200) : [];
}

// The languages a video has captions in: written by people (`subs`), and made by the site from the sound (`auto`).
function langsOf(tracks) {
  if (!tracks || typeof tracks !== 'object') return [];
  return Object.keys(tracks)
    .filter((l) => /^[A-Za-z]{2,3}(-[A-Za-z0-9-]{1,20})?$/.test(l) && Array.isArray(tracks[l]) && tracks[l].length)
    .slice(0, 400);
}

// A lookup's answer, as yt-dlp gave it (`json`), for the video `id`.
export function noteLookup(id, json) {
  if (!id || !json || typeof json !== 'object') return;
  const duration = typeof json.duration === 'number' && json.duration > 0 ? json.duration : null;
  noted.delete(id);
  noted.set(id, {
    chapters: cleanChapters(json.chapters, duration),
    channel: {
      id: isChannelId(json.channel_id) ? json.channel_id : '',
      name: tidy(json.channel || json.uploader, 100),
    },
    subs: langsOf(json.subtitles),
    auto: langsOf(json.automatic_captions),
  });
  if (noted.size > NOTED_MAX) noted.delete(noted.keys().next().value);
}

export const notedFor = (id) => noted.get(id) || null;
export function forgetNoted() {
  noted.clear();
  skips.clear();
}

/*
 * Which of a video's caption tracks to show to someone who reads `want`
 * ("en"): one written by people in that language, else the site's own from
 * the sound in that language, else nothing. Returns { lang, auto } or null.
 * ("en-US" and "en-orig" are English too.)
 */
export function pickCaptions(found, want = 'en') {
  if (!found) return null;
  const w = String(want || 'en').toLowerCase();
  const fits = (l) => l.toLowerCase() === w || l.toLowerCase().startsWith(w + '-');
  const best = (langs) => langs.find((l) => l.toLowerCase() === w) || langs.find((l) => l.toLowerCase() === w + '-orig') || langs.find(fits);
  const sub = best(found.subs || []);
  if (sub) return { lang: sub, auto: false };
  const auto = best(found.auto || []);
  return auto ? { lang: auto, auto: true } : null;
}

/*
 * The stretches of a YouTube video that are a sponsor's, from SponsorBlock:
 * a public list kept by viewers, who mark where the paid part of a video
 * starts and ends (https://sponsor.ajay.app; the data is theirs, under
 * CC BY-NC-SA 4.0).
 *
 * It is asked the way its own browser extension asks: not "what do you have
 * for this video" but "for every video whose fingerprint starts with these
 * four characters", of which there are thousands, and this server picks its
 * own out of the answer. So the list's keeper isn't told what was watched.
 * Nothing is asked at all for a profile that hasn't switched this on.
 */
export const SKIP_KINDS = { sponsor: 'Sponsor', selfpromo: 'Promotion' };
const SKIPS_FOR_MS = 30 * 60 * 1000;
const SKIPS_MAX = 300;
const skips = new Map(); // id -> { at, value (a promise) }

export function cleanSkips(segments, duration = null) {
  const out = [];
  for (const s of Array.isArray(segments) ? segments : []) {
    if (!s || (s.actionType && s.actionType !== 'skip') || !SKIP_KINDS[s.category]) continue;
    const from = Number(Array.isArray(s.segment) ? s.segment[0] : NaN);
    let to = Number(Array.isArray(s.segment) ? s.segment[1] : NaN);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0) continue;
    if (duration) to = Math.min(to, duration);
    // (Not worth a skip: it would take longer than watching it.)
    if (to - from < 2) continue;
    out.push({ from: Math.round(from * 10) / 10, to: Math.round(to * 10) / 10, kind: s.category });
  }
  out.sort((a, b) => a.from - b.from);
  // Marked twice, or one inside another: one stretch.
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && s.from <= last.to + 0.5) last.to = Math.max(last.to, s.to);
    else merged.push({ ...s });
  }
  return merged.slice(0, 40);
}

export function sponsorSkips(id, { fetchImpl = fetch, base = config.sponsorUrl, now = Date.now(), duration = null } = {}) {
  if (!base || typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id)) return Promise.resolve([]);
  const hit = skips.get(id);
  if (hit && now - hit.at < SKIPS_FOR_MS) return hit.value;
  const value = (async () => {
    const prefix = crypto.createHash('sha256').update(id).digest('hex').slice(0, 4);
    const kinds = encodeURIComponent(JSON.stringify(Object.keys(SKIP_KINDS)));
    const res = await fetchImpl(`${base.replace(/\/+$/, '')}/api/skipSegments/${prefix}?categories=${kinds}&actionTypes=${encodeURIComponent('["skip"]')}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return []; // nobody has marked anything under that fingerprint
    if (!res.ok) throw new Error(`the sponsor list answered ${res.status}`);
    const all = await res.json();
    const mine = (Array.isArray(all) ? all : []).find((v) => v && v.videoID === id);
    return cleanSkips(mine ? mine.segments : [], duration);
  })();
  skips.set(id, { at: now, value });
  // (An answer that didn't come isn't kept: the next video played asks again.)
  value.catch(() => skips.get(id) && skips.get(id).value === value && skips.delete(id));
  if (skips.size > SKIPS_MAX) skips.delete(skips.keys().next().value);
  return value;
}
