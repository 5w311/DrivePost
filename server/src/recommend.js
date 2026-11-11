/*
 * Recommendations: videos like the ones this profile has been watching.
 *
 * There is no YouTube account behind DrivePost, so there are no "your
 * recommendations" to ask for. What YouTube does hand out to anyone is the
 * list of related videos it shows beside a video. The server asks for that
 * list for what is playing and for the last few videos played, and deals
 * them into one list, most recent first, leaving out what has been watched
 * already or is lined up.
 */
import { config } from './config.js';
import { Cache, isValidId, thumbFor, TEST_PATTERN_ID } from './youtube.js';

const SEEDS = 6; // how many recent videos get a say
const LIMIT = 30;

// "12:34" or "1:02:03" in seconds, or null.
function seconds(text) {
  if (typeof text !== 'string' || !/^\d{1,3}(:\d{2}){1,2}$/.test(text.trim())) return null;
  return text.trim().split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

// Every value stored under `key`, anywhere inside `node`.
function every(node, key, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 24) return out;
  if (Array.isArray(node)) {
    for (const child of node) every(child, key, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push(v);
    every(v, key, out, depth + 1);
  }
  return out;
}

const textOf = (t) => (typeof t === 'string' ? t : t && (t.content || t.simpleText || (Array.isArray(t.runs) ? t.runs.map((r) => r.text || '').join('') : ''))) || '';

function item(id, title, channel, duration, live) {
  if (!isValidId(id) || id === TEST_PATTERN_ID || !title) return null;
  return {
    id,
    title: String(title).slice(0, 200),
    channel: String(channel || '').trim().slice(0, 100),
    duration: !live && Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    live: !!live,
    thumb: thumbFor(id),
  };
}

// YouTube's current shape for an entry in a list of videos.
function fromLockup(l) {
  if (!l || l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null; // not a playlist, course or mix
  const badges = every(l.contentImage, 'thumbnailBadgeViewModel');
  const labels = badges.map((b) => String(b.text || ''));
  const live = badges.some((b) => /LIVE/.test(String(b.badgeStyle || '')) || /^live$/i.test(String(b.text || '').trim()));
  // Not out yet, or not for everyone: nothing the server could play.
  if (labels.some((t) => /upcoming|premiere|members/i.test(t)) || every(l.metadata, 'badgeViewModel').some((b) => /members/i.test(String(b.badgeText || '')))) return null;
  const length = labels.map(seconds).find((n) => n !== null) ?? null;
  if (!live && length === null) return null; // no length and not live: a Short, or something else that isn't an ordinary video
  const meta = l.metadata && l.metadata.lockupMetadataViewModel;
  const rows = (meta && meta.metadata && meta.metadata.contentMetadataViewModel && meta.metadata.contentMetadataViewModel.metadataRows) || [];
  const firstPart = rows[0] && rows[0].metadataParts && rows[0].metadataParts[0];
  return item(l.contentId, textOf(meta && meta.title), textOf(firstPart && firstPart.text), length, live);
}

// The shape before that, which YouTube still uses in places.
function fromRenderer(r) {
  if (!r || typeof r !== 'object') return null;
  const live =
    every(r.badges, 'style').some((s) => /LIVE/.test(String(s))) ||
    every(r.thumbnailOverlays, 'style').some((s) => s === 'LIVE');
  const length = Number(r.lengthSeconds || r.lengthInSeconds) || seconds(textOf(r.lengthText));
  if (!live && !length) return null;
  return item(r.videoId, textOf(r.title), textOf(r.longBylineText || r.shortBylineText), length, live);
}

/*
 * The related videos in YouTube's answer for one video, in YouTube's order.
 * Looks for the entries wherever they are rather than at a fixed place, so a
 * rearranged page doesn't empty the list.
 */
export function relatedFrom(json) {
  const beside = json && json.contents && json.contents.twoColumnWatchNextResults && json.contents.twoColumnWatchNextResults.secondaryResults;
  const places = [beside, json && json.contents, json && json.playerOverlays].filter(Boolean);
  for (const place of places) {
    const found = [
      ...every(place, 'lockupViewModel').map(fromLockup),
      ...every(place, 'compactVideoRenderer').map(fromRenderer),
      ...every(place, 'endScreenVideoRenderer').map(fromRenderer),
    ].filter(Boolean);
    const seen = new Set();
    const unique = found.filter((v) => !seen.has(v.id) && seen.add(v.id));
    if (unique.length) return unique;
  }
  return [];
}

const relatedCache = new Cache(12 * 60 * 60 * 1000, 300);

// Videos YouTube lists beside this one. Kept for half a day.
export function related(id, fetchImpl = fetch) {
  if (!isValidId(id) || id === TEST_PATTERN_ID) return Promise.resolve([]);
  return relatedCache.get(id, async () => {
    const res = await fetchImpl(config.relatedUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20251101.00.00', hl: 'en', gl: 'US' } }, videoId: id }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`related videos returned ${res.status}`);
    const list = relatedFrom(await res.json());
    if (!list.length) throw new Error('no related videos in the answer'); // don't keep an empty answer for half a day
    return list.filter((v) => v.id !== id);
  });
}

/*
 * One list for a profile, from its `now`, `history` and `queue`. Each recent
 * video's related list is dealt out a round at a time, so the newest gets
 * the first pick and none of them takes over. Returns { items, from }, where
 * `from` is how many recent videos it is based on. `failed` is set when
 * there were videos to go by but YouTube answered for none of them.
 */
export async function recommendFor(state, getRelated = related) {
  const seeds = [];
  for (const v of [state.now, ...(state.history || [])]) {
    if (v && isValidId(v.id) && v.id !== TEST_PATTERN_ID && !seeds.some((s) => s.id === v.id)) seeds.push(v);
    if (seeds.length >= SEEDS) break;
  }
  if (!seeds.length) return { items: [], from: 0 };
  const answers = await Promise.all(seeds.map((s) => getRelated(s.id).then((list) => list, () => null)));
  const lists = answers.map((list) => list || []);
  const skip = new Set([...(state.history || []), ...(state.queue || []), state.now].filter(Boolean).map((v) => v.id));
  const items = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let round = 0; round < longest && items.length < LIMIT; round++) {
    for (const list of lists) {
      const v = list[round];
      if (!v || skip.has(v.id) || items.length >= LIMIT) continue;
      skip.add(v.id);
      items.push(v);
    }
  }
  return { items, from: seeds.length, ...(answers.every((a) => a === null) ? { failed: true } : {}) };
}
